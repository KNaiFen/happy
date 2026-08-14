import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    capturedContext,
    clearPersistence,
    loadRegisteredPushToken,
    markCredentialsRevoked,
    removeCredentials,
    setCredentials,
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
            logoutLocal: (options?: { reload?: boolean }) => Promise<boolean>;
        },
    },
    clearPersistence: vi.fn(),
    loadRegisteredPushToken: vi.fn(),
    markCredentialsRevoked: vi.fn(),
    removeCredentials: vi.fn(),
    setCredentials: vi.fn(),
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
    useEffect: vi.fn(),
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
    TokenStorage: { markCredentialsRevoked, removeCredentials, setCredentials },
}));
vi.mock('@/sync/sync', () => ({ syncCreate, syncQuarantine, syncShutdown }));
vi.mock('expo-updates', () => ({ reloadAsync: vi.fn() }));
vi.mock('@/sync/persistence', () => ({ clearPersistence, loadRegisteredPushToken }));
vi.mock('@/sync/apiPush', () => ({ unregisterPushToken }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/track', () => ({ trackLogout }));

import { AuthProvider } from './AuthContext';

const credentials = { token: 'account-token', secret: 'account-secret' };

describe('AuthProvider logout ordering', () => {
    beforeEach(() => {
        capturedContext.value = null;
        clearPersistence.mockReset();
        loadRegisteredPushToken.mockReset().mockReturnValue('push-token');
        markCredentialsRevoked.mockReset().mockResolvedValue(true);
        removeCredentials.mockReset().mockResolvedValue(true);
        setCredentials.mockReset().mockResolvedValue(true);
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
        await expect(logout).resolves.toBe(true);
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
        await expect(logout).resolves.toBe(true);
        await expect(login).resolves.toBeUndefined();
        expect(removeCredentials.mock.invocationCallOrder[0])
            .toBeLessThan(setCredentials.mock.invocationCallOrder[0]);
        expect(syncShutdown.mock.invocationCallOrder[0])
            .toBeLessThan(syncCreate.mock.invocationCallOrder[0]);
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
});
