import { beforeEach, describe, expect, it, vi } from 'vitest';

const { accountWritable, createMock, updateManyMock, deleteManyMock, txMock } = vi.hoisted(() => {
    const accountWritable = { value: true };
    const createMock = vi.fn();
    const updateManyMock = vi.fn();
    const deleteManyMock = vi.fn();
    const txMock = {
        accountDeletionGithubOAuthAdmission: {
            create: createMock,
            updateMany: updateManyMock,
        },
    };
    return { accountWritable, createMock, updateManyMock, deleteManyMock, txMock };
});

vi.mock('@/app/account/accountWriteGate', () => ({
    acquireAccountWrite: vi.fn(async () => accountWritable.value),
}));
vi.mock('@/storage/inTx', () => ({
    inTx: vi.fn(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock)),
}));
vi.mock('@/storage/db', () => ({
    db: {
        accountDeletionGithubOAuthAdmission: {
            updateMany: updateManyMock,
            deleteMany: deleteManyMock,
        },
    },
}));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'admission-1') }));

import {
    beginGithubOAuthAdmission,
    claimGithubOAuthAdmission,
    settleGithubOAuthAdmission,
} from './githubOAuthAdmission';

const admission = { id: 'admission-1', accountId: 'user-1' };

describe('GitHub OAuth deletion admission', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
        vi.clearAllMocks();
        accountWritable.value = true;
        createMock.mockResolvedValue(admission);
        updateManyMock.mockResolvedValue({ count: 1 });
        deleteManyMock.mockResolvedValue({ count: 1 });
    });

    it('issues state and persists admission only while the account is writable', async () => {
        const issueState = vi.fn(async (admissionId: string) => `state-for-${admissionId}`);
        await expect(beginGithubOAuthAdmission('user-1', issueState)).resolves.toEqual({
            admission,
            state: 'state-for-admission-1',
        });
        expect(createMock).toHaveBeenCalledWith({
            data: {
                id: 'admission-1',
                accountId: 'user-1',
                expiresAt: new Date('2026-08-13T00:05:00.000Z'),
            },
            select: { id: true, accountId: true },
        });
        accountWritable.value = false;
        await expect(beginGithubOAuthAdmission('user-1', issueState)).resolves.toBeNull();
        expect(issueState).toHaveBeenCalledTimes(1);
    });

    it('atomically claims an unexpired admission only once', async () => {
        await expect(claimGithubOAuthAdmission(admission)).resolves.toBe(true);
        expect(updateManyMock).toHaveBeenCalledWith({
            where: {
                id: admission.id,
                accountId: admission.accountId,
                callbackStartedAt: null,
                completedAt: null,
                expiresAt: { gt: new Date('2026-08-13T00:00:00.000Z') },
            },
            data: { callbackStartedAt: new Date('2026-08-13T00:00:00.000Z') },
        });
        updateManyMock.mockResolvedValueOnce({ count: 0 });
        await expect(claimGithubOAuthAdmission(admission)).resolves.toBe(false);
    });

    it('does not claim after deletion wins the account lock', async () => {
        accountWritable.value = false;
        await expect(claimGithubOAuthAdmission(admission)).resolves.toBe(false);
        expect(updateManyMock).not.toHaveBeenCalled();
    });

    it('requires durable completion before best-effort cleanup', async () => {
        await settleGithubOAuthAdmission(admission);
        expect(updateManyMock).toHaveBeenCalledWith({
            where: {
                id: admission.id,
                accountId: admission.accountId,
                callbackStartedAt: { not: null },
                completedAt: null,
            },
            data: { completedAt: new Date('2026-08-13T00:00:00.000Z') },
        });
        expect(deleteManyMock).toHaveBeenCalledWith({
            where: { id: admission.id, completedAt: { not: null } },
        });
        updateManyMock.mockResolvedValueOnce({ count: 0 });
        await expect(settleGithubOAuthAdmission(admission))
            .rejects.toThrow('Failed to persist GitHub OAuth completion');
    });
});
