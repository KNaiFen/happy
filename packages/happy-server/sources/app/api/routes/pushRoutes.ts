import { z } from "zod";
import { type Fastify } from "../types";
import {
    buildSessionAccessWhere,
    sessionAccessIdentityFromRequest,
} from "@/app/api/utils/sessionAccess";
import { dispatchSessionEventPush } from "@/app/push/pushDispatch";
import { buildSessionEventEphemeral, eventRouter } from "@/app/events/eventRouter";
import { inTx } from "@/storage/inTx";
import { acquireAccountRead, acquireAccountWrite } from "@/app/account/accountWriteGate";

export function pushRoutes(app: Fastify) {
    
    // Push Token Registration API
    app.post('/v1/push-tokens', {
        schema: {
            body: z.object({
                token: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                409: z.object({
                    error: z.literal('Account deletion in progress')
                }),
                500: z.object({
                    error: z.literal('Failed to register push token')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { token } = request.body;

        try {
            const admitted = await inTx(async (tx) => {
                if (!await acquireAccountWrite(tx, userId)) return false;
                await tx.accountPushToken.upsert({
                    where: { accountId_token: { accountId: userId, token } },
                    update: { updatedAt: new Date() },
                    create: { accountId: userId, token }
                });
                return true;
            });
            if (!admitted) return reply.code(409).send({ error: 'Account deletion in progress' });

            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to register push token' });
        }
    });

    // Delete Push Token API
    app.delete('/v1/push-tokens/:token', {
        schema: {
            params: z.object({
                token: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                409: z.object({
                    error: z.literal('Account deletion in progress')
                }),
                500: z.object({
                    error: z.literal('Failed to delete push token')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { token } = request.params;

        try {
            const admitted = await inTx(async (tx) => {
                if (!await acquireAccountWrite(tx, userId)) return false;
                await tx.accountPushToken.deleteMany({ where: { accountId: userId, token } });
                return true;
            });
            if (!admitted) return reply.code(409).send({ error: 'Account deletion in progress' });

            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to delete push token' });
        }
    });

    // Session-Event Push API
    // CLI/daemon clients call this instead of talking to Expo directly so the
    // server can apply presence-based suppression (active desktop/web/mobile).
    app.post('/v1/sessions/:sessionId/push-event', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                kind: z.enum(['done', 'permission', 'question']),
                title: z.string().min(1).max(200),
                body: z.string().min(1).max(500),
                data: z.record(z.string(), z.unknown()).optional()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: z.literal('Session not found')
                }),
                409: z.object({
                    error: z.literal('Account deletion in progress')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { kind, title, body, data } = request.body;

        const accessWhere = buildSessionAccessWhere(
            sessionAccessIdentityFromRequest(request),
            { id: sessionId },
        );
        const result = await inTx(async (tx) => {
            if (!await acquireAccountRead(tx, userId)) return { kind: 'blocked' as const };
            const session = accessWhere && await tx.session.findFirst({
                where: accessWhere,
                select: { id: true },
            });
            if (!session) return { kind: 'missing' as const };
            return { kind: 'admitted' as const };
        });

        if (result.kind === 'blocked') {
            return reply.code(409).send({ error: 'Account deletion in progress' });
        }
        if (result.kind === 'missing') {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Fan out only after the read-admission transaction commits. The
        // dispatch path performs another admission check immediately before
        // reading tokens; already admitted Socket/Expo sends are best effort
        // because an external delivery cannot be rolled back atomically.
        eventRouter.emitEphemeral({
            userId,
            payload: buildSessionEventEphemeral(sessionId, kind, title, body),
            recipientFilter: { type: 'all-interested-in-session', sessionId },
        });

        void dispatchSessionEventPush({
            userId,
            sessionId,
            title,
            body,
            data: { ...(data ?? {}), kind },
        });

        return reply.send({ success: true });
    });

    // Get Push Tokens API
    app.get('/v1/push-tokens', {
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;

        try {
            const tokens = await inTx(async (tx) => {
                if (!await acquireAccountRead(tx, userId)) return null;
                return tx.accountPushToken.findMany({
                    where: {
                        accountId: userId,
                        account: { is: { deletionRequestedAt: null } },
                    },
                    orderBy: {
                        createdAt: 'desc'
                    }
                });
            });
            if (!tokens) return reply.code(409).send({ error: 'Account deletion in progress' });

            return reply.send({
                tokens: tokens.map(t => ({
                    id: t.id,
                    token: t.token,
                    createdAt: t.createdAt.getTime(),
                    updatedAt: t.updatedAt.getTime()
                }))
            });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to get push tokens' });
        }
    });
}
