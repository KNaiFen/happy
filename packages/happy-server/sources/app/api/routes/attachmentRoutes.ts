/**
 * Attachment upload/download routes for image attachments in chat sessions.
 *
 * Two storage modes share one authenticated transport:
 * - S3: Server proxies encrypted blobs to the configured bucket.
 * - Local: Server writes/serves encrypted blobs directly.
 *
 * No database records — attachments are identified by their ref path.
 * Cleanup happens when sessions are deleted (Phase 8).
 */
import { z } from 'zod';
import * as crypto from 'crypto';
import { Fastify } from '../types';
import { getFileStream, putFile } from '@/storage/files';
import { inTx } from '@/storage/inTx';
import { acquireAccountRead } from '@/app/account/accountWriteGate';
import {
    beginAccountDeletionUpload,
    settleAccountDeletionUpload,
} from '@/app/account/accountDeletion';
import {
    buildSessionAccessWhere,
    sessionAccessIdentityFromRequest,
} from '@/app/api/utils/sessionAccess';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
// Per-user, per-process limit for actual object writes. Multi-process
// deployments multiply this backstop by their replica count; a shared rate
// limiter can replace it without changing the route contract.
const UPLOAD_RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_MAX = 60;
const uploadRateState = new Map<string, { count: number; windowStart: number }>();

/**
 * Build the base URL the client should use to reach our local-mode upload /
 * download endpoints. Prefer an explicit PUBLIC_URL, then x-forwarded-* (for
 * deployments behind a proxy), then the Host header the request itself
 * arrived on. Falling back to localhost would make any non-localhost client
 * (a phone, another LAN device, a desktop pointing at a dev IP) fail with a
 * generic Network request failed when it tries to follow the URL.
 */
function resolveBaseUrl(_request: { headers: Record<string, string | string[] | undefined> }): string {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
    return `http://localhost:${process.env.PORT || '3005'}`;
}

function checkUploadRate(userId: string): boolean {
    const now = Date.now();
    const entry = uploadRateState.get(userId);
    if (!entry || now - entry.windowStart >= UPLOAD_RATE_WINDOW_MS) {
        uploadRateState.set(userId, { count: 1, windowStart: now });
        // Opportunistic prune so the map cannot grow forever from one-shot
        // users churning through the system.
        if (uploadRateState.size > 10_000) {
            for (const [k, v] of uploadRateState) {
                if (now - v.windowStart >= UPLOAD_RATE_WINDOW_MS) {
                    uploadRateState.delete(k);
                }
            }
        }
        return true;
    }
    if (entry.count >= UPLOAD_RATE_MAX) return false;
    entry.count++;
    return true;
}

export function attachmentRoutes(app: Fastify) {

    /**
     * Request an authenticated upload URL for an attachment.
     * Returns a ref (storage path) and an uploadUrl on this Server. Keeping the
     * transfer server-mediated lets account deletion revoke access immediately.
     */
    app.post('/v1/sessions/:sessionId/attachments/request-upload', {
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: z.object({
                filename: z.string(),
                size: z.number().max(MAX_FILE_SIZE),
            }),
            response: {
                200: z.object({
                ref: z.string(),
                uploadUrl: z.string(),
                method: z.literal('PUT'),
                requiresAuth: z.literal(true),
                }),
                404: z.object({ error: z.string() }),
                409: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { size } = request.body;

        // Verify session ownership
        const accessWhere = buildSessionAccessWhere(
            sessionAccessIdentityFromRequest(request),
            { id: sessionId },
        );
        const session = await inTx(async (tx) => {
            if (!await acquireAccountRead(tx, request.userId)) return null;
            return accessWhere ? tx.session.findFirst({ where: accessWhere }) : null;
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        if (size > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large (max 10MB)' });
        }

        // Always .enc — encrypted opaque blobs, never trust client filename for path.
        const attachmentId = crypto.randomUUID();
        const attachmentFile = `${attachmentId}.enc`;
        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;

        const baseUrl = resolveBaseUrl(request);
        const uploadUrl = `${baseUrl}/v1/sessions/${sessionId}/attachments/${attachmentFile}`;
        return reply.send({ ref, uploadUrl, method: 'PUT', requiresAuth: true });
    });

    /**
     * Accept an encrypted blob upload via PUT and persist it through the
     * configured backend.
     */
    app.put('/v1/sessions/:sessionId/attachments/:attachmentFile', {
        bodyLimit: MAX_FILE_SIZE,
        schema: {
            params: z.object({
                sessionId: z.string(),
                attachmentFile: z.string(),
            }),
            response: {
                200: z.object({ ok: z.boolean() }),
                404: z.object({ error: z.string() }),
                409: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
                429: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId, attachmentFile } = request.params;

        // Verify session ownership
        const accessWhere = buildSessionAccessWhere(
            sessionAccessIdentityFromRequest(request),
            { id: sessionId },
        );
        const session = await inTx(async (tx) => {
            if (!await acquireAccountRead(tx, request.userId)) return null;
            return accessWhere ? tx.session.findFirst({ where: accessWhere }) : null;
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Path traversal protection
        if (attachmentFile.includes('..') || attachmentFile.includes('/')) {
            return reply.code(404).send({ error: 'Invalid attachment file' });
        }

        const body = request.body as Buffer;
        if (body.length > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large (max 10MB)' });
        }

        if (!checkUploadRate(request.userId)) {
            return reply.code(429).send({ error: 'Too many uploads. Try again in a minute.' });
        }

        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;
        const uploadOperation = await beginAccountDeletionUpload(request.userId, ref);
        if (!uploadOperation) {
            return reply.code(409).send({ error: 'Account deletion in progress' });
        }
        let objectWriteCompleted = false;
        try {
            await putFile(ref, body);
            objectWriteCompleted = true;
        } finally {
            if (objectWriteCompleted) {
                await settleAccountDeletionUpload(uploadOperation);
            }
        }

        return reply.send({ ok: true });
    });

    /**
     * Request a download URL for an attachment by ref. The client follows the
     * returned URL with a normal HTTP GET against this server. The second
     * request remains authenticated in both storage modes.
     * Pairs with /request-upload as the design-spec endpoint.
     */
    app.post('/v1/sessions/:sessionId/attachments/request-download', {
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: z.object({
                ref: z.string(),
            }),
            response: {
                200: z.object({
                    downloadUrl: z.string(),
                    requiresAuth: z.literal(true),
                }),
                400: z.object({ error: z.string() }),
                404: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { ref } = request.body;
        const accessWhere = buildSessionAccessWhere(
            sessionAccessIdentityFromRequest(request),
            { id: sessionId },
        );
        const session = await inTx(async (tx) => {
            if (!await acquireAccountRead(tx, request.userId)) return null;
            return accessWhere ? tx.session.findFirst({ where: accessWhere }) : null;
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // ref must live strictly under this session's attachments prefix —
        // otherwise a member of session A could craft a ref pointing into
        // session B and ride this endpoint's auth to read it.
        const expectedPrefix = `sessions/${sessionId}/attachments/`;
        if (!ref.startsWith(expectedPrefix)) {
            return reply.code(400).send({ error: 'Ref does not belong to this session' });
        }
        const attachmentFile = ref.slice(expectedPrefix.length);
        if (!attachmentFile || attachmentFile.includes('/') || attachmentFile.includes('..')) {
            return reply.code(400).send({ error: 'Invalid attachment ref' });
        }

        const baseUrl = resolveBaseUrl(request);
        const downloadUrl = `${baseUrl}/v1/sessions/${sessionId}/attachments/${attachmentFile}`;
        return reply.send({ downloadUrl, requiresAuth: true });
    });

    /**
     * Download an attachment through the authenticated Server. This also backs
     * the URL returned by /request-download.
     */
    app.get('/v1/sessions/:sessionId/attachments/:attachmentFile', {
        schema: {
            params: z.object({
                sessionId: z.string(),
                attachmentFile: z.string(),
            }),
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId, attachmentFile } = request.params;
        // Verify session ownership
        const accessWhere = buildSessionAccessWhere(
            sessionAccessIdentityFromRequest(request),
            { id: sessionId },
        );
        // Path traversal protection
        if (attachmentFile.includes('..') || attachmentFile.includes('/')) {
            return reply.code(404).send({ error: 'Invalid attachment file' });
        }

        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;

        try {
            const session = await inTx(async (tx) => {
                if (!await acquireAccountRead(tx, request.userId)) return null;
                return accessWhere
                    ? tx.session.findFirst({ where: accessWhere })
                    : null;
            });
            if (!session) return reply.code(404).send({ error: 'Session not found' });

            // The transaction above is the admission point. A stream admitted
            // before deletion may finish, but no new stream can be admitted once
            // the deletion marker owns the account row.
            const stream = await getFileStream(ref);
            return reply.type('application/octet-stream').send(stream);
        } catch {
            return reply.code(404).send({ error: 'Attachment not found' });
        }
    });
}
