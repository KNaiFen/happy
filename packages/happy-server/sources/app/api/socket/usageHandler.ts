import { Socket } from "socket.io";
import { AsyncLock } from "@/utils/lock";
import { db } from "@/storage/db";
import { buildUsageEphemeral, eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/log";
import type { ClientConnection } from "@/app/events/eventRouter";
import { sessionWriteWhereForConnection } from "./sessionScope";
import { diagnosticHash } from "@/utils/diagnosticHash";
import { afterTx, inTx } from "@/storage/inTx";
import { acquireAccountWrite } from "@/app/account/accountWriteGate";

export function usageHandler(
    userId: string,
    socket: Socket,
    connection: ClientConnection,
) {
    const receiveUsageLock = new AsyncLock();
    socket.on('usage-report', async (data: any, callback?: (response: any) => void) => {
        await receiveUsageLock.inLock(async () => {
            try {
                const { key, sessionId, tokens, cost } = data;

                // Validate required fields
                if (!key || typeof key !== 'string') {
                    if (callback) {
                        callback({ success: false, error: 'Invalid key' });
                    }
                    return;
                }

                // Validate tokens and cost objects
                if (!tokens || typeof tokens !== 'object' || typeof tokens.total !== 'number') {
                    if (callback) {
                        callback({ success: false, error: 'Invalid tokens object - must include total' });
                    }
                    return;
                }

                if (!cost || typeof cost !== 'object' || typeof cost.total !== 'number') {
                    if (callback) {
                        callback({ success: false, error: 'Invalid cost object - must include total' });
                    }
                    return;
                }

                // Validate sessionId if provided
                if (sessionId && typeof sessionId !== 'string') {
                    if (callback) {
                        callback({ success: false, error: 'Invalid sessionId' });
                    }
                    return;
                }

                try {
                    // If sessionId provided, verify it belongs to the user
                    if (sessionId) {
                        const accessWhere = sessionWriteWhereForConnection(
                            userId,
                            connection,
                            sessionId,
                        );
                        if (!accessWhere) {
                            callback?.({ success: false, error: 'Session not found' });
                            return;
                        }
                        const session = await db.session.findFirst({
                            where: accessWhere,
                        });

                        if (!session) {
                            if (callback) {
                                callback({ success: false, error: 'Session not found' });
                            }
                            return;
                        }
                    } else if (connection.credentialId) {
                        callback?.({ success: false, error: 'Session not found' });
                        return;
                    }

                    // Prepare usage data
                    const usageData: PrismaJson.UsageReportData = {
                        tokens,
                        cost
                    };

                    const result = await inTx(async (tx) => {
                        if (!await acquireAccountWrite(tx, userId)) return { kind: 'deleting' as const };
                        if (sessionId) {
                            const session = await tx.session.findFirst({ where: sessionWriteWhereForConnection(userId, connection, sessionId)! });
                            if (!session) return { kind: 'missing-session' as const };
                        }
                        const report = await tx.usageReport.upsert({
                        where: {
                            accountId_sessionId_key: {
                                accountId: userId,
                                sessionId: sessionId || null,
                                key
                            }
                        },
                        update: {
                            data: usageData,
                            updatedAt: new Date()
                        },
                        create: {
                            accountId: userId,
                            sessionId: sessionId || null,
                            key,
                            data: usageData
                        }
                        });
                        if (sessionId) {
                            const usageEvent = buildUsageEphemeral(sessionId, key, usageData.tokens, usageData.cost);
                            afterTx(tx, () => eventRouter.emitEphemeral({
                                userId,
                                payload: usageEvent,
                                recipientFilter: { type: 'user-scoped-only' }
                            }));
                        }
                        return { kind: 'saved' as const, report };
                    });
                    if (result.kind !== 'saved') {
                        callback?.({ success: false, error: result.kind === 'missing-session' ? 'Session not found' : 'Failed to save usage report' });
                        return;
                    }
                    const report = result.report;

                    log({
                        module: 'websocket',
                        userHash: diagnosticHash(userId),
                        sessionHash: sessionId ? diagnosticHash(sessionId) : undefined,
                    }, 'Usage report saved');

                    if (callback) {
                        callback({
                            success: true,
                            reportId: report.id,
                            createdAt: report.createdAt.getTime(),
                            updatedAt: report.updatedAt.getTime()
                        });
                    }
                } catch {
                    log({ module: 'websocket', level: 'error' }, 'Failed to save usage report');
                    if (callback) {
                        callback({ success: false, error: 'Failed to save usage report' });
                    }
                }
            } catch {
                log({ module: 'websocket', level: 'error' }, 'Usage report handler failed');
                if (callback) {
                    callback({ success: false, error: 'Internal error' });
                }
            }
        });
    });
}
