import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    accountWritable,
    createMock,
    updateManyMock,
    deleteManyMock,
    transactionMock,
    txMock,
} = vi.hoisted(() => {
    const accountWritable = { value: true };
    const createMock = vi.fn();
    const updateManyMock = vi.fn();
    const deleteManyMock = vi.fn();
    const txMock = {
        accountDeletionVoiceAdmission: {
            create: createMock,
            updateMany: updateManyMock,
        },
    };
    const transactionMock = vi.fn(async (callback: (tx: typeof txMock) => Promise<unknown>) => (
        callback(txMock)
    ));
    return {
        accountWritable,
        createMock,
        updateManyMock,
        deleteManyMock,
        transactionMock,
        txMock,
    };
});

vi.mock('@/app/account/accountWriteGate', () => ({
    acquireAccountWrite: vi.fn(async () => accountWritable.value),
}));
vi.mock('@/storage/inTx', () => ({
    inTx: vi.fn(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock)),
}));
vi.mock('@/storage/db', () => ({
    db: {
        $transaction: transactionMock,
        accountDeletionVoiceAdmission: {
            updateMany: updateManyMock,
            deleteMany: deleteManyMock,
        },
    },
}));

import {
    armVoiceCredentialAdmission,
    beginVoiceCredentialAdmission,
    sendVoiceCredentialForAdmission,
    settleVoiceCredentialAdmission,
    VoiceCredentialResponseOutcomeUnknownError,
} from './voiceCredentialAdmission';

const admission = { id: 'voice-admission-1', accountId: 'user-1' };

describe('voice credential deletion admission', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
        vi.clearAllMocks();
        accountWritable.value = true;
        createMock.mockResolvedValue(admission);
        updateManyMock.mockResolvedValue({ count: 1 });
        deleteManyMock.mockResolvedValue({ count: 1 });
        transactionMock.mockImplementation(async (callback) => callback(txMock));
    });

    it('creates a durable pending fence only while the account is writable', async () => {
        await expect(beginVoiceCredentialAdmission('user-1')).resolves.toEqual(admission);
        expect(createMock).toHaveBeenCalledWith({
            data: {
                accountId: 'user-1',
                expiresAt: null,
            },
            select: { id: true, accountId: true },
        });

        accountWritable.value = false;
        await expect(beginVoiceCredentialAdmission('user-1')).resolves.toBeNull();
        expect(createMock).toHaveBeenCalledTimes(1);
    });

    it('arms the fence with the signed credential expiry', async () => {
        const expiresAt = new Date('2026-08-13T00:20:00.000Z');

        await expect(armVoiceCredentialAdmission(admission, expiresAt)).resolves.toBe(true);
        expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: admission.id,
            }),
            data: { expiresAt },
        }));
    });

    it('does not send after deletion wins the account lock or the fence expires', async () => {
        const send = vi.fn();
        accountWritable.value = false;
        await expect(sendVoiceCredentialForAdmission(admission, send)).resolves.toBe(false);
        expect(send).not.toHaveBeenCalled();

        accountWritable.value = true;
        updateManyMock.mockResolvedValueOnce({ count: 0 });
        await expect(sendVoiceCredentialForAdmission(admission, send)).resolves.toBe(false);
        expect(send).not.toHaveBeenCalled();
    });

    it('does not use a local expiry before the provider returns a JWT', async () => {
        vi.advanceTimersByTime(10 * 60 * 1000);
        const expiresAt = new Date('2026-08-13T00:20:00.000Z');
        await expect(armVoiceCredentialAdmission(admission, expiresAt)).resolves.toBe(true);
        expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.not.objectContaining({ expiresAt: expect.anything() }),
            data: { expiresAt },
        }));
    });

    it('does not retry a sent response when transaction commit becomes ambiguous', async () => {
        const send = vi.fn();
        transactionMock.mockImplementationOnce(async (callback) => {
            await callback(txMock);
            throw new Error('commit result unknown');
        });

        await expect(sendVoiceCredentialForAdmission(admission, send))
            .rejects.toBeInstanceOf(VoiceCredentialResponseOutcomeUnknownError);
        expect(send).toHaveBeenCalledTimes(1);
        expect(transactionMock).toHaveBeenCalledTimes(1);
    });

    it('durably settles and then best-effort removes a failed admission', async () => {
        await settleVoiceCredentialAdmission(admission);

        expect(updateManyMock).toHaveBeenCalledWith({
            where: {
                id: admission.id,
                accountId: admission.accountId,
                completedAt: null,
            },
            data: { completedAt: new Date('2026-08-13T00:00:00.000Z') },
        });
        expect(deleteManyMock).toHaveBeenCalledWith({
            where: { id: admission.id, completedAt: { not: null } },
        });
    });
});
