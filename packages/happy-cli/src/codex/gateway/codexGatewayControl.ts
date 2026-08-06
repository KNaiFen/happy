import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { chmod, rm } from 'node:fs/promises';
import { z } from 'zod';
import type { CodexGatewayDescriptor } from './codexGatewayState';

const MAX_CONTROL_BODY_BYTES = 64 * 1024;

export type CodexGatewayControlOperationErrorCode =
    | 'threadUnavailable'
    | 'conflict'
    | 'operationFailed'
    | 'outcomeUnknown';

type CodexGatewayControlWireErrorCode =
    | CodexGatewayControlOperationErrorCode
    | 'invalidRequest'
    | 'bodyTooLarge'
    | 'methodNotAllowed'
    | 'unauthorized'
    | 'notFound';

const CONTROL_ERROR_CODES = new Set<CodexGatewayControlWireErrorCode>([
    'threadUnavailable',
    'conflict',
    'operationFailed',
    'outcomeUnknown',
    'invalidRequest',
    'bodyTooLarge',
    'methodNotAllowed',
    'unauthorized',
    'notFound',
]);

export class CodexGatewayControlOperationError extends Error {
    constructor(readonly code: CodexGatewayControlOperationErrorCode) {
        super(`Codex Gateway operation failed (${code})`);
        this.name = 'CodexGatewayControlOperationError';
    }
}

export class CodexGatewayControlRequestError extends Error {
    constructor(
        readonly code: CodexGatewayControlWireErrorCode,
        readonly status: number,
    ) {
        super(status > 0
            ? `Gateway control request failed (${status})`
            : 'Gateway control request outcome is unknown');
        this.name = 'CodexGatewayControlRequestError';
    }
}

export function isCodexGatewayControlOutcomeUnknown(error: unknown): boolean {
    return (
        error instanceof CodexGatewayControlOperationError
        || error instanceof CodexGatewayControlRequestError
    ) && error.code === 'outcomeUnknown';
}

const NormalExitSchema = z.object({
    attachmentId: z.string().uuid(),
    nonce: z.string().min(32).max(512),
}).strict();
const StopSchema = z.object({ force: z.boolean().default(false) }).strict();
const PresenceReconcileSchema = z.object({
    sessionId: z.string().min(1).max(512),
}).strict();
const CancelRootSchema = z.object({
    operationId: z.string().uuid(),
}).strict();
const TerminalAttachedSchema = z.object({
    attachmentId: z.string().uuid(),
    connectionToken: z.string().min(32).max(512),
    normalExitNonce: z.string().min(32).max(512),
}).strict();
const OpenRootSchema = z.object({
    operationId: z.string().uuid(),
    action: z.enum(['start', 'resume']),
    threadId: z.string().min(1).max(512).nullable().default(null),
    cwd: z.string().min(1).max(8_192).nullable().default(null),
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
}).strict().superRefine((input, context) => {
    if (input.action === 'start' && !input.cwd) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['cwd'],
            message: 'cwd is required for start',
        });
    }
    if (input.action === 'start' && input.threadId) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['threadId'],
            message: 'threadId is not allowed for start',
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
    presenceReconcile(input: z.infer<typeof PresenceReconcileSchema>): Promise<unknown> | unknown;
    cancelRoot(input: z.infer<typeof CancelRootSchema>): Promise<unknown> | unknown;
    openRoot(input: CodexGatewayOpenRootInput): Promise<CodexGatewayOpenRootResult>;
}

export async function startCodexGatewayControlServer(options: {
    socketPath?: string;
    port?: number;
    token: string;
    handlers: CodexGatewayControlHandlers;
    onError?: () => void;
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
                case '/presence/reconcile':
                    result = await options.handlers.presenceReconcile(PresenceReconcileSchema.parse(body));
                    break;
                case '/root/open':
                    result = await options.handlers.openRoot(OpenRootSchema.parse(body));
                    break;
                case '/root/cancel':
                    result = await options.handlers.cancelRoot(CancelRootSchema.parse(body));
                    break;
                default:
                    sendJson(response, 404, { error: 'notFound' });
                    return;
            }
            sendJson(response, 200, { ok: true, result: result ?? null });
        } catch (error) {
            options.onError?.();
            const failure = classifyControlServerError(error);
            sendJson(response, failure.status, { error: failure.code });
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
    path: '/status' | '/normal-exit' | '/stop' | '/terminal-attached' | '/presence/reconcile' | '/root/open' | '/root/cancel';
    body?: unknown;
    timeoutMs?: number;
}): Promise<T> {
    if (!options.descriptor.controlSocketPath && !options.descriptor.controlPort) {
        throw new Error('Codex Gateway control endpoint is unavailable');
    }
    const body = Buffer.from(JSON.stringify(options.body ?? {}), 'utf8');
    let response: { status: number; body: Buffer };
    try {
        response = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
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
            request.on('timeout', () => request.destroy(
                new CodexGatewayControlRequestError('outcomeUnknown', 0),
            ));
            request.on('error', reject);
            request.end(body);
        });
    } catch (error) {
        if (error instanceof CodexGatewayControlRequestError) throw error;
        throw new CodexGatewayControlRequestError('outcomeUnknown', 0);
    }
    if (response.status !== 200) {
        throw new CodexGatewayControlRequestError(
            parseControlResponseError(response.body, response.status),
            response.status,
        );
    }
    let parsed: { ok?: boolean; result?: T };
    try {
        parsed = JSON.parse(response.body.toString('utf8')) as { ok?: boolean; result?: T };
    } catch {
        throw new CodexGatewayControlRequestError('outcomeUnknown', 0);
    }
    if (!parsed.ok) throw new CodexGatewayControlRequestError('outcomeUnknown', 0);
    return parsed.result as T;
}

function classifyControlServerError(error: unknown): {
    status: 400 | 404 | 409 | 413 | 502;
    code: CodexGatewayControlWireErrorCode;
} {
    if (error instanceof ControlBodyTooLargeError) return { status: 413, code: 'bodyTooLarge' };
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
        return { status: 400, code: 'invalidRequest' };
    }
    if (error instanceof CodexGatewayControlOperationError) {
        switch (error.code) {
            case 'threadUnavailable': return { status: 404, code: error.code };
            case 'conflict': return { status: 409, code: error.code };
            case 'operationFailed':
            case 'outcomeUnknown':
                return { status: 502, code: error.code };
        }
    }
    return { status: 502, code: 'operationFailed' };
}

function parseControlResponseError(
    body: Buffer,
    status: number,
): CodexGatewayControlWireErrorCode {
    try {
        const parsed = JSON.parse(body.toString('utf8')) as { error?: unknown };
        if (
            typeof parsed.error === 'string'
            && CONTROL_ERROR_CODES.has(parsed.error as CodexGatewayControlWireErrorCode)
        ) {
            return parsed.error as CodexGatewayControlWireErrorCode;
        }
    } catch {
        // The status code still determines a stable local category.
    }
    if (status === 400) return 'invalidRequest';
    if (status === 401) return 'unauthorized';
    if (status === 404) return 'notFound';
    if (status === 409) return 'conflict';
    if (status === 413) return 'bodyTooLarge';
    return 'operationFailed';
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
