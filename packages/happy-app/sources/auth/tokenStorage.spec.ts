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

describe('TokenStorage credential revocation', () => {
    beforeEach(() => {
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
});
