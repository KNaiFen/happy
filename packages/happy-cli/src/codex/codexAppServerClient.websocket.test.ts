import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CodexAppServerClient,
    CodexRpcOutcomeUnknownError,
} from './codexAppServerClient';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('CodexAppServerClient external WebSocket transport', () => {
    it('initializes and resumes through a separate Unix WebSocket subscriber', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-client-ws-'));
        const socketPath = join(root, 'provider.sock');
        const messages: Array<Record<string, unknown>> = [];
        const provider = await startProvider(socketPath, (socket, message) => {
            messages.push(message);
            if (message.method === 'initialize') {
                socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'test' } }));
            }
            if (message.method === 'thread/resume') {
                socket.send(JSON.stringify({
                    id: message.id,
                    result: {
                        thread: {
                            id: 'thread-websocket',
                            turns: [],
                            status: { type: 'idle' },
                        },
                        model: 'gpt-test',
                        modelProvider: 'openai',
                        cwd: '/tmp/project',
                        approvalPolicy: 'on-request',
                        sandbox: { type: 'readOnly' },
                        reasoningEffort: null,
                    },
                }));
            }
        });
        cleanups.push(async () => {
            await provider.close();
            await rm(root, { recursive: true, force: true });
        });

        const client = new CodexAppServerClient(
            undefined,
            { major: 0, minor: 145, patch: 0 },
            { webSocketEndpoint: { socketPath } },
        );
        cleanups.push(async () => client.disconnect());
        await client.connect();
        const resumed = await client.subscribeThread('thread-websocket');

        expect(resumed.threadId).toBe('thread-websocket');
        expect(messages.map((message) => message.method)).toEqual([
            'initialize',
            'initialized',
            'thread/resume',
        ]);
        expect(messages[0]).toMatchObject({
            params: { capabilities: { experimentalApi: false } },
        });
        expect(messages[2]).toMatchObject({
            method: 'thread/resume',
            params: {
                threadId: 'thread-websocket',
                model: null,
                cwd: null,
                approvalPolicy: null,
                sandbox: null,
                config: null,
            },
        });
    });

    it('marks an in-flight RPC unknown when only the bridge socket closes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-client-ws-'));
        const socketPath = join(root, 'provider.sock');
        const provider = await startProvider(socketPath, (socket, message) => {
            if (message.method === 'initialize') {
                socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'test' } }));
            }
        });
        cleanups.push(async () => {
            await provider.close();
            await rm(root, { recursive: true, force: true });
        });
        const client = new CodexAppServerClient(
            undefined,
            { major: 0, minor: 145, patch: 0 },
            { webSocketEndpoint: { socketPath } },
        );
        const connectionStates: string[] = [];
        client.setConnectionHandler((event) => connectionStates.push(event.connection));
        cleanups.push(async () => client.disconnect());
        await client.connect();

        const pending = client.listModels({ timeoutMs: 10_000 });
        await vi.waitFor(() => expect(provider.clients().length).toBe(1));
        provider.clients()[0]?.terminate();

        await expect(pending).rejects.toBeInstanceOf(CodexRpcOutcomeUnknownError);
        expect(connectionStates.at(-1)).toBe('disconnected');
    });
});

async function startProvider(
    socketPath: string,
    onMessage: (socket: WebSocket, message: Record<string, unknown>) => void,
): Promise<{ clients(): WebSocket[]; close(): Promise<void> }> {
    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
        webSocketServer.handleUpgrade(request, socket, head, (client) => {
            webSocketServer.emit('connection', client, request);
        });
    });
    webSocketServer.on('connection', (socket) => {
        socket.on('message', (data, isBinary) => {
            expect(isBinary).toBe(false);
            const text = data.toString();
            expect(text.endsWith('\n')).toBe(false);
            onMessage(socket, JSON.parse(text) as Record<string, unknown>);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    return {
        clients: () => [...webSocketServer.clients],
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
