import { eventRouter, buildUpdateAccountUpdate } from "@/app/events/eventRouter";
import { Fastify } from "../types";
import { getPublicUrl } from "@/storage/files";
import { z } from "zod";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import { AccountProfile } from "@/types";
import { afterTx, inTx } from "@/storage/inTx";
import { acquireAccountRead, acquireAccountWrite } from "@/app/account/accountWriteGate";
import {
    AccountDeletionError,
    confirmAccountDeletion,
    createAccountDeletionChallenge,
} from "@/app/account/accountDeletion";

export function accountRoutes(app: Fastify) {
    app.post('/v1/account/deletion-challenge', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        if (request.authCredentialId) {
            return reply.code(403).send({ error: 'Account credential required' });
        }
        try {
            return reply.send(await createAccountDeletionChallenge(request.userId));
        } catch (error) {
            if (error instanceof AccountDeletionError) {
                if (error.code === 'legacy-upload-capability-cutoff-unconfirmed') {
                    return reply.code(503).send({ error: 'Account deletion is temporarily unavailable while legacy uploads drain' });
                }
                return reply.code(409).send({ error: 'Account deletion in progress' });
            }
            return reply.code(500).send({ error: 'Failed to create account deletion challenge' });
        }
    });

    app.delete('/v1/account', {
        bodyLimit: 2 * 1024,
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                challengeId: z.string().min(1).max(128),
                challenge: z.string().min(1).max(128),
                publicKey: z.string().min(1).max(128),
                signature: z.string().min(1).max(256),
            }),
        },
    }, async (request, reply) => {
        if (request.authCredentialId) {
            return reply.code(403).send({ error: 'Account credential required' });
        }
        try {
            const status = await confirmAccountDeletion({
                accountId: request.userId,
                ...request.body,
            });
            return reply.code(status === 'deleted' ? 200 : 202).send({ status });
        } catch (error) {
            if (error instanceof AccountDeletionError) {
                if (error.code === 'invalid-proof') {
                    return reply.code(401).send({ error: 'Invalid account deletion proof' });
                }
                if (error.code === 'legacy-upload-capability-cutoff-unconfirmed') {
                    return reply.code(503).send({ error: 'Account deletion is temporarily unavailable while legacy uploads drain' });
                }
                return reply.code(409).send({ error: 'Account deletion confirmation expired' });
            }
            return reply.code(500).send({ error: 'Failed to delete account' });
        }
    });

    app.get('/v1/account/profile', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const result = await inTx(async (tx) => {
            if (!await acquireAccountRead(tx, userId)) return { kind: 'deleting' as const };
            const user = await tx.account.findUnique({
                where: { id: userId },
                select: {
                    firstName: true,
                    lastName: true,
                    username: true,
                    avatar: true,
                    githubUser: true
                }
            });
            if (!user) return { kind: 'missing' as const };
            const connectedVendors = new Set((await tx.serviceAccountToken.findMany({
                where: {
                    accountId: userId,
                    vendor: 'openai',
                },
            })).map(t => t.vendor));
            return { kind: 'ok' as const, user, connectedVendors };
        });
        if (result.kind === 'deleting') {
            return reply.code(409).send({ error: 'Account deletion in progress' });
        }
        if (result.kind === 'missing') {
            return reply.code(404).send({ error: 'Account not found' });
        }
        const { user, connectedVendors } = result;
        return reply.send({
            id: userId,
            timestamp: Date.now(),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            avatar: user.avatar ? { ...user.avatar, url: getPublicUrl(user.avatar.path, request) } : null,
            github: user.githubUser ? user.githubUser.profile : null,
            connectedServices: Array.from(connectedVendors)
        });
    });

    // Get Account Settings API
    app.get('/v1/account/settings', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    settings: z.string().nullable(),
                    settingsVersion: z.number()
                }),
                500: z.object({
                    error: z.literal('Failed to get account settings')
                }),
                409: z.object({
                    error: z.literal('Account deletion in progress')
                })
            }
        }
    }, async (request, reply) => {
        try {
            const result = await inTx(async (tx) => {
                if (!await acquireAccountRead(tx, request.userId)) return { kind: 'deleting' as const };
                const user = await tx.account.findUnique({
                    where: { id: request.userId },
                    select: { settings: true, settingsVersion: true }
                });
                return user
                    ? { kind: 'ok' as const, user }
                    : { kind: 'missing' as const };
            });

            if (result.kind === 'deleting') {
                return reply.code(409).send({ error: 'Account deletion in progress' });
            }
            if (result.kind === 'missing') {
                return reply.code(500).send({ error: 'Failed to get account settings' });
            }

            return reply.send({
                settings: result.user.settings,
                settingsVersion: result.user.settingsVersion
            });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to get account settings' });
        }
    });

    // Update Account Settings API
    app.post('/v1/account/settings', {
        schema: {
            body: z.object({
                settings: z.string().nullable(),
                expectedVersion: z.number().int().min(0)
            }),
            response: {
                200: z.union([z.object({
                    success: z.literal(true),
                    version: z.number()
                }), z.object({
                    success: z.literal(false),
                    error: z.literal('version-mismatch'),
                    currentVersion: z.number(),
                    currentSettings: z.string().nullable()
                })]),
                500: z.object({
                    success: z.literal(false),
                    error: z.literal('Failed to update account settings')
                }),
                409: z.object({
                    success: z.literal(false),
                    error: z.literal('Failed to update account settings')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { settings, expectedVersion } = request.body;

        try {
            // Read and update in one serializable transaction. The account
            // write gate makes a deletion marker win over a request that has
            // only passed authentication but has not committed its mutation.
            const result = await inTx(async (tx) => {
                if (!await acquireAccountWrite(tx, userId)) {
                    return { kind: 'deleting' as const };
                }
                const currentUser = await tx.account.findUnique({
                    where: { id: userId },
                    select: { settings: true, settingsVersion: true }
                });

                if (!currentUser) return { kind: 'missing' as const };

                if (currentUser.settingsVersion !== expectedVersion) {
                    return {
                        kind: 'version-mismatch' as const,
                        currentVersion: currentUser.settingsVersion,
                        currentSettings: currentUser.settings,
                    };
                }

                const updated = await tx.account.updateMany({
                    where: {
                        id: userId,
                        settingsVersion: expectedVersion,
                        deletionRequestedAt: null,
                    },
                    data: {
                        settings,
                        settingsVersion: expectedVersion + 1,
                        updatedAt: new Date()
                    }
                });
                if (updated.count !== 1) return { kind: 'deleting' as const };
                const version = expectedVersion + 1;
                const updSeq = await allocateUserSeq(userId, tx);
                const updatePayload = buildUpdateAccountUpdate(
                    userId,
                    { settings: { value: settings, version } },
                    updSeq,
                    randomKeyNaked(12),
                );
                afterTx(tx, () => eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'user-scoped-only' },
                }));
                return { kind: 'updated' as const, version };
            });

            if (result.kind === 'deleting') {
                return reply.code(409).send({
                    success: false,
                    error: 'Failed to update account settings'
                });
            }
            if (result.kind === 'missing') {
                return reply.code(500).send({
                    success: false,
                    error: 'Failed to update account settings'
                });
            }
            if (result.kind === 'version-mismatch') {
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: result.currentVersion,
                    currentSettings: result.currentSettings,
                });
            }

            return reply.send({
                success: true,
                version: result.version
            });
        } catch {
            log({ module: 'api', level: 'error', operation: 'account.settings.update' }, 'account.settings.update.failed');
            return reply.code(500).send({
                success: false,
                error: 'Failed to update account settings'
            });
        }
    });

    app.post('/v1/usage/query', {
        schema: {
            body: z.object({
                sessionId: z.string().nullish(),
                startTime: z.number().int().positive().nullish(),
                endTime: z.number().int().positive().nullish(),
                groupBy: z.enum(['hour', 'day']).nullish()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, startTime, endTime, groupBy } = request.body;
        const actualGroupBy = groupBy || 'day';

        try {
            const readResult = await inTx(async (tx) => {
                if (!await acquireAccountRead(tx, userId)) return { kind: 'deleting' as const };

                const where: {
                    accountId: string;
                    sessionId?: string | null;
                    createdAt?: {
                        gte?: Date;
                        lte?: Date;
                    };
                } = { accountId: userId };

                if (sessionId) {
                    const session = await tx.session.findFirst({
                        where: { id: sessionId, accountId: userId },
                    });
                    if (!session) return { kind: 'session-missing' as const };
                    where.sessionId = sessionId;
                }

                if (startTime || endTime) {
                    where.createdAt = {};
                    if (startTime) where.createdAt.gte = new Date(startTime * 1000);
                    if (endTime) where.createdAt.lte = new Date(endTime * 1000);
                }

                const reports = await tx.usageReport.findMany({
                    where,
                    orderBy: { createdAt: 'desc' },
                });
                return { kind: 'ok' as const, reports };
            });
            if (readResult.kind === 'deleting') {
                return reply.code(409).send({ error: 'Account deletion in progress' });
            }
            if (readResult.kind === 'session-missing') {
                return reply.code(404).send({ error: 'Session not found' });
            }
            const reports = readResult.reports;

            // Aggregate data by time period
            const aggregated = new Map<string, {
                tokens: Record<string, number>;
                cost: Record<string, number>;
                count: number;
                timestamp: number;
            }>();

            for (const report of reports) {
                const data = report.data as PrismaJson.UsageReportData;
                const date = new Date(report.createdAt);

                // Calculate timestamp based on groupBy
                let timestamp: number;
                if (actualGroupBy === 'hour') {
                    // Round down to hour
                    const hourDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0);
                    timestamp = Math.floor(hourDate.getTime() / 1000);
                } else {
                    // Round down to day
                    const dayDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
                    timestamp = Math.floor(dayDate.getTime() / 1000);
                }

                const key = timestamp.toString();

                if (!aggregated.has(key)) {
                    aggregated.set(key, {
                        tokens: {},
                        cost: {},
                        count: 0,
                        timestamp
                    });
                }

                const agg = aggregated.get(key)!;
                agg.count++;

                // Aggregate tokens
                for (const [tokenKey, tokenValue] of Object.entries(data.tokens)) {
                    if (typeof tokenValue === 'number') {
                        agg.tokens[tokenKey] = (agg.tokens[tokenKey] || 0) + tokenValue;
                    }
                }

                // Aggregate costs
                for (const [costKey, costValue] of Object.entries(data.cost)) {
                    if (typeof costValue === 'number') {
                        agg.cost[costKey] = (agg.cost[costKey] || 0) + costValue;
                    }
                }
            }

            // Convert to array and sort by timestamp
            const result = Array.from(aggregated.values())
                .map(data => ({
                    timestamp: data.timestamp,
                    tokens: data.tokens,
                    cost: data.cost,
                    reportCount: data.count
                }))
                .sort((a, b) => a.timestamp - b.timestamp);

            return reply.send({
                usage: result,
                groupBy: actualGroupBy,
                totalReports: reports.length
            });
        } catch {
            log({ module: 'api', level: 'error', operation: 'account.usage.query' }, 'account.usage.query.failed');
            return reply.code(500).send({ error: 'Failed to query usage reports' });
        }
    });
}
