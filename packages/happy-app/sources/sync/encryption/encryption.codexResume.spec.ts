import { describe, expect, it, vi } from 'vitest';

const deriveKey = vi.hoisted(() => vi.fn(async (
    _master: Uint8Array,
    usage: string,
    path: string[],
) => {
    const discriminator = [...usage, ...path.join('/')]
        .reduce((sum, character) => (sum + character.charCodeAt(0)) % 251, 0);
    return new Uint8Array(32).fill(discriminator);
}));

vi.mock('@/encryption/deriveKey', () => ({ deriveKey }));
vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        crypto_box_seed_keypair: (seed: Uint8Array) => ({
            publicKey: seed.slice(),
            privateKey: seed.slice(),
        }),
    },
}));
vi.mock('@/encryption/libsodium', () => ({
    decryptBox: vi.fn(),
    encryptBox: vi.fn(() => new Uint8Array(48)),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('./encryptor', () => {
    class TestEncryption {
        async encrypt(values: unknown[]) { return values; }
        async decrypt(values: unknown[]) { return values; }
    }
    return {
        AES256Encryption: TestEncryption,
        BoxEncryption: TestEncryption,
        SecretBoxEncryption: TestEncryption,
    };
});

import { Encryption } from './encryption';

describe('Encryption Codex resume keys', () => {
    it('never exposes the legacy account key as session resume material', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const independent = new Uint8Array(32).fill(9);
        await encryption.initializeSessions(new Map([
            ['legacy', null],
            ['independent', independent],
        ]));

        expect(encryption.getIndependentSessionDataKey('legacy')).toBeNull();
        expect(encryption.getIndependentSessionDataKey('independent')).toEqual(independent);
    });

    it('derives stable keys per machine and provider thread without exposing the master secret', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(3));

        const first = await encryption.deriveCodexResumeSessionDataKey('machine-1', 'thread-1');
        const retry = await encryption.deriveCodexResumeSessionDataKey('machine-1', 'thread-1');
        const other = await encryption.deriveCodexResumeSessionDataKey('machine-1', 'thread-2');

        expect(first).toHaveLength(32);
        expect(first).toEqual(retry);
        expect(first).not.toEqual(other);
        expect(deriveKey).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            'Happy Codex Resume Session',
            ['v1', 'machine-1', 'thread-1'],
        );
    });
});
