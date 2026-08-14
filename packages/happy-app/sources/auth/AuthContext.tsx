import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { TokenStorage, AuthCredentials } from '@/auth/tokenStorage';
import { syncCreate, syncQuarantine, syncShutdown } from '@/sync/sync';
import * as Updates from 'expo-updates';
import { clearPersistence, loadRegisteredPushToken } from '@/sync/persistence';
import { unregisterPushToken } from '@/sync/apiPush';
import { Platform } from 'react-native';
import { trackLogout } from '@/track';

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string) => Promise<void>;
    logout: () => Promise<void>;
    logoutLocal: (options?: {
        reload?: boolean;
        expectedCredentials?: AuthCredentials;
    }) => Promise<LocalAuthRevocationPermit | null>;
}

export type LocalAuthRevocationPermit = {
    readonly signal: AbortSignal;
    assertCurrent: () => void;
};

type AuthTeardownKind = 'local' | 'remote';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);
    const credentialsRef = useRef<AuthCredentials | null>(initialCredentials);
    const authGeneration = useRef(0);
    const activeDeletionAdmission = useRef<AbortController | null>(null);
    const activeAuthTeardown = useRef<{
        kind: AuthTeardownKind;
        promise: Promise<boolean>;
    } | null>(null);

    const invalidateDeletionAdmission = () => {
        authGeneration.current += 1;
        activeDeletionAdmission.current?.abort();
        activeDeletionAdmission.current = null;
    };

    // Update global auth state when local state changes
    useEffect(() => {
        setCurrentAuth(credentials ? { isAuthenticated, credentials, login, logout, logoutLocal } : null);
    }, [isAuthenticated, credentials]);

    const login = async (token: string, secret: string) => {
        invalidateDeletionAdmission();
        const teardown = activeAuthTeardown.current;
        if (teardown) await teardown.promise;
        const newCredentials: AuthCredentials = { token, secret };
        const success = await TokenStorage.setCredentials(newCredentials);
        if (success) {
            await syncCreate(newCredentials);
            credentialsRef.current = newCredentials;
            setCredentials(newCredentials);
            setIsAuthenticated(true);
        } else {
            throw new Error('Failed to save credentials');
        }
    };

    const reloadAfterLogout = async () => {
        if (Platform.OS === 'web') {
            window.location.reload();
            return;
        }
        try {
            await Updates.reloadAsync();
        } catch {
            console.log('Reload failed (expected in dev mode)');
        }
    };

    const performLocalAuthTeardown = async (options?: { reload?: boolean; silent?: boolean }): Promise<boolean> => {
        // Quarantine memory and in-flight Sync work synchronously. External
        // teardown starts only after the durable revocation fence is present.
        setCurrentAuth(null);
        credentialsRef.current = null;
        setCredentials(null);
        setIsAuthenticated(false);
        syncQuarantine({ silent: options?.silent });

        let markerWritten = await TokenStorage.markCredentialsRevoked();
        if (!markerWritten) {
            markerWritten = await TokenStorage.markCredentialsRevoked();
        }
        if (!markerWritten) {
            if (Platform.OS !== 'web') await TokenStorage.removeCredentials();
            console.error('Local credential revocation failed');
            return false;
        }

        try {
            trackLogout();
        } catch {
            console.error('Account tracking reset failed');
        }
        const shutdownSucceeded = await syncShutdown({ silent: options?.silent }).then(() => true).catch(() => {
            console.error('Account sync shutdown failed');
            return false;
        });
        try {
            clearPersistence();
        } catch {
            console.error('Account persistence cleanup failed');
        }
        // Web revocation removes only the payload that existed when revocation
        // began. A second delayed removal could erase a later cross-tab login.
        const credentialsRemoved = Platform.OS === 'web'
            ? true
            : await TokenStorage.removeCredentials();
        if (!credentialsRemoved || !shutdownSucceeded) {
            console.error('Local credential removal failed');
            return false;
        }
        if (options?.reload === false) {
            return true;
        }
        await reloadAfterLogout();
        return true;
    };

    const runAuthTeardown = (
        kind: AuthTeardownKind,
        operation: () => Promise<boolean>,
    ): Promise<boolean> => {
        const current = activeAuthTeardown.current;
        if (current) {
            if (kind === 'local' && current.kind === 'remote') {
                return current.promise.then(() => false, () => false);
            }
            return current.promise;
        }

        const teardown = operation();
        activeAuthTeardown.current = { kind, promise: teardown };
        void teardown.then(
            () => {
                if (activeAuthTeardown.current?.promise === teardown) activeAuthTeardown.current = null;
            },
            () => {
                if (activeAuthTeardown.current?.promise === teardown) activeAuthTeardown.current = null;
            },
        );
        return teardown;
    };

    const logout = async () => {
        invalidateDeletionAdmission();
        await runAuthTeardown('local', async () => {
            const logoutCredentials = credentials;
            const registeredPushToken = logoutCredentials ? loadRegisteredPushToken() : null;
            const cleared = await performLocalAuthTeardown({ reload: false });
            if (cleared && logoutCredentials && registeredPushToken) {
                const unregister = unregisterPushToken(logoutCredentials, registeredPushToken, {
                    allowAfterRevocation: true,
                }).catch(() => {
                    console.log('Failed to unregister push token during logout');
                });
                await Promise.race([
                    unregister,
                    new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
                ]);
            }
            if (cleared) await reloadAfterLogout();
            return cleared;
        });
    };

    // Account deletion has already removed server-side push tokens. Avoid a
    // follow-up request with credentials that the server has intentionally revoked.
    const logoutLocal = async (options?: {
        reload?: boolean;
        expectedCredentials?: AuthCredentials;
    }): Promise<LocalAuthRevocationPermit | null> => {
        const expected = options?.expectedCredentials;
        const currentCredentials = credentialsRef.current;
        if (
            expected
            && (
                !currentCredentials
                || currentCredentials.token !== expected.token
                || currentCredentials.secret !== expected.secret
            )
        ) {
            return null;
        }
        const generation = authGeneration.current;
        const cleared = await runAuthTeardown(
            'local',
            () => performLocalAuthTeardown({ reload: options?.reload, silent: true }),
        );
        if (!cleared || generation !== authGeneration.current) return null;

        activeDeletionAdmission.current?.abort();
        const controller = new AbortController();
        activeDeletionAdmission.current = controller;
        return {
            signal: controller.signal,
            assertCurrent: () => {
                if (
                    controller.signal.aborted
                    || generation !== authGeneration.current
                    || activeDeletionAdmission.current !== controller
                ) {
                    throw new Error('Local account revocation is no longer current');
                }
            },
        };
    };

    const performRemoteAuthTeardown = async (): Promise<boolean> => {
        // A storage event comes from another Web context which has already
        // written the durable admission signal. Do not write it again here:
        // doing so would create a cross-tab invalidation loop.
        setCurrentAuth(null);
        credentialsRef.current = null;
        setCredentials(null);
        setIsAuthenticated(false);
        syncQuarantine({ silent: true });
        try {
            trackLogout();
        } catch {
            console.error('Account tracking reset failed');
        }
        const shutdownSucceeded = await syncShutdown({ silent: true }).then(() => true).catch(() => {
            console.error('Account sync shutdown failed');
            return false;
        });
        try {
            clearPersistence();
        } catch {
            console.error('Account persistence cleanup failed');
        }
        await reloadAfterLogout();
        return shutdownSucceeded;
    };

    useEffect(() => TokenStorage.subscribeToCredentialsInvalidation(() => {
        invalidateDeletionAdmission();
        void runAuthTeardown('remote', performRemoteAuthTeardown);
    }), []);

    return (
        <AuthContext.Provider
            value={{
                isAuthenticated,
                credentials,
                login,
                logout,
                logoutLocal,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}

// Helper to get current auth state for non-React contexts
let currentAuthState: AuthContextType | null = null;

export function setCurrentAuth(auth: AuthContextType | null) {
    currentAuthState = auth;
}

export function getCurrentAuth(): AuthContextType | null {
    return currentAuthState;
}
