import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { SyncV4Crypto, SyncV4DecryptionError } from './syncV4Crypto';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/encryption/libsodium.lib', async () => {
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    return { default: sodium };
});

vi.mock('@/encryption/hmac_sha512', () => ({
    hmac_sha512: async (key: Uint8Array, data: Uint8Array) => (
        new Uint8Array(createHmac('sha512', key).update(data).digest())
    ),
}));

const sessionKey = Uint8Array.from({ length: 32 }, (_, index) => index);
const nonce = Uint8Array.from({ length: 12 }, (_, index) => 0xa0 + index);
const opaqueEntityId = 'FB3k6oMuHXDCahGdf5_8oHMotEe6X9yuRE9QOf72uok';
const encryptedVector = 'AaChoqOkpaanqKmqq/4yaqnQnL9rELQvKqBxR11IeGxODZ0EON3TTx6SDW+QXb+M/k2tZlY0VH/Lg69SiybDd3ZgzL6EgUp2fSjJ4VsiT3gG+4U9x+W7R/9mUVGIZ5yn54LNHt0w0OnVndM+9+pkqBVpjnWifPS+KtyLM3ujXH/EEfnWOM30iLOrwJ4q35CG46nyIuSrsTX9/S3P+gCzzULNGT+f5u3pFSRHly7a5sa+xJ0TV7RTqKLpG+vMnkmMYAsXY+gR2LV7GrtGY9DX451CLC0Fk+z0UgGG+OwyeTVN/t4Z5e1W4Ht84LKO5BqS9K27HtzH2yrFjIVVRCzVoCW5/g96gVE7F/BHyBObyWvjKAM2nc1oKuWpsiS5HY3v/xvM5I1EUd27I5y3Xi/uc3nCxA96FV60mGlcS3TTmlHM/WfXb+CnwD4EbGFrSA==';
const entity = {
    schemaVersion: 1 as const,
    entityType: 'codex.part' as const,
    providerId: 'part-1',
    createdAt: 10,
    updatedAt: 11,
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    partId: 'part-1',
    kind: 'reasoningSummary' as const,
    index: 0,
    chunkIndex: 0,
    content: 'Checked the synchronization path.',
    contentType: 'text' as const,
    final: false,
};

async function createCrypto(): Promise<SyncV4Crypto> {
    return SyncV4Crypto.create({
        sessionId: 'session-1',
        sessionKey,
        randomBytes: () => nonce,
    });
}

describe('SyncV4Crypto interoperability', () => {
    it('matches the CLI opaque ID and ciphertext vector', async () => {
        const crypto = await createCrypto();
        await expect(crypto.opaqueEntityId(entity.entityType, entity.providerId)).resolves.toBe(opaqueEntityId);
        const aad = {
            sessionId: 'session-1',
            entityId: opaqueEntityId,
            entityType: entity.entityType,
            revision: 1,
            op: 'upsert' as const,
        };
        await expect(crypto.encryptEntity(aad, entity)).resolves.toBe(encryptedVector);
        await expect(crypto.decryptEntity(aad, encryptedVector)).resolves.toEqual(entity);
    });

    it('rejects altered authenticated fields and ciphertext', async () => {
        const crypto = await createCrypto();
        const aad = {
            sessionId: 'session-1',
            entityId: opaqueEntityId,
            entityType: entity.entityType,
            revision: 1,
            op: 'upsert' as const,
        };
        await expect(crypto.decryptEntity({ ...aad, revision: 2 }, encryptedVector))
            .rejects.toBeInstanceOf(SyncV4DecryptionError);
        const tampered = decodeBase64(encryptedVector);
        tampered[tampered.length - 1] ^= 1;
        await expect(crypto.decryptEntity(aad, encodeBase64(tampered)))
            .rejects.toBeInstanceOf(SyncV4DecryptionError);
    });
});
