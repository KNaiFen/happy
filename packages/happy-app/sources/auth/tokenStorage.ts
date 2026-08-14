import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const AUTH_KEY = 'auth_credentials';
const AUTH_REVOKED_KEY = 'auth_credentials_revoked';
const AUTH_BOOTSTRAP_PENDING_KEY = 'auth_credentials_bootstrap_pending';

// Cache for synchronous access
let credentialsCache: string | null = null;
let revocationGeneration = 0;

async function readNativeCredentialFence(): Promise<boolean> {
    const results = await Promise.allSettled([
        SecureStore.getItemAsync(AUTH_REVOKED_KEY),
        AsyncStorage.getItem(AUTH_REVOKED_KEY),
        SecureStore.getItemAsync(AUTH_BOOTSTRAP_PENDING_KEY),
        AsyncStorage.getItem(AUTH_BOOTSTRAP_PENDING_KEY),
    ]);
    if (results.some((result) => result.status === 'fulfilled' && result.value !== null)) return true;
    return results.some((result) => result.status === 'rejected');
}

async function writeNativeBootstrapMarkers(): Promise<boolean> {
    const results = await Promise.allSettled([
        SecureStore.setItemAsync(AUTH_BOOTSTRAP_PENDING_KEY, '1'),
        AsyncStorage.setItem(AUTH_BOOTSTRAP_PENDING_KEY, '1'),
    ]);
    return results.every((result) => result.status === 'fulfilled');
}

async function writeNativeRevocationMarkers(): Promise<{ anyWritten: boolean; allWritten: boolean }> {
    const results = await Promise.allSettled([
        SecureStore.setItemAsync(AUTH_REVOKED_KEY, '1'),
        AsyncStorage.setItem(AUTH_REVOKED_KEY, '1'),
    ]);
    return {
        anyWritten: results.some((result) => result.status === 'fulfilled'),
        allWritten: results.every((result) => result.status === 'fulfilled'),
    };
}

async function clearNativeRevocationMarkers(): Promise<boolean> {
    try {
        // AsyncStorage remains a fence until the SecureStore marker is gone.
        await SecureStore.deleteItemAsync(AUTH_REVOKED_KEY);
        await AsyncStorage.removeItem(AUTH_REVOKED_KEY);
        await SecureStore.deleteItemAsync(AUTH_BOOTSTRAP_PENDING_KEY);
        await AsyncStorage.removeItem(AUTH_BOOTSTRAP_PENDING_KEY);
        return true;
    } catch {
        return false;
    }
}

async function clearNativeBootstrapMarkers(): Promise<boolean> {
    try {
        await SecureStore.deleteItemAsync(AUTH_BOOTSTRAP_PENDING_KEY);
        await AsyncStorage.removeItem(AUTH_BOOTSTRAP_PENDING_KEY);
        return true;
    } catch {
        return false;
    }
}

async function invalidateNativeCredentialCommit(): Promise<void> {
    // A failed delete may still have taken effect. Restore the fail-closed
    // boundary before attempting to remove a partially committed credential.
    await writeNativeRevocationMarkers();
    try {
        await SecureStore.deleteItemAsync(AUTH_KEY);
    } catch {
        // A surviving marker still blocks automatic credential recovery.
    }
}

export interface AuthCredentials {
    token: string;
    secret: string;
}

export const TokenStorage = {
    async hasCredentialsRevoked(): Promise<boolean> {
        if (Platform.OS === 'web') {
            try {
                return localStorage.getItem(AUTH_REVOKED_KEY) !== null
                    || localStorage.getItem(AUTH_BOOTSTRAP_PENDING_KEY) !== null;
            } catch {
                // Storage access failure must not permit an automatic login.
                return true;
            }
        }
        return readNativeCredentialFence();
    },

    async getCredentials(): Promise<AuthCredentials | null> {
        if (Platform.OS === 'web') {
            try {
                if (
                    localStorage.getItem(AUTH_REVOKED_KEY) !== null
                    || localStorage.getItem(AUTH_BOOTSTRAP_PENDING_KEY) !== null
                ) {
                    credentialsCache = null;
                    return null;
                }
                const stored = localStorage.getItem(AUTH_KEY);
                if (!stored) return null;
                credentialsCache = stored;
                return JSON.parse(stored) as AuthCredentials;
            } catch {
                credentialsCache = null;
                console.error('Credential load failed');
                return null;
            }
        }
        try {
            const revoked = await readNativeCredentialFence();
            if (revoked) {
                credentialsCache = null;
                return null;
            }
            const stored = await SecureStore.getItemAsync(AUTH_KEY);
            if (!stored) return null;
            credentialsCache = stored; // Update cache
            return JSON.parse(stored) as AuthCredentials;
        } catch {
            console.error('Credential load failed');
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        if (Platform.OS === 'web') {
            const json = JSON.stringify(credentials);
            try {
                localStorage.setItem(AUTH_REVOKED_KEY, '1');
                localStorage.setItem(AUTH_KEY, json);
                localStorage.removeItem(AUTH_REVOKED_KEY);
                localStorage.removeItem(AUTH_BOOTSTRAP_PENDING_KEY);
                credentialsCache = json;
                return true;
            } catch {
                credentialsCache = null;
                try {
                    localStorage.setItem(AUTH_REVOKED_KEY, '1');
                } catch {
                    // Credential removal below is the remaining boundary.
                }
                try {
                    localStorage.removeItem(AUTH_KEY);
                } catch {
                    // A restored marker still blocks automatic recovery.
                }
                return false;
            }
        }
        const json = JSON.stringify(credentials);
        const markerWrite = await writeNativeRevocationMarkers();
        if (!markerWrite.allWritten) {
            await invalidateNativeCredentialCommit();
            credentialsCache = null;
            console.error('Credential save failed');
            return false;
        }
        try {
            await SecureStore.setItemAsync(AUTH_KEY, json);
            if (!await clearNativeRevocationMarkers()) {
                await invalidateNativeCredentialCommit();
                credentialsCache = null;
                console.error('Credential save failed');
                return false;
            }
            credentialsCache = json; // Update cache
            return true;
        } catch {
            await invalidateNativeCredentialCommit();
            credentialsCache = null;
            console.error('Credential save failed');
            return false;
        }
    },

    async setE2EBootstrapCredentialsIfNotRevoked(credentials: AuthCredentials): Promise<boolean> {
        const generation = revocationGeneration;
        if (await this.hasCredentialsRevoked() || generation !== revocationGeneration) {
            return false;
        }

        const json = JSON.stringify(credentials);
        if (Platform.OS === 'web') {
            try {
                if (
                    localStorage.getItem(AUTH_REVOKED_KEY) !== null
                    || localStorage.getItem(AUTH_BOOTSTRAP_PENDING_KEY) !== null
                    || generation !== revocationGeneration
                ) {
                    return false;
                }
                localStorage.setItem(AUTH_BOOTSTRAP_PENDING_KEY, '1');
                localStorage.setItem(AUTH_KEY, json);
                if (
                    generation !== revocationGeneration
                    || localStorage.getItem(AUTH_REVOKED_KEY) !== null
                ) {
                    localStorage.removeItem(AUTH_KEY);
                    credentialsCache = null;
                    return false;
                }
                localStorage.removeItem(AUTH_BOOTSTRAP_PENDING_KEY);
                if (
                    localStorage.getItem(AUTH_REVOKED_KEY) !== null
                    || localStorage.getItem(AUTH_BOOTSTRAP_PENDING_KEY) !== null
                ) {
                    localStorage.setItem(AUTH_BOOTSTRAP_PENDING_KEY, '1');
                    localStorage.removeItem(AUTH_KEY);
                    credentialsCache = null;
                    return false;
                }
                credentialsCache = json;
                return true;
            } catch {
                credentialsCache = null;
                try {
                    localStorage.removeItem(AUTH_KEY);
                } catch {
                    // A failed credential write cannot be treated as a bootstrap login.
                }
                return false;
            }
        }

        if (!await writeNativeBootstrapMarkers() || generation !== revocationGeneration) {
            credentialsCache = null;
            return false;
        }
        try {
            await SecureStore.setItemAsync(AUTH_KEY, json);
            if (
                generation !== revocationGeneration
                || (await Promise.allSettled([
                    SecureStore.getItemAsync(AUTH_REVOKED_KEY),
                    AsyncStorage.getItem(AUTH_REVOKED_KEY),
                ])).some((result) => result.status !== 'fulfilled' || result.value !== null)
            ) {
                try {
                    await SecureStore.deleteItemAsync(AUTH_KEY);
                } catch {
                    // The persistent marker still blocks automatic recovery.
                }
                credentialsCache = null;
                return false;
            }
            if (!await clearNativeBootstrapMarkers() || generation !== revocationGeneration) {
                try {
                    await SecureStore.deleteItemAsync(AUTH_KEY);
                } catch {
                    // A surviving bootstrap fence blocks automatic recovery.
                }
                credentialsCache = null;
                return false;
            }
            if (await readNativeCredentialFence()) {
                try {
                    await SecureStore.deleteItemAsync(AUTH_KEY);
                } catch {
                    // The credential fence remains authoritative.
                }
                credentialsCache = null;
                return false;
            }
            credentialsCache = json;
            return true;
        } catch {
            try {
                await SecureStore.deleteItemAsync(AUTH_KEY);
            } catch {
                // No successful bootstrap is exposed after an uncertain write.
            }
            credentialsCache = null;
            return false;
        }
    },

    async markCredentialsRevoked(): Promise<boolean> {
        revocationGeneration += 1;
        credentialsCache = null;
        if (Platform.OS === 'web') {
            try {
                localStorage.setItem(AUTH_REVOKED_KEY, '1');
                return true;
            } catch {
                return false;
            }
        }
        if (!(await writeNativeRevocationMarkers()).anyWritten) {
            console.error('Credential revocation marker failed');
            return false;
        }
        return true;
    },

    async removeCredentials(): Promise<boolean> {
        if (Platform.OS === 'web') {
            try {
                localStorage.removeItem(AUTH_KEY);
                credentialsCache = null;
                return true;
            } catch {
                credentialsCache = null;
                console.error('Credential removal failed');
                return false;
            }
        }
        try {
            await SecureStore.deleteItemAsync(AUTH_KEY);
            credentialsCache = null; // Clear cache
            return true;
        } catch {
            // Never leave stale credentials available through synchronous access
            // after a failed persistence delete; callers must handle the false
            // result before allowing a reload.
            credentialsCache = null;
            console.error('Credential removal failed');
            return false;
        }
    },
};
