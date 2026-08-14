import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    decryptWebCredential,
    deleteWebCredentialKey,
    encryptWebCredential,
    isEncryptedWebCredential,
    runWithWebCredentialLock,
} from './webCredentialStorage';

describe('webCredentialStorage', () => {
    beforeEach(async () => {
        await deleteWebCredentialKey();
    });

    it('stores only authenticated ciphertext and round-trips the credential payload', async () => {
        const plaintext = JSON.stringify({
            token: 'HOSTILE_WEB_TOKEN_SENTINEL',
            secret: 'HOSTILE_WEB_SECRET_SENTINEL',
        });

        const encrypted = await encryptWebCredential(plaintext);

        expect(isEncryptedWebCredential(encrypted.value)).toBe(true);
        expect(encrypted.value).not.toContain('HOSTILE_WEB_TOKEN_SENTINEL');
        expect(encrypted.value).not.toContain('HOSTILE_WEB_SECRET_SENTINEL');
        await expect(decryptWebCredential(encrypted.value)).resolves.toBe(plaintext);
    });

    it('rejects modified ciphertext', async () => {
        const encrypted = await encryptWebCredential('{"token":"token","secret":"secret"}');
        const envelope = JSON.parse(encrypted.value) as { version: number; data: string };
        const replacement = envelope.data.endsWith('A') ? 'B' : 'A';
        envelope.data = `${envelope.data.slice(0, -1)}${replacement}`;

        await expect(decryptWebCredential(JSON.stringify(envelope))).resolves.toBeNull();
    });

    it('makes retained ciphertext unreadable after credential key deletion', async () => {
        const encrypted = await encryptWebCredential('{"token":"token","secret":"secret"}');

        await deleteWebCredentialKey();

        await expect(decryptWebCredential(encrypted.value)).resolves.toBeNull();
    });

    it('authenticates the durable admission signals with the ciphertext', async () => {
        const encrypted = await encryptWebCredential('{"token":"token","secret":"secret"}', {
            revocationSignal: 'revoked:one',
            bootstrapSignal: null,
        });
        const envelope = JSON.parse(encrypted.value) as {
            version: number;
            data: string;
            revocationSignal: string | null;
            bootstrapSignal: string | null;
        };
        envelope.revocationSignal = 'revoked:two';

        await expect(decryptWebCredential(JSON.stringify(envelope))).resolves.toBeNull();
    });

    it('uses a session-only key when IndexedDB is unavailable', async () => {
        const encrypted = await encryptWebCredential('{"token":"token","secret":"secret"}');

        expect(encrypted.persistent).toBe(false);
    });

    it('falls back to a session-only key when IndexedDB access is rejected', async () => {
        const originalIndexedDb = globalThis.indexedDB;
        const originalNavigator = globalThis.navigator;
        const open = () => { throw new Error('storage policy denied'); };
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: { locks: { request: async <T>(_name: string, callback: () => Promise<T> | T) => callback() } },
        });
        Object.defineProperty(globalThis, 'indexedDB', {
            configurable: true,
            value: { open },
        });

        try {
            const encrypted = await encryptWebCredential('{"token":"token","secret":"secret"}');

            expect(encrypted.persistent).toBe(false);
            await expect(decryptWebCredential(encrypted.value))
                .resolves.toBe('{"token":"token","secret":"secret"}');
        } finally {
            Object.defineProperty(globalThis, 'navigator', {
                configurable: true,
                value: originalNavigator,
            });
            Object.defineProperty(globalThis, 'indexedDB', {
                configurable: true,
                value: originalIndexedDb,
            });
            await deleteWebCredentialKey();
        }
    });

    it('does not rerun an operation that fails after acquiring the Web Lock', async () => {
        const originalNavigator = globalThis.navigator;
        const operation = vi.fn(async () => {
            throw new Error('operation failed');
        });
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                locks: {
                    request: async <T>(_name: string, callback: () => Promise<T> | T) => callback(),
                },
            },
        });

        try {
            await expect(runWithWebCredentialLock(operation)).rejects.toThrow('operation failed');
            expect(operation).toHaveBeenCalledOnce();
        } finally {
            Object.defineProperty(globalThis, 'navigator', {
                configurable: true,
                value: originalNavigator,
            });
        }
    });
});
