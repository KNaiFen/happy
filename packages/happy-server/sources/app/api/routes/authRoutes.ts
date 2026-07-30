import { z } from "zod";
import { type Fastify } from "../types";
import * as privacyKit from "privacy-kit";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { log } from "@/utils/log";

export function authRoutes(app: Fastify) {
    app.post('/v1/auth', {
        schema: {
            body: z.object({
                publicKey: z.string(),
                challenge: z.string(),
                signature: z.string()
            })
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const challenge = privacyKit.decodeBase64(request.body.challenge);
        const signature = privacyKit.decodeBase64(request.body.signature);
        const isValid = tweetnacl.sign.detached.verify(challenge, signature, publicKey);
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid signature' });
        }

        // Create or update user in database
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const user = await db.account.upsert({
            where: { publicKey: publicKeyHex },
            update: { updatedAt: new Date() },
            create: { publicKey: publicKeyHex }
        });

        return reply.send({
            success: true,
            token: await auth.createToken(user.id)
        });
    });

    app.post('/v1/auth/request', {
        schema: {
            body: z.object({
                publicKey: z.string(),
                supportsV2: z.boolean().nullish()
            }),
            response: {
                200: z.union([z.object({
                    state: z.literal('requested'),
                }), z.object({
                    state: z.literal('authorized'),
                    token: z.string(),
                    response: z.string()
                })]),
                401: z.object({
                    error: z.enum(['Invalid public key', 'Credential revoked'])
                })
            }
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);

        const answer = await db.terminalAuthRequest.upsert({
            where: { publicKey: publicKeyHex },
            update: { supportsV2: request.body.supportsV2 ?? false },
            create: {
                publicKey: publicKeyHex,
                supportsV2: request.body.supportsV2 ?? false,
                credentialVersion: 2,
            }
        });

        if (answer.revokedAt) {
            return reply.code(401).send({ error: 'Credential revoked' });
        }
        if (answer.response && answer.responseAccountId) {
            const token = await auth.createToken(answer.responseAccountId, {
                credentialId: answer.id,
                session: answer.id,
            });
            return reply.send({
                state: 'authorized',
                token: token,
                response: answer.response
            });
        }

        return reply.send({ state: 'requested' });
    });

    // Get auth request status
    app.get('/v1/auth/request/status', {
        schema: {
            querystring: z.object({
                publicKey: z.string(),
            }),
            response: {
                200: z.object({
                    status: z.enum(['not_found', 'pending', 'authorized']),
                    supportsV2: z.boolean()
                })
            }
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.query.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.send({ status: 'not_found', supportsV2: false });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });

        if (!authRequest) {
            return reply.send({ status: 'not_found', supportsV2: false });
        }

        if (authRequest.revokedAt) {
            return reply.send({ status: 'not_found', supportsV2: false });
        }
        if (authRequest.response && authRequest.responseAccountId) {
            return reply.send({ status: 'authorized', supportsV2: false });
        }

        return reply.send({ status: 'pending', supportsV2: authRequest.supportsV2 });
    });

    // Approve auth request
    app.post('/v1/auth/response', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                response: z.string(),
                publicKey: z.string()
            })
        }
    }, async (request, reply) => {
        if (request.authCredentialId) {
            return reply.code(403).send({ error: 'Account credential required' });
        }
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });
        if (!authRequest) {
            return reply.code(404).send({ error: 'Request not found' });
        }
        if (authRequest.revokedAt) {
            return reply.code(410).send({ error: 'Request revoked' });
        }
        if (
            authRequest.responseAccountId
            && authRequest.responseAccountId !== request.userId
        ) {
            return reply.code(409).send({ error: 'Request already approved' });
        }
        if (authRequest.response && authRequest.responseAccountId === request.userId) {
            return reply.send({ success: true });
        }
        const claimed = await db.terminalAuthRequest.updateMany({
            where: {
                id: authRequest.id,
                response: null,
                responseAccountId: null,
                revokedAt: null,
            },
            data: {
                response: request.body.response,
                responseAccountId: request.userId,
            },
        });
        if (claimed.count === 0) {
            const latest = await db.terminalAuthRequest.findUnique({
                where: { id: authRequest.id },
            });
            if (latest?.revokedAt) {
                return reply.code(410).send({ error: 'Request revoked' });
            }
            if (
                latest?.response
                && latest.responseAccountId === request.userId
            ) {
                return reply.send({ success: true });
            }
            return reply.code(409).send({ error: 'Request already approved' });
        }
        return reply.send({ success: true });
    });

    // Account auth request
    app.post('/v1/auth/account/request', {
        schema: {
            body: z.object({
                publicKey: z.string(),
            }),
            response: {
                200: z.union([z.object({
                    state: z.literal('requested'),
                }), z.object({
                    state: z.literal('authorized'),
                    token: z.string(),
                    response: z.string()
                })]),
                401: z.object({
                    error: z.literal('Invalid public key')
                })
            }
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const answer = await db.accountAuthRequest.upsert({
            where: { publicKey: privacyKit.encodeHex(publicKey) },
            update: {},
            create: { publicKey: privacyKit.encodeHex(publicKey) }
        });

        if (answer.response && answer.responseAccountId) {
            const token = await auth.createToken(answer.responseAccountId!);
            return reply.send({
                state: 'authorized',
                token: token,
                response: answer.response
            });
        }

        return reply.send({ state: 'requested' });
    });

    // Approve account auth request
    app.post('/v1/auth/account/response', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                response: z.string(),
                publicKey: z.string()
            })
        }
    }, async (request, reply) => {
        if (request.authCredentialId) {
            return reply.code(403).send({ error: 'Account credential required' });
        }
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        const authRequest = await db.accountAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(publicKey) }
        });
        if (!authRequest) {
            return reply.code(404).send({ error: 'Request not found' });
        }
        if (
            authRequest.responseAccountId
            && authRequest.responseAccountId !== request.userId
        ) {
            return reply.code(409).send({ error: 'Request already approved' });
        }
        if (authRequest.response && authRequest.responseAccountId === request.userId) {
            return reply.send({ success: true });
        }
        const claimed = await db.accountAuthRequest.updateMany({
            where: {
                id: authRequest.id,
                response: null,
                responseAccountId: null,
            },
            data: {
                response: request.body.response,
                responseAccountId: request.userId,
            },
        });
        if (claimed.count === 0) {
            const latest = await db.accountAuthRequest.findUnique({
                where: { id: authRequest.id },
            });
            if (
                latest?.response
                && latest.responseAccountId === request.userId
            ) {
                return reply.send({ success: true });
            }
            return reply.code(409).send({ error: 'Request already approved' });
        }
        return reply.send({ success: true });
    });

}
