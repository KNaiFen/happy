import { beforeEach, describe, expect, it, vi } from 'vitest';

const { platform, secureStore, asyncStorage } = vi.hoisted(() => ({
    platform: { os: 'ios' },
    secureStore: {
        getItemAsync: vi.fn(),
        setItemAsync: vi.fn(),
        deleteItemAsync: vi.fn(),
    },
    asyncStorage: {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
    },
}));

vi.mock('react-native', () => ({ Platform: { get OS() { return platform.os; } } }));
vi.mock('expo-secure-store', () => secureStore);
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }));

import { TokenStorage } from './tokenStorage';
import { deleteWebCredentialKey } from './webCredentialStorage';

describe('TokenStorage credential revocation', () => {
    beforeEach(async () => {
        platform.os = 'ios';
        secureStore.getItemAsync.mockReset();
        secureStore.setItemAsync.mockReset();
        secureStore.deleteItemAsync.mockReset();
        asyncStorage.getItem.mockReset();
        asyncStorage.setItem.mockReset();
        asyncStorage.removeItem.mockReset();
        secureStore.getItemAsync.mockResolvedValue(null);
        secureStore.setItemAsync.mockResolvedValue(undefined);
        secureStore.deleteItemAsync.mockResolvedValue(undefined);
        asyncStorage.getItem.mockResolvedValue(null);
        asyncStorage.setItem.mockResolvedValue(undefined);
        asyncStorage.removeItem.mockResolvedValue(undefined);
        const originalLocalStorage = globalThis.localStorage;
        const stored = new Map<string, string>();
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: (key: string) => stored.get(key) ?? null,
                setItem: (key: string, value: string) => stored.set(key, value),
                removeItem: (key: string) => stored.delete(key),
            },
        });
        platform.os = 'web';
        await TokenStorage.removeCredentials();
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
        platform.os = 'ios';
        await deleteWebCredentialKey();
    });

    it('keeps a native revocation marker fail-closed while retrying credential deletion', async () => {
        asyncStorage.getItem.mockResolvedValue('1');

        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
        expect(secureStore.deleteItemAsync).not.toHaveBeenCalledWith('auth_credentials');
        await expect(TokenStorage.hasCredentialsRevoked()).resolves.toBe(true);
    });

    it('treats any existing native marker value as revoked', async () => {
        secureStore.getItemAsync.mockResolvedValue('damaged-marker');

        await expect(TokenStorage.hasCredentialsRevoked()).resolves.toBe(true);
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
        expect(secureStore.deleteItemAsync).not.toHaveBeenCalledWith('auth_credentials');
    });

    it('clears a marker only after a successful new credential write', async () => {
        await expect(TokenStorage.setCredentials({ token: 'new-token', secret: 'new-secret' })).resolves.toBe(true);

        expect(secureStore.setItemAsync).toHaveBeenCalledWith('auth_credentials_revoked', '1');
        expect(asyncStorage.setItem).toHaveBeenCalledWith('auth_credentials_revoked', '1');
        expect(secureStore.setItemAsync).toHaveBeenCalledWith(
            'auth_credentials',
            JSON.stringify({ token: 'new-token', secret: 'new-secret' }),
        );
        expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('auth_credentials_revoked');
        expect(asyncStorage.removeItem).toHaveBeenCalledWith('auth_credentials_revoked');
    });

    it('rejects a normal credential commit when revocation wins during the native write', async () => {
        let finishCredentialWrite!: () => void;
        const credentialWrite = new Promise<void>((resolve) => {
            finishCredentialWrite = resolve;
        });
        secureStore.setItemAsync.mockImplementation((key: string) => (
            key === 'auth_credentials' ? credentialWrite : Promise.resolve()
        ));

        const save = TokenStorage.setCredentials({ token: 'new-token', secret: 'new-secret' });
        await vi.waitFor(() => expect(secureStore.setItemAsync).toHaveBeenCalledWith(
            'auth_credentials',
            JSON.stringify({ token: 'new-token', secret: 'new-secret' }),
        ));

        await expect(TokenStorage.markCredentialsRevoked()).resolves.toBe(true);
        finishCredentialWrite();

        await expect(save).resolves.toBe(false);
        expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('auth_credentials');
        expect(secureStore.setItemAsync).toHaveBeenCalledWith('auth_credentials_revoked', '1');
        expect(asyncStorage.setItem).toHaveBeenCalledWith('auth_credentials_revoked', '1');
    });

    it('rejects E2E bootstrap credentials when a revocation races the credential write', async () => {
        let finishCredentialWrite!: () => void;
        const credentialWrite = new Promise<void>((resolve) => {
            finishCredentialWrite = resolve;
        });
        secureStore.setItemAsync.mockImplementation((key: string) => (
            key === 'auth_credentials' ? credentialWrite : Promise.resolve()
        ));

        const bootstrap = TokenStorage.setE2EBootstrapCredentialsIfNotRevoked({
            token: 'bootstrap-token',
            secret: 'bootstrap-secret',
        });
        await vi.waitFor(() => expect(secureStore.setItemAsync).toHaveBeenCalledWith(
            'auth_credentials',
            JSON.stringify({ token: 'bootstrap-token', secret: 'bootstrap-secret' }),
        ));

        await expect(TokenStorage.markCredentialsRevoked()).resolves.toBe(true);
        finishCredentialWrite();

        await expect(bootstrap).resolves.toBe(false);
        expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('auth_credentials');
        expect(secureStore.setItemAsync).toHaveBeenCalledWith('auth_credentials_revoked', '1');
        expect(asyncStorage.setItem).toHaveBeenCalledWith('auth_credentials_revoked', '1');
    });

    it('never clears an existing marker for E2E bootstrap credentials', async () => {
        asyncStorage.getItem.mockResolvedValue('1');

        await expect(TokenStorage.setE2EBootstrapCredentialsIfNotRevoked({
            token: 'bootstrap-token',
            secret: 'bootstrap-secret',
        })).resolves.toBe(false);

        expect(secureStore.setItemAsync).not.toHaveBeenCalledWith('auth_credentials', expect.any(String));
        expect(secureStore.deleteItemAsync).not.toHaveBeenCalledWith('auth_credentials_revoked');
        expect(asyncStorage.removeItem).not.toHaveBeenCalledWith('auth_credentials_revoked');
    });

    it('leaves a bootstrap fence when credential commit cleanup is interrupted', async () => {
        secureStore.deleteItemAsync.mockImplementation(async (key: string) => {
            if (key === 'auth_credentials_bootstrap_pending') throw new Error('cleanup interrupted');
        });

        await expect(TokenStorage.setE2EBootstrapCredentialsIfNotRevoked({
            token: 'bootstrap-token',
            secret: 'bootstrap-secret',
        })).resolves.toBe(false);

        expect(secureStore.setItemAsync).toHaveBeenCalledWith('auth_credentials_bootstrap_pending', '1');
        expect(asyncStorage.setItem).toHaveBeenCalledWith('auth_credentials_bootstrap_pending', '1');
        expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('auth_credentials');
    });

    it('treats an unfinished native bootstrap as revoked', async () => {
        asyncStorage.getItem.mockImplementation(async (key: string) => (
            key === 'auth_credentials_bootstrap_pending' ? '1' : null
        ));

        await expect(TokenStorage.hasCredentialsRevoked()).resolves.toBe(true);
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
    });

    it('does not report removal success when SecureStore rejects deletion', async () => {
        secureStore.deleteItemAsync.mockRejectedValueOnce(new Error('unavailable'));

        await expect(TokenStorage.removeCredentials()).resolves.toBe(false);
    });

    it('retains the revocation marker when a credential write is incomplete', async () => {
        secureStore.deleteItemAsync.mockImplementation(async (key: string) => {
            if (key === 'auth_credentials_revoked') throw new Error('marker unavailable');
        });

        await expect(TokenStorage.setCredentials({ token: 'new-token', secret: 'new-secret' })).resolves.toBe(false);
        expect(secureStore.setItemAsync).toHaveBeenCalledWith('auth_credentials_revoked', '1');
        expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('auth_credentials');
    });

    it('restores markers when cleanup partly succeeds and credential deletion fails', async () => {
        secureStore.deleteItemAsync.mockImplementation(async (key: string) => {
            if (key === 'auth_credentials') throw new Error('credential cleanup unavailable');
        });
        asyncStorage.removeItem.mockRejectedValueOnce(new Error('marker cleanup uncertain'));

        await expect(TokenStorage.setCredentials({ token: 'new-token', secret: 'new-secret' })).resolves.toBe(false);

        expect(asyncStorage.removeItem).toHaveBeenCalledWith('auth_credentials_revoked');
        expect(secureStore.setItemAsync).toHaveBeenCalledWith('auth_credentials_revoked', '1');
        expect(asyncStorage.setItem).toHaveBeenCalledWith('auth_credentials_revoked', '1');
        expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('auth_credentials');
    });

    it('persists revocation when SecureStore and credential deletion both fail', async () => {
        secureStore.setItemAsync.mockRejectedValueOnce(new Error('secure marker unavailable'));
        secureStore.deleteItemAsync.mockRejectedValueOnce(new Error('credential unavailable'));

        await expect(TokenStorage.markCredentialsRevoked()).resolves.toBe(true);
        await expect(TokenStorage.removeCredentials()).resolves.toBe(false);
        expect(asyncStorage.setItem).toHaveBeenCalledWith('auth_credentials_revoked', '1');

        asyncStorage.getItem.mockResolvedValueOnce('1');
        await expect(TokenStorage.hasCredentialsRevoked()).resolves.toBe(true);
    });

    it('fails closed when web localStorage throws or contains malformed data', async () => {
        platform.os = 'web';
        const originalLocalStorage = globalThis.localStorage;
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: vi.fn(() => { throw new Error('denied'); }),
                removeItem: vi.fn(() => { throw new Error('denied'); }),
                setItem: vi.fn(() => { throw new Error('denied'); }),
            },
        });

        await expect(TokenStorage.hasCredentialsRevoked()).resolves.toBe(true);
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
        await expect(TokenStorage.removeCredentials()).resolves.toBe(false);

        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
    });

    it('does not report Web revocation success without a shared admission signal', async () => {
        platform.os = 'web';
        const originalLocalStorage = globalThis.localStorage;
        const stored = new Map<string, string>([
            ['auth_credentials', 'old-encrypted-payload'],
        ]);
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: vi.fn((key: string) => stored.get(key) ?? null),
                setItem: vi.fn((key: string, value: string) => {
                    if (key === 'auth_credentials_revoked') throw new Error('quota exceeded');
                    stored.set(key, value);
                }),
                removeItem: vi.fn((key: string) => stored.delete(key)),
            },
        });

        await expect(TokenStorage.markCredentialsRevoked()).resolves.toBe(false);

        expect(stored.has('auth_credentials_revoked')).toBe(false);
        expect(stored.has('auth_credentials')).toBe(false);
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
    });

    it('treats any existing web marker as revoked without deleting credentials while reading', async () => {
        platform.os = 'web';
        const originalLocalStorage = globalThis.localStorage;
        const getItem = vi.fn((key: string) => key === 'auth_credentials_revoked' ? 'damaged-marker' : '{"token":"old"}');
        const removeItem = vi.fn();
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: { getItem, removeItem, setItem: vi.fn() },
        });

        await expect(TokenStorage.hasCredentialsRevoked()).resolves.toBe(true);
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
        expect(removeItem).not.toHaveBeenCalledWith('auth_credentials');

        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
    });

    it('keeps web credentials out of localStorage when persistent key storage is unavailable', async () => {
        platform.os = 'web';
        const originalLocalStorage = globalThis.localStorage;
        const stored = new Map<string, string>();
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: vi.fn((key: string) => stored.get(key) ?? null),
                setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
                removeItem: vi.fn((key: string) => stored.delete(key)),
            },
        });

        const credentials = {
            token: 'HOSTILE_WEB_TOKEN_SENTINEL',
            secret: 'HOSTILE_WEB_SECRET_SENTINEL',
        };
        await expect(TokenStorage.setCredentials(credentials)).resolves.toBe(true);

        const persisted = stored.get('auth_credentials');
        expect(persisted).toBeUndefined();
        await expect(TokenStorage.getCredentials()).resolves.toEqual(credentials);

        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
    });

    it('does not persist web credentials when revocation wins during encryption', async () => {
        platform.os = 'web';
        const originalLocalStorage = globalThis.localStorage;
        const stored = new Map<string, string>();
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: vi.fn((key: string) => stored.get(key) ?? null),
                setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
                removeItem: vi.fn((key: string) => stored.delete(key)),
            },
        });
        const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
        let encryptionStarted!: () => void;
        let finishEncryption!: () => void;
        const started = new Promise<void>((resolve) => { encryptionStarted = resolve; });
        const blocked = new Promise<void>((resolve) => { finishEncryption = resolve; });
        const encryptSpy = vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
            encryptionStarted();
            await blocked;
            return originalEncrypt(...args);
        });

        try {
            const save = TokenStorage.setCredentials({ token: 'new-token', secret: 'new-secret' });
            await started;
            const revoke = TokenStorage.markCredentialsRevoked();
            await vi.waitFor(() => expect(stored.get('auth_credentials_revoked')).toMatch(/^revoked:/));
            finishEncryption();

            await expect(save).resolves.toBe(false);
            await expect(revoke).resolves.toBe(true);
            expect(stored.get('auth_credentials_revoked')).toMatch(/^revoked:/);
            expect(stored.has('auth_credentials')).toBe(false);
        } finally {
            encryptSpy.mockRestore();
            Object.defineProperty(globalThis, 'localStorage', {
                configurable: true,
                value: originalLocalStorage,
            });
        }
    });

    it('removes legacy plaintext when Web credentials can only be kept for the current session', async () => {
        platform.os = 'web';
        const originalLocalStorage = globalThis.localStorage;
        const credentials = { token: 'legacy-token', secret: 'legacy-secret' };
        const stored = new Map<string, string>([
            ['auth_credentials', JSON.stringify(credentials)],
        ]);
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: vi.fn((key: string) => stored.get(key) ?? null),
                setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
                removeItem: vi.fn((key: string) => stored.delete(key)),
            },
        });

        await expect(TokenStorage.getCredentials()).resolves.toEqual(credentials);

        expect(stored.has('auth_credentials')).toBe(false);
        await expect(TokenStorage.getCredentials()).resolves.toEqual(credentials);

        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
    });

    it('deletes the web credential key with the credential payload', async () => {
        platform.os = 'web';
        const originalLocalStorage = globalThis.localStorage;
        const stored = new Map<string, string>();
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: vi.fn((key: string) => stored.get(key) ?? null),
                setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
                removeItem: vi.fn((key: string) => stored.delete(key)),
            },
        });

        await expect(TokenStorage.setCredentials({ token: 'token', secret: 'secret' })).resolves.toBe(true);
        expect(stored.has('auth_credentials')).toBe(false);
        await expect(TokenStorage.removeCredentials()).resolves.toBe(true);

        await expect(TokenStorage.getCredentials()).resolves.toBeNull();

        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
    });

    it('removes session-only Web credentials when IndexedDB access is rejected', async () => {
        platform.os = 'web';
        const originalIndexedDb = globalThis.indexedDB;
        const originalLocalStorage = globalThis.localStorage;
        const originalNavigator = globalThis.navigator;
        const stored = new Map<string, string>();
        const open = vi.fn(() => { throw new Error('storage policy denied'); });
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: { locks: { request: async <T>(_name: string, callback: () => Promise<T> | T) => callback() } },
        });
        Object.defineProperty(globalThis, 'indexedDB', {
            configurable: true,
            value: { open },
        });
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: vi.fn((key: string) => stored.get(key) ?? null),
                setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
                removeItem: vi.fn((key: string) => stored.delete(key)),
            },
        });

        try {
            await expect(TokenStorage.setCredentials({ token: 'token', secret: 'secret' })).resolves.toBe(true);
            expect(open).toHaveBeenCalled();
            await expect(TokenStorage.removeCredentials()).resolves.toBe(true);
            await expect(TokenStorage.getCredentials()).resolves.toBeNull();
        } finally {
            Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
            Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb });
            Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
            await deleteWebCredentialKey();
        }
    });

    it('serializes concurrent web credential commits without deleting the winning session', async () => {
        platform.os = 'web';
        const originalLocalStorage = globalThis.localStorage;
        const stored = new Map<string, string>();
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: vi.fn((key: string) => stored.get(key) ?? null),
                setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
                removeItem: vi.fn((key: string) => stored.delete(key)),
            },
        });
        const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
        let encryptionStarted!: () => void;
        let finishEncryption!: () => void;
        const started = new Promise<void>((resolve) => { encryptionStarted = resolve; });
        const blocked = new Promise<void>((resolve) => { finishEncryption = resolve; });
        const encryptSpy = vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
            encryptionStarted();
            await blocked;
            return originalEncrypt(...args);
        });

        try {
            const first = TokenStorage.setCredentials({ token: 'first-token', secret: 'first-secret' });
            await started;
            const second = TokenStorage.setCredentials({ token: 'second-token', secret: 'second-secret' });
            finishEncryption();

            await expect(first).resolves.toBe(true);
            await expect(second).resolves.toBe(true);
            await expect(TokenStorage.getCredentials()).resolves.toEqual({
                token: 'second-token',
                secret: 'second-secret',
            });
            expect(stored.has('auth_credentials')).toBe(false);
        } finally {
            encryptSpy.mockRestore();
            Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
        }
    });

    it('does not let a delayed legacy migration overwrite a later explicit login', async () => {
        platform.os = 'web';
        const originalLocalStorage = globalThis.localStorage;
        const stored = new Map<string, string>([
            ['auth_credentials', JSON.stringify({ token: 'legacy-token', secret: 'legacy-secret' })],
        ]);
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: vi.fn((key: string) => stored.get(key) ?? null),
                setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
                removeItem: vi.fn((key: string) => stored.delete(key)),
            },
        });
        const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
        let encryptionStarted!: () => void;
        let finishEncryption!: () => void;
        const started = new Promise<void>((resolve) => { encryptionStarted = resolve; });
        const blocked = new Promise<void>((resolve) => { finishEncryption = resolve; });
        const encryptSpy = vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
            encryptionStarted();
            await blocked;
            return originalEncrypt(...args);
        });

        try {
            const migration = TokenStorage.getCredentials();
            await started;
            const login = TokenStorage.setCredentials({ token: 'new-token', secret: 'new-secret' });
            finishEncryption();

            await expect(migration).resolves.toEqual({ token: 'legacy-token', secret: 'legacy-secret' });
            await expect(login).resolves.toBe(true);
            await expect(TokenStorage.getCredentials()).resolves.toEqual({
                token: 'new-token',
                secret: 'new-secret',
            });
            expect(stored.has('auth_credentials')).toBe(false);
        } finally {
            encryptSpy.mockRestore();
            Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
        }
    });

    it('replays a cross-tab invalidation to subscribers installed after the event', async () => {
        platform.os = 'web';
        const originalLocalStorage = globalThis.localStorage;
        const originalWindow = globalThis.window;
        const stored = new Map<string, string>();
        const storageEvents = new EventTarget();
        Object.defineProperty(globalThis, 'window', { configurable: true, value: storageEvents });
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: vi.fn((key: string) => stored.get(key) ?? null),
                setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
                removeItem: vi.fn((key: string) => stored.delete(key)),
            },
        });
        try {
            await expect(TokenStorage.setCredentials({ token: 'token', secret: 'secret' })).resolves.toBe(true);
            const event = new Event('storage');
            Object.defineProperty(event, 'key', { value: 'auth_credentials_revoked' });
            storageEvents.dispatchEvent(event);
            const invalidated = vi.fn();
            const unsubscribe = TokenStorage.subscribeToCredentialsInvalidation(invalidated);

            expect(invalidated).toHaveBeenCalledOnce();
            await expect(TokenStorage.getCredentials()).resolves.toBeNull();
            unsubscribe();
        } finally {
            Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
            Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
        }
    });

    it('rejects a web E2E bootstrap when another tab starts a bootstrap before commit', async () => {
        platform.os = 'web';
        const originalLocalStorage = globalThis.localStorage;
        const stored = new Map<string, string>();
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: vi.fn((key: string) => stored.get(key) ?? null),
                setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
                removeItem: vi.fn((key: string) => stored.delete(key)),
            },
        });

        const bootstrap = TokenStorage.setE2EBootstrapCredentialsIfNotRevoked({
            token: 'bootstrap-token',
            secret: 'bootstrap-secret',
        });
        stored.set('auth_credentials_bootstrap_pending', '1');

        await expect(bootstrap).resolves.toBe(false);
        expect(stored.get('auth_credentials_bootstrap_pending')).toBe('1');
        expect(stored.has('auth_credentials')).toBe(false);

        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
    });

    it('falls back to session-only credentials when Web Lock admission is rejected', async () => {
        platform.os = 'web';
        const originalIndexedDb = globalThis.indexedDB;
        const originalLocalStorage = globalThis.localStorage;
        const originalNavigator = globalThis.navigator;
        const stored = new Map<string, string>();
        const request = vi.fn(async () => {
            throw new Error('lock policy denied');
        });
        const open = vi.fn();
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: { locks: { request } },
        });
        Object.defineProperty(globalThis, 'indexedDB', {
            configurable: true,
            value: { open },
        });
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: vi.fn((key: string) => stored.get(key) ?? null),
                setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
                removeItem: vi.fn((key: string) => stored.delete(key)),
            },
        });

        try {
            await expect(TokenStorage.setCredentials({ token: 'token', secret: 'secret' })).resolves.toBe(true);
            expect(request).toHaveBeenCalledOnce();
            expect(open).not.toHaveBeenCalled();
            expect(stored.has('auth_credentials')).toBe(false);
            await expect(TokenStorage.markCredentialsRevoked()).resolves.toBe(true);
            await expect(TokenStorage.removeCredentials()).resolves.toBe(true);
        } finally {
            Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
            Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb });
            Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
            await deleteWebCredentialKey();
        }
    });
});
