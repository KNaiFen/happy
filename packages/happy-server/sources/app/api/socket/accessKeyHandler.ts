import { Socket } from "socket.io";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import type { ClientConnection } from "@/app/events/eventRouter";
import { sessionWhereForConnection } from "./sessionScope";
import { diagnosticHash } from "@/utils/diagnosticHash";

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

            // Verify session and machine belong to user
            const [session, machine] = await Promise.all([
                db.session.findFirst({
                    where: sessionWhere,
                }),
                db.machine.findFirst({
                    where: {
                        id: machineId,
                        accountId: userId,
                        deletedAt: null,
                        ...(connection.credentialId
                            ? { credentialId: connection.credentialId }
                            : {}),
                    }
                })
            ]);

            if (!session || !machine) {
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Session or machine not found'
                    });
                }
                return;
            }

            // Get access key
            const accessKey = await db.accessKey.findUnique({
                where: {
                    accountId_machineId_sessionId: {
                        accountId: userId,
                        machineId,
                        sessionId
                    }
                }
            });

            if (callback) {
                if (accessKey) {
                    callback({
                        ok: true,
                        accessKey: {
                            data: accessKey.data,
                            dataVersion: accessKey.dataVersion,
                            createdAt: accessKey.createdAt.getTime(),
                            updatedAt: accessKey.updatedAt.getTime()
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
