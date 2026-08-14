import { z } from "zod";
import { type Fastify } from "../types";
import * as privacyKit from "privacy-kit";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { log } from "@/utils/log";
import { inTx } from "@/storage/inTx";
import { acquireAccountWrite } from "@/app/account/accountWriteGate";
import { acquireAccountRead } from "@/app/account/accountWriteGate";

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

        // A confirmed account deletion is irreversible. Do not let the ordinary
        // public-key login upsert issue a fresh token while cleanup is pending.
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const result = await inTx(async (tx) => {
            // Insert first with a duplicate-tolerant write. This avoids a
            // first-login find/create race when two devices authenticate at
            // the same time, while the subsequent row lock still gates a
            // deletion already in progress.
            await tx.account.createMany({
                data: { publicKey: publicKeyHex },
                skipDuplicates: true,
            });
            const existing = await tx.account.findUniqueOrThrow({
                where: { publicKey: publicKeyHex },
                select: { id: true },
            });
            if (!await acquireAccountWrite(tx, existing.id)) {
                return { kind: 'deleting' as const };
            }
            return {
                kind: 'active' as const,
                user: await tx.account.findUniqueOrThrow({ where: { id: existing.id } }),
            };
        });
        if (result.kind === 'deleting') {
            return reply.code(410).send({ error: 'Account deletion in progress' });
        }

        const token = await auth.createToken(result.user.id);
        if (!token) return reply.code(410).send({ error: 'Account deletion in progress' });
        return reply.send({
            success: true,
            token,
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
                }),
                410: z.object({
                    error: z.literal('Account deletion in progress'),
                }),
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

        const result = await inTx(async (tx) => {
            const existing = await tx.terminalAuthRequest.findUnique({
                where: { publicKey: publicKeyHex },
                select: { responseAccountId: true },
            });
            if (
                existing?.responseAccountId
                && !await acquireAccountWrite(tx, existing.responseAccountId)
            ) {
                return { kind: 'deleting' as const };
            }
            return {
                kind: 'answer' as const,
                answer: await tx.terminalAuthRequest.upsert({
                    where: { publicKey: publicKeyHex },
                    update: { supportsV2: request.body.supportsV2 ?? false },
                    create: {
                        publicKey: publicKeyHex,
                        supportsV2: request.body.supportsV2 ?? false,
                        credentialVersion: 2,
                    }
                }),
            };
        });
        if (result.kind === 'deleting') {
            return reply.code(410).send({ error: 'Account deletion in progress' });
        }
        const answer = result.answer;

        if (answer.revokedAt) {
            return reply.code(401).send({ error: 'Credential revoked' });
        }
        if (answer.response && answer.responseAccountId) {
            if (!(await auth.isAccountActive(answer.responseAccountId))) {
                return reply.code(410).send({ error: 'Account deletion in progress' });
            }
            const token = await auth.createToken(answer.responseAccountId, {
                credentialId: answer.id,
                session: answer.id,
            });
            if (!token) return reply.code(410).send({ error: 'Account deletion in progress' });
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
        const status = await inTx(async (tx) => {
            const authRequest = await tx.terminalAuthRequest.findUnique({
                where: { publicKey: publicKeyHex },
            });
            if (!authRequest || authRequest.revokedAt) {
                return { status: 'not_found' as const, supportsV2: false };
            }
            if (authRequest.response && authRequest.responseAccountId) {
                if (!await acquireAccountRead(tx, authRequest.responseAccountId)) {
                    return { status: 'not_found' as const, supportsV2: false };
                }
                return { status: 'authorized' as const, supportsV2: false };
            }
            return { status: 'pending' as const, supportsV2: authRequest.supportsV2 };
        });
        return reply.send(status);
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
        const result = await inTx(async (tx) => {
            if (!await acquireAccountWrite(tx, request.userId)) return { kind: 'deleting' as const };
            const authRequest = await tx.terminalAuthRequest.findUnique({ where: { publicKey: publicKeyHex } });
            if (!authRequest) return { kind: 'missing' as const };
            if (authRequest.revokedAt) return { kind: 'revoked' as const };
            if (authRequest.responseAccountId && authRequest.responseAccountId !== request.userId) {
                return { kind: 'claimed' as const };
            }
            if (authRequest.response && authRequest.responseAccountId === request.userId) {
                return { kind: 'success' as const };
            }
            const claimed = await tx.terminalAuthRequest.updateMany({
                where: { id: authRequest.id, response: null, responseAccountId: null, revokedAt: null },
                data: { response: request.body.response, responseAccountId: request.userId },
            });
            if (claimed.count === 1) return { kind: 'success' as const };
            const latest = await tx.terminalAuthRequest.findUnique({ where: { id: authRequest.id } });
            if (latest?.revokedAt) return { kind: 'revoked' as const };
            if (latest?.response && latest.responseAccountId === request.userId) return { kind: 'success' as const };
            return { kind: 'claimed' as const };
        });
        if (result.kind === 'deleting') return reply.code(410).send({ error: 'Account deletion in progress' });
        if (result.kind === 'missing') return reply.code(404).send({ error: 'Request not found' });
        if (result.kind === 'revoked') return reply.code(410).send({ error: 'Request revoked' });
        if (result.kind === 'claimed') return reply.code(409).send({ error: 'Request already approved' });
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
                }),
                410: z.object({
                    error: z.literal('Account deletion in progress'),
                }),
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
        const result = await inTx(async (tx) => {
            const existing = await tx.accountAuthRequest.findUnique({
                where: { publicKey: publicKeyHex },
                select: { responseAccountId: true },
            });
            if (
                existing?.responseAccountId
                && !await acquireAccountWrite(tx, existing.responseAccountId)
            ) {
                return { kind: 'deleting' as const };
            }
            return {
                kind: 'answer' as const,
                answer: await tx.accountAuthRequest.upsert({
                    where: { publicKey: publicKeyHex },
                    update: {},
                    create: { publicKey: publicKeyHex }
                }),
            };
        });
        if (result.kind === 'deleting') {
            return reply.code(410).send({ error: 'Account deletion in progress' });
        }
        const answer = result.answer;

        if (answer.response && answer.responseAccountId) {
            if (!(await auth.isAccountActive(answer.responseAccountId))) {
                return reply.code(410).send({ error: 'Account deletion in progress' });
            }
            const token = await auth.createToken(answer.responseAccountId!);
            if (!token) return reply.code(410).send({ error: 'Account deletion in progress' });
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
        const result = await inTx(async (tx) => {
            if (!await acquireAccountWrite(tx, request.userId)) return { kind: 'deleting' as const };
            const authRequest = await tx.accountAuthRequest.findUnique({
                where: { publicKey: privacyKit.encodeHex(publicKey) },
            });
            if (!authRequest) return { kind: 'missing' as const };
            if (authRequest.responseAccountId && authRequest.responseAccountId !== request.userId) return { kind: 'claimed' as const };
            if (authRequest.response && authRequest.responseAccountId === request.userId) return { kind: 'success' as const };
            const claimed = await tx.accountAuthRequest.updateMany({
                where: { id: authRequest.id, response: null, responseAccountId: null },
                data: { response: request.body.response, responseAccountId: request.userId },
            });
            if (claimed.count === 1) return { kind: 'success' as const };
            const latest = await tx.accountAuthRequest.findUnique({ where: { id: authRequest.id } });
            if (latest?.response && latest.responseAccountId === request.userId) return { kind: 'success' as const };
            return { kind: 'claimed' as const };
        });
        if (result.kind === 'deleting') return reply.code(410).send({ error: 'Account deletion in progress' });
        if (result.kind === 'missing') return reply.code(404).send({ error: 'Request not found' });
        if (result.kind === 'claimed') return reply.code(409).send({ error: 'Request already approved' });
        return reply.send({ success: true });
    });

}
