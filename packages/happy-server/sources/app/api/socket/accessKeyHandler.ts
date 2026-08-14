import { Socket } from "socket.io";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import type { ClientConnection } from "@/app/events/eventRouter";
import { sessionWhereForConnection } from "./sessionScope";
import { diagnosticHash } from "@/utils/diagnosticHash";
import { inTx } from "@/storage/inTx";
import { acquireAccountRead } from "@/app/account/accountWriteGate";

export function accessKeyHandler(
    userId: string,
    socket: Socket,
    connection: ClientConnection,
) {
    // Get access key via socket
    socket.on('access-key-get', async (data: { sessionId: string; machineId: string }, callback: (response: any) => void) => {
        try {
            const { sessionId, machineId } = data;

            if (!sessionId || !machineId) {
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Invalid parameters: sessionId and machineId are required'
                    });
                }
                return;
            }
            const scopedMachineId = connection.connectionType === 'user-scoped'
                ? undefined
                : connection.machineId;
            if (
                connection.credentialId
                && (!scopedMachineId || scopedMachineId !== machineId)
            ) {
                callback?.({ ok: false, error: 'Session or machine not found' });
                return;
            }
            const sessionWhere = sessionWhereForConnection(
                userId,
                connection,
                sessionId,
            );
            if (!sessionWhere) {
                callback?.({ ok: false, error: 'Session or machine not found' });
                return;
            }

            const result = await inTx(async (tx) => {
                if (!await acquireAccountRead(tx, userId)) return null;
                const [session, machine] = await Promise.all([
                    tx.session.findFirst({ where: sessionWhere }),
                    tx.machine.findFirst({
                        where: {
                            id: machineId,
                            accountId: userId,
                            deletedAt: null,
                            account: { is: { deletionRequestedAt: null } },
                            ...(connection.credentialId ? { credentialId: connection.credentialId } : {}),
                        },
                    }),
                ]);
                if (!session || !machine) return null;
                const accessKey = await tx.accessKey.findUnique({
                    where: { accountId_machineId_sessionId: { accountId: userId, machineId, sessionId } },
                });
                return { session, accessKey };
            });

            if (!result) {
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Session or machine not found'
                    });
                }
                return;
            }

            if (callback) {
                if (result.accessKey) {
                    callback({
                        ok: true,
                        accessKey: {
                            data: result.accessKey.data,
                            dataVersion: result.accessKey.dataVersion,
                            createdAt: result.accessKey.createdAt.getTime(),
                            updatedAt: result.accessKey.updatedAt.getTime()
                        }
                    });
                } else {
                    callback({
                        ok: true,
                        accessKey: null
                    });
                }
            }

            log({
                module: 'websocket-access-key',
                sessionHash: diagnosticHash(sessionId),
                machineHash: diagnosticHash(machineId),
            }, 'Access key retrieved');
        } catch {
            log({ module: 'websocket', level: 'error' }, 'Access key request failed');
            if (callback) {
                callback({
                    ok: false,
                    error: 'Internal error'
                });
            }
        }
    });
}
