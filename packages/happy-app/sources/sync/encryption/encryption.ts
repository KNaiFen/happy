import { deriveKey } from "@/encryption/deriveKey";
import {
    AES256Encryption,
    BoxEncryption,
    SecretBoxEncryption,
    Encryptor,
    Decryptor,
    DisposableEncryption,
} from "./encryptor";
import { encodeHex } from "@/encryption/hex";
import { EncryptionCache } from "./encryptionCache";
import { SessionEncryption } from "./sessionEncryption";
import { MachineEncryption } from "./machineEncryption";
import { encodeBase64, decodeBase64 } from "@/encryption/base64";
import sodium from '@/encryption/libsodium.lib';
import { decryptBox, encryptBox } from "@/encryption/libsodium";
import { randomUUID } from 'expo-crypto';

export class Encryption {

    static async create(masterSecret: Uint8Array) {
        let contentDataKey: Uint8Array | null = null;
        let anonKey: Uint8Array | null = null;
        let contentKeyPair: sodium.KeyPair | null = null;
        let masterBlobKey: Uint8Array | null = null;
        let transferred = false;

        try {
            // Derive content data key to open session and machine records.
            contentDataKey = await deriveKey(masterSecret, 'Happy EnCoder', ['content']);

            // Derive content data key keypair.
            contentKeyPair = sodium.crypto_box_seed_keypair(contentDataKey);

            // Derive anonymous ID, then immediately clear the temporary key.
            anonKey = await deriveKey(masterSecret, 'Happy Coder', ['analytics', 'id']);
            const anonID = encodeHex(anonKey).slice(0, 16).toLowerCase();

            // Derive master blob key for legacy sessions (those with no per-session dataKey).
            masterBlobKey = await deriveKey(masterSecret, 'Happy Blobs', ['master']);

            // Encryption now owns masterSecret and all derived material.
            const encryption = new Encryption(anonID, masterSecret, contentKeyPair, masterBlobKey);
            transferred = true;
            return encryption;
        } finally {
            if (!transferred) {
                masterSecret.fill(0);
                contentDataKey?.fill(0);
                anonKey?.fill(0);
                masterBlobKey?.fill(0);
                contentKeyPair?.privateKey.fill(0);
                contentKeyPair?.publicKey.fill(0);
            }
            // The seed is only needed to derive the content keypair. The
            // public key retained by Encryption is a separate sodium buffer.
            contentDataKey?.fill(0);
            anonKey?.fill(0);
        }
    }

    private readonly legacyEncryption: SecretBoxEncryption;
    private readonly contentKeyPair: sodium.KeyPair;
    private readonly masterSecret: Uint8Array;
    private readonly masterBlobKey: Uint8Array;
    readonly anonID: string;
    readonly contentDataKey: Uint8Array;

    // Session and machine encryption management
    private sessionEncryptions = new Map<string, SessionEncryption>();
    private sessionDataKeys = new Map<string, Uint8Array>();
    private independentSessionIds = new Set<string>();
    private machineEncryptions = new Map<string, MachineEncryption>();
    private independentMachineIds = new Set<string>();
    private sessionBlobKeys = new Map<string, Uint8Array>();
    private sessionInitializationEpochs = new Map<string, number>();
    private machineInitializationEpochs = new Map<string, number>();
    private sessionInitializationAttempts = new Map<string, symbol>();
    private machineInitializationAttempts = new Map<string, symbol>();
    private removedSessionIds = new Set<string>();
    private removedMachineIds = new Set<string>();
    private cache: EncryptionCache;
    private disposed = false;

    private constructor(anonID: string, masterSecret: Uint8Array, contentKeyPair: sodium.KeyPair, masterBlobKey: Uint8Array) {
        this.anonID = anonID;
        this.masterSecret = masterSecret;
        this.contentKeyPair = contentKeyPair;
        this.legacyEncryption = new SecretBoxEncryption(masterSecret);
        this.masterBlobKey = masterBlobKey;
        this.cache = new EncryptionCache();
        this.contentDataKey = contentKeyPair.publicKey;
    }

    //
    // Core encryption opening
    //

    async openEncryption(
        dataEncryptionKey: Uint8Array | null,
    ): Promise<Encryptor & Decryptor & DisposableEncryption> {
        if (this.disposed) throw new Error('Encryption has been disposed');
        if (!dataEncryptionKey) {
            return this.legacyEncryption;
        }
        return new AES256Encryption(dataEncryptionKey);
    }

    //
    // Session operations
    //

    /**
     * Initialize sessions with their encryption keys
     * This should be called once when sessions are loaded
     */
    async initializeSessions(sessions: Map<string, Uint8Array | null>): Promise<void> {
        if (this.disposed) return;
        for (const [sessionId, dataKey] of sessions) {
            // Skip if already initialized
            if (this.sessionEncryptions.has(sessionId)) {
                continue;
            }
            if (this.removedSessionIds.has(sessionId)) {
                dataKey?.fill(0);
                continue;
            }

            const epoch = this.sessionInitializationEpochs.get(sessionId) ?? 0;
            const attempt = Symbol(sessionId);
            this.sessionInitializationAttempts.set(sessionId, attempt);
            let encryptor: (Encryptor & Decryptor & DisposableEncryption) | null = null;
            let sessionEnc: SessionEncryption | null = null;
            let ownedDataKey: Uint8Array | null = null;
            let blobKey: Uint8Array | null = null;

            try {
                // Create appropriate encryptor based on data key. AES contexts
                // retain their own key copy; the input remains caller-owned.
                encryptor = await this.openEncryption(dataKey);
                if (!this.isCurrentSessionInitialization(sessionId, attempt, epoch)) {
                    if (dataKey) encryptor.dispose();
                    continue;
                }

                sessionEnc = new SessionEncryption(sessionId, encryptor, this.cache);
                const previousSessionEnc = this.sessionEncryptions.get(sessionId);
                const previousSessionIndependent = this.independentSessionIds.has(sessionId);
                if (previousSessionEnc) {
                    if (previousSessionIndependent) {
                        previousSessionEnc.dispose();
                        this.sessionDataKeys.get(sessionId)?.fill(0);
                        this.sessionBlobKeys.get(sessionId)?.fill(0);
                    }
                    this.sessionEncryptions.delete(sessionId);
                    this.sessionDataKeys.delete(sessionId);
                    this.sessionBlobKeys.delete(sessionId);
                    this.independentSessionIds.delete(sessionId);
                    this.cache.clearSessionCache(sessionId);
                }
                this.sessionEncryptions.set(sessionId, sessionEnc);
                ownedDataKey = dataKey ? dataKey.slice() : this.masterSecret;
                this.sessionDataKeys.set(sessionId, ownedDataKey);
                if (dataKey) this.independentSessionIds.add(sessionId);
                else this.independentSessionIds.delete(sessionId);

                // Derive a blob subkey for independent sessions.
                blobKey = dataKey
                    ? await deriveKey(dataKey, 'Happy Blobs', ['session'])
                    : this.masterBlobKey;
                if (!this.isCurrentSessionInitialization(sessionId, attempt, epoch)
                    || this.sessionEncryptions.get(sessionId) !== sessionEnc) {
                    this.removeSessionInitialization(sessionId, attempt, sessionEnc, ownedDataKey, blobKey, !!dataKey);
                    continue;
                }
                this.sessionBlobKeys.set(sessionId, blobKey);
            } catch (error) {
                if (sessionEnc && ownedDataKey) {
                    this.removeSessionInitialization(sessionId, attempt, sessionEnc, ownedDataKey, blobKey, !!dataKey);
                } else if (dataKey && encryptor) {
                    encryptor.dispose();
                }
                throw error;
            } finally {
                if (this.sessionInitializationAttempts.get(sessionId) === attempt) {
                    this.sessionInitializationAttempts.delete(sessionId);
                }
            }
        }
    }

    private isCurrentSessionInitialization(sessionId: string, attempt: symbol, epoch: number): boolean {
        return !this.disposed
            && !this.removedSessionIds.has(sessionId)
            && this.sessionInitializationAttempts.get(sessionId) === attempt
            && (this.sessionInitializationEpochs.get(sessionId) ?? 0) === epoch;
    }

    private removeSessionInitialization(
        sessionId: string,
        attempt: symbol,
        sessionEnc: SessionEncryption,
        ownedDataKey: Uint8Array,
        blobKey: Uint8Array | null,
        independent: boolean,
    ): void {
        const ownsAttempt = this.sessionInitializationAttempts.get(sessionId) === attempt;
        if (!ownsAttempt) {
            if (independent) {
                ownedDataKey.fill(0);
                blobKey?.fill(0);
                sessionEnc.dispose();
            }
            return;
        }
        if (this.sessionEncryptions.get(sessionId) === sessionEnc) {
            this.sessionEncryptions.delete(sessionId);
            if (independent) this.independentSessionIds.delete(sessionId);
            this.cache.clearSessionCache(sessionId);
        }
        if (this.sessionDataKeys.get(sessionId) === ownedDataKey) {
            this.sessionDataKeys.delete(sessionId);
            if (independent) ownedDataKey.fill(0);
        }
        if (this.sessionBlobKeys.get(sessionId) === blobKey) {
            this.sessionBlobKeys.delete(sessionId);
        }
        if (independent) {
            ownedDataKey.fill(0);
            blobKey?.fill(0);
            sessionEnc.dispose();
        }
    }

    /**
     * Get session encryption if it has been initialized
     * Returns null if not initialized (should never happen in normal flow)
     */
    getSessionEncryption(sessionId: string): SessionEncryption | null {
        return this.sessionEncryptions.get(sessionId) || null;
    }

    isSessionRemoved(sessionId: string): boolean {
        return this.removedSessionIds.has(sessionId);
    }

    /**
     * Returns the session content key for domain-separated Sync v4 derivation.
     */
    getSessionDataKey(sessionId: string): Uint8Array | null {
        const key = this.sessionDataKeys.get(sessionId);
        return key ? key.slice() : null;
    }

    /** Returns only an independently wrapped session key; legacy master keys never cross machine RPC. */
    getIndependentSessionDataKey(sessionId: string): Uint8Array | null {
        if (!this.independentSessionIds.has(sessionId)) return null;
        const key = this.sessionDataKeys.get(sessionId);
        return key ? key.slice() : null;
    }

    /** Deterministic, domain-separated key for attaching one external Codex thread. */
    async deriveCodexResumeSessionDataKey(machineId: string, threadId: string): Promise<Uint8Array> {
        if (!machineId || !threadId) {
            throw new Error('machineId and threadId are required');
        }
        return deriveKey(this.masterSecret, 'Happy Codex Resume Session', [
            'v1',
            machineId,
            threadId,
        ]);
    }

    /**
     * Remove session encryption from memory when session is deleted
     */
    removeSessionEncryption(sessionId: string): void {
        this.removedSessionIds.add(sessionId);
        this.sessionInitializationAttempts.delete(sessionId);
        this.sessionInitializationEpochs.set(
            sessionId,
            (this.sessionInitializationEpochs.get(sessionId) ?? 0) + 1,
        );
        const isIndependent = this.independentSessionIds.has(sessionId);
        const sessionEncryption = this.sessionEncryptions.get(sessionId);
        if (isIndependent) {
            sessionEncryption?.dispose();
            this.sessionDataKeys.get(sessionId)?.fill(0);
            this.sessionBlobKeys.get(sessionId)?.fill(0);
        }
        this.sessionEncryptions.delete(sessionId);
        this.sessionDataKeys.delete(sessionId);
        this.independentSessionIds.delete(sessionId);
        this.sessionBlobKeys.delete(sessionId);
        // Also clear any cached data for this session
        this.cache.clearSessionCache(sessionId);
    }

    /**
     * Get the 32-byte NaCl secretbox key for encrypting binary blobs
     * (image attachments) in a session. Distinct from the message encryption
     * key to maintain cryptographic separation.
     * Returns null if the session has not been initialized.
     */
    getSessionBlobKey(sessionId: string): Uint8Array | null {
        return this.sessionBlobKeys.get(sessionId) ?? null;
    }

    //
    // Machine operations
    //

    /**
     * Initialize machines with their encryption keys
     * This should be called once when machines are loaded
     */
    async initializeMachines(machines: Map<string, Uint8Array | null>): Promise<void> {
        if (this.disposed) return;
        for (const [machineId, dataKey] of machines) {
            // Skip if already initialized
            if (this.machineEncryptions.has(machineId)) {
                continue;
            }
            if (this.removedMachineIds.has(machineId)) {
                dataKey?.fill(0);
                continue;
            }

            const epoch = this.machineInitializationEpochs.get(machineId) ?? 0;
            const attempt = Symbol(machineId);
            this.machineInitializationAttempts.set(machineId, attempt);
            let encryptor: (Encryptor & Decryptor & DisposableEncryption) | null = null;
            let machineEnc: MachineEncryption | null = null;

            try {
                // Create appropriate encryptor based on data key. The AES
                // implementation copies the input key for context ownership.
                encryptor = await this.openEncryption(dataKey);
                if (!this.isCurrentMachineInitialization(machineId, attempt, epoch)) {
                    if (dataKey) encryptor.dispose();
                    continue;
                }
                machineEnc = new MachineEncryption(machineId, encryptor, this.cache);
                const previousMachineEnc = this.machineEncryptions.get(machineId);
                const previousMachineIndependent = this.independentMachineIds.has(machineId);
                if (previousMachineEnc) {
                    if (previousMachineIndependent) previousMachineEnc.dispose();
                    this.machineEncryptions.delete(machineId);
                    this.independentMachineIds.delete(machineId);
                    this.cache.clearMachineCache(machineId);
                }
                this.machineEncryptions.set(machineId, machineEnc);
                if (dataKey) this.independentMachineIds.add(machineId);
                else this.independentMachineIds.delete(machineId);
            } catch (error) {
                if (machineEnc && dataKey) machineEnc.dispose();
                else if (dataKey && encryptor) encryptor.dispose();
                throw error;
            } finally {
                if (this.machineInitializationAttempts.get(machineId) === attempt) {
                    this.machineInitializationAttempts.delete(machineId);
                }
            }
        }
    }

    private isCurrentMachineInitialization(machineId: string, attempt: symbol, epoch: number): boolean {
        return !this.disposed
            && !this.removedMachineIds.has(machineId)
            && this.machineInitializationAttempts.get(machineId) === attempt
            && (this.machineInitializationEpochs.get(machineId) ?? 0) === epoch;
    }

    /**
     * Get machine encryption if it has been initialized
     * Returns null if not initialized (should never happen in normal flow)
     */
    getMachineEncryption(machineId: string): MachineEncryption | null {
        return this.machineEncryptions.get(machineId) || null;
    }

    isMachineRemoved(machineId: string): boolean {
        return this.removedMachineIds.has(machineId);
    }

    /**
     * Remove machine encryption from memory when the machine is deleted
     */
    removeMachineEncryption(machineId: string): void {
        this.removedMachineIds.add(machineId);
        this.machineInitializationAttempts.delete(machineId);
        this.machineInitializationEpochs.set(
            machineId,
            (this.machineInitializationEpochs.get(machineId) ?? 0) + 1,
        );
        if (this.independentMachineIds.has(machineId)) {
            this.machineEncryptions.get(machineId)?.dispose();
            this.independentMachineIds.delete(machineId);
        }
        this.machineEncryptions.delete(machineId);
        this.cache.clearMachineCache(machineId);
    }

    /** Drop all account keys and decrypted caches at the end of a lifecycle. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const encryption of this.sessionEncryptions.values()) encryption.dispose();
        for (const encryption of this.machineEncryptions.values()) encryption.dispose();
        this.sessionEncryptions.clear();
        for (const key of this.sessionDataKeys.values()) key.fill(0);
        this.sessionDataKeys.clear();
        this.independentSessionIds.clear();
        this.machineEncryptions.clear();
        this.independentMachineIds.clear();
        this.sessionInitializationEpochs.clear();
        this.machineInitializationEpochs.clear();
        this.sessionInitializationAttempts.clear();
        this.machineInitializationAttempts.clear();
        this.removedSessionIds.clear();
        this.removedMachineIds.clear();
        for (const key of this.sessionBlobKeys.values()) key.fill(0);
        this.sessionBlobKeys.clear();
        this.cache.clearAll();
        this.legacyEncryption.dispose();
        this.contentKeyPair.privateKey.fill(0);
        this.contentKeyPair.publicKey.fill(0);
        this.contentDataKey.fill(0);
        this.masterBlobKey.fill(0);
        this.masterSecret.fill(0);
    }

    //
    // Legacy methods for machine metadata (temporary until machines are migrated)
    //

    async encryptRaw(data: any): Promise<string> {
        const encrypted = await this.legacyEncryption.encrypt([data]);
        return encodeBase64(encrypted[0], 'base64');
    }

    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.legacyEncryption.decrypt([encryptedData]);
            return decrypted[0] || null;
        } catch (error) {
            return null;
        }
    }

    //
    // Data Encryption Key decryption
    //

    async decryptEncryptionKey(encrypted: string) {
        // Never throw: callers (fetchMachines/fetchSessions/artifacts) iterate
        // many keys, and an exception on one malformed/foreign key would
        // reject the whole sync and silently drop every item. Always degrade
        // to null so the caller can decide per-item.
        try {
            const encryptedKey = decodeBase64(encrypted, 'base64');
            if (encryptedKey[0] !== 0) {
                return null;
            }

            const decrypted = decryptBox(encryptedKey.slice(1), this.contentKeyPair.privateKey);
            if (!decrypted) {
                return null;
            }
            return decrypted;
        } catch {
            console.error('decryptEncryptionKey failed');
            return null;
        }
    }

    async encryptEncryptionKey(key: Uint8Array): Promise<Uint8Array> {
        // Use public key for encryption (encrypt TO ourselves)
        const encrypted = encryptBox(key, this.contentKeyPair.publicKey);
        const result = new Uint8Array(encrypted.length + 1);
        result[0] = 0; // Version byte
        result.set(encrypted, 1);
        return result;
    }

    generateId(): string {
        return randomUUID();
    }
}
