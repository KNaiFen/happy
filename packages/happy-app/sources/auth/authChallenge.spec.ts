import { beforeEach, describe, expect, it, vi } from 'vitest';

const { keypair, cryptoSignDetached } = vi.hoisted(() => ({
    keypair: {
        privateKey: new Uint8Array(64).fill(7),
        publicKey: new Uint8Array(32).fill(8),
    },
    cryptoSignDetached: vi.fn(),
}));

vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn(() => new Uint8Array(32)),
}));
vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        crypto_sign_seed_keypair: vi.fn(() => keypair),
        crypto_sign_detached: cryptoSignDetached,
    },
}));

import { signAuthChallenge } from './authChallenge';

describe('signAuthChallenge key material lifetime', () => {
    beforeEach(() => {
        keypair.privateKey.fill(7);
        keypair.publicKey.fill(8);
        cryptoSignDetached.mockReset();
        cryptoSignDetached.mockReturnValue(new Uint8Array(64).fill(9));
    });

    it('clears the derived signing private key after success', () => {
        const result = signAuthChallenge(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));

        expect(result.publicKey).toEqual(new Uint8Array(32).fill(8));
        expect(keypair.privateKey).toEqual(new Uint8Array(64));
    });

    it('clears the derived signing private key when signing throws', () => {
        cryptoSignDetached.mockImplementationOnce(() => {
            throw new Error('signing failed');
        });

        expect(() => signAuthChallenge(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)))
            .toThrow('signing failed');
        expect(keypair.privateKey).toEqual(new Uint8Array(64));
    });
});
