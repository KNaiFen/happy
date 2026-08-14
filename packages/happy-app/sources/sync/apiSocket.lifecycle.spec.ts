import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getCredentials: vi.fn(),
    io: vi.fn(),
    serverFetch: vi.fn(),
}));

vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('react-native', () => ({
    AppState: { currentState: 'active' },
    Platform: { OS: 'ios' },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.11.48' } } }));
vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: { getCredentials: mocks.getCredentials },
}));
vi.mock('./storage', () => ({
    storage: { getState: () => ({ localSettings: { verboseLogging: false } }) },
}));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => false }));
vi.mock('./serverConfig', () => ({ assertServerUrlAllowed: (value: string) => value }));
vi.mock('./serverTransport', () => ({ serverFetch: mocks.serverFetch }));

import { apiSocket } from './apiSocket';
import {
    AccountOutboundCancelledError,
    beginAccountOutboundLifecycle,
    endAccountOutboundLifecycle,
} from './accountOutboundFence';

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function fakeSocket() {
    const socket = {
        disconnect: vi.fn(),
        emit: vi.fn(),
        emitWithAck: vi.fn(),
        on: vi.fn(),
        onAny: vi.fn(),
        recovered: false,
        timeout: vi.fn(),
    };
    socket.timeout.mockReturnValue(socket);
    return socket;
}

function fakeEncryption(sessionEncryptRaw = vi.fn(async (value: unknown) => value)) {
    return {
        getSessionEncryption: vi.fn(() => ({
            encryptRaw: sessionEncryptRaw,
            decryptRaw: vi.fn(async (value: unknown) => value),
        })),
        getMachineEncryption: vi.fn(),
    };
}

describe('ApiSocket account lifecycle fencing', () => {
    beforeEach(() => {
        mocks.getCredentials.mockReset();
        mocks.io.mockReset();
        mocks.serverFetch.mockReset();
        apiSocket.reset();
        endAccountOutboundLifecycle();
    });

    afterEach(() => {
        apiSocket.reset();
        endAccountOutboundLifecycle();
    });

    it('does not send an old HTTP request after credentials resolve into a new account lifecycle', async () => {
        const oldCredentials = deferred<{ token: string; secret: string } | null>();
        const oldSocket = fakeSocket();
        const newSocket = fakeSocket();
        mocks.io.mockReturnValueOnce(oldSocket).mockReturnValueOnce(newSocket);
        mocks.getCredentials.mockReturnValueOnce(oldCredentials.promise);
        beginAccountOutboundLifecycle('old-token');
        apiSocket.initialize(
            { endpoint: 'https://happy.example', token: 'old-token' },
            fakeEncryption() as never,
        );

        const request = apiSocket.request('/v4/sessions/session-1/mutations', { method: 'POST' });
        endAccountOutboundLifecycle();
        apiSocket.reset();
        beginAccountOutboundLifecycle('new-token');
        apiSocket.initialize(
            { endpoint: 'https://happy.example', token: 'new-token' },
            fakeEncryption() as never,
        );
        oldCredentials.resolve({ token: 'old-token', secret: 'old-secret' });

        await expect(request).rejects.toBeInstanceOf(AccountOutboundCancelledError);
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('does not emit an old RPC after encryption resolves into a new account lifecycle', async () => {
        const encrypted = deferred<unknown>();
        const encryptionStarted = deferred<void>();
        const oldSocket = fakeSocket();
        const newSocket = fakeSocket();
        mocks.io.mockReturnValueOnce(oldSocket).mockReturnValueOnce(newSocket);
        beginAccountOutboundLifecycle('old-token');
        apiSocket.initialize(
            { endpoint: 'https://happy.example', token: 'old-token' },
            fakeEncryption(vi.fn(() => {
                encryptionStarted.resolve();
                return encrypted.promise;
            })) as never,
        );

        const rpc = apiSocket.sessionRPC('session-1', 'write', { value: 'payload' });
        await encryptionStarted.promise;
        endAccountOutboundLifecycle();
        apiSocket.reset();
        beginAccountOutboundLifecycle('new-token');
        apiSocket.initialize(
            { endpoint: 'https://happy.example', token: 'new-token' },
            fakeEncryption() as never,
        );
        encrypted.resolve('ciphertext');

        await expect(rpc).rejects.toBeInstanceOf(AccountOutboundCancelledError);
        expect(oldSocket.emitWithAck).not.toHaveBeenCalled();
        expect(newSocket.emitWithAck).not.toHaveBeenCalled();
    });

    it('does not send an old app-state hint through a new account socket', () => {
        const oldSocket = fakeSocket();
        const newSocket = fakeSocket();
        mocks.io.mockReturnValueOnce(oldSocket).mockReturnValueOnce(newSocket);
        beginAccountOutboundLifecycle('old-token');
        const oldPermit = apiSocket.initialize(
            { endpoint: 'https://happy.example', token: 'old-token' },
            fakeEncryption() as never,
        );

        endAccountOutboundLifecycle();
        apiSocket.reset();
        beginAccountOutboundLifecycle('new-token');
        apiSocket.initialize(
            { endpoint: 'https://happy.example', token: 'new-token' },
            fakeEncryption() as never,
        );

        expect(() => apiSocket.sendAppState('background', oldPermit))
            .toThrow(AccountOutboundCancelledError);
        expect(oldSocket.emit).not.toHaveBeenCalled();
        expect(newSocket.emit).not.toHaveBeenCalled();
    });
});
