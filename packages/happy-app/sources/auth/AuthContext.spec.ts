import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    capturedContext,
    clearPersistence,
    effects,
    loadRegisteredPushToken,
    markCredentialsRevoked,
    platform,
    removeCredentials,
    setCredentials,
    subscribeToCredentialsInvalidation,
    syncCreate,
    syncQuarantine,
    syncShutdown,
    trackLogout,
    unregisterPushToken,
} = vi.hoisted(() => ({
    capturedContext: {
        value: null as null | {
            login: (token: string, secret: string) => Promise<void>;
            logout: () => Promise<void>;
            logoutLocal: (options?: {
                reload?: boolean;
                expectedCredentials?: typeof credentials;
            }) => Promise<{
                readonly signal: AbortSignal;
                assertCurrent: () => void;
            } | null>;
        },
    },
    effects: [] as Array<() => void | (() => void)>,
    clearPersistence: vi.fn(),
    loadRegisteredPushToken: vi.fn(),
    markCredentialsRevoked: vi.fn(),
    platform: { os: 'ios' },
    removeCredentials: vi.fn(),
    setCredentials: vi.fn(),
    subscribeToCredentialsInvalidation: vi.fn(),
    syncCreate: vi.fn(),
    syncQuarantine: vi.fn(),
    syncShutdown: vi.fn(),
    trackLogout: vi.fn(),
    unregisterPushToken: vi.fn(),
}));

function captureProviderProps(props: { value: NonNullable<typeof capturedContext.value> }) {
    capturedContext.value = props.value;
    return null;
}

vi.mock('react', () => ({
    default: {
        createContext: () => ({ Provider: 'AuthContextProvider' }),
        createElement: (_type: unknown, props: { value: NonNullable<typeof capturedContext.value> }) => captureProviderProps(props),
    },
    createContext: () => ({ Provider: 'AuthContextProvider' }),
    useContext: vi.fn(),
    useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
    useRef: <T>(initial: T) => ({ current: initial }),
    useState: <T>(initial: T) => [initial, vi.fn()] as const,
}));
vi.mock('react/jsx-runtime', () => ({
    jsx: (_type: unknown, props: { value: NonNullable<typeof capturedContext.value> }) => captureProviderProps(props),
}));
vi.mock('react/jsx-dev-runtime', () => ({
    jsxDEV: (_type: unknown, props: { value: NonNullable<typeof capturedContext.value> }) => captureProviderProps(props),
}));
vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: {
        markCredentialsRevoked,
        removeCredentials,
        setCredentials,
        subscribeToCredentialsInvalidation,
    },
}));
vi.mock('@/sync/sync', () => ({ syncCreate, syncQuarantine, syncShutdown }));
vi.mock('expo-updates', () => ({ reloadAsync: vi.fn() }));
vi.mock('@/sync/persistence', () => ({ clearPersistence, loadRegisteredPushToken }));
vi.mock('@/sync/apiPush', () => ({ unregisterPushToken }));
vi.mock('react-native', () => ({ Platform: { get OS() { return platform.os; } } }));
vi.mock('@/track', () => ({ trackLogout }));

import { AuthProvider } from './AuthContext';

const credentials = { token: 'account-token', secret: 'account-secret' };

describe('AuthProvider logout ordering', () => {
    beforeEach(() => {
        capturedContext.value = null;
        effects.splice(0);
        platform.os = 'ios';
        clearPersistence.mockReset();
        loadRegisteredPushToken.mockReset().mockReturnValue('push-token');
        markCredentialsRevoked.mockReset().mockResolvedValue(true);
        removeCredentials.mockReset().mockResolvedValue(true);
        setCredentials.mockReset().mockResolvedValue(true);
        subscribeToCredentialsInvalidation.mockReset().mockReturnValue(() => undefined);
        syncCreate.mockReset().mockResolvedValue(undefined);
        syncQuarantine.mockReset();
        syncShutdown.mockReset().mockResolvedValue(undefined);
        trackLogout.mockReset();
        unregisterPushToken.mockReset().mockResolvedValue(undefined);
    });

    it('quarantines immediately but waits for the durable marker before external teardown', async () => {
        let finishMarker!: (written: boolean) => void;
        markCredentialsRevoked.mockReturnValueOnce(new Promise<boolean>((resolve) => {
            finishMarker = resolve;
        }));
        AuthProvider({ children: null, initialCredentials: credentials });

        const logout = capturedContext.value!.logout();
        expect(syncQuarantine).toHaveBeenCalledOnce();
        expect(trackLogout).not.toHaveBeenCalled();
        expect(syncShutdown).not.toHaveBeenCalled();
        expect(unregisterPushToken).not.toHaveBeenCalled();

        finishMarker(true);
        await logout;
        expect(trackLogout).toHaveBeenCalledOnce();
        expect(syncShutdown).toHaveBeenCalledOnce();
        expect(syncShutdown).toHaveBeenCalledWith({ silent: undefined });
        expect(markCredentialsRevoked.mock.invocationCallOrder[0])
            .toBeLessThan(trackLogout.mock.invocationCallOrder[0]);
        expect(markCredentialsRevoked.mock.invocationCallOrder[0])
            .toBeLessThan(syncShutdown.mock.invocationCallOrder[0]);
    });

    it('keeps local account deletion teardown behind the durable marker', async () => {
        let finishMarker!: (written: boolean) => void;
        markCredentialsRevoked.mockReturnValueOnce(new Promise<boolean>((resolve) => {
            finishMarker = resolve;
        }));
        AuthProvider({ children: null, initialCredentials: credentials });

        const logout = capturedContext.value!.logoutLocal({ reload: false });
        expect(syncQuarantine).toHaveBeenCalledOnce();
        expect(trackLogout).not.toHaveBeenCalled();
        expect(syncShutdown).not.toHaveBeenCalled();

        finishMarker(true);
        const permit = await logout;
        expect(permit).not.toBeNull();
        expect(() => permit!.assertCurrent()).not.toThrow();
        expect(trackLogout).toHaveBeenCalledOnce();
        expect(syncShutdown).toHaveBeenCalledOnce();
        expect(syncShutdown).toHaveBeenCalledWith({ silent: true });
        expect(unregisterPushToken).not.toHaveBeenCalled();
    });

    it('serializes an explicit login behind the complete local teardown', async () => {
        let finishMarker!: (written: boolean) => void;
        markCredentialsRevoked.mockReturnValueOnce(new Promise<boolean>((resolve) => {
            finishMarker = resolve;
        }));
        AuthProvider({ children: null, initialCredentials: credentials });

        const logout = capturedContext.value!.logoutLocal({ reload: false });
        const login = capturedContext.value!.login('new-token', 'new-secret');
        expect(setCredentials).not.toHaveBeenCalled();
        expect(syncCreate).not.toHaveBeenCalled();

        finishMarker(true);
        await expect(logout).resolves.toBeNull();
        await expect(login).resolves.toBeUndefined();
        expect(removeCredentials.mock.invocationCallOrder[0])
            .toBeLessThan(setCredentials.mock.invocationCallOrder[0]);
        expect(syncShutdown.mock.invocationCallOrder[0])
            .toBeLessThan(syncCreate.mock.invocationCallOrder[0]);
    });

    it('does not let delayed Web shutdown cleanup erase a later cross-tab login', async () => {
        platform.os = 'web';
        let finishShutdown!: () => void;
        syncShutdown.mockReturnValueOnce(new Promise<void>((resolve) => {
            finishShutdown = resolve;
        }));
        AuthProvider({ children: null, initialCredentials: credentials });

        const logout = capturedContext.value!.logoutLocal({ reload: false });
        await vi.waitFor(() => expect(syncShutdown).toHaveBeenCalledOnce());

        expect(removeCredentials).not.toHaveBeenCalled();
        finishShutdown();
        await expect(logout).resolves.not.toBeNull();
        expect(removeCredentials).not.toHaveBeenCalled();
    });

    it('does not start external teardown when both marker writes fail', async () => {
        markCredentialsRevoked.mockResolvedValue(false);
        AuthProvider({ children: null, initialCredentials: credentials });

        await capturedContext.value!.logout();

        expect(markCredentialsRevoked).toHaveBeenCalledTimes(2);
        expect(removeCredentials).toHaveBeenCalledOnce();
        expect(trackLogout).not.toHaveBeenCalled();
        expect(syncShutdown).not.toHaveBeenCalled();
        expect(unregisterPushToken).not.toHaveBeenCalled();
    });

    it('does not treat a local-only Web delete as a cross-tab revocation fence', async () => {
        platform.os = 'web';
        markCredentialsRevoked.mockResolvedValue(false);
        AuthProvider({ children: null, initialCredentials: credentials });

        await expect(capturedContext.value!.logoutLocal({ reload: false })).resolves.toBeNull();

        expect(markCredentialsRevoked).toHaveBeenCalledTimes(2);
        expect(removeCredentials).not.toHaveBeenCalled();
        expect(syncShutdown).not.toHaveBeenCalled();
    });

    it('does not contact the push service until local revocation has completed', async () => {
        let finishRemoval!: (removed: boolean) => void;
        removeCredentials.mockReturnValueOnce(new Promise<boolean>((resolve) => {
            finishRemoval = resolve;
        }));
        AuthProvider({ children: null, initialCredentials: credentials });

        const logout = capturedContext.value!.logout();
        await vi.waitFor(() => expect(removeCredentials).toHaveBeenCalledOnce());
        expect(unregisterPushToken).not.toHaveBeenCalled();

        finishRemoval(true);
        await logout;
        expect(unregisterPushToken).toHaveBeenCalledWith(credentials, 'push-token', {
            allowAfterRevocation: true,
        });
        expect(removeCredentials.mock.invocationCallOrder[0])
            .toBeLessThan(unregisterPushToken.mock.invocationCallOrder[0]);
    });

    it('does not contact the push service when local revocation fails', async () => {
        removeCredentials.mockResolvedValueOnce(false);
        AuthProvider({ children: null, initialCredentials: credentials });

        await capturedContext.value!.logout();

        expect(unregisterPushToken).not.toHaveBeenCalled();
    });

    it('quarantines immediately when another Web context revokes or replaces admission', async () => {
        let invalidate!: () => void;
        subscribeToCredentialsInvalidation.mockImplementation((listener: () => void) => {
            invalidate = listener;
            return () => undefined;
        });
        AuthProvider({ children: null, initialCredentials: credentials });
        effects.at(-1)!();

        invalidate();

        expect(syncQuarantine).toHaveBeenCalledWith({ silent: true });
        expect(markCredentialsRevoked).not.toHaveBeenCalled();
        expect(removeCredentials).not.toHaveBeenCalled();
        expect(unregisterPushToken).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(syncShutdown).toHaveBeenCalledWith({ silent: true }));
    });

    it('does not treat an in-flight remote teardown as local deletion revocation', async () => {
        let invalidate!: () => void;
        let finishShutdown!: () => void;
        subscribeToCredentialsInvalidation.mockImplementation((listener: () => void) => {
            invalidate = listener;
            return () => undefined;
        });
        syncShutdown.mockReturnValueOnce(new Promise<void>((resolve) => {
            finishShutdown = resolve;
        }));
        AuthProvider({ children: null, initialCredentials: credentials });
        effects.at(-1)!();

        invalidate();
        const localRevocation = capturedContext.value!.logoutLocal({
            reload: false,
            expectedCredentials: credentials,
        });
        finishShutdown();

        await expect(localRevocation).resolves.toBeNull();
        expect(markCredentialsRevoked).not.toHaveBeenCalled();
    });

    it('invalidates a deletion permit when a later remote admission change arrives', async () => {
        let invalidate!: () => void;
        subscribeToCredentialsInvalidation.mockImplementation((listener: () => void) => {
            invalidate = listener;
            return () => undefined;
        });
        AuthProvider({ children: null, initialCredentials: credentials });
        effects.at(-1)!();

        const permit = await capturedContext.value!.logoutLocal({
            reload: false,
            expectedCredentials: credentials,
        });
        expect(permit).not.toBeNull();
        expect(() => permit!.assertCurrent()).not.toThrow();

        invalidate();

        expect(permit!.signal.aborted).toBe(true);
        expect(() => permit!.assertCurrent()).toThrow('Local account revocation is no longer current');
    });
});
