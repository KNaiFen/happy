import { getMetricsLabelsFromSocket, machineAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { buildMachineActivityEphemeral, buildUpdateMachineUpdate, eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { Socket } from "socket.io";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { afterTx, inTx } from "@/storage/inTx";
import { acquireAccountWrite } from "@/app/account/accountWriteGate";

export function machineUpdateHandler(userId: string, socket: Socket) {
    const labels = getMetricsLabelsFromSocket(socket);
    const credentialId = socket.data.credentialId as string | undefined;
    const scopedMachineId = credentialId
        ? socket.data.machineId as string | undefined
        : undefined;

    const canTargetMachine = (machineId: string): boolean => (
        credentialId ? scopedMachineId === machineId : true
    );

    socket.on('machine-alive', async (data: {
        machineId: string;
        time: number;
    }) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'machine-alive', ...labels });
            machineAliveEventsCounter.inc();

            // Basic validation
            if (!data || typeof data.time !== 'number' || !data.machineId) {
                return;
            }
            if (!canTargetMachine(data.machineId)) return;

            let t = data.time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) {
                return;
            }

            // Check machine validity using cache
            const isValid = await activityCache.isMachineValid(data.machineId, userId);
            if (!isValid) {
                return;
            }

            // Queue database update (will only update if time difference is significant)
            activityCache.queueMachineUpdate(data.machineId, t);

            const machineActivity = buildMachineActivityEphemeral(data.machineId, true, t);
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch {
            log({ module: 'websocket', level: 'error' }, 'Machine heartbeat failed');
        }
    });

    // Machine metadata update with optimistic concurrency control
    socket.on('machine-update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            const { machineId, metadata, expectedVersion } = data;

            // Validate input
            if (!machineId || typeof metadata !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }
            if (!canTargetMachine(machineId)) {
                callback?.({ result: 'error', message: 'Machine scope mismatch' });
                return;
            }

            const result = await inTx(async (tx) => {
                if (!await acquireAccountWrite(tx, userId)) return { kind: 'deleting' as const };
                const machine = await tx.machine.findFirst({
                    where: {
                        accountId: userId, id: machineId, deletedAt: null,
                        account: { is: { deletionRequestedAt: null } },
                        ...(credentialId ? { credentialId } : {}),
                    }
                });
                if (!machine) return { kind: 'missing' as const };
                if (machine.metadataVersion !== expectedVersion) {
                    return { kind: 'version-mismatch' as const, version: machine.metadataVersion, metadata: machine.metadata };
                }
                const updated = await tx.machine.updateMany({
                where: {
                    accountId: userId,
                    id: machineId,
                    metadataVersion: expectedVersion,
                    deletedAt: null,
                    account: { is: { deletionRequestedAt: null } },
                    ...(credentialId ? { credentialId } : {}),
                },
                data: {
                    metadata: metadata,
                    metadataVersion: expectedVersion + 1
                    // NOT updating active or lastActiveAt here
                }
                });
                if (updated.count !== 1) return { kind: 'version-mismatch' as const, version: machine.metadataVersion, metadata: machine.metadata };
                const updSeq = await allocateUserSeq(userId, tx);
                const metadataUpdate = { value: metadata, version: expectedVersion + 1 };
                const updatePayload = buildUpdateMachineUpdate(machineId, updSeq, randomKeyNaked(12), metadataUpdate);
                afterTx(tx, () => eventRouter.emitUpdate({ userId, payload: updatePayload, recipientFilter: { type: 'machine-scoped-only', machineId } }));
                return { kind: 'success' as const };
            });
            if (result.kind === 'deleting') {
                callback?.({ result: 'error', message: 'Account deletion in progress' });
                return;
            }
            if (result.kind === 'missing') {
                callback?.({ result: 'error', message: 'Machine not found' });
                return;
            }
            if (result.kind === 'version-mismatch') {
                callback({
                    result: 'version-mismatch',
                    version: result.version,
                    metadata: result.metadata
                });
                return;
            }

            // Send success response with new version
            callback({
                result: 'success',
                version: expectedVersion + 1,
                metadata: metadata
            });
        } catch {
            log({ module: 'websocket', level: 'error' }, 'Machine metadata update failed');
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    // Machine daemon state update with optimistic concurrency control
    socket.on('machine-update-state', async (data: any, callback: (response: any) => void) => {
        try {
            const { machineId, daemonState, expectedVersion } = data;

            // Validate input
            if (!machineId || typeof daemonState !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }
            if (!canTargetMachine(machineId)) {
                callback?.({ result: 'error', message: 'Machine scope mismatch' });
                return;
            }

            const result = await inTx(async (tx) => {
                if (!await acquireAccountWrite(tx, userId)) return { kind: 'deleting' as const };
                const machine = await tx.machine.findFirst({
                    where: {
                        accountId: userId, id: machineId, deletedAt: null,
                        account: { is: { deletionRequestedAt: null } },
                        ...(credentialId ? { credentialId } : {}),
                    }
                });
                if (!machine) return { kind: 'missing' as const };
                if (machine.daemonStateVersion !== expectedVersion) {
                    return { kind: 'version-mismatch' as const, version: machine.daemonStateVersion, daemonState: machine.daemonState };
                }
                const updated = await tx.machine.updateMany({
                where: {
                    accountId: userId,
                    id: machineId,
                    daemonStateVersion: expectedVersion,
                    deletedAt: null,
                    account: { is: { deletionRequestedAt: null } },
                    ...(credentialId ? { credentialId } : {}),
                },
                data: {
                    daemonState: daemonState,
                    daemonStateVersion: expectedVersion + 1,
                    active: true,
                    lastActiveAt: new Date()
                }
                });
                if (updated.count !== 1) return { kind: 'version-mismatch' as const, version: machine.daemonStateVersion, daemonState: machine.daemonState };
                const updSeq = await allocateUserSeq(userId, tx);
                const daemonStateUpdate = { value: daemonState, version: expectedVersion + 1 };
                const updatePayload = buildUpdateMachineUpdate(machineId, updSeq, randomKeyNaked(12), undefined, daemonStateUpdate);
                afterTx(tx, () => eventRouter.emitUpdate({ userId, payload: updatePayload, recipientFilter: { type: 'machine-scoped-only', machineId } }));
                return { kind: 'success' as const };
            });
            if (result.kind === 'deleting') {
                callback?.({ result: 'error', message: 'Account deletion in progress' });
                return;
            }
            if (result.kind === 'missing') {
                callback?.({ result: 'error', message: 'Machine not found' });
                return;
            }
            if (result.kind === 'version-mismatch') {
                callback({
                    result: 'version-mismatch',
                    version: result.version,
                    daemonState: result.daemonState
                });
                return;
            }

            // Send success response with new version
            callback({
                result: 'success',
                version: expectedVersion + 1,
                daemonState: daemonState
            });
        } catch {
            log({ module: 'websocket', level: 'error' }, 'Machine state update failed');
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });
}
