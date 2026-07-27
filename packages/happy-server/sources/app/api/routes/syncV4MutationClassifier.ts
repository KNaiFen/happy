import {
    type SyncAckStatusV4,
    type SyncMutationV4,
} from "@slopus/happy-wire";

interface ComparableSyncV4Mutation {
    producerId: string;
    entityId: string;
    entityType: string;
    revision: number;
    op: string;
    ciphertext: string;
}

export interface StoredSyncV4Mutation extends ComparableSyncV4Mutation {
    mutationId: string;
    seq: number;
}

interface ClassifySyncV4MutationsInput {
    mutations: readonly SyncMutationV4[];
    existingMutations: ReadonlyMap<string, StoredSyncV4Mutation>;
    currentEntities: ReadonlyMap<string, ComparableSyncV4Mutation>;
}

export interface SyncV4MutationClassification {
    mutation: SyncMutationV4;
    status: SyncAckStatusV4;
    existingSeq?: number;
}

interface RevisionConflictDetails {
    entityId: string;
    revision: number;
}

export class RevisionConflictError extends Error {
    readonly details: RevisionConflictDetails;

    constructor(details: RevisionConflictDetails) {
        super("Sync v4 entity revision conflict");
        this.name = "RevisionConflictError";
        this.details = details;
    }
}

export class MutationConflictError extends Error {
    readonly mutationId: string;

    constructor(mutationId: string) {
        super("Sync v4 mutation id conflict");
        this.name = "MutationConflictError";
        this.mutationId = mutationId;
    }
}

function hasSameMutationContent(
    left: ComparableSyncV4Mutation,
    right: ComparableSyncV4Mutation,
): boolean {
    return left.producerId === right.producerId
        && left.entityId === right.entityId
        && left.entityType === right.entityType
        && left.revision === right.revision
        && left.op === right.op
        && left.ciphertext === right.ciphertext;
}

/**
 * Classifies one ordered mutation batch against the committed projection.
 * Accepted entries update only a batch-local projection so later revisions in
 * the same request see earlier entries without mutating caller-owned state.
 */
export function classifySyncV4Mutations({
    mutations,
    existingMutations,
    currentEntities,
}: ClassifySyncV4MutationsInput): SyncV4MutationClassification[] {
    const projectedEntities = new Map(currentEntities);
    const classifications: SyncV4MutationClassification[] = [];

    for (const mutation of mutations) {
        const existingMutation = existingMutations.get(mutation.mutationId);
        if (existingMutation) {
            if (!hasSameMutationContent(existingMutation, mutation)) {
                throw new MutationConflictError(mutation.mutationId);
            }
            classifications.push({
                mutation,
                status: "duplicate",
                existingSeq: existingMutation.seq,
            });
            continue;
        }

        const currentEntity = projectedEntities.get(mutation.entityId);
        if (currentEntity?.revision === mutation.revision) {
            if (!hasSameMutationContent(currentEntity, mutation)) {
                throw new RevisionConflictError({
                    entityId: mutation.entityId,
                    revision: mutation.revision,
                });
            }
            classifications.push({ mutation, status: "superseded" });
            continue;
        }

        const status: SyncAckStatusV4 = currentEntity && currentEntity.revision > mutation.revision
            ? "superseded"
            : "accepted";
        classifications.push({ mutation, status });
        if (status === "accepted") projectedEntities.set(mutation.entityId, mutation);
    }

    return classifications;
}
