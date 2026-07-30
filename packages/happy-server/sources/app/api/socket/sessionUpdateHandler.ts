import { getMetricsLabelsFromSocket, sessionAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { buildNewMessageUpdate, buildSessionActivityEphemeral, buildUpdateSessionUpdate, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { allocateSessionSeq, allocateUserSeq } from "@/storage/seq";
import { AsyncLock } from "@/utils/lock";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { Socket } from "socket.io";
import { sessionWhereForConnection } from "./sessionScope";
import { diagnosticHash } from "@/utils/diagnosticHash";
import { inTx } from "@/storage/inTx";

export function sessionUpdateHandler(userId: string, socket: Socket, connection: ClientConnection) {
    const labels = getMetricsLabelsFromSocket(socket);
    socket.on('update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, metadata, expectedVersion } = data;

            // Validate input
            if (!sid || typeof metadata !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }
            const accessWhere = sessionWhereForConnection(userId, connection, sid);
            if (!accessWhere) {
                callback?.({ result: 'error' });
                return;
            }

            // Resolve session
            const session = await db.session.findFirst({
                where: accessWhere,
            });
            if (!session) {
                return;
            }

            // Check version
            if (session.metadataVersion !== expectedVersion) {
                callback({ result: 'version-mismatch', version: session.metadataVersion, metadata: session.metadata });
                return null;
            }

            // Update metadata
            const { count } = await db.session.updateMany({
                where: { ...accessWhere, metadataVersion: expectedVersion },
                data: {
                    metadata: metadata,
                    metadataVersion: expectedVersion + 1
                }
            });
            if (count === 0) {
                callback({ result: 'version-mismatch', version: session.metadataVersion, metadata: session.metadata });
                return null;
            }

            // Generate session metadata update
            const updSeq = await allocateUserSeq(userId);
            const metadataUpdate = {
                value: metadata,
                version: expectedVersion + 1
            };
            const updatePayload = buildUpdateSessionUpdate(sid, updSeq, randomKeyNaked(12), metadataUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
            });

            // Send success response with new version via callback
            callback({ result: 'success', version: expectedVersion + 1, metadata: metadata });
        } catch {
            log({ module: 'websocket', level: 'error' }, 'Session metadata update failed');
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });

    socket.on('update-state', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, agentState, expectedVersion } = data;

            // Validate input
            if (!sid || (typeof agentState !== 'string' && agentState !== null) || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }
            const accessWhere = sessionWhereForConnection(userId, connection, sid);
            if (!accessWhere) {
                callback?.({ result: 'error' });
                return;
            }

            // Resolve session
            const session = await db.session.findFirst({
                where: accessWhere,
            });
            if (!session) {
                callback({ result: 'error' });
                return null;
            }

            // Check version
            if (session.agentStateVersion !== expectedVersion) {
                callback({ result: 'version-mismatch', version: session.agentStateVersion, agentState: session.agentState });
                return null;
            }

            // Update agent state
            const { count } = await db.session.updateMany({
                where: { ...accessWhere, agentStateVersion: expectedVersion },
                data: {
                    agentState: agentState,
                    agentStateVersion: expectedVersion + 1
                }
            });
            if (count === 0) {
                callback({ result: 'version-mismatch', version: session.agentStateVersion, agentState: session.agentState });
                return null;
            }

            // Generate session agent state update
            const updSeq = await allocateUserSeq(userId);
            const agentStateUpdate = {
                value: agentState,
                version: expectedVersion + 1
            };
            const updatePayload = buildUpdateSessionUpdate(sid, updSeq, randomKeyNaked(12), undefined, agentStateUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
            });

            // Send success response with new version via callback
            callback({ result: 'success', version: expectedVersion + 1, agentState: agentState });
        } catch {
            log({ module: 'websocket', level: 'error' }, 'Session state update failed');
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });
    socket.on('session-alive', async (data: {
        sid: string;
        time: number;
        thinking?: boolean;
    }) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'session-alive', ...labels });
            sessionAliveEventsCounter.inc();

            // Basic validation
            if (!data || typeof data.time !== 'number' || !data.sid) {
                return;
            }

            let t = data.time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) {
                return;
            }

            const { sid, thinking } = data;
            const accessWhere = sessionWhereForConnection(userId, connection, sid);
            if (!accessWhere) return;
            const session = await db.session.findFirst({
                where: accessWhere,
                select: { id: true },
            });
            if (!session) return;

            // Check session validity using cache
            const isValid = await activityCache.isSessionValid(sid, userId);
            if (!isValid) {
                return;
            }

            // Queue database update (will only update if time difference is significant)
            activityCache.queueSessionUpdate(sid, t);

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, true, t, thinking || false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch {
            log({ module: 'websocket', level: 'error' }, 'Session heartbeat failed');
        }
    });

    const receiveMessageLock = new AsyncLock();
    socket.on('message', async (data: any) => {
        await receiveMessageLock.inLock(async () => {
            try {
                websocketEventsCounter.inc({ event_type: 'message', ...labels });
                const { sid, message, localId } = data ?? {};
                if (
                    typeof sid !== 'string'
                    || typeof message !== 'string'
                    || (localId !== undefined && localId !== null && typeof localId !== 'string')
                ) {
                    return;
                }
                const accessWhere = sessionWhereForConnection(userId, connection, sid);
                if (!accessWhere) return;

                log({
                    module: 'websocket',
                    sessionHash: diagnosticHash(sid),
                    messageLength: Buffer.byteLength(message, 'utf8'),
                    connectionType: connection.connectionType,
                }, 'Received encrypted session message');

                const result = await inTx(async (tx) => {
                    const session = await tx.session.findFirst({
                        where: accessWhere,
                        select: { id: true },
                    });
                    if (!session) return null;

                    const useLocalId = typeof localId === 'string' ? localId : null;
                    if (useLocalId) {
                        const existing = await tx.sessionMessage.findFirst({
                            where: { sessionId: sid, localId: useLocalId }
                        });
                        if (existing) {
                            return { msg: existing, update: null };
                        }
                    }

                    const updSeq = await allocateUserSeq(userId, tx);
                    const msgSeq = await allocateSessionSeq(sid, tx);
                    const msgContent: PrismaJson.SessionMessageContent = {
                        t: 'encrypted',
                        c: message
                    };
                    const msg = await tx.sessionMessage.create({
                        data: {
                            sessionId: sid,
                            seq: msgSeq,
                            content: msgContent,
                            localId: useLocalId
                        }
                    });
                    return {
                        msg,
                        update: buildNewMessageUpdate(
                            msg,
                            sid,
                            updSeq,
                            randomKeyNaked(12),
                        ),
                    };
                });
                if (!result?.update) return;

                // Emit new message update to relevant clients
                eventRouter.emitUpdate({
                    userId,
                    payload: result.update,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: connection
                });
            } catch {
                log({ module: 'websocket', level: 'error' }, 'Session message handler failed');
            }
        });
    });

    socket.on('session-end', async (data: {
        sid: string;
        time: number;
    }) => {
        try {
            const { sid, time } = data;
            let t = time;
            if (typeof t !== 'number') {
                return;
            }
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) { // Ignore if time is in the past 10 minutes
                return;
            }
            const accessWhere = sessionWhereForConnection(userId, connection, sid);
            if (!accessWhere) return;

            // Update last active at
            const { count } = await db.session.updateMany({
                where: accessWhere,
                data: { lastActiveAt: new Date(t), active: false }
            });
            if (count === 0) return;

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, false, t, false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch {
            log({ module: 'websocket', level: 'error' }, 'Session end update failed');
        }
    });

}
