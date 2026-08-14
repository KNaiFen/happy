import { Prisma, type Artifact } from '@prisma/client';
import { acquireAccountWrite } from '@/app/account/accountWriteGate';
import { buildNewArtifactUpdate, eventRouter } from '@/app/events/eventRouter';
import { afterTx, inTx, type TransactionHost } from '@/storage/inTx';
import { allocateArtifactMutation } from '@/storage/seq';
import { randomKeyNaked } from '@/utils/randomKeyNaked';

export type ArtifactCreateInput = {
    id: string;
    header: ReturnType<Uint8Array['slice']>;
    body: ReturnType<Uint8Array['slice']>;
    dataEncryptionKey: ReturnType<Uint8Array['slice']>;
};

export type ArtifactCreateResult =
    | { kind: 'deleting' }
    | { kind: 'conflict' }
    | { kind: 'existing' | 'created'; artifact: Artifact; updateSeq: number };

export async function createArtifactForAccount(
    accountId: string,
    input: ArtifactCreateInput,
    transactionHost?: TransactionHost,
): Promise<ArtifactCreateResult> {
    try {
        return await createAttempt(accountId, input, transactionHost);
    } catch (error) {
        if (!isUniqueConflict(error)) throw error;

        return inTx(async (tx) => {
            if (!await acquireAccountWrite(tx, accountId)) return { kind: 'deleting' as const };
            const existing = await tx.artifact.findUnique({ where: { id: input.id } });
            if (!existing) throw error;
            if (existing.accountId !== accountId) return { kind: 'conflict' as const };
            return { kind: 'existing' as const, artifact: existing, updateSeq: existing.updateSeq };
        }, transactionHost);
    }
}

async function createAttempt(
    accountId: string,
    input: ArtifactCreateInput,
    transactionHost?: TransactionHost,
): Promise<ArtifactCreateResult> {
    return inTx(async (tx) => {
        if (!await acquireAccountWrite(tx, accountId)) return { kind: 'deleting' as const };
        const existing = await tx.artifact.findUnique({ where: { id: input.id } });
        if (existing?.accountId !== undefined && existing.accountId !== accountId) {
            return { kind: 'conflict' as const };
        }
        if (existing) {
            return { kind: 'existing' as const, artifact: existing, updateSeq: existing.updateSeq };
        }

        const artifact = await tx.artifact.create({
            data: {
                ...input,
                accountId,
                headerVersion: 1,
                bodyVersion: 1,
                seq: 0,
                updateSeq: 0,
            },
        });
        const { seq: updateSeq } = await allocateArtifactMutation(accountId, tx);
        await tx.artifact.updateMany({
            where: { id: input.id, accountId },
            data: { updateSeq },
        });
        const payload = buildNewArtifactUpdate(artifact, updateSeq, randomKeyNaked(12));
        afterTx(tx, () => eventRouter.emitUpdate({
            userId: accountId,
            payload,
            recipientFilter: { type: 'user-scoped-only' },
        }));
        return { kind: 'created' as const, artifact, updateSeq };
    }, transactionHost);
}

function isUniqueConflict(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
