import { eventRouter } from "@/app/events/eventRouter";
import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { inTx, afterTx } from "@/storage/inTx";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { buildNewMachineUpdate, buildUpdateMachineUpdate, buildDeleteMachineUpdate } from "@/app/events/eventRouter";
import { auth } from "@/app/auth/auth";
import { activityCache } from "@/app/presence/sessionCache";
import { diagnosticHash } from "@/utils/diagnosticHash";
import { Prisma } from "@prisma/client";
import { acquireAccountRead, acquireAccountWrite } from "@/app/account/accountWriteGate";

function machineResponse(machine: {
    id: string;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    seq: number;
    active: boolean;
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
}) {
    return {
        id: machine.id,
        metadata: machine.metadata,
        metadataVersion: machine.metadataVersion,
        daemonState: machine.daemonState,
        daemonStateVersion: machine.daemonStateVersion,
        dataEncryptionKey: machine.dataEncryptionKey
            ? Buffer.from(machine.dataEncryptionKey).toString('base64')
            : null,
        seq: machine.seq,
        active: machine.active,
        activeAt: machine.lastActiveAt.getTime(),
        createdAt: machine.createdAt.getTime(),
        updatedAt: machine.updatedAt.getTime(),
    };
}

export function machinesRoutes(app: Fastify) {
    app.post('/v1/machines', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string(),
                metadata: z.string(), // Encrypted metadata
                daemonState: z.string().optional(), // Encrypted daemon state
                dataEncryptionKey: z.string().nullish()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, metadata, daemonState, dataEncryptionKey } = request.body;
        const credentialId = request.authCredentialId;
        if (!credentialId) {
            return reply.code(403).send({ error: 'Terminal credential required' });
        }

        let result;
        try {
            result = await inTx(async (tx) => {
                if (!await acquireAccountWrite(tx, userId)) {
                    return { kind: 'account-deleting' as const };
                }
                const credential = await tx.terminalAuthRequest.findFirst({
                    where: {
                        id: credentialId,
                        responseAccountId: userId,
                        response: { not: null },
                        revokedAt: null,
                    },
                    select: {
                        id: true,
                        credentialVersion: true,
                        machine: { select: { id: true } },
                    },
                });
                if (!credential) return { kind: 'credential-invalid' as const };
                if (credential.machine && credential.machine.id !== id) {
                    return { kind: 'credential-conflict' as const };
                }

                const existing = await tx.machine.findUnique({ where: { id } });
                if (existing) {
                    if (existing.accountId !== userId) {
                        return { kind: 'machine-conflict' as const };
                    }
                    if (existing.deletedAt) {
                        return { kind: 'machine-deleted' as const };
                    }
                    if (existing.credentialId && existing.credentialId !== credentialId) {
                        return { kind: 'credential-conflict' as const };
                    }
                    const machine = existing.credentialId
                        ? existing
                        : await tx.machine.update({
                            where: { id },
                            data: { credentialId },
                        });
                    return { kind: 'existing' as const, machine };
                }

                if (credential.credentialVersion < 2) {
                    return { kind: 'reauth-required' as const };
                }

                const machine = await tx.machine.create({
                    data: {
                        id,
                        accountId: userId,
                        credentialId,
                        metadata,
                        metadataVersion: 1,
                        daemonState: daemonState || null,
                        daemonStateVersion: daemonState ? 1 : 0,
                        dataEncryptionKey: dataEncryptionKey
                            ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64'))
                            : undefined,
                        active: false,
                    }
                });

                afterTx(tx, async () => {
                    const updSeq1 = await allocateUserSeq(userId);
                    if (updSeq1 === null) return;
                    const updSeq2 = await allocateUserSeq(userId);
                    if (updSeq2 === null) return;
                    const newMachinePayload = buildNewMachineUpdate(
                        machine,
                        updSeq1,
                        randomKeyNaked(12),
                    );
                    eventRouter.emitUpdate({
                        userId,
                        payload: newMachinePayload,
                        recipientFilter: { type: 'user-scoped-only' }
                    });

                    const machineMetadata = { version: 1, value: metadata };
                    const updatePayload = buildUpdateMachineUpdate(
                        machine.id,
                        updSeq2,
                        randomKeyNaked(12),
                        machineMetadata,
                    );
                    eventRouter.emitUpdate({
                        userId,
                        payload: updatePayload,
                        recipientFilter: { type: 'machine-scoped-only', machineId: machine.id }
                    });
                });
                return { kind: 'created' as const, machine };
            });
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError
                && error.code === 'P2002'
            ) {
                return reply.code(409).send({ error: 'Machine credential conflict' });
            }
            throw error;
        }

        if (result.kind === 'credential-invalid') {
            return reply.code(401).send({ error: 'Terminal credential revoked' });
        }
        if (result.kind === 'account-deleting') {
            return reply.code(409).send({ error: 'Account deletion in progress' });
        }
        if (result.kind === 'machine-deleted') {
            return reply.code(410).send({ error: 'Machine was deleted; re-authentication required' });
        }
        if (result.kind === 'reauth-required') {
            return reply.code(409).send({ error: 'Re-authentication required to register this machine' });
        }
        if (result.kind === 'machine-conflict' || result.kind === 'credential-conflict') {
            return reply.code(409).send({ error: 'Machine credential conflict' });
        }
        log({
            module: 'machines',
            machineHash: diagnosticHash(id),
            userHash: diagnosticHash(userId),
            created: result.kind === 'created',
        }, 'Machine registered');
        return reply.send({ machine: machineResponse(result.machine) });
    });


    // Machines API
    app.get('/v1/machines', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        if (request.authCredentialId && !request.authMachineId) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }

        const machines = await inTx(async (tx) => {
            if (!await acquireAccountRead(tx, userId)) return null;
            return tx.machine.findMany({
                where: {
                    accountId: userId,
                    deletedAt: null,
                    ...(request.authCredentialId ? {
                        id: request.authMachineId,
                        credentialId: request.authCredentialId,
                    } : {}),
                },
                orderBy: { lastActiveAt: 'desc' }
            });
        });
        if (!machines) return reply.code(409).send({ error: 'Account deletion in progress' });

        return machines.map(machineResponse);
    });

    // GET /v1/machines/:id - Get single machine by ID
    app.get('/v1/machines/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        if (
            request.authCredentialId
            && request.authMachineId !== id
        ) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        const result = await inTx(async (tx) => {
            if (!await acquireAccountRead(tx, userId)) return { kind: 'deleting' as const };
            const machine = await tx.machine.findFirst({
                where: {
                    accountId: userId,
                    id: id,
                    deletedAt: null,
                    ...(request.authCredentialId
                        ? { credentialId: request.authCredentialId }
                        : {}),
                }
            });
            return machine
                ? { kind: 'ok' as const, machine }
                : { kind: 'missing' as const };
        });

        if (result.kind === 'deleting') {
            return reply.code(409).send({ error: 'Account deletion in progress' });
        }
        if (result.kind === 'missing') {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        return {
            machine: machineResponse(result.machine)
        };
    });

    // DELETE /v1/machines/:id - Remove a machine and its access keys.
    // Sessions spawned by this machine are preserved so history is not lost.
    app.delete('/v1/machines/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        if (request.authCredentialId) {
            return reply.code(403).send({ error: 'Account credential required' });
        }

        const deleted = await inTx(async (tx) => {
            if (!await acquireAccountWrite(tx, userId)) return { kind: 'deleting' as const };
            const machine = await tx.machine.findFirst({
                where: { accountId: userId, id, account: { is: { deletionRequestedAt: null } } }
            });
            if (!machine) {
                return { kind: 'missing' as const };
            }
            if (machine.deletedAt) {
                return { kind: 'deleted' as const };
            }

            const accessKeys = await tx.accessKey.findMany({
                where: { accountId: userId, machineId: id },
                select: { sessionId: true },
            });
            const originSessions = await tx.session.findMany({
                where: { accountId: userId, originMachineId: id },
                select: { id: true },
            });
            const affectedSessionIds = [...new Set([
                ...accessKeys.map((key) => key.sessionId),
                ...originSessions.map((session) => session.id),
            ])];
            const inferredSessionIds = accessKeys.map((key) => key.sessionId);
            if (inferredSessionIds.length > 0) {
                await tx.session.updateMany({
                    where: {
                        accountId: userId,
                        id: { in: inferredSessionIds },
                        originMachineId: null,
                    },
                    data: { originMachineId: id },
                });
            }

            const deletedAt = new Date();
            await tx.session.updateMany({
                where: { accountId: userId, originMachineId: id },
                data: { active: false, lastActiveAt: deletedAt },
            });

            await tx.accessKey.deleteMany({
                where: { accountId: userId, machineId: id }
            });

            await tx.machine.update({
                where: { id },
                data: {
                    active: false,
                    deletedAt,
                },
            });
            if (machine.credentialId) {
                await tx.terminalAuthRequest.updateMany({
                    where: {
                        id: machine.credentialId,
                        responseAccountId: userId,
                        revokedAt: null,
                    },
                    data: { revokedAt: deletedAt },
                });
            }

            afterTx(tx, async () => {
                const updSeq = await allocateUserSeq(userId);
                if (updSeq === null) return;
                const updatePayload = buildDeleteMachineUpdate(id, updSeq, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'user-scoped-only' }
                });
                if (machine.credentialId) {
                    auth.invalidateCredentialTokens(machine.credentialId);
                    eventRouter.disconnectCredential(userId, machine.credentialId);
                }
                activityCache.invalidateMachine(id);
                activityCache.invalidateSessions(affectedSessionIds);
                eventRouter.disconnectMachine(userId, id);
                log({
                    module: 'machines',
                    machineHash: diagnosticHash(id),
                    userHash: diagnosticHash(userId),
                }, 'Machine deleted');
            });

            return { kind: 'deleted' as const };
        });

        if (deleted.kind === 'deleting') {
            return reply.code(409).send({ error: 'Account deletion in progress' });
        }
        if (deleted.kind === 'missing') {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        return reply.send({ success: true });
    });

}
