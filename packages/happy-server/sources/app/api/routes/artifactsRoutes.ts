import { eventRouter, buildUpdateArtifactUpdate, buildDeleteArtifactUpdate } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { afterTx, inTx } from "@/storage/inTx";
import { Fastify } from "../types";
import { z } from "zod";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateArtifactMutation } from "@/storage/seq";
import { log } from "@/utils/log";
import * as privacyKit from "privacy-kit";
import { acquireAccountRead, acquireAccountWrite } from "@/app/account/accountWriteGate";
import { diagnosticHash } from "@/utils/diagnosticHash";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createArtifactForAccount } from "@/app/artifacts/artifactCreate";

type ArtifactSnapshotCursor = {
    highWatermark: number;
    artifactRevision: number;
    lastId: string;
};

function artifactSnapshotCursorSignature(userId: string, payload: string): Buffer {
    return createHmac('sha256', process.env.HANDY_MASTER_SECRET!)
        .update('artifact-snapshot-cursor-v1\0')
        .update(userId)
        .update('\0')
        .update(payload)
        .digest();
}

export function artifactsRoutes(app: Fastify) {
    const artifactSnapshotCursor = z.object({
        highWatermark: z.number().int().nonnegative(),
        artifactRevision: z.number().int().nonnegative(),
        lastId: z.string().min(1).max(256),
    });

    function decodeArtifactSnapshotCursor(value: string | undefined, userId: string): ArtifactSnapshotCursor | null {
        if (!value) return null;
        try {
            const separator = value.indexOf('.');
            if (separator <= 0 || separator === value.length - 1) return null;
            const payload = value.slice(0, separator);
            const signature = Buffer.from(value.slice(separator + 1), 'base64url');
            const expected = artifactSnapshotCursorSignature(userId, payload);
            if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
            const decoded = artifactSnapshotCursor.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
            return decoded.success ? decoded.data : null;
        } catch {
            return null;
        }
    }

    function encodeArtifactSnapshotCursor(cursor: ArtifactSnapshotCursor, userId: string): string {
        const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
        return `${payload}.${artifactSnapshotCursorSignature(userId, payload).toString('base64url')}`;
    }

    // GET /v1/artifacts - List a complete, account-sequenced snapshot page.
    app.get('/v1/artifacts', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(100).default(100),
                cursor: z.string().max(4096).optional(),
            }),
            response: {
                200: z.object({
                    artifacts: z.array(z.object({
                        id: z.string(),
                        header: z.string(),
                        headerVersion: z.number(),
                        dataEncryptionKey: z.string(),
                        seq: z.number(),
                        updateSeq: z.number().int().nonnegative(),
                        createdAt: z.number(),
                        updatedAt: z.number()
                    })),
                    highWatermark: z.number().int().nonnegative(),
                    nextCursor: z.string().max(4096).nullable(),
                }),
                400: z.object({ error: z.literal('Invalid artifact snapshot cursor') }),
                500: z.object({ error: z.literal('Failed to get artifacts') }),
                409: z.union([
                    z.object({ error: z.literal('Account deletion in progress') }),
                    z.object({ error: z.literal('Artifact snapshot changed') }),
                ])
            }
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { limit, cursor: cursorValue } = request.query;
        const cursor = decodeArtifactSnapshotCursor(cursorValue, userId);
        if (cursorValue && !cursor) return reply.code(400).send({ error: 'Invalid artifact snapshot cursor' });

        try {
            const page = await inTx(async (tx) => {
                if (!await acquireAccountRead(tx, userId)) return null;
                const account = await tx.account.findUnique({
                    where: { id: userId },
                    select: { seq: true, artifactRevision: true },
                });
                if (!account) return null;
                const highWatermark = cursor?.highWatermark ?? account.seq;
                const artifactRevision = cursor?.artifactRevision ?? account.artifactRevision;
                if (cursor && account.artifactRevision !== artifactRevision) return { kind: 'snapshotChanged' as const };
                if (account.seq < highWatermark) return { kind: 'invalidCursor' as const };
                const artifacts = await tx.artifact.findMany({
                    where: {
                        accountId: userId,
                        updateSeq: { lte: highWatermark },
                        ...(cursor ? { id: { gt: cursor.lastId } } : {}),
                        account: { is: { deletionRequestedAt: null } },
                    },
                    orderBy: { id: 'asc' },
                    take: limit + 1,
                    select: {
                        id: true,
                        header: true,
                        headerVersion: true,
                        dataEncryptionKey: true,
                        seq: true,
                        updateSeq: true,
                        createdAt: true,
                        updatedAt: true
                    }
                });
                const hasNext = artifacts.length > limit;
                const rows = hasNext ? artifacts.slice(0, limit) : artifacts;
                return {
                    kind: 'page' as const,
                    highWatermark,
                    artifacts: rows,
                    nextCursor: hasNext
                        ? encodeArtifactSnapshotCursor({
                            highWatermark,
                            artifactRevision,
                            lastId: rows[rows.length - 1]!.id,
                        }, userId)
                        : null,
                };
            });

            if (!page) return reply.code(409).send({ error: 'Account deletion in progress' });
            if (page.kind === 'invalidCursor') return reply.code(400).send({ error: 'Invalid artifact snapshot cursor' });
            if (page.kind === 'snapshotChanged') return reply.code(409).send({ error: 'Artifact snapshot changed' });

            return reply.send({
                artifacts: page.artifacts.map(a => ({
                    id: a.id,
                    header: privacyKit.encodeBase64(a.header),
                    headerVersion: a.headerVersion,
                    dataEncryptionKey: privacyKit.encodeBase64(a.dataEncryptionKey),
                    seq: a.seq,
                    updateSeq: a.updateSeq,
                    createdAt: a.createdAt.getTime(),
                    updatedAt: a.updatedAt.getTime(),
                })),
                highWatermark: page.highWatermark,
                nextCursor: page.nextCursor,
            });
        } catch {
            log({ module: 'api', level: 'error', operation: 'artifact.list', userHash: diagnosticHash(userId) }, 'Artifact operation failed');
            return reply.code(500).send({ error: 'Failed to get artifacts' });
        }
    });

    // GET /v1/artifacts/:id - Get single artifact with full body
    app.get('/v1/artifacts/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    id: z.string(),
                    header: z.string(),
                    headerVersion: z.number(),
                    body: z.string(),
                    bodyVersion: z.number(),
                    dataEncryptionKey: z.string(),
                    seq: z.number(),
                    updateSeq: z.number().int().nonnegative(),
                    createdAt: z.number(),
                    updatedAt: z.number()
                }),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                500: z.object({
                    error: z.literal('Failed to get artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        try {
            const artifact = await inTx(async (tx) => {
                if (!await acquireAccountRead(tx, userId)) return null;
                return tx.artifact.findFirst({
                    where: {
                        id,
                        accountId: userId,
                        account: { is: { deletionRequestedAt: null } },
                    }
                });
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Artifact not found' });
            }

            return reply.send({
                id: artifact.id,
                header: privacyKit.encodeBase64(artifact.header),
                headerVersion: artifact.headerVersion,
                body: privacyKit.encodeBase64(artifact.body),
                bodyVersion: artifact.bodyVersion,
                dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
                seq: artifact.seq,
                updateSeq: artifact.updateSeq,
                createdAt: artifact.createdAt.getTime(),
                updatedAt: artifact.updatedAt.getTime()
            });
        } catch {
            log({ module: 'api', level: 'error', operation: 'artifact.get', userHash: diagnosticHash(userId), artifactHash: diagnosticHash(id) }, 'Artifact operation failed');
            return reply.code(500).send({ error: 'Failed to get artifact' });
        }
    });

    // POST /v1/artifacts - Create new artifact
    app.post('/v1/artifacts', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string().uuid(),
                header: z.string(),
                body: z.string(),
                dataEncryptionKey: z.string()
            }),
            response: {
                200: z.object({
                    id: z.string(),
                    header: z.string(),
                    headerVersion: z.number(),
                    body: z.string(),
                    bodyVersion: z.number(),
                    dataEncryptionKey: z.string(),
                    seq: z.number(),
                    updateSeq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number()
                }),
                409: z.object({
                    error: z.literal('Artifact with this ID already exists for another account')
                }),
                500: z.object({
                    error: z.literal('Failed to create artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, header, body, dataEncryptionKey } = request.body;

        try {
            const result = await createArtifactForAccount(userId, {
                id,
                header: privacyKit.decodeBase64(header),
                body: privacyKit.decodeBase64(body),
                dataEncryptionKey: privacyKit.decodeBase64(dataEncryptionKey),
            });

            if (result.kind === 'deleting') {
                return reply.code(500).send({ error: 'Failed to create artifact' });
            }
            if (result.kind === 'conflict') {
                return reply.code(409).send({ error: 'Artifact with this ID already exists for another account' });
            }
            log({ module: 'api', operation: 'artifact.create', artifactHash: diagnosticHash(id), userHash: diagnosticHash(userId), created: result.kind === 'created' }, 'Artifact create resolved');
            const artifact = result.artifact;

            return reply.send({
                id: artifact.id,
                header: privacyKit.encodeBase64(artifact.header),
                headerVersion: artifact.headerVersion,
                body: privacyKit.encodeBase64(artifact.body),
                bodyVersion: artifact.bodyVersion,
                dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
                seq: artifact.seq,
                updateSeq: result.updateSeq,
                createdAt: artifact.createdAt.getTime(),
                updatedAt: artifact.updatedAt.getTime()
            });
        } catch {
            log({ module: 'api', level: 'error', operation: 'artifact.create', userHash: diagnosticHash(userId), artifactHash: diagnosticHash(id) }, 'Artifact operation failed');
            return reply.code(500).send({ error: 'Failed to create artifact' });
        }
    });

    // POST /v1/artifacts/:id - Update artifact with version control
    app.post('/v1/artifacts/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: z.object({
                header: z.string().optional(),
                expectedHeaderVersion: z.number().int().min(0).optional(),
                body: z.string().optional(),
                expectedBodyVersion: z.number().int().min(0).optional()
            }),
            response: {
                200: z.union([
                    z.object({
                        success: z.literal(true),
                        updateSeq: z.number(),
                        headerVersion: z.number().optional(),
                        bodyVersion: z.number().optional()
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal('version-mismatch'),
                        currentHeaderVersion: z.number().optional(),
                        currentBodyVersion: z.number().optional(),
                        currentHeader: z.string().optional(),
                        currentBody: z.string().optional()
                    })
                ]),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                500: z.object({
                    error: z.literal('Failed to update artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { header, expectedHeaderVersion, body, expectedBodyVersion } = request.body;

        try {
            const result = await inTx(async (tx) => {
                if (!await acquireAccountWrite(tx, userId)) return { kind: 'deleting' as const };
                const currentArtifact = await tx.artifact.findFirst({
                    where: { id, accountId: userId, account: { is: { deletionRequestedAt: null } } }
                });
                if (!currentArtifact) return { kind: 'missing' as const };
                const headerMismatch = header !== undefined && expectedHeaderVersion !== undefined && currentArtifact.headerVersion !== expectedHeaderVersion;
                const bodyMismatch = body !== undefined && expectedBodyVersion !== undefined && currentArtifact.bodyVersion !== expectedBodyVersion;
                if (headerMismatch || bodyMismatch) return { kind: 'version-mismatch' as const, artifact: currentArtifact, headerMismatch, bodyMismatch };
                const updateData: any = { updatedAt: new Date(), seq: currentArtifact.seq + 1 };
                const headerUpdate = header !== undefined && expectedHeaderVersion !== undefined
                    ? { value: header, version: expectedHeaderVersion + 1 } : undefined;
                const bodyUpdate = body !== undefined && expectedBodyVersion !== undefined
                    ? { value: body, version: expectedBodyVersion + 1 } : undefined;
                if (headerUpdate) { updateData.header = privacyKit.decodeBase64(headerUpdate.value); updateData.headerVersion = headerUpdate.version; }
                if (bodyUpdate) { updateData.body = privacyKit.decodeBase64(bodyUpdate.value); updateData.bodyVersion = bodyUpdate.version; }
                const updated = await tx.artifact.updateMany({
                    where: { id, accountId: userId, account: { is: { deletionRequestedAt: null } }, ...(header && { headerVersion: expectedHeaderVersion }), ...(body && { bodyVersion: expectedBodyVersion }) },
                    data: updateData,
                });
                if (updated.count !== 1) return { kind: 'version-mismatch' as const, artifact: currentArtifact, headerMismatch: Boolean(header), bodyMismatch: Boolean(body) };
                const { seq: updSeq } = await allocateArtifactMutation(userId, tx);
                await tx.artifact.updateMany({ where: { id, accountId: userId }, data: { updateSeq: updSeq } });
                const updatePayload = buildUpdateArtifactUpdate(id, currentArtifact.seq + 1, updSeq, randomKeyNaked(12), headerUpdate, bodyUpdate);
                afterTx(tx, () => eventRouter.emitUpdate({ userId, payload: updatePayload, recipientFilter: { type: 'user-scoped-only' } }));
                return { kind: 'updated' as const, headerUpdate, bodyUpdate, updateSeq: updSeq };
            });
            if (result.kind === 'deleting' || result.kind === 'missing') return reply.code(404).send({ error: 'Artifact not found' });
            if (result.kind === 'version-mismatch') {
                const currentArtifact = result.artifact;
                return reply.send({ success: false, error: 'version-mismatch',
                    ...(result.headerMismatch && { currentHeaderVersion: currentArtifact.headerVersion, currentHeader: privacyKit.encodeBase64(currentArtifact.header) }),
                    ...(result.bodyMismatch && { currentBodyVersion: currentArtifact.bodyVersion, currentBody: privacyKit.encodeBase64(currentArtifact.body) }) });
            }

            return reply.send({
                success: true,
                updateSeq: result.updateSeq,
                ...(result.headerUpdate && { headerVersion: result.headerUpdate.version }),
                ...(result.bodyUpdate && { bodyVersion: result.bodyUpdate.version })
            });
        } catch {
            log({ module: 'api', level: 'error', operation: 'artifact.update', userHash: diagnosticHash(userId), artifactHash: diagnosticHash(id) }, 'Artifact operation failed');
            return reply.code(500).send({ error: 'Failed to update artifact' });
        }
    });

    // DELETE /v1/artifacts/:id - Delete artifact
    app.delete('/v1/artifacts/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    updateSeq: z.number()
                }),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                500: z.object({
                    error: z.literal('Failed to delete artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        try {
            const result = await inTx(async (tx) => {
                if (!await acquireAccountWrite(tx, userId)) return { kind: 'deleting' as const };
                const artifact = await tx.artifact.findFirst({ where: { id, accountId: userId, account: { is: { deletionRequestedAt: null } } } });
                if (!artifact) return { kind: 'missing' as const };
                await tx.artifact.delete({ where: { id } });
                const { seq: updSeq } = await allocateArtifactMutation(userId, tx);
                const deletePayload = buildDeleteArtifactUpdate(id, updSeq, randomKeyNaked(12));
                afterTx(tx, () => eventRouter.emitUpdate({ userId, payload: deletePayload, recipientFilter: { type: 'user-scoped-only' } }));
                return { kind: 'deleted' as const, seq: updSeq };
            });
            if (result.kind !== 'deleted') return reply.code(404).send({ error: 'Artifact not found' });

            return reply.send({ success: true, updateSeq: result.seq });
        } catch {
            log({ module: 'api', level: 'error', operation: 'artifact.delete', userHash: diagnosticHash(userId), artifactHash: diagnosticHash(id) }, 'Artifact operation failed');
            return reply.code(500).send({ error: 'Failed to delete artifact' });
        }
    });
}
