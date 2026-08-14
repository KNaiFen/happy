import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    state,
    dbMock,
    txMock,
    deleteAccountFilesMock,
    deleteSessionAttachmentsMock,
    probeFileMock,
    deleteFileMock,
    resetState,
} = vi.hoisted(() => {
    const deleteAccountFilesMock = vi.fn(async () => {});
    const deleteSessionAttachmentsMock = vi.fn(async () => {});
    const probeFileMock = vi.fn(async (): Promise<'present' | 'absent' | 'unknown'> => 'unknown');
    const deleteFileMock = vi.fn(async () => {});
    const state = {
        accountExists: true,
        finalSweepAfter: new Date('2026-08-12T00:00:00.000Z'),
        requestedAt: new Date('2026-08-11T23:00:00.000Z'),
        leaseToken: null as string | null,
        leaseExpiresAt: null as Date | null,
        uploadOperationStatus: null as null | 'pending' | 'completed',
        voiceAdmission: null as null | {
            completedAt: Date | null;
            credentialIssuedAt: Date | null;
            expiresAt: Date | null;
        },
        githubOAuthAdmission: null as null | {
            callbackStartedAt: Date | null;
            completedAt: Date | null;
            expiresAt: Date;
        },
        orphanSweep: null as null | { value: string; updatedAt: Date; expiresAt: Date },
        sessions: [{ id: 'session-current', accountId: 'user-1' }],
        attachmentSessionIds: ['session-current', 'session-orphan'],
        feedItems: [
            { id: 'feed-own', body: { kind: 'text', text: 'own item' } },
            { id: 'feed-reference', body: { kind: 'friend_accepted', uid: 'user-1' } },
            { id: 'feed-other', body: { kind: 'friend_accepted', uid: 'user-2' } },
        ],
        failDuringCleanup: false,
    };

    const resetState = () => {
        state.accountExists = true;
        state.finalSweepAfter = new Date('2026-08-12T00:00:00.000Z');
        state.requestedAt = new Date('2026-08-11T23:00:00.000Z');
        state.leaseToken = null;
        state.leaseExpiresAt = null;
        state.uploadOperationStatus = null;
        state.voiceAdmission = null;
        state.githubOAuthAdmission = null;
        state.orphanSweep = null;
        state.sessions = [{ id: 'session-current', accountId: 'user-1' }];
        state.attachmentSessionIds = ['session-current', 'session-orphan'];
        state.feedItems = [
            { id: 'feed-own', body: { kind: 'text', text: 'own item' } },
            { id: 'feed-reference', body: { kind: 'friend_accepted', uid: 'user-1' } },
            { id: 'feed-other', body: { kind: 'friend_accepted', uid: 'user-2' } },
        ];
        state.failDuringCleanup = false;
        deleteAccountFilesMock.mockClear();
        deleteSessionAttachmentsMock.mockClear();
        probeFileMock.mockReset();
        probeFileMock.mockResolvedValue('unknown');
        deleteFileMock.mockClear();
    };

    const sessionFindMany = vi.fn(async (args: any) => {
        if (state.failDuringCleanup) throw new Error('object-store-read-failed');
        if (args.where.accountId) {
            return state.sessions
                .filter((session) => session.accountId === args.where.accountId)
                .map((session) => ({ id: session.id }));
        }
        const ids = args.where.id?.in as string[] | undefined;
        return state.sessions
            .filter((session) => ids?.includes(session.id))
            .map((session) => ({ id: session.id }));
    });
    const accountDelete = vi.fn(async () => {
        state.accountExists = false;
    });
    const userFeedDeleteMany = vi.fn(async () => ({ count: 0 }));
    const emptyDeleteMany = vi.fn(async () => ({ count: 0 }));
    const machineDeleteMany = vi.fn(async () => ({ count: 0 }));
    const terminalAuthRequestDeleteMany = vi.fn(async () => ({ count: 0 }));
    const accountDeletionRequestUpdateMany = vi.fn(async (args: any) => {
        if (typeof args.data.leaseToken === 'string') {
            if (state.leaseToken !== null) return { count: 0 };
            state.leaseToken = args.data.leaseToken;
            state.leaseExpiresAt = args.data.leaseExpiresAt;
            return { count: 1 };
        }
        if (args.data.leaseToken === null) {
            if (args.where.leaseToken !== state.leaseToken) return { count: 0 };
            state.leaseToken = null;
            state.leaseExpiresAt = null;
            return { count: 1 };
        }
        if (args.where.leaseToken === state.leaseToken) {
            state.leaseExpiresAt = args.data.leaseExpiresAt ?? state.leaseExpiresAt;
            return { count: 1 };
        }
        return { count: 0 };
    });
    const globalLockFindUnique = vi.fn(async () => state.orphanSweep);
    const globalLockUpdateMany = vi.fn(async (args: any) => {
        if (!state.orphanSweep) return { count: 0 };
        if (args.where.value && args.where.value !== state.orphanSweep.value) return { count: 0 };
        if (args.where.expiresAt?.lte && state.orphanSweep.expiresAt > args.where.expiresAt.lte) return { count: 0 };
        state.orphanSweep = {
            value: args.data.value,
            updatedAt: new Date(),
            expiresAt: args.data.expiresAt,
        };
        return { count: 1 };
    });
    const globalLockCreate = vi.fn(async (args: any) => {
        if (state.orphanSweep) throw new Error('unique constraint');
        state.orphanSweep = {
            value: args.data.value,
            updatedAt: new Date(),
            expiresAt: args.data.expiresAt,
        };
        return state.orphanSweep;
    });
    const uploadOperationCreate = vi.fn(async () => {
        state.uploadOperationStatus = 'pending';
        return { id: 'upload-operation-1' };
    });
    const uploadOperationUpdateMany = vi.fn(async () => {
        if (state.uploadOperationStatus !== 'pending') return { count: 0 };
        state.uploadOperationStatus = 'completed';
        return { count: 1 };
    });
    const uploadOperationDeleteMany = vi.fn(async () => {
        if (state.uploadOperationStatus !== 'completed') return { count: 0 };
        state.uploadOperationStatus = null;
        return { count: 1 };
    });
    const voiceAdmissionFindFirst = vi.fn(async () => {
        const admission = state.voiceAdmission;
        if (!admission) return null;
        if (admission.completedAt !== null && admission.credentialIssuedAt === null) return null;
        if (admission.credentialIssuedAt !== null
            && admission.expiresAt !== null
            && admission.expiresAt <= new Date()) return null;
        return { id: 'voice-admission-1' };
    });
    const voiceAdmissionDeleteMany = vi.fn(async (args: any) => {
        const admission = state.voiceAdmission;
        if (!admission) return { count: 0 };
        const finalSweep = args.where?.accountId && !args.where?.OR;
        const expired = admission.expiresAt !== null && admission.expiresAt <= new Date();
        const completedWithoutCredential = admission.completedAt !== null
            && admission.credentialIssuedAt === null;
        if (finalSweep || expired || completedWithoutCredential) {
            state.voiceAdmission = null;
            return { count: 1 };
        }
        return { count: 0 };
    });
    const githubOAuthAdmissionFindFirst = vi.fn(async () => {
        const admission = state.githubOAuthAdmission;
        if (!admission || admission.callbackStartedAt === null || admission.completedAt !== null) {
            return null;
        }
        return { id: 'github-oauth-admission-1' };
    });
    const githubOAuthAdmissionDeleteMany = vi.fn(async (args: any) => {
        const admission = state.githubOAuthAdmission;
        if (!admission) return { count: 0 };
        const finalSweep = args.where?.accountId && !args.where?.OR;
        const completed = admission.completedAt !== null;
        const expiredUnclaimed = admission.callbackStartedAt === null
            && admission.expiresAt <= new Date();
        if (finalSweep || completed || expiredUnclaimed) {
            state.githubOAuthAdmission = null;
            return { count: 1 };
        }
        return { count: 0 };
    });

    const txMock = {
        accountDeletionRequest: { updateMany: accountDeletionRequestUpdateMany },
        account: {
            updateMany: vi.fn(async () => ({ count: state.accountExists ? 1 : 0 })),
            findUnique: vi.fn(async () => (state.accountExists ? {
                deletionRequestedAt: new Date('2026-08-11T00:00:00.000Z'),
            } : null)),
            delete: accountDelete,
        },
        session: { findMany: sessionFindMany, deleteMany: emptyDeleteMany },
        userRelationship: { findMany: vi.fn(async () => []), deleteMany: emptyDeleteMany },
        userFeedItem: {
            findMany: vi.fn(async () => state.feedItems),
            deleteMany: userFeedDeleteMany,
        },
        accessKey: { deleteMany: emptyDeleteMany },
        sessionMessage: { deleteMany: emptyDeleteMany },
        usageReport: { deleteMany: emptyDeleteMany },
        machine: {
            findMany: vi.fn(async () => [
                { credentialId: 'terminal-credential-1' },
                { credentialId: null },
            ]),
            deleteMany: machineDeleteMany,
        },
        terminalAuthRequest: { deleteMany: terminalAuthRequestDeleteMany },
        accountAuthRequest: { deleteMany: emptyDeleteMany },
        accountPushToken: { deleteMany: emptyDeleteMany },
        uploadedFile: { deleteMany: emptyDeleteMany },
        serviceAccountToken: { deleteMany: emptyDeleteMany },
        artifact: { deleteMany: emptyDeleteMany },
        userKVStore: { deleteMany: emptyDeleteMany },
        voiceConversation: { deleteMany: emptyDeleteMany },
        githubUser: { deleteMany: emptyDeleteMany },
        accountDeletionUploadOperation: { create: uploadOperationCreate },
        accountDeletionVoiceAdmission: {
            findFirst: voiceAdmissionFindFirst,
            deleteMany: voiceAdmissionDeleteMany,
        },
        accountDeletionGithubOAuthAdmission: {
            findFirst: githubOAuthAdmissionFindFirst,
            deleteMany: githubOAuthAdmissionDeleteMany,
        },
    };
    const dbMock = {
        accountDeletionRequest: {
            findUnique: vi.fn(async (args: any) => args.select?.leaseToken
                ? { leaseToken: state.leaseToken, leaseExpiresAt: state.leaseExpiresAt }
                : {
                    finalSweepAfter: state.finalSweepAfter,
                    requestedAt: state.requestedAt,
                }),
            updateMany: accountDeletionRequestUpdateMany,
        },
        session: { findMany: sessionFindMany },
        accountDeletionUploadOperation: {
            findMany: vi.fn(async () => state.uploadOperationStatus === 'pending'
                ? [{ id: 'upload-operation-1', objectKey: 'sessions/session-current/attachments/a.enc' }]
                : []),
            findFirst: vi.fn(async () => state.uploadOperationStatus === 'pending'
                ? { id: 'upload-operation-1', objectKey: 'sessions/session-current/attachments/a.enc' }
                : null),
            updateMany: uploadOperationUpdateMany,
            deleteMany: uploadOperationDeleteMany,
        },
        accountDeletionVoiceAdmission: {
            findFirst: voiceAdmissionFindFirst,
            deleteMany: voiceAdmissionDeleteMany,
        },
        accountDeletionGithubOAuthAdmission: {
            findFirst: githubOAuthAdmissionFindFirst,
            deleteMany: githubOAuthAdmissionDeleteMany,
        },
        globalLock: {
            findUnique: globalLockFindUnique,
            updateMany: globalLockUpdateMany,
            create: globalLockCreate,
        },
    };

    return {
        state,
        dbMock,
        txMock,
        deleteAccountFilesMock,
        deleteSessionAttachmentsMock,
        probeFileMock,
        deleteFileMock,
        resetState,
    };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/storage/inTx', () => ({ inTx: async (callback: (tx: unknown) => Promise<unknown>) => callback(txMock) }));
vi.mock('@/storage/files', () => ({
    deleteAccountFiles: deleteAccountFilesMock,
    deleteSessionAttachments: deleteSessionAttachmentsMock,
    probeFile: probeFileMock,
    deleteFile: deleteFileMock,
    forEachSessionAttachmentId: async (visitor: (sessionIds: readonly string[]) => Promise<void>) => {
        await visitor(state.attachmentSessionIds);
    },
    isLocalStorage: () => true,
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
vi.mock('privacy-kit', () => ({
    decodeBase64: vi.fn(),
    encodeHex: vi.fn(),
}));

import {
    beginAccountDeletionUpload,
    processAccountDeletion,
    settleAccountDeletionUpload,
} from './accountDeletion';

describe('processAccountDeletion', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-11T23:50:00.000Z'));
        vi.clearAllMocks();
        resetState();
    });

    it('keeps the account locked until legacy direct-upload capabilities have expired', async () => {
        const result = await processAccountDeletion('user-1');

        expect(result).toBe('pending');
        expect(deleteAccountFilesMock).not.toHaveBeenCalled();
        expect(deleteSessionAttachmentsMock).not.toHaveBeenCalled();
        expect(txMock.account.delete).not.toHaveBeenCalled();
        expect(state.leaseToken).toBeNull();
    });

    it('performs the final sweep, deletes foreign feed references, and removes the account', async () => {
        vi.setSystemTime(new Date('2026-08-12T00:01:00.000Z'));

        const result = await processAccountDeletion('user-1');

        expect(result).toBe('deleted');
        expect(deleteSessionAttachmentsMock).toHaveBeenCalledWith('session-orphan');
        expect(txMock.userFeedItem.deleteMany).toHaveBeenCalledWith({
            where: {
                OR: [
                    { userId: 'user-1' },
                    { body: { path: ['uid'], equals: 'user-1' } },
                ],
            },
        });
        expect(txMock.account.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
        expect(txMock.accessKey.deleteMany).toHaveBeenCalledWith({
            where: {
                OR: [
                    { accountId: 'user-1' },
                    { sessionId: { in: ['session-current'] } },
                ],
            },
        });
        expect(txMock.terminalAuthRequest.deleteMany).toHaveBeenCalledWith({
            where: {
                OR: [
                    { responseAccountId: 'user-1' },
                    { id: { in: ['terminal-credential-1'] } },
                ],
            },
        });
        expect(txMock.terminalAuthRequest.deleteMany.mock.invocationCallOrder[0])
            .toBeLessThan(txMock.machine.deleteMany.mock.invocationCallOrder[0]);
        expect(txMock.githubUser.deleteMany).toHaveBeenCalledWith({
            where: { Account: { none: {} } },
        });
        const avatarCleanup = (txMock.account.updateMany.mock.calls as unknown as any[][])
            .map((call) => call[0])
            .find((args: any) => args.where.avatar);
        expect(avatarCleanup).toMatchObject({
            where: {
                avatar: {
                    path: ['path'],
                    string_starts_with: 'public/users/user-1/',
                },
            },
        });
    });

    it('waits for a previously admitted proxy upload until it reports a terminal result', async () => {
        vi.setSystemTime(new Date('2026-08-15T00:20:00.000Z'));
        state.uploadOperationStatus = 'pending';

        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');
        expect(deleteAccountFilesMock).not.toHaveBeenCalled();
        expect(txMock.account.delete).not.toHaveBeenCalled();

        state.uploadOperationStatus = null;
        await expect(processAccountDeletion('user-1')).resolves.toBe('deleted');
        expect(deleteAccountFilesMock).toHaveBeenCalledWith('user-1', ['session-current']);
    });

    it('waits through the signed lifetime of an issued voice credential', async () => {
        vi.setSystemTime(new Date('2026-08-15T00:20:00.000Z'));
        state.voiceAdmission = {
            completedAt: new Date(),
            credentialIssuedAt: new Date(),
            expiresAt: new Date('2026-08-15T00:25:00.000Z'),
        };

        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');
        expect(deleteAccountFilesMock).not.toHaveBeenCalled();
        expect(txMock.account.delete).not.toHaveBeenCalled();

        vi.setSystemTime(new Date('2026-08-15T00:25:01.000Z'));
        await expect(processAccountDeletion('user-1')).resolves.toBe('deleted');
        expect(state.voiceAdmission).toBeNull();
    });

    it('keeps an unresolved pre-response admission pending without a provider expiry', async () => {
        vi.setSystemTime(new Date('2026-08-15T00:20:00.000Z'));
        state.voiceAdmission = {
            completedAt: null,
            credentialIssuedAt: null,
            expiresAt: null,
        };

        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');
        vi.setSystemTime(new Date('2026-08-15T01:22:01.000Z'));
        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');
        expect(txMock.account.delete).not.toHaveBeenCalled();
    });

    it('keeps a claimed GitHub callback pending after the state TTL and lease replacement', async () => {
        vi.setSystemTime(new Date('2026-08-15T00:20:00.000Z'));
        state.githubOAuthAdmission = {
            callbackStartedAt: new Date(),
            completedAt: null,
            expiresAt: new Date('2026-08-15T00:25:00.000Z'),
        };

        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');
        vi.advanceTimersByTime(60 * 60 * 1000);
        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');
        expect(txMock.account.delete).not.toHaveBeenCalled();

        state.githubOAuthAdmission.completedAt = new Date();
        await expect(processAccountDeletion('user-1')).resolves.toBe('deleted');
        expect(state.githubOAuthAdmission).toBeNull();
    });

    it('does not wait for an expired GitHub state that was never claimed', async () => {
        vi.setSystemTime(new Date('2026-08-15T00:20:00.000Z'));
        state.githubOAuthAdmission = {
            callbackStartedAt: null,
            completedAt: null,
            expiresAt: new Date('2026-08-15T00:19:00.000Z'),
        };

        await expect(processAccountDeletion('user-1')).resolves.toBe('deleted');
        expect(state.githubOAuthAdmission).toBeNull();
    });

    it('does not let a replacement worker bypass an unsettled upload after the deletion lease expires', async () => {
        vi.setSystemTime(new Date('2026-08-15T00:20:00.000Z'));
        state.uploadOperationStatus = 'pending';

        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');
        expect(deleteAccountFilesMock).not.toHaveBeenCalled();

        vi.advanceTimersByTime(10 * 60 * 1000);
        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');
        expect(deleteAccountFilesMock).not.toHaveBeenCalled();
        expect(txMock.account.delete).not.toHaveBeenCalled();

        await settleAccountDeletionUpload('upload-operation-1');
        await expect(processAccountDeletion('user-1')).resolves.toBe('deleted');
    });

    it('does not put an expiry on a newly admitted upload operation', async () => {
        await expect(beginAccountDeletionUpload(
            'user-1',
            'sessions/session-current/attachments/a.enc',
        )).resolves.toBe('upload-operation-1');
        expect(txMock.accountDeletionUploadOperation.create).toHaveBeenCalledWith({
            data: {
                accountId: 'user-1',
                objectKey: 'sessions/session-current/attachments/a.enc',
            },
            select: { id: true },
        });
        expect(state.uploadOperationStatus).toBe('pending');

        await settleAccountDeletionUpload('upload-operation-1');
        expect(dbMock.accountDeletionUploadOperation.updateMany).toHaveBeenCalledWith({
            where: { id: 'upload-operation-1', completedAt: null },
            data: { completedAt: expect.any(Date) },
        });
        expect(state.uploadOperationStatus).toBeNull();
    });

    it('does not block deletion when completion is durable but bookkeeping cleanup fails', async () => {
        vi.setSystemTime(new Date('2026-08-15T00:20:00.000Z'));
        state.uploadOperationStatus = 'pending';
        dbMock.accountDeletionUploadOperation.deleteMany.mockRejectedValueOnce(
            new Error('database temporarily unavailable'),
        );

        await expect(settleAccountDeletionUpload('upload-operation-1')).resolves.toBeUndefined();
        expect(state.uploadOperationStatus).toBe('completed');
        await expect(processAccountDeletion('user-1')).resolves.toBe('deleted');
    });

    it('cleans a visible ambiguous upload but keeps the operation pending', async () => {
        vi.setSystemTime(new Date('2026-08-15T00:20:00.000Z'));
        state.uploadOperationStatus = 'pending';
        probeFileMock.mockResolvedValue('present');

        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');
        expect(deleteFileMock).toHaveBeenCalledWith('sessions/session-current/attachments/a.enc');
        expect(state.uploadOperationStatus).toBe('pending');
        expect(txMock.account.delete).not.toHaveBeenCalled();
    });

    it('keeps an ambiguous upload pending when storage is currently absent', async () => {
        vi.setSystemTime(new Date('2026-08-15T00:20:00.000Z'));
        state.uploadOperationStatus = 'pending';
        probeFileMock.mockResolvedValue('absent');

        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');
        expect(deleteFileMock).not.toHaveBeenCalled();
        expect(state.uploadOperationStatus).toBe('pending');
        expect(txMock.account.delete).not.toHaveBeenCalled();
    });

    it('keeps an ambiguous upload pending when storage cannot prove its state', async () => {
        vi.setSystemTime(new Date('2026-08-15T00:20:00.000Z'));
        state.uploadOperationStatus = 'pending';
        probeFileMock.mockResolvedValue('unknown');

        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');
        expect(deleteFileMock).not.toHaveBeenCalled();
        expect(txMock.account.delete).not.toHaveBeenCalled();
    });

    it('keeps an upload pending when it is absent once, then deletes a late object on retry', async () => {
        vi.setSystemTime(new Date('2026-08-15T00:20:00.000Z'));
        state.uploadOperationStatus = 'pending';
        probeFileMock.mockResolvedValueOnce('absent').mockResolvedValueOnce('present');

        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');
        expect(deleteFileMock).not.toHaveBeenCalled();
        expect(txMock.account.delete).not.toHaveBeenCalled();

        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');
        expect(deleteFileMock).toHaveBeenCalledWith('sessions/session-current/attachments/a.enc');
        expect(txMock.account.delete).not.toHaveBeenCalled();
    });

    it('releases only the lease token it claimed after a cleanup failure', async () => {
        state.failDuringCleanup = true;

        await expect(processAccountDeletion('user-1')).resolves.toBe('pending');

        const calls = dbMock.accountDeletionRequest.updateMany.mock.calls;
        const claim = calls.find((call: any[]) => typeof call[0].data.leaseToken === 'string');
        const release = calls.find((call: any[]) => call[0].data.leaseToken === null);
        if (!claim || !release) {
            throw new Error('Expected both a lease claim and release');
        }
        expect(release[0].where.leaseToken).toBe(claim[0].data.leaseToken);
    });
});
