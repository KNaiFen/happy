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
                data: { archivedAt, active: false, lastActiveAt: archivedAt },
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

        // Notify all clients about the session deactivation
        const sessionActivity = buildSessionActivityEphemeral(
            sessionId,
            false,
            result.archivedAt.getTime(),
            false,
        );
        eventRouter.emitEphemeral({
            userId,
            payload: sessionActivity,
            recipientFilter: { type: 'user-scoped-only' }
        });

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
                select: { archivedAt: true, lastActiveAt: true },
            });
            if (!session) return null;
            const alreadyUnarchived = session.archivedAt === null;
            const activeAt = new Date(Math.max(
                Date.now(),
                session.lastActiveAt.getTime() + 1,
                (session.archivedAt?.getTime() ?? 0) + 1,
            ));
            const updated = await tx.session.updateMany({
                where: accessWhere,
                data: { archivedAt: null, active: true, lastActiveAt: activeAt },
            });
            if (updated.count === 0) {
                throw new Error('Session unarchive transaction lost ownership');
            }
            return { alreadyUnarchived, activeAt };
        });
        if (!result) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        activityCache.invalidateSessions([sessionId]);
        const sessionActivity = buildSessionActivityEphemeral(sessionId, true, result.activeAt.getTime(), false);
        eventRouter.emitEphemeral({
            userId,
            payload: sessionActivity,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({
            success: true,
            activeAt: result.activeAt.getTime(),
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
