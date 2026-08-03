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
import type { ServerNotification, Thread } from '../protocol';

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
    // This is the official root response's snapshot. It remains in memory only;
    // the original provider frame is forwarded byte-for-byte below.
    providerSnapshot?: Thread;
}

export interface CodexGatewayProxyHooks {
    beforeRootRequest?(request: CodexGatewayRootRequest): Promise<void> | void;
    rootBound?(binding: CodexGatewayRootBinding): Promise<void> | void;
    rootFailed?(request: CodexGatewayRootRequest): Promise<void> | void;
    // The provider frame itself stays transparent to the terminal. This hook only
    // mirrors parsed server notifications into Happy's independent projection path.
    terminalNotification?(notification: ServerNotification): Promise<void> | void;
    threadMaterialized?(threadId: string): Promise<void> | void;
    claimTerminal?(connectionId: string, bearerToken: string | null): boolean;
    terminalConnected?(connectionId: string): Promise<void> | void;
    terminalDisconnected?(connectionId: string): Promise<void> | void;
    protocolError?(error: unknown): void;
}

interface PendingRootRequest extends CodexGatewayRootRequest {}

interface PendingTurnStart {
    threadId: string;
}

export class CodexGatewayProxy {
    private httpServer: HttpServer | null = null;
    private webSocketServer: WebSocketServer | null = null;
    private boundEndpoint: CodexGatewayProxyEndpoint | null = null;
    private readonly downstreams = new Set<WebSocket>();

    constructor(
        private readonly listen: CodexGatewayProxyEndpoint,
        private readonly upstream: CodexGatewayProxyEndpoint,
        private readonly hooks: CodexGatewayProxyHooks = {},
    ) {}

    async start(): Promise<CodexGatewayProxyEndpoint> {
        if (this.httpServer && this.boundEndpoint) return this.boundEndpoint;
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
            const connectionId = randomUUID();
            const bearerToken = readBearerToken(request.headers.authorization);
            if (this.hooks.claimTerminal && !this.hooks.claimTerminal(connectionId, bearerToken)) {
                socket.write([
                    'HTTP/1.1 401 Unauthorized',
                    'Connection: close',
                    'Content-Length: 0',
                    '',
                    '',
                ].join('\r\n'));
                socket.destroy();
                return;
            }
            webSocketServer.handleUpgrade(request, socket, head, (downstream) => {
                this.accept(downstream, connectionId);
            });
        });
        const boundEndpoint = await listenHttpServer(httpServer, this.listen);
        if (this.listen.socketPath && process.platform !== 'win32') {
            await chmod(this.listen.socketPath, 0o600);
        }
        this.httpServer = httpServer;
        this.webSocketServer = webSocketServer;
        this.boundEndpoint = boundEndpoint;
        return boundEndpoint;
    }

    async close(): Promise<void> {
        const downstreams = [...this.downstreams];
        this.downstreams.clear();
        for (const socket of downstreams) socket.close(1001, 'Gateway stopping');
        const webSocketServer = this.webSocketServer;
        const httpServer = this.httpServer;
        this.webSocketServer = null;
        this.httpServer = null;
        this.boundEndpoint = null;
        if (webSocketServer) {
            await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
        }
        await new Promise<void>((resolve, reject) => {
            if (!httpServer) return resolve();
            httpServer.close((error) => error ? reject(error) : resolve());
        });
        if (this.listen.socketPath) await rm(this.listen.socketPath, { force: true });
    }

    private accept(downstream: WebSocket, connectionId: string): void {
        this.downstreams.add(downstream);
        const pendingRoots = new Map<JsonRpcId, PendingRootRequest>();
        const pendingTurnStarts = new Map<JsonRpcId, PendingTurnStart>();
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
                await this.observeProviderMessage(
                    normalized,
                    isBinary,
                    pendingRoots,
                    pendingTurnStarts,
                );
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
                pendingTurnStarts,
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
            for (const pending of pendingRoots.values()) {
                void this.hooks.rootFailed?.(pending);
            }
            pendingRoots.clear();
            pendingTurnStarts.clear();
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
        pendingTurnStarts: Map<JsonRpcId, PendingTurnStart>;
        forward(data: RawData, isBinary: boolean): void;
        reject(requestId: JsonRpcId, message: string): void;
    }): Promise<void> {
        if (options.isBinary) {
            options.forward(options.data, true);
            return;
        }
        const parsed = parseJsonRpcObject(options.data);
        if (!parsed || !isJsonRpcId(parsed.id) || typeof parsed.method !== 'string') {
            options.forward(options.data, false);
            return;
        }
        if (parsed.method === 'turn/start') {
            const threadId = directThreadId(parsed.params);
            if (threadId) options.pendingTurnStarts.set(parsed.id, { threadId });
            options.forward(options.data, false);
            return;
        }
        if (!ROOT_METHODS.has(parsed.method)) {
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
        pendingTurnStarts: Map<JsonRpcId, PendingTurnStart>,
    ): Promise<void> {
        if (isBinary) return;
        const parsed = parseJsonRpcObject(data);
        if (!parsed) return;
        if (!isJsonRpcResponse(parsed)) {
            const notification = serverNotification(parsed);
            if (notification) this.notifyTerminalNotification(notification);
            const threadId = providerActivityThreadId(parsed);
            if (threadId) await this.notifyThreadMaterialized(threadId);
            return;
        }
        const pendingTurn = pendingTurnStarts.get(parsed.id);
        if (pendingTurn) {
            pendingTurnStarts.delete(parsed.id);
            if (!('error' in parsed)) {
                await this.notifyThreadMaterialized(pendingTurn.threadId);
            }
        }
        const pending = pendingRoots.get(parsed.id);
        if (!pending) return;
        pendingRoots.delete(parsed.id);
        if ('error' in parsed) {
            await this.hooks.rootFailed?.(pending);
            return;
        }
        const providerSnapshot = responseThreadSnapshot(parsed.result);
        const threadId = providerSnapshot?.id ?? responseThreadId(parsed.result);
        if (!threadId) {
            throw new Error(`${pending.method} response omitted the thread ID`);
        }
        await this.hooks.rootBound?.({
            ...pending,
            threadId,
            ...(providerSnapshot ? { providerSnapshot } : {}),
        });
    }

    private async notifyThreadMaterialized(threadId: string): Promise<void> {
        try {
            await this.hooks.threadMaterialized?.(threadId);
        } catch (error) {
            this.hooks.protocolError?.(error);
        }
    }

    private notifyTerminalNotification(notification: ServerNotification): void {
        try {
            void Promise.resolve(this.hooks.terminalNotification?.(notification)).catch((error) => {
                this.hooks.protocolError?.(error);
            });
        } catch (error) {
            this.hooks.protocolError?.(error);
        }
    }
}

function readBearerToken(header: string | undefined): string | null {
    if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice(7);
    return token.length > 0 ? token : null;
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

function responseThreadSnapshot(result: unknown): Thread | null {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const thread = (result as Record<string, unknown>).thread;
    if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return null;
    const id = (thread as Record<string, unknown>).id;
    return typeof id === 'string' && id.length > 0 ? thread as Thread : null;
}

function directThreadId(params: unknown): string | null {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
    const threadId = (params as Record<string, unknown>).threadId;
    return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
}

function providerActivityThreadId(message: Record<string, unknown>): string | null {
    if (typeof message.method !== 'string') return null;
    const direct = directThreadId(message.params);
    if (direct) return direct;
    if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)) {
        return null;
    }
    const thread = (message.params as Record<string, unknown>).thread;
    if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return null;
    const id = (thread as Record<string, unknown>).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

function isJsonRpcResponse(message: Record<string, unknown>): message is Record<string, unknown> & {
    id: JsonRpcId;
} {
    return isJsonRpcId(message.id)
        && typeof message.method !== 'string'
        && ('result' in message || 'error' in message);
}

function serverNotification(message: Record<string, unknown>): ServerNotification | null {
    const params = message.params;
    if (
        Object.prototype.hasOwnProperty.call(message, 'id')
        || typeof message.method !== 'string'
        || !Object.prototype.hasOwnProperty.call(message, 'params')
        || !params
        || typeof params !== 'object'
        || Array.isArray(params)
    ) {
        return null;
    }
    return { method: message.method, params } as ServerNotification;
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
): Promise<CodexGatewayProxyEndpoint> {
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
    if (endpoint.socketPath) return { socketPath: endpoint.socketPath };
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Codex Gateway proxy did not expose a loopback port');
    }
    const boundUrl = new URL(endpoint.url!);
    boundUrl.port = String(address.port);
    return { url: boundUrl.toString() };
}
