import { type Tx } from "@/storage/inTx";
import { Prisma } from "@prisma/client";
import type { SyncMutationV4 } from "@slopus/happy-wire";
import { syncV4MutationContentHash } from "./syncV4MutationClassifier";

export type SequencedSyncV4Mutation = {
    mutation: SyncMutationV4;
    status: "accepted" | "superseded";
    seq: number;
};

type SyncV4EntityProjection = {
    sessionId: string;
    producerId: string;
    entityId: string;
    entityType: string;
    revision: number;
    op: string;
    ciphertext: string;
    updatedSeq: number;
};

export async function persistSyncV4MutationWrites(
    tx: Tx,
    sessionId: string,
    writes: readonly SequencedSyncV4Mutation[],
): Promise<void> {
    const finalEntities = new Map<string, SyncV4EntityProjection>();
    for (const write of writes) {
        if (write.status !== "accepted") continue;
        const { mutation } = write;
        finalEntities.set(mutation.entityId, {
            sessionId,
            producerId: mutation.producerId,
            entityId: mutation.entityId,
            entityType: mutation.entityType,
            revision: mutation.revision,
            op: mutation.op,
            ciphertext: mutation.ciphertext,
            updatedSeq: write.seq,
        });
    }

    if (finalEntities.size > 0) {
        const values = [...finalEntities.values()].map((entity) => Prisma.sql`(
            ${crypto.randomUUID()},
            ${entity.sessionId},
            ${entity.producerId},
            ${entity.entityId},
            ${entity.entityType},
            ${entity.revision},
            ${entity.op},
            ${entity.ciphertext},
            ${entity.updatedSeq},
            CURRENT_TIMESTAMP
        )`);
        await tx.$executeRaw(Prisma.sql`
            INSERT INTO "SessionEntityV4" (
                "id", "sessionId", "producerId", "entityId", "entityType",
                "revision", "op", "ciphertext", "updatedSeq", "updatedAt"
            ) VALUES ${Prisma.join(values)}
            ON CONFLICT ("sessionId", "entityId") DO UPDATE SET
                "producerId" = EXCLUDED."producerId",
                "entityType" = EXCLUDED."entityType",
                "revision" = EXCLUDED."revision",
                "op" = EXCLUDED."op",
                "ciphertext" = EXCLUDED."ciphertext",
                "updatedSeq" = EXCLUDED."updatedSeq",
                "updatedAt" = CURRENT_TIMESTAMP
        `);
    }

    if (writes.length > 0) {
        await tx.sessionMutationV4.createMany({
            data: writes.map(({ mutation, status, seq }) => ({
                sessionId,
                mutationId: mutation.mutationId,
                producerId: mutation.producerId,
                entityId: mutation.entityId,
                entityType: mutation.entityType,
                revision: mutation.revision,
                op: mutation.op,
                ciphertext: mutation.ciphertext,
                contentHash: syncV4MutationContentHash(mutation),
                status,
                seq,
            })),
        });
    }
}
