import {
    CodexEntityV4Schema,
    encodeSyncV4Aad,
    encodeSyncV4OpaqueEntityIdInput,
    type CodexEntityType,
    type CodexEntityV4,
    type SyncV4Aad,
} from '@slopus/happy-wire';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { decodeBase64, encodeBase64 } from '../encryption/base64';
import { deriveKey } from '../encryption/deriveKey';
import { hmac_sha512 } from '../encryption/hmac_sha512';
import sodium from '../encryption/libsodium.lib';

const SYNC_V4_CIPHERTEXT_VERSION = 1;
const SYNC_V4_NONCE_BYTES = 12;
const SYNC_V4_AUTH_TAG_BYTES = 16;

interface SyncV4CryptoOptions {
    sessionId: string;
    sessionKey: Uint8Array;
    randomBytes?: (size: number) => Uint8Array;
}

export class SyncV4DecryptionError extends Error {
    constructor() {
        super('Unable to authenticate Sync v4 entity');
    }
}

/**
 * App counterpart to the CLI Sync v4 crypto context. Both implementations
 * share key derivation, canonical AAD, and ChaCha20-Poly1305 wire bytes.
 */
export class SyncV4Crypto {
    static async create(options: SyncV4CryptoOptions): Promise<SyncV4Crypto> {
        if (options.sessionKey.length !== 32) {
            throw new Error('Sync v4 requires a 32-byte session key');
        }
        await sodium.ready;
        const rootKey = await deriveKey(options.sessionKey, 'Happy Sync v4', [options.sessionId]);
        let entityIdKey: Uint8Array | null = null;
        let entityAeadKey: Uint8Array | null = null;
        let crypto: SyncV4Crypto | null = null;
        try {
            entityIdKey = await deriveKey(rootKey, 'Happy Sync v4 Entity IDs', ['hmac']);
            entityAeadKey = await deriveKey(rootKey, 'Happy Sync v4 Entities', ['aead']);
            crypto = new SyncV4Crypto(
                options.sessionId,
                entityIdKey,
                entityAeadKey,
                options.randomBytes ?? ((size) => sodium.randombytes_buf(size) as Uint8Array),
            );
            return crypto;
        } finally {
            rootKey.fill(0);
            // Ownership moves to SyncV4Crypto only after construction succeeds.
            if (!crypto) {
                entityIdKey?.fill(0);
                entityAeadKey?.fill(0);
            }
        }
    }

    private constructor(
        private readonly sessionId: string,
        private readonly entityIdKey: Uint8Array,
        private readonly entityAeadKey: Uint8Array,
        private readonly getRandomBytes: (size: number) => Uint8Array,
    ) {}

    private disposed = false;

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.entityIdKey.fill(0);
        this.entityAeadKey.fill(0);
    }

    async opaqueEntityId(entityType: CodexEntityType, providerId: string): Promise<string> {
        this.assertUsable();
        const digest = await hmac_sha512(
            this.entityIdKey,
            new TextEncoder().encode(encodeSyncV4OpaqueEntityIdInput(entityType, providerId)),
        );
        return encodeBase64(digest.slice(0, 32), 'base64url');
    }

    async encryptEntity(aad: SyncV4Aad, entity: CodexEntityV4): Promise<string> {
        this.assertUsable();
        this.assertAadSession(aad);
        const canonicalEntity = CodexEntityV4Schema.parse(entity);
        if (canonicalEntity.entityType !== aad.entityType) {
            throw new Error('Sync v4 entity type does not match AAD');
        }
        const expectedEntityId = await this.opaqueEntityId(
            canonicalEntity.entityType,
            canonicalEntity.providerId,
        );
        if (expectedEntityId !== aad.entityId) {
            throw new Error('Sync v4 provider ID does not match opaque entity ID');
        }
        const nonce = this.getRandomBytes(SYNC_V4_NONCE_BYTES);
        if (nonce.length !== SYNC_V4_NONCE_BYTES) {
            throw new Error('Sync v4 nonce source returned an invalid length');
        }
        const plaintext = new TextEncoder().encode(JSON.stringify(canonicalEntity));
        const additionalData = new TextEncoder().encode(encodeSyncV4Aad(aad));
        const ciphertext = chacha20poly1305(
            this.entityAeadKey,
            nonce,
            additionalData,
        ).encrypt(plaintext);
        const bundle = new Uint8Array(1 + nonce.length + ciphertext.length);
        bundle[0] = SYNC_V4_CIPHERTEXT_VERSION;
        bundle.set(nonce, 1);
        bundle.set(ciphertext, 1 + nonce.length);
        return encodeBase64(bundle);
    }

    async decryptEntity(aad: SyncV4Aad, encodedCiphertext: string): Promise<CodexEntityV4> {
        this.assertUsable();
        this.assertAadSession(aad);
        try {
            const bundle = decodeBase64(encodedCiphertext);
            const minimumLength = 1 + SYNC_V4_NONCE_BYTES + SYNC_V4_AUTH_TAG_BYTES;
            if (bundle.length < minimumLength || bundle[0] !== SYNC_V4_CIPHERTEXT_VERSION) {
                throw new SyncV4DecryptionError();
            }
            const nonce = bundle.slice(1, 1 + SYNC_V4_NONCE_BYTES);
            const ciphertext = bundle.slice(1 + SYNC_V4_NONCE_BYTES);
            const additionalData = new TextEncoder().encode(encodeSyncV4Aad(aad));
            const plaintext = chacha20poly1305(
                this.entityAeadKey,
                nonce,
                additionalData,
            ).decrypt(ciphertext);
            const entity = CodexEntityV4Schema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
            if (entity.entityType !== aad.entityType) {
                throw new SyncV4DecryptionError();
            }
            const expectedEntityId = await this.opaqueEntityId(entity.entityType, entity.providerId);
            if (expectedEntityId !== aad.entityId) {
                throw new SyncV4DecryptionError();
            }
            return entity;
        } catch (error) {
            if (error instanceof SyncV4DecryptionError) throw error;
            throw new SyncV4DecryptionError();
        }
    }

    private assertAadSession(aad: SyncV4Aad): void {
        if (aad.sessionId !== this.sessionId) {
            throw new Error('Sync v4 AAD belongs to a different session');
        }
    }

    private assertUsable(): void {
        if (this.disposed) throw new Error('Sync v4 crypto has been disposed');
    }
}
