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
    logoutLocal: (options?: { reload?: boolean }) => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);
    const activeLocalAuthTeardown = useRef<Promise<boolean> | null>(null);

    // Update global auth state when local state changes
    useEffect(() => {
        setCurrentAuth(credentials ? { isAuthenticated, credentials, login, logout, logoutLocal } : null);
    }, [isAuthenticated, credentials]);

    const login = async (token: string, secret: string) => {
        const teardown = activeLocalAuthTeardown.current;
        if (teardown) await teardown;
        const newCredentials: AuthCredentials = { token, secret };
        const success = await TokenStorage.setCredentials(newCredentials);
        if (success) {
            await syncCreate(newCredentials);
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
        setCredentials(null);
        setIsAuthenticated(false);
        syncQuarantine({ silent: options?.silent });

        let markerWritten = await TokenStorage.markCredentialsRevoked();
        if (!markerWritten) {
            markerWritten = await TokenStorage.markCredentialsRevoked();
        }
        if (!markerWritten) {
            await TokenStorage.removeCredentials();
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
        const credentialsRemoved = await TokenStorage.removeCredentials();
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

    const runLocalAuthTeardown = (operation: () => Promise<boolean>): Promise<boolean> => {
        const current = activeLocalAuthTeardown.current;
        if (current) return current;

        const teardown = operation();
        activeLocalAuthTeardown.current = teardown;
        void teardown.then(
            () => {
                if (activeLocalAuthTeardown.current === teardown) activeLocalAuthTeardown.current = null;
            },
            () => {
                if (activeLocalAuthTeardown.current === teardown) activeLocalAuthTeardown.current = null;
            },
        );
        return teardown;
    };

    const logout = async () => {
        await runLocalAuthTeardown(async () => {
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
    const logoutLocal = async (options?: { reload?: boolean }): Promise<boolean> => {
        return runLocalAuthTeardown(() => performLocalAuthTeardown({ ...options, silent: true }));
    };

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
