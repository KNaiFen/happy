import { createServer, type Server as HttpServer } from 'node:http';
import { chmod, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import {
    CODEX_APP_SERVER_MAX_RPC_BYTES,
    codexWebSocketRawDataBuffer,
    connectCodexAppServerWebSocket,
    type CodexAppServerWebSocketEndpoint,
} from '../codexAppServerWebSocket';

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const ROOT_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork']);

type JsonRpcId = string | number;

export type CodexGatewayProxyEndpoint = CodexAppServerWebSocketEndpoint;

export interface CodexGatewayRootRequest {
    connectionId: string;
    requestId: JsonRpcId;
    method: 'thread/start' | 'thread/resume' | 'thread/fork';
    requestedThreadId: string | null;
}

export interface CodexGatewayRootBinding extends CodexGatewayRootRequest {
    threadId: string;
}

export interface CodexGatewayProxyHooks {
    beforeRootRequest?(request: CodexGatewayRootRequest): Promise<void> | void;
    rootBound?(binding: CodexGatewayRootBinding): Promise<void> | void;
    terminalConnected?(connectionId: string): Promise<void> | void;
    terminalDisconnected?(connectionId: string): Promise<void> | void;
    protocolError?(error: unknown): void;
}

interface PendingRootRequest extends CodexGatewayRootRequest {}

export class CodexGatewayProxy {
    private httpServer: HttpServer | null = null;
    private webSocketServer: WebSocketServer | null = null;
    private readonly downstreams = new Set<WebSocket>();

    constructor(
        private readonly listen: CodexGatewayProxyEndpoint,
        private readonly upstream: CodexGatewayProxyEndpoint,
        private readonly hooks: CodexGatewayProxyHooks = {},
    ) {}

    async start(): Promise<void> {
        if (this.httpServer) return;
        if (this.listen.socketPath) await rm(this.listen.socketPath, { force: true });
        const httpServer = createServer((_request, response) => {
            response.writeHead(426, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            response.end('WebSocket upgrade required');
        });
        const webSocketServer = new WebSocketServer({
            noServer: true,
            maxPayload: CODEX_APP_SERVER_MAX_RPC_BYTES,
        });
        httpServer.on('upgrade', (request, socket, head) => {
            webSocketServer.handleUpgrade(request, socket, head, (downstream) => {
                webSocketServer.emit('connection', downstream, request);
            });
        });
        webSocketServer.on('connection', (downstream) => this.accept(downstream));
        await listenHttpServer(httpServer, this.listen);
        if (this.listen.socketPath && process.platform !== 'win32') {
            await chmod(this.listen.socketPath, 0o600);
        }
        this.httpServer = httpServer;
        this.webSocketServer = webSocketServer;
    }

    async close(): Promise<void> {
        const downstreams = [...this.downstreams];
        this.downstreams.clear();
        for (const socket of downstreams) socket.close(1001, 'Gateway stopping');
        const webSocketServer = this.webSocketServer;
        const httpServer = this.httpServer;
        this.webSocketServer = null;
        this.httpServer = null;
        if (webSocketServer) {
            await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
        }
        await new Promise<void>((resolve, reject) => {
            if (!httpServer) return resolve();
            httpServer.close((error) => error ? reject(error) : resolve());
        });
        if (this.listen.socketPath) await rm(this.listen.socketPath, { force: true });
    }

    private accept(downstream: WebSocket): void {
        const connectionId = randomUUID();
        this.downstreams.add(downstream);
        const pendingRoots = new Map<JsonRpcId, PendingRootRequest>();
        const buffered: Array<{ data: Buffer; isBinary: boolean }> = [];
        let bufferedBytes = 0;
        let upstreamOpened = false;
        let terminalMessagePipeline = Promise.resolve();
        let providerMessagePipeline = Promise.resolve();
        const upstream = connectCodexAppServerWebSocket(this.upstream);

        const closePair = (code = 1011, reason = 'Gateway transport closed') => {
            if (downstream.readyState === WebSocket.OPEN || downstream.readyState === WebSocket.CONNECTING) {
                downstream.close(code, reason);
            }
            if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
                upstream.close(code, reason);
            }
        };

        upstream.on('open', () => {
            upstreamOpened = true;
            for (const message of buffered) upstream.send(message.data, { binary: message.isBinary });
            buffered.length = 0;
            bufferedBytes = 0;
            void this.hooks.terminalConnected?.(connectionId);
        });
        upstream.on('message', (data, isBinary) => {
            const normalized = codexWebSocketRawDataBuffer(data);
            providerMessagePipeline = providerMessagePipeline.then(async () => {
                await this.observeProviderMessage(normalized, isBinary, pendingRoots);
                if (downstream.readyState === WebSocket.OPEN) {
                    downstream.send(normalized, { binary: isBinary });
                }
            }).catch((error) => {
                this.hooks.protocolError?.(error);
                closePair();
            });
        });
        upstream.on('error', (error) => {
            this.hooks.protocolError?.(error);
            closePair();
        });
        upstream.on('close', (code, reason) => {
            if (downstream.readyState !== WebSocket.OPEN) return;
            if (code === 1005) {
                downstream.terminate();
                return;
            }
            downstream.close(code, reason.toString());
        });

        downstream.on('message', (data, isBinary) => {
            terminalMessagePipeline = terminalMessagePipeline.then(() => this.forwardTerminalMessage({
                connectionId,
                data,
                isBinary,
                pendingRoots,
                forward: (message, binary) => {
                    if (upstreamOpened && upstream.readyState === WebSocket.OPEN) {
                        upstream.send(message, { binary });
                        return;
                    }
                    const normalized = codexWebSocketRawDataBuffer(message);
                    if (bufferedBytes + normalized.byteLength > MAX_BUFFERED_BYTES) {
                        closePair(1009, 'Gateway startup buffer exceeded');
                        return;
                    }
                    buffered.push({ data: normalized, isBinary: binary });
                    bufferedBytes += normalized.byteLength;
                },
                reject: (requestId, message) => {
                    if (downstream.readyState !== WebSocket.OPEN) return;
                    downstream.send(JSON.stringify({
                        id: requestId,
                        error: { code: -32040, message },
                    }));
                },
            })).catch((error) => {
                this.hooks.protocolError?.(error);
                closePair();
            });
        });
        downstream.on('error', (error) => {
            this.hooks.protocolError?.(error);
            closePair();
        });
        downstream.on('close', () => {
            this.downstreams.delete(downstream);
            pendingRoots.clear();
            if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
                upstream.close(1000, 'Terminal disconnected');
            }
            void this.hooks.terminalDisconnected?.(connectionId);
        });
    }

    private async forwardTerminalMessage(options: {
        connectionId: string;
        data: RawData;
        isBinary: boolean;
        pendingRoots: Map<JsonRpcId, PendingRootRequest>;
        forward(data: RawData, isBinary: boolean): void;
        reject(requestId: JsonRpcId, message: string): void;
    }): Promise<void> {
        if (options.isBinary) {
            options.forward(options.data, true);
            return;
        }
        const parsed = parseJsonRpcObject(options.data);
        if (!parsed || !isJsonRpcId(parsed.id) || typeof parsed.method !== 'string' || !ROOT_METHODS.has(parsed.method)) {
            options.forward(options.data, false);
            return;
        }
        const root: CodexGatewayRootRequest = {
            connectionId: options.connectionId,
            requestId: parsed.id,
            method: parsed.method as CodexGatewayRootRequest['method'],
            requestedThreadId: requestedThreadId(parsed.method, parsed.params),
        };
        try {
            await this.hooks.beforeRootRequest?.(root);
        } catch (error) {
            options.reject(root.requestId, safeRootRejectionMessage(error));
            return;
        }
        options.pendingRoots.set(root.requestId, root);
        options.forward(options.data, false);
    }

    private async observeProviderMessage(
        data: RawData,
        isBinary: boolean,
        pendingRoots: Map<JsonRpcId, PendingRootRequest>,
    ): Promise<void> {
        if (isBinary) return;
        const parsed = parseJsonRpcObject(data);
        if (!parsed || !isJsonRpcId(parsed.id)) return;
        const pending = pendingRoots.get(parsed.id);
        if (!pending) return;
        pendingRoots.delete(parsed.id);
        if ('error' in parsed) return;
        const threadId = responseThreadId(parsed.result);
        if (!threadId) {
            throw new Error(`${pending.method} response omitted the thread ID`);
        }
        await this.hooks.rootBound?.({ ...pending, threadId });
    }
}

export function connectCodexGatewayWebSocket(endpoint: CodexGatewayProxyEndpoint): WebSocket {
    return connectCodexAppServerWebSocket(endpoint);
}

function parseJsonRpcObject(data: RawData): Record<string, unknown> | null {
    try {
        const text = codexWebSocketRawDataBuffer(data).toString('utf8');
        if (Buffer.byteLength(text, 'utf8') > CODEX_APP_SERVER_MAX_RPC_BYTES) return null;
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function requestedThreadId(method: string, params: unknown): string | null {
    if (method !== 'thread/resume') return null;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
    const threadId = (params as Record<string, unknown>).threadId;
    return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
}

function responseThreadId(result: unknown): string | null {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const record = result as Record<string, unknown>;
    if (typeof record.threadId === 'string' && record.threadId.length > 0) return record.threadId;
    if (!record.thread || typeof record.thread !== 'object' || Array.isArray(record.thread)) return null;
    const id = (record.thread as Record<string, unknown>).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

function safeRootRejectionMessage(error: unknown): string {
    if (error instanceof Error && error.name === 'CodexGatewayThreadLeaseConflictError') {
        return 'This Codex thread is already open in another Happy Gateway. Use happy codex attach.';
    }
    return 'Happy could not safely switch the current Codex thread.';
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
    return (typeof value === 'string' && value.length <= 256)
        || (typeof value === 'number' && Number.isSafeInteger(value));
}

async function listenHttpServer(
    server: HttpServer,
    endpoint: CodexGatewayProxyEndpoint,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        if (endpoint.socketPath) {
            server.listen(endpoint.socketPath, () => {
                server.off('error', reject);
                resolve();
            });
            return;
        }
        if (!endpoint.url) {
            reject(new Error('Codex Gateway proxy listen endpoint is missing'));
            return;
        }
        const parsed = new URL(endpoint.url);
        server.listen(Number(parsed.port), parsed.hostname, () => {
            server.off('error', reject);
            resolve();
        });
    });
}
