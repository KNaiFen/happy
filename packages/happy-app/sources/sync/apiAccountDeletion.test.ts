import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteAccount } from './apiAccountDeletion';

const {
    decodeBase64,
    encodeBase64,
    signAuthChallenge,
    serverFetch,
    decodedSecret,
    decodedChallenge,
} = vi.hoisted(() => ({
    decodeBase64: vi.fn(),
    encodeBase64: vi.fn(),
    signAuthChallenge: vi.fn(),
    serverFetch: vi.fn(),
    decodedSecret: { value: null as Uint8Array | null },
    decodedChallenge: { value: null as Uint8Array | null },
}));

vi.mock('@/encryption/base64', () => ({ decodeBase64, encodeBase64 }));
vi.mock('@/auth/authChallenge', () => ({ signAuthChallenge }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://happy.example' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'test-client' }));
vi.mock('./serverTransport', () => ({ serverFetch }));

const credentials = {
    token: 'account-token',
    secret: 'account-secret',
};

const signedChallenge = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const signature = Uint8Array.from({ length: 64 }, (_, index) => index + 65);
let signedSecret: Uint8Array | null = null;
let signedChallengeInput: Uint8Array | null = null;

beforeEach(() => {
    decodeBase64.mockReset();
    encodeBase64.mockReset();
    signAuthChallenge.mockReset();
    serverFetch.mockReset();

    decodedSecret.value = new Uint8Array(32).fill(1);
    decodedChallenge.value = signedChallenge.slice();
    signedSecret = null;
    signedChallengeInput = null;
    decodeBase64.mockImplementation((value: string) => (
        value === credentials.secret ? decodedSecret.value! : decodedChallenge.value!
    ));
    encodeBase64.mockImplementation((value: Uint8Array) => `encoded:${value[0]}:${value.length}`);
    signAuthChallenge.mockImplementation((secret: Uint8Array, challenge: Uint8Array) => {
        signedSecret = secret.slice();
        signedChallengeInput = challenge.slice();
        return {
        challenge: decodedChallenge.value!,
        publicKey: publicKey.slice(),
        signature: signature.slice(),
        };
    });
});

describe('deleteAccount', () => {
    it('obtains a server challenge, signs it, and submits one authenticated deletion proof', async () => {
        serverFetch
            .mockResolvedValueOnce(jsonResponse({
                challengeId: 'challenge-1',
                challenge: 'server-challenge',
                expiresAt: Date.now() + 60_000,
            }))
            .mockResolvedValueOnce(jsonResponse({ status: 'deleted' }));

        await expect(deleteAccount(credentials)).resolves.toBe('deleted');

        const headers = {
            Authorization: 'Bearer account-token',
            'Content-Type': 'application/json',
            'X-Happy-Client': 'test-client',
        };
        expect(serverFetch).toHaveBeenNthCalledWith(1,
            'https://happy.example/v1/account/deletion-challenge',
            { method: 'POST', headers },
        );
        expect(signedSecret).toEqual(new Uint8Array(32).fill(1));
        expect(signedChallengeInput).toEqual(signedChallenge);
        expect(decodedSecret.value).toEqual(new Uint8Array(32));
        expect(decodedChallenge.value).toEqual(new Uint8Array(32));
        expect(serverFetch).toHaveBeenNthCalledWith(2,
            'https://happy.example/v1/account',
            {
                method: 'DELETE',
                headers,
                body: JSON.stringify({
                    challengeId: 'challenge-1',
                    challenge: 'encoded:1:32',
                    publicKey: 'encoded:33:32',
                    signature: 'encoded:65:64',
                }),
            },
        );
    });

    it('waits for local revocation before submitting the deletion proof', async () => {
        let releaseRevocation!: () => void;
        const revocation = new Promise<void>((resolve) => { releaseRevocation = resolve; });
        const controller = new AbortController();
        const assertCurrent = vi.fn();
        const beforeProofSubmission = vi.fn(async () => {
            await revocation;
            return { signal: controller.signal, assertCurrent };
        });
        serverFetch
            .mockResolvedValueOnce(jsonResponse({
                challengeId: 'challenge-1',
                challenge: 'server-challenge',
                expiresAt: Date.now() + 60_000,
            }))
            .mockResolvedValueOnce(jsonResponse({ status: 'deleted' }));

        const deletion = deleteAccount(credentials, { beforeProofSubmission });
        await vi.waitFor(() => expect(beforeProofSubmission).toHaveBeenCalledOnce());
        expect(serverFetch).toHaveBeenCalledTimes(1);
        expect(signAuthChallenge).toHaveBeenCalledOnce();

        releaseRevocation();
        await expect(deletion).resolves.toBe('deleted');
        expect(serverFetch).toHaveBeenCalledTimes(2);
        expect(assertCurrent).toHaveBeenCalledOnce();
        expect(serverFetch.mock.calls[1][1]).toMatchObject({ signal: controller.signal });
    });

    it('does not submit a deletion proof when local revocation fails', async () => {
        serverFetch.mockResolvedValueOnce(jsonResponse({
            challengeId: 'challenge-1',
            challenge: 'server-challenge',
            expiresAt: Date.now() + 60_000,
        }));

        await expect(deleteAccount(credentials, {
            beforeProofSubmission: async () => { throw new Error('revocation unavailable'); },
        })).rejects.toThrow('revocation unavailable');
        expect(serverFetch).toHaveBeenCalledTimes(1);
        expect(decodeBase64).toHaveBeenCalledTimes(2);
        expect(signAuthChallenge).toHaveBeenCalledOnce();
    });

    it('does not submit a proof when local revocation becomes stale before transport', async () => {
        const assertCurrent = vi.fn(() => {
            throw new Error('Local account revocation is no longer current');
        });
        serverFetch.mockResolvedValueOnce(jsonResponse({
            challengeId: 'challenge-1',
            challenge: 'server-challenge',
            expiresAt: Date.now() + 60_000,
        }));

        await expect(deleteAccount(credentials, {
            beforeProofSubmission: async () => ({
                signal: new AbortController().signal,
                assertCurrent,
            }),
        })).rejects.toThrow('Local account revocation is no longer current');

        expect(assertCurrent).toHaveBeenCalledOnce();
        expect(serverFetch).toHaveBeenCalledTimes(1);
    });

    it('accepts a pending deletion without retrying the consumed proof', async () => {
        serverFetch
            .mockResolvedValueOnce(jsonResponse({
                challengeId: 'challenge-1',
                challenge: 'server-challenge',
                expiresAt: Date.now() + 60_000,
            }))
            .mockResolvedValueOnce(jsonResponse({ status: 'pending' }));

        await expect(deleteAccount(credentials)).resolves.toBe('pending');
        expect(serverFetch).toHaveBeenCalledTimes(2);
    });

    it('does not sign or submit an expired challenge', async () => {
        serverFetch.mockResolvedValueOnce(jsonResponse({
            challengeId: 'expired-challenge',
            challenge: 'server-challenge',
            expiresAt: Date.now() - 1,
        }));

        await expect(deleteAccount(credentials)).rejects.toThrow('Account deletion proof expired');
        expect(signAuthChallenge).not.toHaveBeenCalled();
        expect(serverFetch).toHaveBeenCalledTimes(1);
    });

    it('stops before creating a proof when the challenge request fails', async () => {
        serverFetch.mockResolvedValueOnce({ ok: false, status: 401 });

        await expect(deleteAccount(credentials)).rejects.toThrow('Failed to create account deletion proof: 401');
        expect(signAuthChallenge).not.toHaveBeenCalled();
        expect(serverFetch).toHaveBeenCalledTimes(1);
    });

    it.each([401, 403])('does not revoke locally for deterministic challenge response %s', async (status) => {
        const beforeProofSubmission = vi.fn(async () => undefined);
        serverFetch.mockResolvedValueOnce({ ok: false, status });

        await expect(deleteAccount(credentials, { beforeProofSubmission })).rejects.toThrow(
            `Failed to create account deletion proof: ${status}`,
        );
        expect(beforeProofSubmission).not.toHaveBeenCalled();
        expect(serverFetch).toHaveBeenCalledTimes(1);
    });

    it('revokes locally when another device has already committed deletion', async () => {
        const beforeProofSubmission = vi.fn(async () => undefined);
        serverFetch.mockResolvedValueOnce({ ok: false, status: 409 });

        await expect(deleteAccount(credentials, { beforeProofSubmission })).resolves.toBe('pending');
        expect(beforeProofSubmission).toHaveBeenCalledOnce();
        expect(signAuthChallenge).not.toHaveBeenCalled();
        expect(serverFetch).toHaveBeenCalledTimes(1);
    });

    it('does not report a pending deletion when local revocation fails', async () => {
        serverFetch.mockResolvedValueOnce({ ok: false, status: 409 });

        await expect(deleteAccount(credentials, {
            beforeProofSubmission: async () => { throw new Error('revocation unavailable'); },
        })).rejects.toThrow('revocation unavailable');
        expect(signAuthChallenge).not.toHaveBeenCalled();
        expect(serverFetch).toHaveBeenCalledTimes(1);
    });

    it('clears local state conservatively when the confirmed request has an uncertain server outcome', async () => {
        serverFetch
            .mockResolvedValueOnce(jsonResponse({
                challengeId: 'challenge-1',
                challenge: 'server-challenge',
                expiresAt: Date.now() + 60_000,
            }))
            .mockResolvedValueOnce({ ok: false, status: 503 });

        await expect(deleteAccount(credentials)).resolves.toBe('uncertain');
        expect(serverFetch).toHaveBeenCalledTimes(2);
    });

    it('treats a lost response after proof submission as uncertain and never retries the proof', async () => {
        let revoked = false;
        serverFetch
            .mockResolvedValueOnce(jsonResponse({
                challengeId: 'challenge-1',
                challenge: 'server-challenge',
                expiresAt: Date.now() + 60_000,
            }))
            .mockImplementationOnce(async () => {
                expect(revoked).toBe(true);
                throw new Error('network lost');
            });

        await expect(deleteAccount(credentials, {
            beforeProofSubmission: async () => { revoked = true; },
        })).resolves.toBe('uncertain');
        expect(serverFetch).toHaveBeenCalledTimes(2);
        expect(revoked).toBe(true);
        expect(decodedSecret.value).toEqual(new Uint8Array(32));
        expect(decodedChallenge.value).toEqual(new Uint8Array(32));
    });

    it('clears the decoded challenge when signing fails before submission', async () => {
        serverFetch.mockResolvedValueOnce(jsonResponse({
            challengeId: 'challenge-1',
            challenge: 'server-challenge',
            expiresAt: Date.now() + 60_000,
        }));
        signAuthChallenge.mockImplementationOnce(() => {
            throw new Error('signing failed');
        });

        await expect(deleteAccount(credentials)).rejects.toThrow('signing failed');
        expect(serverFetch).toHaveBeenCalledTimes(1);
        expect(decodedSecret.value).toEqual(new Uint8Array(32));
        expect(decodedChallenge.value).toEqual(new Uint8Array(32));
    });

    it('keeps a deterministic proof rejection distinct from an uncertain transport outcome', async () => {
        serverFetch
            .mockResolvedValueOnce(jsonResponse({
                challengeId: 'challenge-1',
                challenge: 'server-challenge',
                expiresAt: Date.now() + 60_000,
            }))
            .mockResolvedValueOnce({ ok: false, status: 409 });

        await expect(deleteAccount(credentials)).rejects.toThrow('Failed to delete account: 409');
        expect(serverFetch).toHaveBeenCalledTimes(2);
    });
});

function jsonResponse(payload: unknown): Response {
    return {
        ok: true,
        json: vi.fn().mockResolvedValue(payload),
    } as unknown as Response;
}
