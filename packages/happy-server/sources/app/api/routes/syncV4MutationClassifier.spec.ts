import type { SyncMutationV4 } from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';
import {
    MutationConflictError,
    RevisionConflictError,
    classifySyncV4Mutations,
    type StoredSyncV4Mutation,
} from '@/app/api/routes/syncV4MutationClassifier';

const mutation: SyncMutationV4 = {
    mutationId: 'mutation-1',
    producerId: 'producer-1',
    entityId: 'entity-1',
    entityType: 'codex.item',
    revision: 1,
    op: 'upsert',
    ciphertext: 'ciphertext-1',
};

describe('classifySyncV4Mutations', () => {
    it('classifies accepted, duplicate, superseded, and conflicting revisions', () => {
        const existingMutations = new Map<string, StoredSyncV4Mutation>([[
            mutation.mutationId,
            { ...mutation, seq: 7 },
        ]]);
        const currentEntities = new Map([[mutation.entityId, mutation]]);
        expect(classifySyncV4Mutations({
            mutations: [mutation],
            existingMutations,
            currentEntities,
        })).toEqual([{ mutation, status: 'duplicate', existingSeq: 7 }]);
        expect(classifySyncV4Mutations({
            mutations: [{ ...mutation, mutationId: 'mutation-2', revision: 3 }],
            existingMutations,
            currentEntities,
        })).toMatchObject([{ status: 'accepted' }]);
        expect(classifySyncV4Mutations({
            mutations: [{ ...mutation, mutationId: 'mutation-3', revision: 0 }],
            existingMutations,
            currentEntities,
        })).toMatchObject([{ status: 'superseded' }]);
        expect(() => classifySyncV4Mutations({
            mutations: [{ ...mutation, ciphertext: 'changed' }],
            existingMutations,
            currentEntities,
        })).toThrow(MutationConflictError);
        expect(() => classifySyncV4Mutations({
            mutations: [{ ...mutation, mutationId: 'mutation-4', ciphertext: 'changed' }],
            existingMutations,
            currentEntities,
        })).toThrow(RevisionConflictError);
    });

    it('converges 100,000 mutations under reorder, duplicates, disconnects, and lost invalidations', () => {
        const random = xorshift32(0x145_000);
        const mutations = buildMutations(100_000);
        shuffle(mutations, random);
        const storedMutations = new Map<string, StoredSyncV4Mutation>();
        const serverEntities = new Map<string, SyncMutationV4>();
        const journal: Array<SyncMutationV4 & { seq: number }> = [];
        let retryCount = 0;
        let seq = 0;

        for (let offset = 0; offset < mutations.length;) {
            const size = Math.min(1 + random() % 100, mutations.length - offset);
            const batch = mutations.slice(offset, offset + size);
            offset += size;
            const classified = classifySyncV4Mutations({
                mutations: batch,
                existingMutations: storedMutations,
                currentEntities: serverEntities,
            });
            for (const classification of classified) {
                if (classification.status === 'duplicate') continue;
                seq += 1;
                storedMutations.set(classification.mutation.mutationId, {
                    ...classification.mutation,
                    seq,
                });
                journal.push({ ...classification.mutation, seq });
                if (classification.status === 'accepted') {
                    serverEntities.set(classification.mutation.entityId, classification.mutation);
                }
            }

            // A response lost after commit causes an identical full-batch retry.
            if (random() % 7 === 0) {
                retryCount += 1;
                const retry = classifySyncV4Mutations({
                    mutations: batch,
                    existingMutations: storedMutations,
                    currentEntities: serverEntities,
                });
                expect(retry.every((entry) => entry.status === 'duplicate')).toBe(true);
            }
        }

        // No invalidation is delivered. Polling starts only after every write,
        // and selected entity applications crash once before cursor commit.
        const receiverEntities = new Map<string, SyncMutationV4>();
        const crashOnce = new Set<number>();
        let receiveCursor = 0;
        while (receiveCursor < journal.length) {
            const change = journal[receiveCursor];
            const current = receiverEntities.get(change.entityId);
            if (!current || change.revision > current.revision) receiverEntities.set(change.entityId, change);
            if (change.seq % 997 === 0 && !crashOnce.has(change.seq)) {
                crashOnce.add(change.seq);
                continue;
            }
            receiveCursor = change.seq;
        }

        expect(retryCount).toBeGreaterThan(100);
        expect(storedMutations).toHaveLength(100_000);
        expect(journal).toHaveLength(100_000);
        expect(receiveCursor).toBe(100_000);
        expect(project(receiverEntities)).toEqual(project(serverEntities));

        // An expired cursor rebuilds the same final projection from snapshot pages.
        const snapshotProjection = new Map<string, SyncMutationV4>();
        const snapshot = [...serverEntities.values()].sort((left, right) => left.entityId.localeCompare(right.entityId));
        for (let offset = 0; offset < snapshot.length; offset += 500) {
            for (const entity of snapshot.slice(offset, offset + 500)) snapshotProjection.set(entity.entityId, entity);
        }
        expect(project(snapshotProjection)).toEqual(project(serverEntities));
    }, 30_000);
});

function buildMutations(count: number): SyncMutationV4[] {
    const entityCount = 4_096;
    return Array.from({ length: count }, (_, index) => ({
        mutationId: `mutation-${index}`,
        producerId: `producer-${index % 2}`,
        entityId: `entity-${index % entityCount}`,
        entityType: index % 11 === 0 ? 'codex.command' as const : 'codex.item' as const,
        revision: Math.floor(index / entityCount) + 1,
        op: index % 29 === 0 ? 'delete' as const : 'upsert' as const,
        ciphertext: `ciphertext-${index}`,
    }));
}

function project(entities: Map<string, SyncMutationV4>): Array<{
    entityId: string;
    revision: number;
    op: SyncMutationV4['op'];
    ciphertext: string;
}> {
    return [...entities.values()]
        .map(({ entityId, revision, op, ciphertext }) => ({ entityId, revision, op, ciphertext }))
        .sort((left, right) => left.entityId.localeCompare(right.entityId));
}

function xorshift32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

function shuffle<T>(values: T[], random: () => number): void {
    for (let index = values.length - 1; index > 0; index -= 1) {
        const target = random() % (index + 1);
        [values[index], values[target]] = [values[target], values[index]];
    }
}
