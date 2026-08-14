import { z } from "zod";
import { Fastify } from "../types";
import { db } from "@/storage/db";
import { RelationshipStatus } from "@prisma/client";
import { friendAdd } from "@/app/social/friendAdd";
import { Context } from "@/context";
import { friendRemove } from "@/app/social/friendRemove";
import { friendList } from "@/app/social/friendList";
import { buildUserProfile } from "@/app/social/type";
import { inTx } from "@/storage/inTx";
import { acquireAccountRead } from "@/app/account/accountWriteGate";

export async function userRoutes(app: Fastify) {

    // Get user profile
    app.get('/v1/user/:id', {
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema
                }),
                404: z.object({
                    error: z.literal('User not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const { id } = request.params;

        // Fetch user
        const result = await inTx(async (tx) => {
            if (!await acquireAccountRead(tx, request.userId)) return null;
            const user = await tx.account.findFirst({
                where: { id, deletionRequestedAt: null },
                include: { githubUser: true },
            });
            if (!user) return null;
            const relationship = await tx.userRelationship.findFirst({
                where: { fromUserId: request.userId, toUserId: id },
            });
            return { user, status: relationship?.status || RelationshipStatus.none };
        });

        if (!result) {
            return reply.code(404).send({ error: 'User not found' });
        }

        // Build user profile
        return reply.send({
            user: buildUserProfile(result.user, result.status)
        });
    });

    // Search for users
    app.get('/v1/user/search', {
        schema: {
            querystring: z.object({
                query: z.string()
            }),
            response: {
                200: z.object({
                    users: z.array(UserProfileSchema)
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const { query } = request.query;

        // Search for users by username, first 10 matches
        const userProfiles = await inTx(async (tx) => {
            if (!await acquireAccountRead(tx, request.userId)) return [];
            const users = await tx.account.findMany({
                where: {
                    deletionRequestedAt: null,
                    username: { startsWith: query, mode: 'insensitive' },
                },
                include: { githubUser: true },
                take: 10,
                orderBy: { username: 'asc' },
            });
            return Promise.all(users.map(async (user) => {
                const relationship = await tx.userRelationship.findFirst({
                    where: { fromUserId: request.userId, toUserId: user.id },
                });
                return buildUserProfile(user, relationship?.status || RelationshipStatus.none);
            }));
        });

        return reply.send({
            users: userProfiles
        });
    });

    // Add friend
    app.post('/v1/friends/add', {
        schema: {
            body: z.object({
                uid: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema.nullable()
                }),
                404: z.object({
                    error: z.literal('User not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const user = await friendAdd(Context.create(request.userId), request.body.uid);
        return reply.send({ user });
    });

    app.post('/v1/friends/remove', {
        schema: {
            body: z.object({
                uid: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema.nullable()
                }),
                404: z.object({
                    error: z.literal('User not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const user = await friendRemove(Context.create(request.userId), request.body.uid);
        return reply.send({ user });
    });

    app.get('/v1/friends', {
        schema: {
            response: {
                200: z.object({
                    friends: z.array(UserProfileSchema)
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const friends = await inTx(async (tx) => {
            if (!await acquireAccountRead(tx, request.userId)) return [];
            return friendList(Context.create(request.userId), tx);
        });
        return reply.send({ friends });
    });
};

// Shared Zod Schemas
const RelationshipStatusSchema = z.enum(['none', 'requested', 'pending', 'friend', 'rejected']);
const UserProfileSchema = z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string().nullable(),
    avatar: z.object({
        path: z.string(),
        url: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
        thumbhash: z.string().optional()
    }).nullable(),
    username: z.string(),
    bio: z.string().nullable(),
    status: RelationshipStatusSchema
});
