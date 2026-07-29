import {
    CodexEntityV4Schema,
    encodeSyncV4Aad,
    encodeSyncV4OpaqueEntityIdInput,
    type CodexEntityType,
    type CodexEntityV4,
    type SyncV4Aad,
} from '@slopus/happy-wire';
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
        const entityIdKey = await deriveKey(rootKey, 'Happy Sync v4 Entity IDs', ['hmac']);
        const entityAeadKey = await deriveKey(rootKey, 'Happy Sync v4 Entities', ['aead']);
        return new SyncV4Crypto(
            options.sessionId,
            entityIdKey,
            entityAeadKey,
            options.randomBytes ?? ((size) => sodium.randombytes_buf(size) as Uint8Array),
        );
    }

    private constructor(
        private readonly sessionId: string,
        private readonly entityIdKey: Uint8Array,
        private readonly entityAeadKey: Uint8Array,
        private readonly getRandomBytes: (size: number) => Uint8Array,
    ) {}

    async opaqueEntityId(entityType: CodexEntityType, providerId: string): Promise<string> {
        const digest = await hmac_sha512(
            this.entityIdKey,
            new TextEncoder().encode(encodeSyncV4OpaqueEntityIdInput(entityType, providerId)),
        );
        return encodeBase64(digest.slice(0, 32), 'base64url');
    }

    async encryptEntity(aad: SyncV4Aad, entity: CodexEntityV4): Promise<string> {
        this.assertAadSession(aad);
        if (entity.entityType !== aad.entityType) {
            throw new Error('Sync v4 entity type does not match AAD');
        }
        const expectedEntityId = await this.opaqueEntityId(entity.entityType, entity.providerId);
        if (expectedEntityId !== aad.entityId) {
            throw new Error('Sync v4 provider ID does not match opaque entity ID');
        }
        const nonce = this.getRandomBytes(SYNC_V4_NONCE_BYTES);
        if (nonce.length !== SYNC_V4_NONCE_BYTES) {
            throw new Error('Sync v4 nonce source returned an invalid length');
        }
        const plaintext = new TextEncoder().encode(JSON.stringify(entity));
        const additionalData = new TextEncoder().encode(encodeSyncV4Aad(aad));
        const ciphertext = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
            plaintext,
            additionalData,
            null,
            nonce,
            this.entityAeadKey,
            'uint8array',
        ) as Uint8Array;
        const bundle = new Uint8Array(1 + nonce.length + ciphertext.length);
        bundle[0] = SYNC_V4_CIPHERTEXT_VERSION;
        bundle.set(nonce, 1);
        bundle.set(ciphertext, 1 + nonce.length);
        return encodeBase64(bundle);
    }

    async decryptEntity(aad: SyncV4Aad, encodedCiphertext: string): Promise<CodexEntityV4> {
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
            const plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
                null,
                ciphertext,
                additionalData,
                nonce,
                this.entityAeadKey,
                'uint8array',
            ) as Uint8Array;
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
}
