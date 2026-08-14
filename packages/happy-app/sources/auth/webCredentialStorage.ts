import { decodeBase64, encodeBase64 } from '@/encryption/base64';

const DATABASE_NAME = 'happy-web-credentials';
const DATABASE_VERSION = 1;
const KEY_STORE_NAME = 'keys';
const CREDENTIAL_KEY_ID = 'credentials-aes-gcm-v1';
const CREDENTIAL_LOCK_NAME = 'happy-web-credentials-v1';
const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;
const LEGACY_ENVELOPE_VERSION = 1;
const ENVELOPE_VERSION = 2;
const MAX_STORED_CREDENTIAL_LENGTH = 64 * 1024;

export type WebCredentialAdmission = {
    revocationSignal: string | null;
    bootstrapSignal: string | null;
};

type LegacyCredentialEnvelope = {
    version: typeof LEGACY_ENVELOPE_VERSION;
    data: string;
};

type CredentialEnvelope = {
    version: typeof ENVELOPE_VERSION;
    data: string;
    revocationSignal: string | null;
    bootstrapSignal: string | null;
};

type ParsedCredentialEnvelope = LegacyCredentialEnvelope | CredentialEnvelope;

export type EncryptedWebCredential = {
    value: string;
    persistent: boolean;
};

type LockManagerLike = {
    request<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
};

let ephemeralCredentialKey: CryptoKey | null = null;
let indexedDbUnavailable = false;
let webLocksUnavailable = false;
let fallbackLockTail: Promise<void> = Promise.resolve();

function getWebLockManager(): LockManagerLike | null {
    if (webLocksUnavailable) return null;
    if (typeof navigator === 'undefined') return null;
    const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
    return locks && typeof locks.request === 'function' ? locks : null;
}

export async function runWithWebCredentialLock<T>(operation: () => Promise<T>): Promise<T> {
    const locks = getWebLockManager();
    if (locks) {
        let operationStarted = false;
        try {
            return await locks.request(CREDENTIAL_LOCK_NAME, () => {
                operationStarted = true;
                return operation();
            });
        } catch (error) {
            if (operationStarted) throw error;
            // A browser may expose Web Locks but reject every request by policy.
            // Keep this page session-only once cross-context serialization cannot
            // be established, then serialize its remaining work in-process.
            webLocksUnavailable = true;
            indexedDbUnavailable = true;
        }
    }

    const previous = fallbackLockTail;
    let release!: () => void;
    fallbackLockTail = new Promise<void>((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        return await operation();
    } finally {
        release();
    }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Credential key request failed'));
    });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Credential key transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Credential key transaction aborted'));
    });
}

function openCredentialDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(KEY_STORE_NAME)) {
                request.result.createObjectStore(KEY_STORE_NAME);
            }
        };
        request.onsuccess = () => {
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };
        request.onerror = () => reject(request.error ?? new Error('Credential key database failed'));
        request.onblocked = () => reject(new Error('Credential key database blocked'));
    });
}

function asCredentialKey(value: unknown): CryptoKey | null {
    if (!value || typeof value !== 'object') return null;
    const key = value as CryptoKey;
    if (
        key.type !== 'secret'
        || key.extractable
        || key.algorithm?.name !== ALGORITHM
        || !key.usages.includes('encrypt')
        || !key.usages.includes('decrypt')
    ) {
        return null;
    }
    return key;
}

async function readPersistedCredentialKey(): Promise<unknown> {
    const database = await openCredentialDatabase();
    try {
        const transaction = database.transaction(KEY_STORE_NAME, 'readonly');
        const completed = transactionComplete(transaction);
        try {
            const value = await requestResult(transaction.objectStore(KEY_STORE_NAME).get(CREDENTIAL_KEY_ID));
            await completed;
            return value;
        } catch (error) {
            await completed.catch(() => undefined);
            throw error;
        }
    } finally {
        database.close();
    }
}

async function addPersistedCredentialKey(key: CryptoKey): Promise<void> {
    const database = await openCredentialDatabase();
    try {
        const transaction = database.transaction(KEY_STORE_NAME, 'readwrite');
        const completed = transactionComplete(transaction);
        try {
            await requestResult(transaction.objectStore(KEY_STORE_NAME).add(key, CREDENTIAL_KEY_ID));
            await completed;
        } catch (error) {
            await completed.catch(() => undefined);
            throw error;
        }
    } finally {
        database.close();
    }
}

async function deletePersistedCredentialKey(): Promise<void> {
    const database = await openCredentialDatabase();
    try {
        const transaction = database.transaction(KEY_STORE_NAME, 'readwrite');
        const completed = transactionComplete(transaction);
        try {
            await requestResult(transaction.objectStore(KEY_STORE_NAME).delete(CREDENTIAL_KEY_ID));
            await completed;
        } catch (error) {
            await completed.catch(() => undefined);
            throw error;
        }
    } finally {
        database.close();
    }
}

async function generateCredentialKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey(
        { name: ALGORITHM, length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

async function getOrCreateCredentialKey(): Promise<{ key: CryptoKey; persistent: boolean }> {
    if (
        !getWebLockManager()
        || typeof indexedDB === 'undefined'
        || indexedDbUnavailable
    ) {
        ephemeralCredentialKey ??= await generateCredentialKey();
        return { key: ephemeralCredentialKey, persistent: false };
    }

    try {
        const persisted = await readPersistedCredentialKey();
        if (persisted !== undefined) {
            const key = asCredentialKey(persisted);
            if (!key) throw new Error('Credential key is invalid');
            return { key, persistent: true };
        }

        const generated = await generateCredentialKey();
        try {
            await addPersistedCredentialKey(generated);
            return { key: generated, persistent: true };
        } catch (error) {
            const winner = asCredentialKey(await readPersistedCredentialKey());
            if (winner) return { key: winner, persistent: true };
            throw error;
        }
    } catch {
        indexedDbUnavailable = true;
        ephemeralCredentialKey ??= await generateCredentialKey();
        return { key: ephemeralCredentialKey, persistent: false };
    }
}

async function getCredentialKeyForDecrypt(): Promise<CryptoKey | null> {
    if (ephemeralCredentialKey) return ephemeralCredentialKey;
    if (
        !getWebLockManager()
        || typeof indexedDB === 'undefined'
        || indexedDbUnavailable
    ) {
        return null;
    }
    try {
        const key = asCredentialKey(await readPersistedCredentialKey());
        if (!key) return null;
        return key;
    } catch {
        indexedDbUnavailable = true;
        return null;
    }
}

function isAdmissionValue(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function parseEnvelope(value: string): ParsedCredentialEnvelope | null {
    if (!value || value.length > MAX_STORED_CREDENTIAL_LENGTH) return null;
    try {
        const parsed = JSON.parse(value) as {
            version?: number;
            data?: unknown;
            revocationSignal?: unknown;
            bootstrapSignal?: unknown;
        };
        if (typeof parsed.data !== 'string') return null;
        if (parsed.version === LEGACY_ENVELOPE_VERSION) {
            return { version: LEGACY_ENVELOPE_VERSION, data: parsed.data };
        }
        if (
            parsed.version !== ENVELOPE_VERSION
            || !isAdmissionValue(parsed.revocationSignal)
            || !isAdmissionValue(parsed.bootstrapSignal)
        ) {
            return null;
        }
        return {
            version: ENVELOPE_VERSION,
            data: parsed.data,
            revocationSignal: parsed.revocationSignal,
            bootstrapSignal: parsed.bootstrapSignal,
        };
    } catch {
        return null;
    }
}

function admissionData(admission: WebCredentialAdmission): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(admission));
}

export function getWebCredentialAdmission(value: string): WebCredentialAdmission | null {
    const envelope = parseEnvelope(value);
    if (!envelope) return null;
    if (envelope.version === LEGACY_ENVELOPE_VERSION) {
        return { revocationSignal: null, bootstrapSignal: null };
    }
    return {
        revocationSignal: envelope.revocationSignal,
        bootstrapSignal: envelope.bootstrapSignal,
    };
}

export function isEncryptedWebCredential(value: string): boolean {
    return parseEnvelope(value) !== null;
}

export async function encryptWebCredential(
    plaintext: string,
    admission: WebCredentialAdmission = { revocationSignal: null, bootstrapSignal: null },
): Promise<EncryptedWebCredential> {
    if (plaintext.length > MAX_STORED_CREDENTIAL_LENGTH) {
        throw new Error('Credential payload is too large');
    }
    const { key, persistent } = await getOrCreateCredentialKey();
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const ciphertext = await crypto.subtle.encrypt(
        {
            name: ALGORITHM,
            iv: iv as BufferSource,
            additionalData: admissionData(admission) as BufferSource,
        },
        key,
        new TextEncoder().encode(plaintext) as BufferSource,
    );
    const bundle = new Uint8Array(iv.length + ciphertext.byteLength);
    bundle.set(iv, 0);
    bundle.set(new Uint8Array(ciphertext), iv.length);
    return {
        value: JSON.stringify({
            version: ENVELOPE_VERSION,
            data: encodeBase64(bundle),
            ...admission,
        } satisfies CredentialEnvelope),
        persistent,
    };
}

export async function decryptWebCredential(value: string): Promise<string | null> {
    const envelope = parseEnvelope(value);
    if (!envelope) return null;
    try {
        const bundle = decodeBase64(envelope.data);
        if (bundle.length <= IV_LENGTH + 16) return null;
        const key = await getCredentialKeyForDecrypt();
        if (!key) return null;
        const algorithm: AesGcmParams = {
            name: ALGORITHM,
            iv: bundle.slice(0, IV_LENGTH) as BufferSource,
        };
        if (envelope.version === ENVELOPE_VERSION) {
            algorithm.additionalData = admissionData({
                revocationSignal: envelope.revocationSignal,
                bootstrapSignal: envelope.bootstrapSignal,
            }) as BufferSource;
        }
        const plaintext = await crypto.subtle.decrypt(
            algorithm,
            key,
            bundle.slice(IV_LENGTH) as BufferSource,
        );
        return new TextDecoder().decode(plaintext);
    } catch {
        return null;
    }
}

export function clearEphemeralWebCredentialKey(): void {
    ephemeralCredentialKey = null;
}

export async function deleteWebCredentialKey(): Promise<void> {
    clearEphemeralWebCredentialKey();
    if (typeof indexedDB === 'undefined' || webLocksUnavailable) {
        indexedDbUnavailable = false;
        return;
    }
    try {
        await deletePersistedCredentialKey();
        indexedDbUnavailable = false;
    } catch (error) {
        indexedDbUnavailable = true;
        throw error;
    }
}
