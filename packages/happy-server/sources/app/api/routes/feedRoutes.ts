import { z } from "zod";
import { Fastify } from "../types";
import { FeedBodySchema } from "@/app/feed/types";
import { feedGet } from "@/app/feed/feedGet";
import { Context } from "@/context";
import { inTx } from "@/storage/inTx";
import { acquireAccountRead } from "@/app/account/accountWriteGate";

export function feedRoutes(app: Fastify) {
    app.get('/v1/feed', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                before: z.string().optional(),
                after: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50)
            }).optional(),
            response: {
                200: z.object({
                    items: z.array(z.object({
                        id: z.string(),
                        body: FeedBodySchema,
                        repeatKey: z.string().nullable(),
                        cursor: z.string(),
                        createdAt: z.number()
                    })),
                    hasMore: z.boolean()
                }),
                409: z.object({
                    error: z.literal('Account deletion in progress')
                })
            }
        }
    }, async (request, reply) => {
        const result = await inTx(async (tx) => {
            if (!await acquireAccountRead(tx, request.userId)) return { kind: 'deleting' as const };
            const items = await feedGet(tx, Context.create(request.userId), {
                cursor: {
                    before: request.query?.before,
                    after: request.query?.after
                },
                limit: request.query?.limit
            });
            return { kind: 'ok' as const, items };
        });
        if (result.kind === 'deleting') {
            return reply.code(409).send({ error: 'Account deletion in progress' });
        }
        return reply.send({ items: result.items.items, hasMore: result.items.hasMore });
    });
}
