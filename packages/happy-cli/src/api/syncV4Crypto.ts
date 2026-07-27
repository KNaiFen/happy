import {
    CodexEntityV4Schema,
    encodeSyncV4Aad,
    encodeSyncV4OpaqueEntityIdInput,
    type CodexEntityType,
    type CodexEntityV4,
    type SyncV4Aad,
} from "@slopus/happy-wire";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { decodeBase64, encodeBase64 } from "@/api/encryption";
import { deriveKey } from "@/utils/deriveKey";
import { hmac_sha512 } from "@/utils/hmac_sha512";

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
        super("Unable to authenticate Sync v4 entity");
    }
}

/**
 * Provides domain-separated opaque IDs and authenticated entity encryption for
 * one Happy session. The server never receives the provider ID or plaintext.
 */
export class SyncV4Crypto {
    static async create(options: SyncV4CryptoOptions): Promise<SyncV4Crypto> {
        if (options.sessionKey.length !== 32) {
            throw new Error("Sync v4 requires a 32-byte session key");
        }
        const rootKey = await deriveKey(options.sessionKey, "Happy Sync v4", [options.sessionId]);
        const entityIdKey = await deriveKey(rootKey, "Happy Sync v4 Entity IDs", ["hmac"]);
        const entityAeadKey = await deriveKey(rootKey, "Happy Sync v4 Entities", ["aead"]);
        return new SyncV4Crypto(
            options.sessionId,
            entityIdKey,
            entityAeadKey,
            options.randomBytes ?? ((size) => new Uint8Array(randomBytes(size))),
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
        return encodeBase64(digest.slice(0, 32), "base64url");
    }

    async encryptEntity(aad: SyncV4Aad, entity: CodexEntityV4): Promise<string> {
        this.assertAadSession(aad);
        if (entity.entityType !== aad.entityType) {
            throw new Error("Sync v4 entity type does not match AAD");
        }
        const expectedEntityId = await this.opaqueEntityId(entity.entityType, entity.providerId);
        if (expectedEntityId !== aad.entityId) {
            throw new Error("Sync v4 provider ID does not match opaque entity ID");
        }

        const nonce = this.getRandomBytes(SYNC_V4_NONCE_BYTES);
        if (nonce.length !== SYNC_V4_NONCE_BYTES) {
            throw new Error("Sync v4 nonce source returned an invalid length");
        }
        const cipher = createCipheriv("chacha20-poly1305", this.entityAeadKey, nonce, {
            authTagLength: SYNC_V4_AUTH_TAG_BYTES,
        });
        const plaintext = Buffer.from(JSON.stringify(entity), "utf8");
        cipher.setAAD(Buffer.from(encodeSyncV4Aad(aad), "utf8"), { plaintextLength: plaintext.length });
        const ciphertext = Buffer.concat([
            cipher.update(plaintext),
            cipher.final(),
        ]);
        const authTag = cipher.getAuthTag();
        const bundle = new Uint8Array(1 + nonce.length + ciphertext.length + authTag.length);
        bundle[0] = SYNC_V4_CIPHERTEXT_VERSION;
        bundle.set(nonce, 1);
        bundle.set(ciphertext, 1 + nonce.length);
        bundle.set(authTag, 1 + nonce.length + ciphertext.length);
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
            const authTag = bundle.slice(bundle.length - SYNC_V4_AUTH_TAG_BYTES);
            const ciphertext = bundle.slice(1 + SYNC_V4_NONCE_BYTES, bundle.length - SYNC_V4_AUTH_TAG_BYTES);
            const decipher = createDecipheriv("chacha20-poly1305", this.entityAeadKey, nonce, {
                authTagLength: SYNC_V4_AUTH_TAG_BYTES,
            });
            decipher.setAAD(Buffer.from(encodeSyncV4Aad(aad), "utf8"), { plaintextLength: ciphertext.length });
            decipher.setAuthTag(authTag);
            const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
            const entity = CodexEntityV4Schema.parse(JSON.parse(plaintext));
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
            throw new Error("Sync v4 AAD belongs to a different session");
        }
    }
}
