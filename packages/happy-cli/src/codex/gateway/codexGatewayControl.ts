import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { chmod, rm } from 'node:fs/promises';
import { z } from 'zod';
import type { CodexGatewayDescriptor } from './codexGatewayState';

const MAX_CONTROL_BODY_BYTES = 64 * 1024;

const NormalExitSchema = z.object({
    attachmentId: z.string().uuid(),
    nonce: z.string().min(32).max(512),
}).strict();
const StopSchema = z.object({ force: z.boolean().default(false) }).strict();
const TerminalAttachedSchema = z.object({
    attachmentId: z.string().uuid(),
    connectionToken: z.string().min(32).max(512),
    normalExitNonce: z.string().min(32).max(512),
}).strict();
const OpenRootSchema = z.object({
    operationId: z.string().uuid(),
    action: z.enum(['start', 'resume']),
    threadId: z.string().min(1).max(512).nullable().default(null),
    cwd: z.string().min(1).max(8_192),
    model: z.string().min(1).max(512).nullable().default(null),
    permissionMode: z.enum([
        'default',
        'read-only',
        'safe-yolo',
        'yolo',
    ]).default('default'),
    effortLevel: z.string().min(1).max(128).nullable().default(null),
    parentSessionId: z.string().min(1).max(512).nullable().default(null),
    forkedFromMessageId: z.string().min(1).max(512).nullable().default(null),
    isSideChat: z.boolean().default(false),
    happySessionId: z.string().min(1).max(512).nullable().default(null),
    dataEncryptionKey: z.string().min(1).max(128).nullable().default(null),
}).strict().superRefine((input, context) => {
    if (input.action === 'resume' && !input.threadId) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['threadId'],
            message: 'threadId is required for resume',
        });
    }
    if (input.action === 'start' && input.threadId) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['threadId'],
            message: 'threadId is not allowed for start',
        });
    }
    if (Boolean(input.happySessionId) !== Boolean(input.dataEncryptionKey)) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['happySessionId'],
            message: 'happySessionId and dataEncryptionKey must be supplied together',
        });
    }
});
export type CodexGatewayOpenRootInput = z.infer<typeof OpenRootSchema>;

export interface CodexGatewayOpenRootResult {
    gatewayId: string;
    threadId: string;
    sessionId: string;
    generation: number;
}

export interface CodexGatewayControlHandlers {
    status(): Promise<unknown> | unknown;
    normalExit(input: z.infer<typeof NormalExitSchema>): Promise<unknown> | unknown;
    stop(input: z.infer<typeof StopSchema>): Promise<unknown> | unknown;
    terminalAttached(input: z.infer<typeof TerminalAttachedSchema>): Promise<unknown> | unknown;
    openRoot(input: CodexGatewayOpenRootInput): Promise<CodexGatewayOpenRootResult>;
}

export async function startCodexGatewayControlServer(options: {
    socketPath?: string;
    port?: number;
    token: string;
    handlers: CodexGatewayControlHandlers;
}): Promise<{ socketPath: string | null; port: number | null; close(): Promise<void> }> {
    if ((options.socketPath ? 1 : 0) + (options.port !== undefined ? 1 : 0) !== 1) {
        throw new Error('Exactly one Gateway control endpoint is required');
    }
    if (options.token.length < 32) throw new Error('Gateway control token is too short');
    if (options.socketPath) await rm(options.socketPath, { force: true });

    const server = createServer(async (request, response) => {
        try {
            if (request.method !== 'POST') {
                sendJson(response, 405, { error: 'methodNotAllowed' });
                return;
            }
            if (!validBearerToken(request.headers.authorization, options.token)) {
                sendJson(response, 401, { error: 'unauthorized' });
                return;
            }
            const body = await readJsonBody(request);
            let result: unknown;
            switch (request.url) {
                case '/status':
                    result = await options.handlers.status();
                    break;
                case '/normal-exit':
                    result = await options.handlers.normalExit(NormalExitSchema.parse(body));
                    break;
                case '/stop':
                    result = await options.handlers.stop(StopSchema.parse(body));
                    break;
                case '/terminal-attached':
                    result = await options.handlers.terminalAttached(TerminalAttachedSchema.parse(body));
                    break;
                case '/root/open':
                    result = await options.handlers.openRoot(OpenRootSchema.parse(body));
                    break;
                default:
                    sendJson(response, 404, { error: 'notFound' });
                    return;
            }
            sendJson(response, 200, { ok: true, result: result ?? null });
        } catch (error) {
            const status = error instanceof ControlBodyTooLargeError ? 413 : 400;
            sendJson(response, status, {
                error: error instanceof ControlBodyTooLargeError ? 'bodyTooLarge' : 'invalidRequest',
            });
        }
    });
    await listen(server, options);
    if (options.socketPath && process.platform !== 'win32') await chmod(options.socketPath, 0o600);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    return {
        socketPath: options.socketPath ?? null,
        port,
        close: async () => {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            if (options.socketPath) await rm(options.socketPath, { force: true });
        },
    };
}

export async function callCodexGatewayControl<T>(options: {
    descriptor: CodexGatewayDescriptor;
    token: string;
    path: '/status' | '/normal-exit' | '/stop' | '/terminal-attached' | '/root/open';
    body?: unknown;
    timeoutMs?: number;
}): Promise<T> {
    if (!options.descriptor.controlSocketPath && !options.descriptor.controlPort) {
        throw new Error('Codex Gateway control endpoint is unavailable');
    }
    const body = Buffer.from(JSON.stringify(options.body ?? {}), 'utf8');
    const response = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const request = httpRequest({
            method: 'POST',
            path: options.path,
            ...(options.descriptor.controlSocketPath
                ? { socketPath: options.descriptor.controlSocketPath }
                : { hostname: '127.0.0.1', port: options.descriptor.controlPort ?? undefined }),
            headers: {
                authorization: `Bearer ${options.token}`,
                'content-type': 'application/json',
                'content-length': String(body.length),
            },
            timeout: options.timeoutMs ?? 5_000,
        }, (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
            incoming.on('end', () => resolve({
                status: incoming.statusCode ?? 500,
                body: Buffer.concat(chunks),
            }));
        });
        request.on('timeout', () => request.destroy(new Error('Gateway control request timed out')));
        request.on('error', reject);
        request.end(body);
    });
    if (response.status !== 200) throw new Error(`Gateway control request failed (${response.status})`);
    const parsed = JSON.parse(response.body.toString('utf8')) as { ok?: boolean; result?: T };
    if (!parsed.ok) throw new Error('Gateway control response was invalid');
    return parsed.result as T;
}

function validBearerToken(header: string | undefined, expected: string): boolean {
    if (!header?.startsWith('Bearer ')) return false;
    const supplied = createHash('sha256').update(header.slice(7)).digest();
    const wanted = createHash('sha256').update(expected).digest();
    return timingSafeEqual(supplied, wanted);
}

class ControlBodyTooLargeError extends Error {}

async function readJsonBody(request: import('node:http').IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_CONTROL_BODY_BYTES) throw new ControlBodyTooLargeError();
        chunks.push(buffer);
    }
    if (size === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
    const encoded = Buffer.from(JSON.stringify(body), 'utf8');
    response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': String(encoded.length),
        'cache-control': 'no-store',
    });
    response.end(encoded);
}

async function listen(
    server: Server,
    options: { socketPath?: string; port?: number },
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(
            options.socketPath ? { path: options.socketPath } : { host: '127.0.0.1', port: options.port ?? 0 },
            () => {
                server.off('error', reject);
                resolve();
            },
        );
    });
}
