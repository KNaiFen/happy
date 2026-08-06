import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CodexAppServerClient,
    CodexRpcOutcomeUnknownError,
    isCodexThreadUnavailableRpcResponse,
} from './codexAppServerClient';
import { connectCodexAppServerWebSocket } from './codexAppServerWebSocket';

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
        expect(provider.extensionOffers()).toEqual([undefined]);
    });

    it('treats only the exact stable no-rollout resume error as not materialized', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-client-ws-'));
        const socketPath = join(root, 'provider.sock');
        let materialized = false;
        const provider = await startProvider(socketPath, (socket, message) => {
            if (message.method === 'initialize') {
                socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'test' } }));
            }
            if (message.method !== 'thread/resume') return;
            if (!materialized) {
                socket.send(JSON.stringify({
                    id: message.id,
                    error: {
                        code: -32600,
                        message: 'no rollout found for thread id thread-fresh',
                    },
                }));
                return;
            }
            socket.send(JSON.stringify({
                id: message.id,
                result: {
                    thread: {
                        id: 'thread-fresh',
                        turns: [{ id: 'turn-1', items: [], status: 'completed', error: null }],
                        status: { type: 'idle' },
                    },
                    model: 'gpt-test',
                    modelProvider: 'openai',
                    cwd: '/tmp/project',
                    approvalPolicy: 'never',
                    sandbox: { type: 'readOnly' },
                    reasoningEffort: null,
                },
            }));
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

        await expect(client.subscribeThreadIfMaterialized('thread-fresh')).resolves.toBeNull();
        materialized = true;
        await expect(client.subscribeThreadIfMaterialized('thread-fresh')).resolves.toMatchObject({
            threadId: 'thread-fresh',
            thread: { turns: [expect.objectContaining({ id: 'turn-1' })] },
        });
    });

    it('does not suppress a different thread/resume protocol error', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-client-ws-'));
        const socketPath = join(root, 'provider.sock');
        const provider = await startProvider(socketPath, (socket, message) => {
            if (message.method === 'initialize') {
                socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'test' } }));
            }
            if (message.method === 'thread/resume') {
                socket.send(JSON.stringify({
                    id: message.id,
                    error: {
                        code: -32600,
                        message: 'no rollout found for thread id another-thread',
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

        await expect(client.subscribeThreadIfMaterialized('thread-fresh'))
            .rejects.toThrow('thread/resume failed (code=-32600)');
    });

    it('recognizes only the exact thread lookup failure as unavailable', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-client-ws-'));
        const socketPath = join(root, 'provider.sock');
        const provider = await startProvider(socketPath, (socket, message) => {
            if (message.method === 'initialize') {
                socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'test' } }));
            }
            if (message.method === 'thread/read') {
                const params = message.params as { threadId?: unknown } | undefined;
                socket.send(JSON.stringify({
                    id: message.id,
                    error: {
                        code: -32600,
                        message: params?.threadId === 'thread-missing'
                            ? 'no rollout found for thread id thread-missing'
                            : 'provider temporarily unavailable',
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

        const missing = await client.readThread({ threadId: 'thread-missing' })
            .catch((error: unknown) => error);
        const providerFailure = await client.readThread({ threadId: 'thread-other' })
            .catch((error: unknown) => error);

        expect(isCodexThreadUnavailableRpcResponse(missing, 'thread-missing')).toBe(true);
        expect(isCodexThreadUnavailableRpcResponse(providerFailure, 'thread-other')).toBe(false);
    });

    it('does not offer compression on loopback WebSocket endpoints', async () => {
        const provider = await startLoopbackUpgradeRecorder();
        cleanups.push(provider.close);
        const socket = connectCodexAppServerWebSocket({
            url: provider.url,
            bearerToken: 'test-token',
        });
        socket.on('error', () => undefined);
        await provider.upgraded;
        expect(provider.extensionOffers()).toEqual([undefined]);
        socket.terminate();
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

    it('keeps a passive stable server request unanswered for another subscriber', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-client-ws-'));
        const socketPath = join(root, 'provider.sock');
        const messages: Array<Record<string, unknown>> = [];
        const provider = await startProvider(socketPath, (socket, message) => {
            messages.push(message);
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
        client.setServerRequestHandler(async () => null);
        cleanups.push(async () => client.disconnect());
        await client.connect();

        provider.clients()[0]?.send(JSON.stringify({
            id: 99,
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a' },
        }));
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(messages.some((message) => message.id === 99)).toBe(false);
    });
});

async function startProvider(
    socketPath: string,
    onMessage: (socket: WebSocket, message: Record<string, unknown>) => void,
): Promise<{
    clients(): WebSocket[];
    extensionOffers(): Array<string | string[] | undefined>;
    close(): Promise<void>;
}> {
    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    const extensionOffers: Array<string | string[] | undefined> = [];
    server.on('upgrade', (request, socket, head) => {
        extensionOffers.push(request.headers['sec-websocket-extensions']);
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
        extensionOffers: () => [...extensionOffers],
        close: async () => {
            for (const client of webSocketServer.clients) client.terminate();
            await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
            await closeServer(server);
            await rm(socketPath, { force: true });
        },
    };
}

async function startLoopbackUpgradeRecorder(): Promise<{
    url: string;
    upgraded: Promise<void>;
    extensionOffers(): Array<string | string[] | undefined>;
    close(): Promise<void>;
}> {
    const server = createServer();
    const extensionOffers: Array<string | string[] | undefined> = [];
    let resolveUpgrade!: () => void;
    const upgraded = new Promise<void>((resolve) => {
        resolveUpgrade = resolve;
    });
    server.on('upgrade', (request, socket) => {
        extensionOffers.push(request.headers['sec-websocket-extensions']);
        socket.destroy();
        resolveUpgrade();
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Loopback test provider did not expose a TCP address');
    }
    return {
        url: `ws://127.0.0.1:${address.port}`,
        upgraded,
        extensionOffers: () => [...extensionOffers],
        close: async () => closeServer(server),
    };
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}
