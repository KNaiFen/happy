import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, dbMock, txMock, resetState } = vi.hoisted(() => {
    const state = {
        publicKey: '',
        deletionRequested: false,
        challenge: null as null | {
            id: string;
            hash: string;
            expiresAt: Date;
            consumedAt: Date | null;
        },
        request: null as null | { finalSweepAfter: Date; requestedAt: Date },
        leaseToken: null as string | null,
    };

    const resetState = () => {
        state.publicKey = '';
        state.deletionRequested = false;
        state.challenge = null;
        state.request = null;
        state.leaseToken = null;
    };

    const txMock: any = {
        accountDeletionChallenge: {
            updateMany: vi.fn(async (args: any) => {
                if (!state.challenge
                    || state.challenge.id !== args.where.id
                    || state.challenge.consumedAt !== null
                    || state.challenge.expiresAt <= args.where.expiresAt.gt) {
                    return { count: 0 };
                }
                state.challenge.consumedAt = args.data.consumedAt;
                return { count: 1 };
            }),
        },
        account: {
            updateMany: vi.fn(async () => {
                if (state.deletionRequested) return { count: 0 };
                state.deletionRequested = true;
                return { count: 1 };
            }),
        },
        accountDeletionRequest: {
            upsert: vi.fn(async (args: any) => {
                state.request ??= {
                    finalSweepAfter: args.create.finalSweepAfter,
                    requestedAt: new Date(),
                };
                return state.request;
            }),
        },
    };

    const dbMock: any = {
        account: {
            findUnique: vi.fn(async () => ({ deletionRequestedAt: state.deletionRequested ? new Date() : null })),
        },
        accountDeletionChallenge: {
            deleteMany: vi.fn(async () => ({ count: 0 })),
            create: vi.fn(async (args: any) => {
                state.challenge = {
                    id: 'challenge-1',
                    hash: args.data.challengeHash,
                    expiresAt: args.data.expiresAt,
                    consumedAt: null,
                };
                return { id: state.challenge.id };
            }),
            findFirst: vi.fn(async (args: any) => {
                if (!state.challenge
                    || state.challenge.id !== args.where.id
                    || state.challenge.consumedAt !== null
                    || state.challenge.expiresAt <= args.where.expiresAt.gt
                    || state.deletionRequested) {
                    return null;
                }
                return {
                    challengeHash: state.challenge.hash,
                    account: { publicKey: state.publicKey },
                };
            }),
        },
        accountDeletionRequest: {
            findUnique: vi.fn(async () => state.request),
            updateMany: vi.fn(async (args: any) => {
                if (typeof args.data.leaseToken === 'string') {
                    if (state.leaseToken !== null) return { count: 0 };
                    state.leaseToken = args.data.leaseToken;
                    return { count: 1 };
                }
                if (args.data.leaseToken === null && args.where.leaseToken === state.leaseToken) {
                    state.leaseToken = null;
                    return { count: 1 };
                }
                return { count: 0 };
            }),
        },
        session: { findMany: vi.fn(async () => []) },
        accountDeletionUploadOperation: { findFirst: vi.fn(async () => null) },
        globalLock: { findUnique: vi.fn(async () => null) },
    };

    return { state, dbMock, txMock, resetState };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/storage/inTx', () => ({
    inTx: async (callback: (tx: unknown) => Promise<unknown>) => callback(txMock),
}));
vi.mock('@/storage/files', () => ({
    isLocalStorage: () => false,
    deleteAccountFiles: vi.fn(async () => {}),
    deleteSessionAttachments: vi.fn(async () => {}),
    probeFile: vi.fn(async () => 'absent'),
    deleteFile: vi.fn(async () => {}),
    forEachSessionAttachmentId: vi.fn(async () => {}),
}));
vi.mock('@/app/auth/auth', () => ({ auth: { invalidateUserTokens: vi.fn() } }));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { disconnectUser: vi.fn(), emitUpdate: vi.fn() },
    buildRelationshipUpdatedEvent: vi.fn(),
}));
vi.mock('@/app/presence/sessionCache', () => ({ activityCache: { invalidateUser: vi.fn() } }));
vi.mock('@/storage/seq', () => ({ allocateUserSeq: vi.fn(async () => 1) }));
vi.mock('@/utils/diagnosticHash', () => ({ diagnosticHash: vi.fn(() => 'hash') }));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'key') }));
vi.mock('@/utils/shutdown', () => ({ onShutdown: vi.fn() }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { confirmAccountDeletion, createAccountDeletionChallenge } from './accountDeletion';

describe('account deletion proof', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
        process.env.ACCOUNT_DELETION_LEGACY_DIRECT_UPLOADS_DRAINED_AT = '2026-08-11T23:59:00.000Z';
        vi.clearAllMocks();
        resetState();
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.ACCOUNT_DELETION_LEGACY_DIRECT_UPLOADS_DRAINED_AT;
    });

    it('does not create a single-use proof before a legacy S3 issuer drain time is confirmed', async () => {
        delete process.env.ACCOUNT_DELETION_LEGACY_DIRECT_UPLOADS_DRAINED_AT;

        await expect(createAccountDeletionChallenge('account-1'))
            .rejects.toMatchObject({ code: 'legacy-upload-capability-cutoff-unconfirmed' });
    });

    it.each([
        '2026-02-30T00:00:00Z',
        '2026-04-31T12:34:56.789Z',
        '2026-01-01T24:00:00Z',
    ])('rejects an impossible legacy direct-upload drain timestamp: %s', async (drainedAt) => {
        process.env.ACCOUNT_DELETION_LEGACY_DIRECT_UPLOADS_DRAINED_AT = drainedAt;

        await expect(createAccountDeletionChallenge('account-1'))
            .rejects.toMatchObject({ code: 'legacy-upload-capability-cutoff-unconfirmed' });
    });

    it('accepts only a matching, unexpired Ed25519 proof and consumes it once', async () => {
        const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        state.publicKey = Buffer.from(keyPair.publicKey).toString('hex').toUpperCase();

        const challenge = await createAccountDeletionChallenge('account-1');
        const rawChallenge = Buffer.from(challenge.challenge, 'base64');
        const signature = nacl.sign.detached(rawChallenge, keyPair.secretKey);
        const proof = {
            accountId: 'account-1',
            challengeId: challenge.challengeId,
            challenge: challenge.challenge,
            publicKey: Buffer.from(keyPair.publicKey).toString('base64'),
            signature: Buffer.from(signature).toString('base64'),
        };

        await expect(confirmAccountDeletion(proof)).resolves.toBe('pending');
        expect(state.deletionRequested).toBe(true);
        expect(state.challenge?.consumedAt).not.toBeNull();

        await expect(confirmAccountDeletion(proof)).rejects.toMatchObject({
            code: 'expired-challenge',
        });
    });

    it('rejects a signature from a different account key before it locks anything', async () => {
        const expected = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const attacker = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        state.publicKey = Buffer.from(expected.publicKey).toString('hex').toUpperCase();

        const challenge = await createAccountDeletionChallenge('account-1');
        const rawChallenge = Buffer.from(challenge.challenge, 'base64');
        const signature = nacl.sign.detached(rawChallenge, attacker.secretKey);

        await expect(confirmAccountDeletion({
            accountId: 'account-1',
            challengeId: challenge.challengeId,
            challenge: challenge.challenge,
            publicKey: Buffer.from(attacker.publicKey).toString('base64'),
            signature: Buffer.from(signature).toString('base64'),
        })).rejects.toMatchObject({ code: 'invalid-proof' });
        expect(state.deletionRequested).toBe(false);
        expect(state.challenge?.consumedAt).toBeNull();
    });
});
