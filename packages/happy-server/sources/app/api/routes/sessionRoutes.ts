import { eventRouter, buildNewSessionUpdate, buildSessionActivityEphemeral } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { log } from "@/utils/log";
import { diagnosticHash } from "@/utils/diagnosticHash";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { isSupportedSessionTag } from "@/app/session/supportedSessionTags";
import { allocateUserSeq } from "@/storage/seq";
import { sessionDelete } from "@/app/session/sessionDelete";
import { inTx } from "@/storage/inTx";
import { activityCache } from "@/app/presence/sessionCache";
import {
    buildSessionAccessWhere,
    sessionAccessIdentityFromRequest,
} from "@/app/api/utils/sessionAccess";

function sessionResponse(session: {
    id: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    active: boolean;
    archivedAt: Date | null;
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
    originMachineId: string | null;
    originMachine: { deletedAt: Date | null } | null;
}) {
    return {
        id: session.id,
        seq: session.seq,
        createdAt: session.createdAt.getTime(),
        updatedAt: session.updatedAt.getTime(),
        active: session.active,
        activeAt: session.lastActiveAt.getTime(),
        archivedAt: session.archivedAt?.getTime() ?? null,
        metadata: session.metadata,
        metadataVersion: session.metadataVersion,
        agentState: session.agentState,
        agentStateVersion: session.agentStateVersion,
        dataEncryptionKey: session.dataEncryptionKey
            ? Buffer.from(session.dataEncryptionKey).toString('base64')
            : null,
        originMachineId: session.originMachineId,
        machineDeletedAt: session.originMachine?.deletedAt?.getTime() ?? null,
        lastMessage: null,
    };
}

function nextPresenceTimestamp(lastActiveAt: Date, archivedAt?: Date | null): Date {
    return new Date(Math.max(
        Date.now(),
        lastActiveAt.getTime() + 1,
        (archivedAt?.getTime() ?? 0) + 1,
    ));
}

function emitSessionActivity(
    userId: string,
    sessionId: string,
    active: boolean,
    activeAt: Date,
    archivedAt: Date | null,
): void {
    eventRouter.emitEphemeral({
        userId,
        payload: buildSessionActivityEphemeral(
            sessionId,
            active,
            activeAt.getTime(),
            false,
            archivedAt?.getTime() ?? null,
        ),
        recipientFilter: { type: 'user-scoped-only' },
    });
}

export function sessionRoutes(app: Fastify) {

    // Sessions API
    app.get('/v1/sessions', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const accessWhere = buildSessionAccessWhere(
            sessionAccessIdentityFromRequest(request),
        );
        if (!accessWhere) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }

        const sessions = await db.session.findMany({
            where: accessWhere,
            orderBy: { updatedAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                archivedAt: true,
                lastActiveAt: true,
                originMachineId: true,
                originMachine: { select: { deletedAt: true } },
                // messages: {
                //     orderBy: { seq: 'desc' },
                //     take: 1,
                //     select: {
                //         id: true,
                //         seq: true,
                //         content: true,
                //         localId: true,
                //         createdAt: true
                //     }
                // }
            }
        });

        return reply.send({
            sessions: sessions.map(sessionResponse)
        });
    });

    // V2 Sessions API - Active sessions only
    app.get('/v2/sessions/active', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).default(150)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const limit = request.query?.limit || 150;
        const accessWhere = buildSessionAccessWhere(
            sessionAccessIdentityFromRequest(request),
            {
                active: true,
                lastActiveAt: { gt: new Date(Date.now() - 1000 * 60 * 15) },
            },
        );
        if (!accessWhere) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }

        const sessions = await db.session.findMany({
            where: accessWhere,
            orderBy: { lastActiveAt: 'desc' },
            take: limit,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                archivedAt: true,
                lastActiveAt: true,
                originMachineId: true,
                originMachine: { select: { deletedAt: true } },
            }
        });

        return reply.send({
            sessions: sessions.map(sessionResponse)
        });
    });

    // V2 Sessions API - Cursor-based pagination with change tracking
    app.get('/v2/sessions', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50),
                changedSince: z.coerce.number().int().positive().optional(),
                originMachineId: z.string().min(1).max(200).optional(),
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 50, changedSince, originMachineId } = request.query || {};

        // Decode cursor - simple ID-based cursor
        let cursorSessionId: string | undefined;
        if (cursor) {
            if (cursor.startsWith('cursor_v1_')) {
                cursorSessionId = cursor.substring(10);
            } else {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
        }

        // Build where clause
        const accessIdentity = sessionAccessIdentityFromRequest(request);
        if (
            accessIdentity.credentialId
            && originMachineId
            && originMachineId !== accessIdentity.machineId
        ) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }
        const accessWhere = buildSessionAccessWhere(accessIdentity, {
            ...(originMachineId ? { originMachineId } : {}),
        });
        if (!accessWhere) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }
        const where: Prisma.SessionWhereInput = accessWhere;

        // Add changedSince filter (just a filter, doesn't affect pagination)
        if (changedSince) {
            where.updatedAt = {
                gt: new Date(changedSince)
            };
        }

        // Add cursor pagination - always by ID descending (most recent first)
        if (cursorSessionId) {
            where.id = {
                lt: cursorSessionId  // Get sessions with ID less than cursor (for desc order)
            };
        }

        // Always sort by ID descending for consistent pagination
        const orderBy = { id: 'desc' as const };

        const sessions = await db.session.findMany({
            where,
            orderBy,
            take: limit + 1, // Fetch one extra to determine if there are more
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                archivedAt: true,
                lastActiveAt: true,
                originMachineId: true,
                originMachine: { select: { deletedAt: true } },
            }
        });

        // Check if there are more results
        const hasNext = sessions.length > limit;
        const resultSessions = hasNext ? sessions.slice(0, limit) : sessions;

        // Generate next cursor - simple ID-based cursor
        let nextCursor: string | null = null;
        if (hasNext && resultSessions.length > 0) {
            const lastSession = resultSessions[resultSessions.length - 1];
            nextCursor = `cursor_v1_${lastSession.id}`;
        }

        return reply.send({
            sessions: resultSessions.map(sessionResponse),
            nextCursor,
            hasNext
        });
    });

    // Create or load session by tag
    app.post('/v1/sessions', {
        schema: {
            body: z.object({
                tag: z.string().refine(isSupportedSessionTag, {
                    message: 'Only Codex Sync v4 session tags are supported',
                }),
                metadata: z.string(),
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish(),
                machineId: z.string().min(1).max(200).optional(),
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { tag, metadata, agentState, dataEncryptionKey, machineId } = request.body;
        const credentialId = request.authCredentialId;

        if (credentialId && !machineId) {
            return reply.code(400).send({ error: 'machineId is required for terminal sessions' });
        }
        if (credentialId && request.authMachineId !== machineId) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }

        const result = await inTx(async (tx) => {
            if (credentialId) {
                const machine = await tx.machine.findFirst({
                    where: {
                        id: machineId,
                        accountId: userId,
                        credentialId,
                        deletedAt: null,
                    },
                    select: { id: true },
                });
                if (!machine) return { kind: 'machine-not-authorized' as const };
            }

            let session = await tx.session.findFirst({
                where: {
                    accountId: userId,
                    tag,
                },
                include: {
                    originMachine: { select: { deletedAt: true } },
                },
            });
            if (!session) {
                session = await tx.session.create({
                    data: {
                        accountId: userId,
                        tag,
                        metadata,
                        agentState: agentState ?? null,
                        agentStateVersion: agentState ? 1 : 0,
                        originMachineId: credentialId ? machineId : null,
                        dataEncryptionKey: dataEncryptionKey
                            ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64'))
                            : undefined,
                    },
                    include: {
                        originMachine: { select: { deletedAt: true } },
                    },
                });
                return { kind: 'created' as const, session };
            }
            if (
                credentialId
                && session.originMachineId
                && session.originMachineId !== machineId
            ) {
                return { kind: 'machine-conflict' as const };
            }
            if (credentialId && !session.originMachineId) {
                return { kind: 'machine-conflict' as const };
            }
            if (session.archivedAt) {
                return { kind: 'archived' as const };
            }
            return { kind: 'existing' as const, session };
        });

        if (result.kind === 'machine-not-authorized') {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }
        if (result.kind === 'machine-conflict') {
            return reply.code(409).send({ error: 'Session belongs to another machine' });
        }
        if (result.kind === 'archived') {
            return reply.code(409).send({ error: 'sessionArchived' });
        }
        if (result.kind === 'existing') {
            log({
                module: 'session-create',
                sessionHash: diagnosticHash(result.session.id),
                userHash: diagnosticHash(userId),
            }, 'Found existing session');
            return reply.send({ session: sessionResponse(result.session) });
        }

        const updSeq = await allocateUserSeq(userId);
        log({
            module: 'session-create',
            sessionHash: diagnosticHash(result.session.id),
            userHash: diagnosticHash(userId),
        }, 'Session created');
        const updatePayload = buildNewSessionUpdate(
            result.session,
            updSeq,
            randomKeyNaked(12),
        );
        eventRouter.emitUpdate({
            userId,
            payload: updatePayload,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({ session: sessionResponse(result.session) });
    });

    app.post('/v4/sessions/:sessionId/presence/claim', {
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({ leaseId: z.string().uuid() }),
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { leaseId } = request.body;
        if (!request.authCredentialId || !request.authMachineId) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }
        const accessWhere = buildSessionAccessWhere(
            sessionAccessIdentityFromRequest(request),
            { id: sessionId },
        );
        if (!accessWhere) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }

        const result = await inTx(async (tx) => {
            const session = await tx.session.findFirst({
                where: accessWhere,
                select: { archivedAt: true, active: true, lastActiveAt: true },
            });
            if (!session) return { kind: 'missing' as const };
            if (session.archivedAt) return { kind: 'archived' as const };

            const wasActive = session.active;
            const activeAt = nextPresenceTimestamp(session.lastActiveAt);
            const updated = await tx.session.updateMany({
                where: { ...accessWhere, archivedAt: null },
                data: { presenceLeaseId: leaseId, active: true, lastActiveAt: activeAt },
            });
            if (updated.count === 0) return { kind: 'archived' as const };
            return { kind: 'claimed' as const, activeAt, activated: !wasActive };
        });
        if (result.kind === 'missing') return reply.code(404).send({ error: 'Session not found' });
        if (result.kind === 'archived') return reply.code(409).send({ error: 'sessionArchived' });

        activityCache.invalidateSessions([sessionId]);
        if (result.activated) {
            emitSessionActivity(userId, sessionId, true, result.activeAt, null);
        }
        return reply.send({ success: true, leaseId, activeAt: result.activeAt.getTime() });
    });

    app.post('/v4/sessions/:sessionId/presence/touch', {
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({ leaseId: z.string().uuid() }),
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { leaseId } = request.body;
        if (!request.authCredentialId || !request.authMachineId) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }
        const accessWhere = buildSessionAccessWhere(
            sessionAccessIdentityFromRequest(request),
            { id: sessionId },
        );
        if (!accessWhere) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }

        const result = await inTx(async (tx) => {
            const session = await tx.session.findFirst({
                where: accessWhere,
                select: { archivedAt: true, presenceLeaseId: true, active: true, lastActiveAt: true },
            });
            if (!session) return { kind: 'missing' as const };
            if (session.archivedAt) return { kind: 'archived' as const };
            if (session.presenceLeaseId !== leaseId) return { kind: 'superseded' as const };

            const wasActive = session.active;
            const activeAt = nextPresenceTimestamp(session.lastActiveAt);
            const updated = await tx.session.updateMany({
                where: { ...accessWhere, archivedAt: null, presenceLeaseId: leaseId },
                data: { active: true, lastActiveAt: activeAt },
            });
            if (updated.count === 0) {
                const current = await tx.session.findFirst({
                    where: accessWhere,
                    select: { archivedAt: true },
                });
                return current?.archivedAt
                    ? { kind: 'archived' as const }
                    : { kind: 'superseded' as const };
            }
            return { kind: 'touched' as const, activeAt, activated: !wasActive };
        });
        if (result.kind === 'missing') return reply.code(404).send({ error: 'Session not found' });
        if (result.kind === 'archived') return reply.code(409).send({ error: 'sessionArchived' });
        if (result.kind === 'superseded') return reply.code(409).send({ error: 'presenceLeaseSuperseded' });

        activityCache.invalidateSessions([sessionId]);
        if (result.activated) {
            emitSessionActivity(userId, sessionId, true, result.activeAt, null);
        }
        return reply.send({ success: true, leaseId, activeAt: result.activeAt.getTime() });
    });

    app.post('/v4/sessions/:sessionId/presence/release', {
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({ leaseId: z.string().uuid() }),
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { leaseId } = request.body;
        if (!request.authCredentialId || !request.authMachineId) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }
        const accessWhere = buildSessionAccessWhere(
            sessionAccessIdentityFromRequest(request),
            { id: sessionId },
        );
        if (!accessWhere) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }

        const result = await inTx(async (tx) => {
            const session = await tx.session.findFirst({
                where: accessWhere,
                select: { archivedAt: true, presenceLeaseId: true, active: true, lastActiveAt: true },
            });
            if (!session) return { kind: 'missing' as const };
            if (session.archivedAt) return { kind: 'archived' as const };
            if (session.presenceLeaseId !== leaseId) return { kind: 'superseded' as const };

            const wasActive = session.active;
            const inactiveAt = nextPresenceTimestamp(session.lastActiveAt);
            const updated = await tx.session.updateMany({
                where: { ...accessWhere, archivedAt: null, presenceLeaseId: leaseId },
                data: { active: false, lastActiveAt: inactiveAt, presenceLeaseId: null },
            });
            if (updated.count === 0) {
                const current = await tx.session.findFirst({
                    where: accessWhere,
                    select: { archivedAt: true },
                });
                return current?.archivedAt
                    ? { kind: 'archived' as const }
                    : { kind: 'superseded' as const };
            }
            return { kind: 'released' as const, inactiveAt, deactivated: wasActive };
        });
        if (result.kind === 'missing') return reply.code(404).send({ error: 'Session not found' });
        if (result.kind === 'archived') return reply.code(409).send({ error: 'sessionArchived' });
        if (result.kind === 'superseded') return reply.code(409).send({ error: 'presenceLeaseSuperseded' });

        activityCache.invalidateSessions([sessionId]);
        if (result.deactivated) {
            emitSessionActivity(userId, sessionId, false, result.inactiveAt, null);
        }
        return reply.send({ success: true, leaseId, activeAt: result.inactiveAt.getTime() });
    });

    // Codex v4 archive is an authoritative, persistent lifecycle tombstone.
    app.post('/v4/sessions/:sessionId/archive', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const accessWhere = buildSessionAccessWhere(
            sessionAccessIdentityFromRequest(request),
            { id: sessionId },
        );
        if (!accessWhere) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }
        const result = await inTx(async (tx) => {
            const session = await tx.session.findFirst({
                where: accessWhere,
                select: { archivedAt: true },
            });
            if (!session) return null;
            if (session.archivedAt) {
                return { archivedAt: session.archivedAt, alreadyArchived: true };
            }
            const archivedAt = new Date();
            const updated = await tx.session.updateMany({
                where: { ...accessWhere, archivedAt: null },
                data: {
                    archivedAt,
                    active: false,
                    lastActiveAt: archivedAt,
                    presenceLeaseId: null,
                },
            });
            if (updated.count === 0) {
                throw new Error('Session archive transaction lost ownership');
            }
            return { archivedAt, alreadyArchived: false };
        });

        if (!result) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        activityCache.invalidateSessions([sessionId]);

        emitSessionActivity(userId, sessionId, false, result.archivedAt, result.archivedAt);

        return reply.send({
            success: true,
            archivedAt: result.archivedAt.getTime(),
            alreadyArchived: result.alreadyArchived,
        });
    });

    app.post('/v4/sessions/:sessionId/unarchive', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        if (!request.authCredentialId || !request.authMachineId) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }

        const accessWhere = buildSessionAccessWhere(
            sessionAccessIdentityFromRequest(request),
            { id: sessionId },
        );
        if (!accessWhere) {
            return reply.code(403).send({ error: 'Machine is not authorized' });
        }

        const result = await inTx(async (tx) => {
            const session = await tx.session.findFirst({
                where: accessWhere,
                select: { archivedAt: true, active: true, lastActiveAt: true },
            });
            if (!session) return null;
            const alreadyUnarchived = session.archivedAt === null;
            if (alreadyUnarchived) {
                return { alreadyUnarchived, activeAt: session.lastActiveAt, active: session.active };
            }
            const activeAt = nextPresenceTimestamp(session.lastActiveAt, session.archivedAt);
            const updated = await tx.session.updateMany({
                where: { ...accessWhere, archivedAt: session.archivedAt },
                data: {
                    archivedAt: null,
                    active: false,
                    lastActiveAt: activeAt,
                    presenceLeaseId: null,
                },
            });
            if (updated.count === 0) {
                throw new Error('Session unarchive transaction lost ownership');
            }
            return { alreadyUnarchived, activeAt, active: false };
        });
        if (!result) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        activityCache.invalidateSessions([sessionId]);
        if (!result.alreadyUnarchived) {
            emitSessionActivity(userId, sessionId, false, result.activeAt, null);
        }

        return reply.send({
            success: true,
            activeAt: result.activeAt.getTime(),
            active: result.active,
            alreadyUnarchived: result.alreadyUnarchived,
        });
    });

    // Delete session
    app.delete('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const deleted = await sessionDelete(
            { uid: userId },
            sessionId,
            sessionAccessIdentityFromRequest(request),
        );

        if (!deleted) {
            return reply.code(404).send({ error: 'Session not found or not owned by user' });
        }

        return reply.send({ success: true });
    });
}
