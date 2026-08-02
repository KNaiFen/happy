import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexGatewayThreadLeaseConflictError } from './codexGatewayLease';
import { CodexGatewayProxy, connectCodexGatewayWebSocket } from './codexGatewayProxy';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Codex Gateway JSON-RPC proxy', () => {
    it('starts and closes without an attached terminal', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-proxy-'));
        const upstreamPath = join(root, 'upstream.sock');
        const downstreamPath = join(root, 'downstream.sock');
        const upstream = await startWebSocketServer(upstreamPath, () => undefined);
        const proxy = new CodexGatewayProxy(
            { socketPath: downstreamPath },
            { socketPath: upstreamPath },
        );
        await proxy.start();
        await proxy.close();
        await upstream.close();
        await rm(root, { recursive: true, force: true });
    });

    it('passes ordinary traffic unchanged and observes successful root bindings', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-proxy-'));
        const upstreamPath = join(root, 'upstream.sock');
        const downstreamPath = join(root, 'downstream.sock');
        const upstreamMessages: string[] = [];
        const upstream = await startWebSocketServer(upstreamPath, (socket) => {
            socket.on('message', (data) => {
                const text = data.toString();
                upstreamMessages.push(text);
                const request = JSON.parse(text) as { id: number; method: string };
                if (request.method === 'initialize') socket.send(JSON.stringify({ id: request.id, result: { userAgent: 'test' } }));
                if (request.method === 'thread/resume') socket.send(JSON.stringify({
                    id: request.id,
                    result: { thread: { id: 'thread-1' } },
                }));
            });
        });
        const rootBound = vi.fn();
        const proxy = new CodexGatewayProxy(
            { socketPath: downstreamPath },
            { socketPath: upstreamPath },
            { rootBound },
        );
        await proxy.start();
        cleanups.push(async () => { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); });
        const client = connectCodexGatewayWebSocket({ socketPath: downstreamPath });
        cleanups.push(async () => { client.close(); });
        await opened(client);

        client.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }));
        expect(await nextMessage(client)).toBe('{"id":1,"result":{"userAgent":"test"}}');
        client.send(JSON.stringify({ id: 2, method: 'thread/resume', params: { threadId: 'thread-1' } }));
        expect(await nextMessage(client)).toBe('{"id":2,"result":{"thread":{"id":"thread-1"}}}');
        await vi.waitFor(() => expect(rootBound).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 2,
            method: 'thread/resume',
            requestedThreadId: 'thread-1',
            threadId: 'thread-1',
        })));
        expect(upstreamMessages).toEqual([
            '{"id":1,"method":"initialize","params":{}}',
            '{"id":2,"method":"thread/resume","params":{"threadId":"thread-1"}}',
        ]);
    });

    it('rejects a conflicting resume before it reaches the provider', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-proxy-'));
        const upstreamPath = join(root, 'upstream.sock');
        const downstreamPath = join(root, 'downstream.sock');
        const upstreamMessage = vi.fn();
        const upstream = await startWebSocketServer(upstreamPath, (socket) => socket.on('message', upstreamMessage));
        const proxy = new CodexGatewayProxy(
            { socketPath: downstreamPath },
            { socketPath: upstreamPath },
            {
                beforeRootRequest: () => {
                    throw new CodexGatewayThreadLeaseConflictError('other-gateway');
                },
            },
        );
        await proxy.start();
        cleanups.push(async () => { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); });
        const client = connectCodexGatewayWebSocket({ socketPath: downstreamPath });
        cleanups.push(async () => { client.close(); });
        await opened(client);

        client.send(JSON.stringify({ id: 7, method: 'thread/resume', params: { threadId: 'thread-1' } }));
        expect(JSON.parse(await nextMessage(client))).toMatchObject({
            id: 7,
            error: { code: -32040, message: expect.stringContaining('happy codex attach') },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(upstreamMessage).not.toHaveBeenCalled();
    });

    it('preserves terminal request order while a root preflight is pending', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-proxy-'));
        const upstreamPath = join(root, 'upstream.sock');
        const downstreamPath = join(root, 'downstream.sock');
        const upstreamMessages: string[] = [];
        const upstream = await startWebSocketServer(upstreamPath, (socket) => {
            socket.on('message', (data) => upstreamMessages.push(data.toString()));
        });
        let releasePreflight: (() => void) | undefined;
        const preflight = new Promise<void>((resolve) => { releasePreflight = resolve; });
        const proxy = new CodexGatewayProxy(
            { socketPath: downstreamPath },
            { socketPath: upstreamPath },
            { beforeRootRequest: () => preflight },
        );
        await proxy.start();
        cleanups.push(async () => { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); });
        const client = connectCodexGatewayWebSocket({ socketPath: downstreamPath });
        cleanups.push(async () => { client.close(); });
        await opened(client);

        client.send(JSON.stringify({ id: 1, method: 'thread/resume', params: { threadId: 'thread-1' } }));
        client.send(JSON.stringify({ id: 2, method: 'turn/start', params: {} }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(upstreamMessages).toEqual([]);
        releasePreflight?.();
        await vi.waitFor(() => expect(upstreamMessages).toEqual([
            '{"id":1,"method":"thread/resume","params":{"threadId":"thread-1"}}',
            '{"id":2,"method":"turn/start","params":{}}',
        ]));
    });

    it('passes binary frames through without coercing their payload', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-proxy-'));
        const upstreamPath = join(root, 'upstream.sock');
        const downstreamPath = join(root, 'downstream.sock');
        const upstream = await startWebSocketServer(upstreamPath, (socket) => {
            socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
        });
        const proxy = new CodexGatewayProxy(
            { socketPath: downstreamPath },
            { socketPath: upstreamPath },
        );
        await proxy.start();
        cleanups.push(async () => { await proxy.close(); await upstream.close(); await rm(root, { recursive: true, force: true }); });
        const client = connectCodexGatewayWebSocket({ socketPath: downstreamPath });
        cleanups.push(async () => { client.close(); });
        await opened(client);

        const response = nextRawMessage(client);
        client.send(Buffer.from([0, 1, 2, 255]), { binary: true });
        await expect(response).resolves.toEqual({ data: Buffer.from([0, 1, 2, 255]), isBinary: true });
    });
});

async function startWebSocketServer(
    socketPath: string,
    onConnection: (socket: WebSocket) => void,
): Promise<{ close(): Promise<void> }> {
    const server = createServer();
    const websocket = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
        websocket.handleUpgrade(request, socket, head, (client) => websocket.emit('connection', client, request));
    });
    websocket.on('connection', onConnection);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    return {
        close: async () => {
            for (const client of websocket.clients) client.close();
            await new Promise<void>((resolve) => websocket.close(() => resolve()));
            await closeServer(server);
            await rm(socketPath, { force: true });
        },
    };
}

async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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

async function nextRawMessage(socket: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
    return await new Promise((resolve, reject) => {
        socket.once('message', (data, isBinary) => resolve({ data: Buffer.from(data as Buffer), isBinary }));
        socket.once('error', reject);
    });
}
