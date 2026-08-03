import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexGatewayAttachmentManager } from './codexGatewayAttachment';
import { CodexGatewayProxy, connectCodexGatewayWebSocket } from './codexGatewayProxy';
import { startCodexGatewayTuiRelay } from './codexGatewayTuiRelay';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Codex Gateway TUI attachment relay', () => {
    it('authenticates concurrent loopback clients and forwards with the same Unix bearer', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-tui-relay-'));
        const socketPath = join(root, 'tui.sock');
        const token = 'attachment-token-that-is-at-least-thirty-two-bytes';
        const upstream = await startAuthenticatedUnixServer(socketPath, token);
        const relay = await startCodexGatewayTuiRelay({
            upstreamSocketPath: socketPath,
            bearerToken: token,
        });
        cleanups.push(async () => {
            await relay.close();
            await upstream.close();
            await rm(root, { recursive: true, force: true });
        });

        const endpoint = new URL(relay.remoteUrl);
        expect(endpoint.protocol).toBe('ws:');
        expect(endpoint.hostname).toBe('127.0.0.1');
        expect(Number(endpoint.port)).toBeGreaterThan(0);

        const rejected = connectCodexGatewayWebSocket({
            url: relay.remoteUrl,
            bearerToken: 'wrong-token-that-is-at-least-thirty-two-bytes',
        });
        await expect(opened(rejected)).rejects.toThrow('Unexpected server response: 401');
        expect(upstream.connections).toHaveBeenCalledTimes(0);

        const accepted = connectCodexGatewayWebSocket({
            url: relay.remoteUrl,
            bearerToken: token,
        });
        cleanups.push(async () => accepted.terminate());
        await opened(accepted);
        const response = nextMessage(accepted);
        accepted.send('terminal-message');
        await expect(response).resolves.toBe('provider:terminal-message');
        expect(upstream.authorizationHeaders).toEqual([`Bearer ${token}`]);
        expect(upstream.connections).toHaveBeenCalledTimes(1);

        const duplicate = connectCodexGatewayWebSocket({
            url: relay.remoteUrl,
            bearerToken: token,
        });
        cleanups.push(async () => duplicate.terminate());
        await opened(duplicate);
        const duplicateResponse = nextMessage(duplicate);
        duplicate.send('picker-message');
        await expect(duplicateResponse).resolves.toBe('provider:picker-message');
        expect(upstream.authorizationHeaders).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
        expect(upstream.connections).toHaveBeenCalledTimes(2);
    });

    it('initializes a picker and lists threads through the nested authenticated proxies', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-tui-relay-'));
        const providerSocketPath = join(root, 'provider.sock');
        const tuiSocketPath = join(root, 'tui.sock');
        const token = 'attachment-token-that-is-at-least-thirty-two-bytes';
        const provider = await startAuthenticatedUnixServer(providerSocketPath, null, {
            responseForMessage: (message) => {
                const request = JSON.parse(message) as {
                    id?: string | number;
                    method?: string;
                };
                if (request.method === 'initialize') {
                    return JSON.stringify({
                        id: request.id,
                        result: {
                            userAgent: 'codex-cli/0.146.0',
                            codexHome: root,
                            platformFamily: 'unix',
                            platformOs: 'linux',
                        },
                    });
                }
                if (request.method === 'thread/list') {
                    return JSON.stringify({
                        id: request.id,
                        result: { data: [], nextCursor: null },
                    });
                }
                return null;
            },
        });
        const attachment = new CodexGatewayAttachmentManager({ origin: 'terminal' });
        attachment.register({
            attachmentId: 'attachment-id',
            connectionToken: token,
            normalExitNonce: 'normal-exit-nonce',
        });
        const workerProxy = new CodexGatewayProxy(
            { socketPath: tuiSocketPath },
            { socketPath: providerSocketPath },
            {
                claimTerminal: (connectionId, bearerToken) => attachment.claim(connectionId, bearerToken),
                terminalDisconnected: (connectionId) => attachment.disconnect(connectionId),
            },
        );
        await workerProxy.start();
        const relay = await startCodexGatewayTuiRelay({
            upstreamSocketPath: tuiSocketPath,
            bearerToken: token,
        });
        cleanups.push(async () => {
            await relay.close();
            await workerProxy.close();
            attachment.dispose();
            await provider.close();
            await rm(root, { recursive: true, force: true });
        });

        const primary = connectCodexGatewayWebSocket({
            url: relay.remoteUrl,
            bearerToken: token,
        });
        const picker = connectCodexGatewayWebSocket({
            url: relay.remoteUrl,
            bearerToken: token,
        });
        cleanups.push(async () => {
            primary.terminate();
            picker.terminate();
        });
        await Promise.all([opened(primary), opened(picker)]);

        const primaryInitialize = nextMessage(primary);
        const pickerInitialize = nextMessage(picker);
        primary.send(JSON.stringify({ id: 'initialize', method: 'initialize', params: {} }));
        picker.send(JSON.stringify({ id: 'initialize', method: 'initialize', params: {} }));
        await expect(Promise.all([primaryInitialize, pickerInitialize])).resolves.toEqual([
            expect.stringContaining('"id":"initialize"'),
            expect.stringContaining('"id":"initialize"'),
        ]);

        primary.send(JSON.stringify({ method: 'initialized' }));
        picker.send(JSON.stringify({ method: 'initialized' }));
        const listed = nextMessage(picker);
        picker.send(JSON.stringify({
            id: 1,
            method: 'thread/list',
            params: { cursor: null, limit: 100, sortKey: 'updated_at' },
        }));
        await expect(listed).resolves.toBe(JSON.stringify({
            id: 1,
            result: { data: [], nextCursor: null },
        }));
        expect(provider.connections).toHaveBeenCalledTimes(2);
        expect(provider.authorizationHeaders).toEqual([undefined, undefined]);
    });

    it('forwards a provider frame larger than the former 4 MiB transport limit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-tui-relay-'));
        const socketPath = join(root, 'tui.sock');
        const token = 'attachment-token-that-is-at-least-thirty-two-bytes';
        const providerResponse = 'p'.repeat((5 * 1024 * 1024) + 37);
        const upstream = await startAuthenticatedUnixServer(socketPath, token, {
            providerResponse,
        });
        const relay = await startCodexGatewayTuiRelay({
            upstreamSocketPath: socketPath,
            bearerToken: token,
        });
        cleanups.push(async () => {
            await relay.close();
            await upstream.close();
            await rm(root, { recursive: true, force: true });
        });

        const client = connectCodexGatewayWebSocket({
            url: relay.remoteUrl,
            bearerToken: token,
        });
        cleanups.push(async () => client.terminate());
        await opened(client);
        const response = nextMessage(client);
        client.send('request-large-provider-frame');
        const received = await response;

        expect(Buffer.byteLength(received, 'utf8')).toBe(Buffer.byteLength(providerResponse, 'utf8'));
        expect(createHash('sha256').update(received).digest('hex')).toBe(
            createHash('sha256').update(providerResponse).digest('hex'),
        );
    });
});

async function startAuthenticatedUnixServer(
    socketPath: string,
    expectedToken: string | null,
    options: {
        providerResponse?: string;
        responseForMessage?: (message: string) => string | null;
    } = {},
): Promise<{
    authorizationHeaders: Array<string | undefined>;
    connections: ReturnType<typeof vi.fn>;
    close(): Promise<void>;
}> {
    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    const authorizationHeaders: Array<string | undefined> = [];
    const connections = vi.fn();
    server.on('upgrade', (request, socket, head) => {
        authorizationHeaders.push(request.headers.authorization);
        const expectedAuthorization = expectedToken ? `Bearer ${expectedToken}` : undefined;
        if (request.headers.authorization !== expectedAuthorization) {
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
        webSocketServer.handleUpgrade(request, socket, head, (client) => {
            webSocketServer.emit('connection', client, request);
        });
    });
    webSocketServer.on('connection', (socket) => {
        connections();
        socket.on('message', (data, isBinary) => {
            const message = data.toString();
            const response = options.responseForMessage
                ? options.responseForMessage(message)
                : options.providerResponse ?? `provider:${message}`;
            if (response === null) return;
            socket.send(response, {
                binary: isBinary,
            });
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    return {
        authorizationHeaders,
        connections,
        close: async () => {
            for (const client of webSocketServer.clients) client.terminate();
            await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
            await closeServer(server);
            await rm(socketPath, { force: true });
        },
    };
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

async function opened(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
}

async function nextMessage(socket: WebSocket): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        socket.once('message', (data) => resolve(data.toString()));
        socket.once('error', reject);
    });
}
