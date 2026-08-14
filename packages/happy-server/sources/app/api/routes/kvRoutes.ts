import { z } from "zod";
import { Fastify } from "../types";
import { kvGet } from "@/app/kv/kvGet";
import { kvList } from "@/app/kv/kvList";
import { kvBulkGet } from "@/app/kv/kvBulkGet";
import { kvMutate } from "@/app/kv/kvMutate";
import { log } from "@/utils/log";
import { acquireAccountRead, AccountWriteBlockedError } from "@/app/account/accountWriteGate";
import { inTx } from "@/storage/inTx";

export function kvRoutes(app: Fastify) {
    // GET /v1/kv/:key - Get single value
    app.get('/v1/kv/:key', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                key: z.string()
            }),
            response: {
                200: z.object({
                    key: z.string(),
                    value: z.string(),
                    version: z.number()
                }).nullable(),
                404: z.object({
                    error: z.literal('Key not found')
                }),
                409: z.object({
                    error: z.literal('Account deletion in progress')
                }),
                500: z.object({
                    error: z.literal('Failed to get value')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { key } = request.params;

        try {
            const result = await inTx(async (tx) => {
                if (!await acquireAccountRead(tx, userId)) return { kind: 'deleting' as const };
                return { kind: 'ok' as const, value: await kvGet(tx, { uid: userId }, key) };
            });
            if (result.kind === 'deleting') {
                return reply.code(409).send({ error: 'Account deletion in progress' });
            }

            if (!result.value) {
                return reply.code(404).send({ error: 'Key not found' });
            }

            return reply.send(result.value);
        } catch {
            log({ module: 'api', level: 'error', operation: 'kv.get' }, 'kv.get.failed');
            return reply.code(500).send({ error: 'Failed to get value' });
        }
    });

    // GET /v1/kv - List key-value pairs with optional prefix filter
    app.get('/v1/kv', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                prefix: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(1000).default(100)
            }),
            response: {
                200: z.object({
                    items: z.array(z.object({
                        key: z.string(),
                        value: z.string(),
                        version: z.number()
                    }))
                }),
                409: z.object({
                    error: z.literal('Account deletion in progress')
                }),
                500: z.object({
                    error: z.literal('Failed to list items')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { prefix, limit } = request.query;

        try {
            const result = await inTx(async (tx) => {
                if (!await acquireAccountRead(tx, userId)) return { kind: 'deleting' as const };
                return { kind: 'ok' as const, value: await kvList(tx, { uid: userId }, { prefix, limit }) };
            });
            if (result.kind === 'deleting') {
                return reply.code(409).send({ error: 'Account deletion in progress' });
            }
            return reply.send(result.value);
        } catch {
            log({ module: 'api', level: 'error', operation: 'kv.list' }, 'kv.list.failed');
            return reply.code(500).send({ error: 'Failed to list items' });
        }
    });

    // POST /v1/kv/bulk - Bulk get values
    app.post('/v1/kv/bulk', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                keys: z.array(z.string()).min(1).max(100)
            }),
            response: {
                200: z.object({
                    values: z.array(z.object({
                        key: z.string(),
                        value: z.string(),
                        version: z.number()
                    }))
                }),
                409: z.object({
                    error: z.literal('Account deletion in progress')
                }),
                500: z.object({
                    error: z.literal('Failed to get values')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { keys } = request.body;

        try {
            const result = await inTx(async (tx) => {
                if (!await acquireAccountRead(tx, userId)) return { kind: 'deleting' as const };
                return { kind: 'ok' as const, value: await kvBulkGet(tx, { uid: userId }, keys) };
            });
            if (result.kind === 'deleting') {
                return reply.code(409).send({ error: 'Account deletion in progress' });
            }
            return reply.send(result.value);
        } catch {
            log({ module: 'api', level: 'error', operation: 'kv.bulk_get' }, 'kv.bulk_get.failed');
            return reply.code(500).send({ error: 'Failed to get values' });
        }
    });

    // PUT /v1/kv - Atomic batch mutation
    app.post('/v1/kv', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                mutations: z.array(z.object({
                    key: z.string(),
                    value: z.string().nullable(),
                    version: z.number()  // Always required, use -1 for new keys
                })).min(1).max(100)
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    results: z.array(z.object({
                        key: z.string(),
                        version: z.number()
                    }))
                }),
                409: z.union([
                    z.object({
                        success: z.literal(false),
                        errors: z.array(z.object({
                            key: z.string(),
                            error: z.literal('version-mismatch'),
                            version: z.number(),
                            value: z.string().nullable()
                        }))
                    }),
                    z.object({ error: z.literal('Account deletion in progress') }),
                ]),
                500: z.object({
                    error: z.literal('Failed to mutate values')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { mutations } = request.body;

        try {
            const result = await kvMutate({ uid: userId }, mutations);

            if (!result.success) {
                return reply.code(409).send({
                    success: false as const,
                    errors: result.errors!
                });
            }

            return reply.send({
                success: true as const,
                results: result.results!
            });
        } catch (error) {
            if (error instanceof AccountWriteBlockedError) {
                return reply.code(409).send({ error: 'Account deletion in progress' });
            }
            log({ module: 'api', level: 'error', operation: 'kv.mutate' }, 'kv.mutate.failed');
            return reply.code(500).send({ error: 'Failed to mutate values' });
        }
    });
}
