import { describe, expect, it, vi } from 'vitest';

const { encryptors } = vi.hoisted(() => ({
    encryptors: [] as Array<{ disposed: boolean; dispose: () => void; encrypt: (values: unknown[]) => Promise<unknown[]>; decrypt: (values: unknown[]) => Promise<unknown[]> }>,
}));

vi.mock('@/encryption/deriveKey', () => ({
    deriveKey: vi.fn(async () => new Uint8Array(32).fill(7)),
}));
vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        crypto_box_seed_keypair: (seed: Uint8Array) => ({ publicKey: seed.slice(), privateKey: seed.slice() }),
    },
}));
vi.mock('@/encryption/libsodium', () => ({ decryptBox: vi.fn(), encryptBox: vi.fn(() => new Uint8Array(48)) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('./encryptor', () => {
    class TestEncryption {
        disposed = false;
        constructor() { encryptors.push(this); }
        async encrypt(values: unknown[]) { return values; }
        async decrypt(values: unknown[]) { return values; }
        dispose() { this.disposed = true; }
    }
    return { AES256Encryption: TestEncryption, BoxEncryption: TestEncryption, SecretBoxEncryption: TestEncryption };
});

import { Encryption } from './encryption';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => { resolve = next; });
    return { promise, resolve };
}

describe('Encryption lifecycle ownership', () => {
    it('does not recreate session context when deletion wins before initialization', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        encryption.removeSessionEncryption('session-1');
        const key = new Uint8Array(32).fill(2);

        await encryption.initializeSessions(new Map([['session-1', key]]));

        expect(encryption.getSessionEncryption('session-1')).toBeNull();
        expect(encryption.getIndependentSessionDataKey('session-1')).toBeNull();
        expect(encryption.getSessionBlobKey('session-1')).toBeNull();
        expect(key).toEqual(new Uint8Array(32));
    });

    it('does not recreate machine context when deletion wins before initialization', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        encryption.removeMachineEncryption('machine-1');
        const key = new Uint8Array(32).fill(2);

        await encryption.initializeMachines(new Map([['machine-1', key]]));

        expect(encryption.getMachineEncryption('machine-1')).toBeNull();
        expect(key).toEqual(new Uint8Array(32));
    });

    it('invalidates an in-flight machine open when deletion settles first', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        const originalOpen = encryption.openEncryption.bind(encryption);
        const opened = deferred<Awaited<ReturnType<typeof originalOpen>>>();
        vi.spyOn(encryption, 'openEncryption').mockImplementationOnce(async () => opened.promise);
        const key = new Uint8Array(32).fill(2);

        const initialization = encryption.initializeMachines(new Map([['machine-1', key]]));
        await Promise.resolve();
        encryption.removeMachineEncryption('machine-1');
        opened.resolve(await originalOpen(key));
        await initialization;

        expect(encryption.getMachineEncryption('machine-1')).toBeNull();
        expect(encryptors.some((entry) => entry.disposed)).toBe(true);
    });

    it('disposes a stale session initialization without clearing the winning context', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        const originalOpen = encryption.openEncryption.bind(encryption);
        const first = deferred<Awaited<ReturnType<typeof originalOpen>>>();
        let calls = 0;
        vi.spyOn(encryption, 'openEncryption').mockImplementation(async (key) => {
            calls += 1;
            if (calls === 1) return first.promise;
            return originalOpen(key);
        });
        const firstKey = new Uint8Array(32).fill(2);
        const firstInit = encryption.initializeSessions(new Map([['session-1', firstKey]]));
        await Promise.resolve();

        const secondKey = new Uint8Array(32).fill(3);
        await encryption.initializeSessions(new Map([['session-1', secondKey]]));
        first.resolve(await originalOpen(firstKey));
        await firstInit;

        expect(encryption.getSessionEncryption('session-1')).not.toBeNull();
        expect(encryption.getIndependentSessionDataKey('session-1')).toEqual(secondKey);
        expect(encryptors.some((entry) => entry.disposed)).toBe(true);
    });

    it('disposes a stale machine initialization without replacing the winning context', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        const originalOpen = encryption.openEncryption.bind(encryption);
        const first = deferred<ReturnType<typeof originalOpen> extends Promise<infer T> ? T : never>();
        let calls = 0;
        vi.spyOn(encryption, 'openEncryption').mockImplementation(async (key) => {
            calls += 1;
            if (calls === 1) return first.promise as never;
            return originalOpen(key);
        });

        const firstInit = encryption.initializeMachines(new Map([['machine-1', new Uint8Array(32).fill(2)]]));
        await Promise.resolve();
        await encryption.initializeMachines(new Map([['machine-1', new Uint8Array(32).fill(3)]]));
        first.resolve(await originalOpen(new Uint8Array(32).fill(2)) as never);
        await firstInit;

        const current = encryption.getMachineEncryption('machine-1');
        expect(current).not.toBeNull();
        expect(encryptors.some((entry) => entry.disposed)).toBe(true);
    });

    it('invalidates session initialization when deletion occurs during blob-key derivation', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        const blobKey = deferred<Uint8Array>();
        const deriveModule = await import('@/encryption/deriveKey');
        vi.mocked(deriveModule.deriveKey).mockImplementationOnce(async () => blobKey.promise);
        const key = new Uint8Array(32).fill(2);

        const initialization = encryption.initializeSessions(new Map([['session-1', key]]));
        await Promise.resolve();
        encryption.removeSessionEncryption('session-1');
        blobKey.resolve(new Uint8Array(32).fill(5));
        await initialization;

        expect(encryption.getSessionEncryption('session-1')).toBeNull();
        expect(encryption.getIndependentSessionDataKey('session-1')).toBeNull();
        expect(encryption.getSessionBlobKey('session-1')).toBeNull();
    });
});
