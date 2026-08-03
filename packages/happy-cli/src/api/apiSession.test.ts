import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiSessionClient } from './apiSession';
import { encodeBase64, encrypt } from './encryption';
import { SyncV4Client } from './syncV4Client';

const mocks = vi.hoisted(() => ({
    io: vi.fn(),
    axiosGet: vi.fn(),
    axiosPost: vi.fn(),
    shouldReconnect: vi.fn(() => true),
}));

vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('axios', () => ({
    default: {
        get: mocks.axiosGet,
        post: mocks.axiosPost,
    },
}));
vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'https://server.test',
        currentCliVersion: '1.4.36',
    },
}));
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));
vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
    },
}));
vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn(),
}));
vi.mock('@/utils/lidState', () => ({
    shouldReconnect: mocks.shouldReconnect,
}));

type SocketHandler = (...args: any[]) => void;

class Deferred<T> {
    readonly promise: Promise<T>;
    private resolvePromise!: (value: T | PromiseLike<T>) => void;

    constructor() {
        this.promise = new Promise<T>((resolve) => {
            this.resolvePromise = resolve;
        });
    }

    resolve(value: T): void {
        this.resolvePromise(value);
    }
}

function makeSession() {
    return {
        id: 'test-session-id',
        seq: 0,
        metadata: {
            path: '/tmp',
            host: 'localhost',
            machineId: 'machine-1',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib',
            happyToolsDir: '/home/user/.happy/tools',
            flavor: 'codex',
            codexSyncVersion: 4 as const,
        },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy' as const,
    };
}

function syncClient(overrides: Partial<SyncV4Client> = {}): SyncV4Client {
    return {
        start: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        invalidate: vi.fn(),
        ...overrides,
    } as unknown as SyncV4Client;
}

describe('ApiSessionClient Codex V4 control plane', () => {
    let handlers: Record<string, SocketHandler[]>;
    let socket: {
        connected: boolean;
        connect: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        emitWithAck: ReturnType<typeof vi.fn>;
    };
    let session: ReturnType<typeof makeSession>;

    const emit = (event: string, ...args: any[]) => {
        for (const handler of handlers[event] ?? []) handler(...args);
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.io.mockReset();
        mocks.axiosGet.mockReset();
        mocks.axiosPost.mockReset();
        mocks.shouldReconnect.mockReset();
        mocks.shouldReconnect.mockReturnValue(true);
        handlers = {};
        session = makeSession();
        socket = {
            connected: true,
            connect: vi.fn(),
            close: vi.fn(),
            on: vi.fn((event: string, handler: SocketHandler) => {
                (handlers[event] ??= []).push(handler);
            }),
            emitWithAck: vi.fn(async () => ({ result: 'error' })),
        };
        mocks.io.mockReturnValue(socket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('connects the session RPC socket and registers V4 invalidations', () => {
        const client = new ApiSessionClient('fake-token', session);
        const v4 = syncClient();
        (client as unknown as { syncV4Client: SyncV4Client }).syncV4Client = v4;

        emit('ephemeral', { type: 'sync-v4-invalidate', sessionId: session.id, highWatermark: '42' });
        emit('ephemeral', { type: 'sync-v4-invalidate', sessionId: 'other', highWatermark: 42 });
        expect(v4.invalidate).not.toHaveBeenCalled();

        emit('ephemeral', { type: 'sync-v4-invalidate', sessionId: session.id, highWatermark: 42 });
        expect(v4.invalidate).toHaveBeenCalledWith(42);
        expect(socket.connect).toHaveBeenCalledOnce();
    });

    it('installs the entity handler before starting Sync V4', async () => {
        const order: string[] = [];
        const v4 = syncClient({
            start: vi.fn(async () => { order.push('start'); }),
        });
        vi.spyOn(SyncV4Client, 'create').mockResolvedValue(v4);
        const client = new ApiSessionClient('fake-token', session);

        await client.enableSyncV4(() => {
            order.push('handler');
            return async () => undefined;
        });

        expect(order).toEqual(['handler', 'start']);
        await client.close();
        expect(v4.close).toHaveBeenCalledOnce();
    });

    it('forwards only the authoritative V4 archive tombstone', async () => {
        const v4 = syncClient();
        const create = vi.spyOn(SyncV4Client, 'create').mockResolvedValue(v4);
        const client = new ApiSessionClient('fake-token', session);
        const archived = vi.fn();
        client.on('archived', archived);
        await client.enableSyncV4(() => async () => undefined);

        const legacyMetadata = { ...session.metadata, lifecycleState: 'archived' };
        emit('update', {
            body: {
                t: 'update-session',
                metadata: {
                    value: encodeBase64(encrypt(
                        session.encryptionKey,
                        session.encryptionVariant,
                        legacyMetadata,
                    )),
                    version: 1,
                },
            },
        });
        expect(archived).not.toHaveBeenCalled();

        const options = create.mock.calls[0][0] as { onSessionArchived?: () => void };
        options.onSessionArchived?.();
        expect(archived).toHaveBeenCalledOnce();
        await client.close();
    });

    it('requires a machine identity before starting Sync V4', async () => {
        const create = vi.spyOn(SyncV4Client, 'create');
        const client = new ApiSessionClient('fake-token', session);
        (client as unknown as { metadata: null }).metadata = null;

        await expect(client.enableSyncV4(() => async () => undefined))
            .rejects.toThrow('requires a machine identity');
        expect(create).not.toHaveBeenCalled();
        await client.close();
    });

    it('shares concurrent Sync V4 initialization', async () => {
        const created = new Deferred<SyncV4Client>();
        const v4 = syncClient();
        const create = vi.spyOn(SyncV4Client, 'create').mockReturnValue(created.promise);
        const client = new ApiSessionClient('fake-token', session);
        const createHandler = vi.fn(() => async () => undefined);

        const first = client.enableSyncV4(createHandler);
        const second = client.enableSyncV4(createHandler);
        created.resolve(v4);

        await expect(Promise.all([first, second])).resolves.toEqual([v4, v4]);
        expect(create).toHaveBeenCalledOnce();
        expect(createHandler).toHaveBeenCalledOnce();
        await client.close();
    });

    it('closes a client that finishes initialization after the session closes', async () => {
        const created = new Deferred<SyncV4Client>();
        const v4 = syncClient();
        vi.spyOn(SyncV4Client, 'create').mockReturnValue(created.promise);
        const client = new ApiSessionClient('fake-token', session);

        const enabling = client.enableSyncV4(() => async () => undefined);
        await client.close();
        created.resolve(v4);

        await expect(enabling).rejects.toThrow('API session has been closed');
        expect(v4.start).not.toHaveBeenCalled();
        expect(v4.close).toHaveBeenCalledOnce();
    });

    it('never reconnects after close', async () => {
        vi.useFakeTimers();
        socket.connected = false;
        const client = new ApiSessionClient('fake-token', session);

        emit('connect_error', new Error('offline'));
        await client.close();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(socket.connect).toHaveBeenCalledOnce();
    });

    it('does not send bearer credentials to a lookalike attachment origin', async () => {
        mocks.axiosPost.mockResolvedValueOnce({
            data: { downloadUrl: 'https://server.test.evil.example/download' },
        });
        mocks.axiosGet.mockResolvedValueOnce({ data: new Uint8Array([1, 2, 3]).buffer });
        const client = new ApiSessionClient('fake-token', session);

        await client.downloadAttachment('attachment-ref');

        expect(mocks.axiosGet).toHaveBeenCalledWith(
            'https://server.test.evil.example/download',
            expect.objectContaining({ headers: {} }),
        );
        await client.close();
    });
});
