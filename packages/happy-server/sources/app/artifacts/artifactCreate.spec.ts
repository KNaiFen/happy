import { Prisma, type Artifact } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { TransactionHost, Tx } from '@/storage/inTx';
import { createArtifactForAccount } from './artifactCreate';

const input = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    header: new Uint8Array([1]).slice(),
    body: new Uint8Array([2]).slice(),
    dataEncryptionKey: new Uint8Array([3]).slice(),
};

describe('createArtifactForAccount unique-conflict recovery', () => {
    it('settles a concurrent same-account winner as idempotent success', async () => {
        const artifact = fixtureArtifact('account-1');
        const host = uniqueConflictThenRecoveryHost({ gate: true, artifact });

        await expect(createArtifactForAccount('account-1', input, host)).resolves.toEqual({
            kind: 'existing',
            artifact,
            updateSeq: artifact.updateSeq,
        });
    });

    it('settles a concurrent cross-account winner as a conflict', async () => {
        const host = uniqueConflictThenRecoveryHost({
            gate: true,
            artifact: fixtureArtifact('account-2'),
        });

        await expect(createArtifactForAccount('account-1', input, host)).resolves.toEqual({
            kind: 'conflict',
        });
    });

    it('fails closed when the conflicting row cannot be proven after P2002', async () => {
        const host = uniqueConflictThenRecoveryHost({ gate: true, artifact: null });

        await expect(createArtifactForAccount('account-1', input, host)).rejects.toMatchObject({
            code: 'P2002',
        });
    });

    it('honors account deletion admission while resolving P2002', async () => {
        const host = uniqueConflictThenRecoveryHost({
            gate: false,
            artifact: fixtureArtifact('account-1'),
        });

        await expect(createArtifactForAccount('account-1', input, host)).resolves.toEqual({
            kind: 'deleting',
        });
    });
});

function uniqueConflictThenRecoveryHost(options: {
    gate: boolean;
    artifact: Artifact | null;
}): TransactionHost {
    let transactionNumber = 0;
    const tx = {
        account: {
            updateMany: vi.fn(async () => ({ count: options.gate ? 1 : 0 })),
        },
        artifact: {
            findUnique: vi.fn(async () => options.artifact),
        },
    } as unknown as Tx;

    return {
        $transaction: vi.fn(async (callback: (transaction: Tx) => Promise<unknown>) => {
            transactionNumber += 1;
            if (transactionNumber === 1) throw uniqueConflict();
            return callback(tx);
        }),
    } as unknown as TransactionHost;
}

function uniqueConflict(): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { modelName: 'Artifact', target: ['id'] },
    });
}

function fixtureArtifact(accountId: string): Artifact {
    return {
        ...input,
        accountId,
        headerVersion: 1,
        bodyVersion: 1,
        seq: 0,
        updateSeq: 41,
        createdAt: new Date(0),
        updatedAt: new Date(0),
    };
}
