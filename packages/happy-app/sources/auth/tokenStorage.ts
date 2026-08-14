import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import {
    clearEphemeralWebCredentialKey,
    decryptWebCredential,
    deleteWebCredentialKey,
    encryptWebCredential,
    getWebCredentialAdmission,
    isEncryptedWebCredential,
    runWithWebCredentialLock,
    WebCredentialAdmission,
} from './webCredentialStorage';

const AUTH_KEY = 'auth_credentials';
const AUTH_REVOKED_KEY = 'auth_credentials_revoked';
const AUTH_BOOTSTRAP_PENDING_KEY = 'auth_credentials_bootstrap_pending';
const AUTH_SESSION_CHANGE_KEY = 'auth_credentials_session_change';

// Cache for synchronous access
let credentialsCache: string | null = null;
let revocationGeneration = 0;
let ephemeralWebCredentials: {
    json: string;
    admission: WebCredentialAdmission;
    generation: number;
} | null = null;
const webCredentialInvalidationListeners = new Set<() => void>();
let webCredentialStorageListenerInstalled = false;
let webCredentialInvalidated = false;

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

function parseAuthCredentials(value: string): AuthCredentials | null {
    try {
        const parsed = JSON.parse(value) as Partial<AuthCredentials>;
        if (typeof parsed.token !== 'string' || typeof parsed.secret !== 'string') return null;
        return { token: parsed.token, secret: parsed.secret };
    } catch {
        return null;
    }
}

function createWebSignal(kind: 'revoked' | 'bootstrap' | 'session'): string {
    return `${kind}:${crypto.randomUUID()}`;
}

function readWebCredentialAdmission(): WebCredentialAdmission {
    return {
        revocationSignal: localStorage.getItem(AUTH_REVOKED_KEY),
        bootstrapSignal: localStorage.getItem(AUTH_BOOTSTRAP_PENDING_KEY),
    };
}

function admissionsEqual(left: WebCredentialAdmission, right: WebCredentialAdmission): boolean {
    return left.revocationSignal === right.revocationSignal
        && left.bootstrapSignal === right.bootstrapSignal;
}

function isWebAdmissionCurrent(admission: WebCredentialAdmission): boolean {
    return admissionsEqual(admission, readWebCredentialAdmission());
}

function hasWebCredentialFence(admission: WebCredentialAdmission): boolean {
    return admission.revocationSignal !== null || admission.bootstrapSignal !== null;
}

function installWebCredentialStorageListener(): void {
    if (
        webCredentialStorageListenerInstalled
        || typeof window === 'undefined'
        || typeof window.addEventListener !== 'function'
    ) {
        return;
    }
    webCredentialStorageListenerInstalled = true;
    window.addEventListener('storage', (event) => {
        if (
            event.key !== AUTH_REVOKED_KEY
            && event.key !== AUTH_BOOTSTRAP_PENDING_KEY
            && event.key !== AUTH_SESSION_CHANGE_KEY
        ) {
            return;
        }
        webCredentialInvalidated = true;
        revocationGeneration += 1;
        credentialsCache = null;
        ephemeralWebCredentials = null;
        for (const listener of webCredentialInvalidationListeners) {
            listener();
        }
    });
}

function publishWebCredentialSessionChange(): void {
    localStorage.setItem(AUTH_SESSION_CHANGE_KEY, createWebSignal('session'));
}

export const TokenStorage = {
    async hasCredentialsRevoked(): Promise<boolean> {
        if (Platform.OS === 'web') {
            installWebCredentialStorageListener();
            try {
                const admission = readWebCredentialAdmission();
                const ephemeral = ephemeralWebCredentials;
                if (
                    ephemeral
                    && ephemeral.generation === revocationGeneration
                    && admissionsEqual(ephemeral.admission, admission)
                ) {
                    return false;
                }
                const stored = localStorage.getItem(AUTH_KEY);
                if (!stored) return hasWebCredentialFence(admission);
                if (!isEncryptedWebCredential(stored)) return hasWebCredentialFence(admission);
                const storedAdmission = getWebCredentialAdmission(stored);
                return !storedAdmission || !admissionsEqual(storedAdmission, admission);
            } catch {
                // Storage access failure must not permit an automatic login.
                return true;
            }
        }
        return readNativeCredentialFence();
    },

    async getCredentials(): Promise<AuthCredentials | null> {
        if (Platform.OS === 'web') {
            installWebCredentialStorageListener();
            return runWithWebCredentialLock(async () => {
                const generation = revocationGeneration;
                let legacyCredentialDetected = false;
                try {
                    const admission = readWebCredentialAdmission();
                    const ephemeral = ephemeralWebCredentials;
                    if (
                        ephemeral
                        && ephemeral.generation === generation
                        && admissionsEqual(ephemeral.admission, admission)
                    ) {
                        return parseAuthCredentials(ephemeral.json);
                    }
                    const stored = localStorage.getItem(AUTH_KEY);
                    if (!stored) return null;
                    let expectedStored: string | null = stored;
                    let plaintext: string | null;
                    if (isEncryptedWebCredential(stored)) {
                        const storedAdmission = getWebCredentialAdmission(stored);
                        if (!storedAdmission || !admissionsEqual(storedAdmission, admission)) return null;
                        plaintext = await decryptWebCredential(stored);
                    } else {
                        if (hasWebCredentialFence(admission)) return null;
                        const legacyCredentials = parseAuthCredentials(stored);
                        if (!legacyCredentials) return null;
                        legacyCredentialDetected = true;
                        const encrypted = await encryptWebCredential(stored, admission);
                        if (
                            generation !== revocationGeneration
                            || !isWebAdmissionCurrent(admission)
                            || localStorage.getItem(AUTH_KEY) !== stored
                        ) {
                            credentialsCache = null;
                            return null;
                        }
                        if (encrypted.persistent) {
                            localStorage.setItem(AUTH_KEY, encrypted.value);
                            if (
                                generation !== revocationGeneration
                                || !isWebAdmissionCurrent(admission)
                                || localStorage.getItem(AUTH_KEY) !== encrypted.value
                            ) {
                                credentialsCache = null;
                                return null;
                            }
                            expectedStored = encrypted.value;
                        } else {
                            localStorage.removeItem(AUTH_KEY);
                            if (
                                generation !== revocationGeneration
                                || !isWebAdmissionCurrent(admission)
                                || localStorage.getItem(AUTH_KEY) !== null
                            ) {
                                credentialsCache = null;
                                return null;
                            }
                            ephemeralWebCredentials = { json: stored, admission, generation };
                            expectedStored = null;
                        }
                        plaintext = stored;
                    }
                    if (
                        plaintext === null
                        || generation !== revocationGeneration
                        || !isWebAdmissionCurrent(admission)
                        || localStorage.getItem(AUTH_KEY) !== expectedStored
                    ) {
                        credentialsCache = null;
                        return null;
                    }
                    const credentials = parseAuthCredentials(plaintext);
                    if (!credentials) {
                        credentialsCache = null;
                        return null;
                    }
                    credentialsCache = plaintext;
                    return credentials;
                } catch {
                    credentialsCache = null;
                    if (legacyCredentialDetected) {
                        try {
                            localStorage.setItem(AUTH_REVOKED_KEY, createWebSignal('revoked'));
                            localStorage.removeItem(AUTH_KEY);
                        } catch {
                            // A surviving plaintext credential is still blocked by
                            // whichever durable marker operation succeeded.
                        }
                    }
                    console.error('Credential load failed');
                    return null;
                }
            });
        }
        try {
            const revoked = await readNativeCredentialFence();
            if (revoked) {
                credentialsCache = null;
                return null;
            }
            const stored = await SecureStore.getItemAsync(AUTH_KEY);
            if (!stored) return null;
            const credentials = parseAuthCredentials(stored);
            if (!credentials) return null;
            credentialsCache = stored; // Update cache
            return credentials;
        } catch {
            console.error('Credential load failed');
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        const generation = revocationGeneration;
        if (Platform.OS === 'web') {
            const json = JSON.stringify(credentials);
            installWebCredentialStorageListener();
            return runWithWebCredentialLock(async () => {
                try {
                    const admission = readWebCredentialAdmission();
                    const encrypted = await encryptWebCredential(json, admission);
                    if (generation !== revocationGeneration || !isWebAdmissionCurrent(admission)) {
                        credentialsCache = null;
                        return false;
                    }
                    if (encrypted.persistent) {
                        localStorage.setItem(AUTH_KEY, encrypted.value);
                        if (
                            generation !== revocationGeneration
                            || !isWebAdmissionCurrent(admission)
                            || localStorage.getItem(AUTH_KEY) !== encrypted.value
                        ) {
                            credentialsCache = null;
                            return false;
                        }
                    } else {
                        localStorage.removeItem(AUTH_KEY);
                        if (
                            generation !== revocationGeneration
                            || !isWebAdmissionCurrent(admission)
                            || localStorage.getItem(AUTH_KEY) !== null
                        ) {
                            credentialsCache = null;
                            return false;
                        }
                        ephemeralWebCredentials = { json, admission, generation };
                    }
                    publishWebCredentialSessionChange();
                    credentialsCache = json;
                    return true;
                } catch {
                    credentialsCache = null;
                    ephemeralWebCredentials = null;
                    try {
                        localStorage.setItem(AUTH_REVOKED_KEY, createWebSignal('revoked'));
                    } catch {
                        // A surviving admission signal remains the durable fence.
                    }
                    return false;
                }
            });
        }
        const json = JSON.stringify(credentials);
        const markerWrite = await writeNativeRevocationMarkers();
        if (!markerWrite.allWritten || generation !== revocationGeneration) {
            await invalidateNativeCredentialCommit();
            credentialsCache = null;
            console.error('Credential save failed');
            return false;
        }
        try {
            await SecureStore.setItemAsync(AUTH_KEY, json);
            if (generation !== revocationGeneration) {
                await invalidateNativeCredentialCommit();
                credentialsCache = null;
                return false;
            }
            if (!await clearNativeRevocationMarkers()) {
                await invalidateNativeCredentialCommit();
                credentialsCache = null;
                console.error('Credential save failed');
                return false;
            }
            if (generation !== revocationGeneration) {
                await invalidateNativeCredentialCommit();
                credentialsCache = null;
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
            installWebCredentialStorageListener();
            return runWithWebCredentialLock(async () => {
                try {
                    const beforeBootstrap = readWebCredentialAdmission();
                    if (hasWebCredentialFence(beforeBootstrap) || generation !== revocationGeneration) {
                        return false;
                    }
                    const bootstrapSignal = createWebSignal('bootstrap');
                    const admission: WebCredentialAdmission = {
                        revocationSignal: beforeBootstrap.revocationSignal,
                        bootstrapSignal,
                    };
                    localStorage.setItem(AUTH_BOOTSTRAP_PENDING_KEY, bootstrapSignal);
                    const encrypted = await encryptWebCredential(json, admission);
                    if (generation !== revocationGeneration || !isWebAdmissionCurrent(admission)) {
                        credentialsCache = null;
                        return false;
                    }
                    if (encrypted.persistent) {
                        localStorage.setItem(AUTH_KEY, encrypted.value);
                        if (
                            generation !== revocationGeneration
                            || !isWebAdmissionCurrent(admission)
                            || localStorage.getItem(AUTH_KEY) !== encrypted.value
                        ) {
                            credentialsCache = null;
                            return false;
                        }
                    } else {
                        localStorage.removeItem(AUTH_KEY);
                        if (
                            generation !== revocationGeneration
                            || !isWebAdmissionCurrent(admission)
                            || localStorage.getItem(AUTH_KEY) !== null
                        ) {
                            credentialsCache = null;
                            return false;
                        }
                        ephemeralWebCredentials = { json, admission, generation };
                    }
                    publishWebCredentialSessionChange();
                    credentialsCache = json;
                    return true;
                } catch {
                    credentialsCache = null;
                    ephemeralWebCredentials = null;
                    return false;
                }
            });
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
        ephemeralWebCredentials = null;
        if (Platform.OS === 'web') {
            installWebCredentialStorageListener();
            let expectedStored: string | null = null;
            let expectedSessionChange: string | null = null;
            let admissionReadable = false;
            try {
                expectedStored = localStorage.getItem(AUTH_KEY);
                expectedSessionChange = localStorage.getItem(AUTH_SESSION_CHANGE_KEY);
                localStorage.setItem(AUTH_REVOKED_KEY, createWebSignal('revoked'));
                admissionReadable = true;
            } catch {
                // Without a shared admission signal, other Web contexts cannot
                // be quarantined reliably. Local cleanup below is best-effort.
            }
            clearEphemeralWebCredentialKey();
            let credentialHandled = false;
            let markerPresent = false;
            await runWithWebCredentialLock(async () => {
                try {
                    markerPresent = localStorage.getItem(AUTH_REVOKED_KEY) !== null;
                    const currentStored = localStorage.getItem(AUTH_KEY);
                    const currentSessionChange = localStorage.getItem(AUTH_SESSION_CHANGE_KEY);
                    if (
                        currentStored !== expectedStored
                        || currentSessionChange !== expectedSessionChange
                    ) {
                        // A later explicit login owns the current payload/key.
                        credentialHandled = true;
                        return;
                    }
                    localStorage.removeItem(AUTH_KEY);
                    credentialHandled = localStorage.getItem(AUTH_KEY) === null;
                } catch {
                    return;
                }
                if (credentialHandled && expectedStored !== null) {
                    try {
                        await deleteWebCredentialKey();
                    } catch {
                        // The ciphertext is gone and the admission signal blocks
                        // recovery even if IndexedDB key deletion is unavailable.
                    }
                }
            });
            return admissionReadable && markerPresent && credentialHandled;
        }
        if (!(await writeNativeRevocationMarkers()).anyWritten) {
            console.error('Credential revocation marker failed');
            return false;
        }
        return true;
    },

    async removeCredentials(): Promise<boolean> {
        if (Platform.OS === 'web') {
            installWebCredentialStorageListener();
            return runWithWebCredentialLock(async () => {
                let removed = true;
                let storedCredentialPresent = false;
                try {
                    storedCredentialPresent = localStorage.getItem(AUTH_KEY) !== null;
                    localStorage.removeItem(AUTH_KEY);
                    removed = localStorage.getItem(AUTH_KEY) === null;
                } catch {
                    removed = false;
                }
                clearEphemeralWebCredentialKey();
                if (removed && storedCredentialPresent) {
                    try {
                        await deleteWebCredentialKey();
                    } catch {
                        removed = false;
                    }
                }
                credentialsCache = null;
                ephemeralWebCredentials = null;
                if (!removed) console.error('Credential removal failed');
                return removed;
            });
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

    subscribeToCredentialsInvalidation(listener: () => void): () => void {
        if (Platform.OS !== 'web') return () => undefined;
        installWebCredentialStorageListener();
        webCredentialInvalidationListeners.add(listener);
        if (webCredentialInvalidated) listener();
        return () => {
            webCredentialInvalidationListeners.delete(listener);
        };
    },
};
