import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import {
    buildSessionAccessWhere,
    sessionAccessIdentityFromRequest,
    type SessionAccessIdentity,
} from "@/app/api/utils/sessionAccess";
import { diagnosticHash } from "@/utils/diagnosticHash";
import { inTx, type Tx } from "@/storage/inTx";

async function canAccessSessionMachine(
    store: Pick<Tx, "session" | "machine">,
    identity: SessionAccessIdentity,
    sessionId: string,
    machineId: string,
): Promise<boolean> {
    if (identity.credentialId && identity.machineId !== machineId) return false;
    const sessionWhere = buildSessionAccessWhere(identity, { id: sessionId });
    if (!sessionWhere) return false;

    const [session, machine] = await Promise.all([
        store.session.findFirst({
            where: sessionWhere,
            select: { id: true },
        }),
        store.machine.findFirst({
            where: {
                id: machineId,
                accountId: identity.userId,
                deletedAt: null,
                ...(identity.credentialId
                    ? { credentialId: identity.credentialId }
                    : {}),
            },
            select: { id: true },
        }),
    ]);
    return Boolean(session && machine);
}

export function accessKeysRoutes(app: Fastify) {
    // Get Access Key API
    app.get('/v1/access-keys/:sessionId/:machineId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                machineId: z.string()
            }),
            response: {
                200: z.object({
                    accessKey: z.object({
                        data: z.string(),
                        dataVersion: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number()
                    }).nullable()
                }),
                404: z.object({
                    error: z.literal('Session or machine not found')
                }),
                500: z.object({
                    error: z.literal('Failed to get access key')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, machineId } = request.params;

        try {
            if (!await canAccessSessionMachine(
                db,
                sessionAccessIdentityFromRequest(request),
                sessionId,
                machineId,
            )) {
                return reply.code(404).send({ error: 'Session or machine not found' });
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

            if (!accessKey) {
                return reply.send({ accessKey: null });
            }

            return reply.send({
                accessKey: {
                    data: accessKey.data,
                    dataVersion: accessKey.dataVersion,
                    createdAt: accessKey.createdAt.getTime(),
                    updatedAt: accessKey.updatedAt.getTime()
                }
            });
        } catch {
            log({ module: 'access-keys', level: 'error' }, 'Failed to get access key');
            return reply.code(500).send({ error: 'Failed to get access key' });
        }
    });

    // Create Access Key API
    app.post('/v1/access-keys/:sessionId/:machineId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                machineId: z.string()
            }),
            body: z.object({
                data: z.string()
            }),
            response: {
                200: z.object({
                    success: z.boolean(),
                    accessKey: z.object({
                        data: z.string(),
                        dataVersion: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number()
                    }).optional(),
                    error: z.string().optional()
                }),
                404: z.object({
                    error: z.literal('Session or machine not found')
                }),
                409: z.object({
                    error: z.literal('Access key already exists')
                }),
                500: z.object({
                    error: z.literal('Failed to create access key')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, machineId } = request.params;
        const { data } = request.body;

        try {
            const result = await inTx(async (tx) => {
                if (!await canAccessSessionMachine(
                    tx,
                    sessionAccessIdentityFromRequest(request),
                    sessionId,
                    machineId,
                )) {
                    return { kind: 'not-found' as const };
                }

                const existing = await tx.accessKey.findUnique({
                    where: {
                        accountId_machineId_sessionId: {
                            accountId: userId,
                            machineId,
                            sessionId
                        }
                    }
                });

                if (existing) {
                    return { kind: 'exists' as const };
                }

                const accessKey = await tx.accessKey.create({
                    data: {
                        accountId: userId,
                        machineId,
                        sessionId,
                        data,
                        dataVersion: 1
                    }
                });
                return { kind: 'created' as const, accessKey };
            });

            if (result.kind === 'not-found') {
                return reply.code(404).send({ error: 'Session or machine not found' });
            }
            if (result.kind === 'exists') {
                return reply.code(409).send({ error: 'Access key already exists' });
            }
            const { accessKey } = result;

            log({
                module: 'access-keys',
                userHash: diagnosticHash(userId),
                sessionHash: diagnosticHash(sessionId),
                machineHash: diagnosticHash(machineId),
            }, 'Created new access key');

            return reply.send({
                success: true,
                accessKey: {
                    data: accessKey.data,
                    dataVersion: accessKey.dataVersion,
                    createdAt: accessKey.createdAt.getTime(),
                    updatedAt: accessKey.updatedAt.getTime()
                }
            });
        } catch {
            log({ module: 'access-keys', level: 'error' }, 'Failed to create access key');
            return reply.code(500).send({ error: 'Failed to create access key' });
        }
    });

    // Update Access Key API
    app.put('/v1/access-keys/:sessionId/:machineId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                machineId: z.string()
            }),
            body: z.object({
                data: z.string(),
                expectedVersion: z.number().int().min(0)
            }),
            response: {
                200: z.union([
                    z.object({
                        success: z.literal(true),
                        version: z.number()
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal('version-mismatch'),
                        currentVersion: z.number(),
                        currentData: z.string()
                    })
                ]),
                404: z.object({
                    error: z.literal('Access key not found')
                }),
                500: z.object({
                    success: z.literal(false),
                    error: z.literal('Failed to update access key')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, machineId } = request.params;
        const { data, expectedVersion } = request.body;

        try {
            const result = await inTx(async (tx) => {
                if (!await canAccessSessionMachine(
                    tx,
                    sessionAccessIdentityFromRequest(request),
                    sessionId,
                    machineId,
                )) {
                    return { kind: 'not-found' as const };
                }
                const currentAccessKey = await tx.accessKey.findUnique({
                    where: {
                        accountId_machineId_sessionId: {
                            accountId: userId,
                            machineId,
                            sessionId
                        }
                    }
                });
                if (!currentAccessKey) {
                    return { kind: 'not-found' as const };
                }

                if (currentAccessKey.dataVersion !== expectedVersion) {
                    return {
                        kind: 'version-mismatch' as const,
                        currentVersion: currentAccessKey.dataVersion,
                        currentData: currentAccessKey.data,
                    };
                }

                const { count } = await tx.accessKey.updateMany({
                    where: {
                        accountId: userId,
                        machineId,
                        sessionId,
                        dataVersion: expectedVersion
                    },
                    data: {
                        data,
                        dataVersion: expectedVersion + 1,
                        updatedAt: new Date()
                    }
                });

                if (count > 0) {
                    return {
                        kind: 'updated' as const,
                        version: expectedVersion + 1,
                    };
                }

                const accessKey = await tx.accessKey.findUnique({
                    where: {
                        accountId_machineId_sessionId: {
                            accountId: userId,
                            machineId,
                            sessionId
                        }
                    }
                });
                return {
                    kind: 'version-mismatch' as const,
                    currentVersion: accessKey?.dataVersion || 0,
                    currentData: accessKey?.data || '',
                };
            });

            if (result.kind === 'not-found') {
                return reply.code(404).send({ error: 'Access key not found' });
            }
            if (result.kind === 'version-mismatch') {
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: result.currentVersion,
                    currentData: result.currentData
                });
            }

            log({
                module: 'access-keys',
                userHash: diagnosticHash(userId),
                sessionHash: diagnosticHash(sessionId),
                machineHash: diagnosticHash(machineId),
                version: result.version,
            }, 'Updated access key');

            return reply.send({
                success: true,
                version: result.version
            });
        } catch {
            log({ module: 'access-keys', level: 'error' }, 'Failed to update access key');
            return reply.code(500).send({
                success: false,
                error: 'Failed to update access key'
            });
        }
    });
}
