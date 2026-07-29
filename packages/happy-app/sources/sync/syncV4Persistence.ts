/**
 * Crash-recoverable MMKV-shaped persistence for App Sync v4 state.
 *
 * Entity cache records and outbox mutations are stored under individual keys.
 * Prefix scans recover records written immediately before an index update.
 */

import {
    SyncEntitySnapshotV4Schema,
    SyncMutationV4Schema,
    type SyncAckV4,
    type SyncChangeV4,
    type SyncEntitySnapshotV4,
    type SyncMutationV4,
} from '@slopus/happy-wire';
import { z } from 'zod';

export interface SyncV4KeyValueStorage {
    getString(key: string): string | undefined;
    getNumber(key: string): number | undefined;
    set(key: string, value: string | number | boolean): void;
    delete(key: string): void;
    getAllKeys(): string[];
}

const outboxRecordSchema = z.object({
    order: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mutation: SyncMutationV4Schema,
}).strict();

const snapshotMarkerSchema = z.object({
    generation: z.string().startsWith('snapshot-'),
}).strict();

const LEGACY_GENERATION = 'legacy';
const INDEX_BUCKET_COUNT = 64;

export type SyncV4ChangeClassificationKind = 'new' | 'exactReplay' | 'superseded';

export interface SyncV4ClassifiedChange {
    kind: SyncV4ChangeClassificationKind;
    change: SyncChangeV4;
}

export interface SyncV4PersistentSession {
    producerId: string;
    receiveCursor: number;
    entities: SyncEntitySnapshotV4[];
    outbox: SyncMutationV4[];
    snapshotRequired: boolean;
}

export class SyncV4OutboxCorruptionError extends Error {
    constructor(readonly key: string) {
        super(`Sync v4 outbox record is corrupt: ${key}`);
    }
}

export class SyncV4RevisionConflictError extends Error {
    constructor() {
        super('Sync v4 change has conflicting ciphertext for the same revision');
        this.name = 'SyncV4RevisionConflictError';
    }
}

export class SyncV4Persistence {
    constructor(
        private readonly storage: SyncV4KeyValueStorage,
        private readonly generateId: () => string = defaultRandomUUID,
    ) {}

    loadSession(sessionId: string): SyncV4PersistentSession {
        const producerId = this.loadProducerId();
        const activeGeneration = this.readActiveGeneration(sessionId);
        let snapshotRequired = this.recoverSnapshotMarker(sessionId, activeGeneration);
        let entities: SyncEntitySnapshotV4[] = [];
        let receiveCursor = 0;
        try {
            entities = this.readEntities(sessionId, activeGeneration);
            receiveCursor = this.readCursor(sessionId, activeGeneration);
        } catch {
            this.beginSnapshot(sessionId);
            entities = [];
            snapshotRequired = true;
        }
        return {
            producerId,
            receiveCursor,
            entities,
            outbox: this.readOutbox(sessionId),
            snapshotRequired,
        };
    }

    loadProducerId(): string {
        const existing = this.storage.getString('sync-v4:producer-id');
        if (existing && z.string().uuid().safeParse(existing).success) return existing;
        const producerId = this.generateId();
        this.storage.set('sync-v4:producer-id', producerId);
        return producerId;
    }

    getReceiveCursor(sessionId: string): number {
        return this.readCursor(sessionId, this.readActiveGeneration(sessionId));
    }

    nextRevision(sessionId: string, entityId: string): number {
        const cached = this.storage.getString(entityKey(
            sessionId,
            this.readActiveGeneration(sessionId),
            entityId,
        ));
        let currentRevision = this.readRevisionWatermark(sessionId, entityId);
        if (cached) {
            currentRevision = Math.max(
                currentRevision,
                SyncEntitySnapshotV4Schema.parse(JSON.parse(cached)).revision,
            );
        }
        for (const mutation of this.readOutbox(sessionId)) {
            if (mutation.entityId === entityId) currentRevision = Math.max(currentRevision, mutation.revision);
        }
        return currentRevision + 1;
    }

    enqueueMutations(sessionId: string, mutations: SyncMutationV4[]): void {
        if (mutations.length === 0) return;
        let order = this.storage.getNumber(outboxOrderKey(sessionId)) ?? 0;
        const indexes = new Map<number, Set<string>>();
        for (const mutation of mutations) {
            order += 1;
            this.storage.set(outboxOrderKey(sessionId), order);
            this.storage.set(outboxMutationKey(sessionId, mutation.mutationId), JSON.stringify({ order, mutation }));
            this.writeRevisionWatermark(sessionId, mutation.entityId, mutation.revision);
            const bucket = indexBucket(mutation.mutationId);
            const index = indexes.get(bucket)
                ?? new Set(this.readStringIndexSafe(outboxIndexBucketKey(sessionId, bucket)));
            index.add(mutation.mutationId);
            indexes.set(bucket, index);
        }
        for (const [bucket, index] of indexes) {
            this.writeStringIndex(outboxIndexBucketKey(sessionId, bucket), [...index]);
        }
    }

    acknowledgeMutations(sessionId: string, acknowledgements: SyncAckV4[]): void {
        const indexes = new Map<number, Set<string>>();
        for (const acknowledgement of acknowledgements) {
            this.storage.delete(outboxMutationKey(sessionId, acknowledgement.mutationId));
            const bucket = indexBucket(acknowledgement.mutationId);
            const index = indexes.get(bucket)
                ?? new Set(this.readStringIndexSafe(outboxIndexBucketKey(sessionId, bucket)));
            index.delete(acknowledgement.mutationId);
            indexes.set(bucket, index);
        }
        for (const [bucket, index] of indexes) {
            this.writeStringIndex(outboxIndexBucketKey(sessionId, bucket), [...index]);
        }
    }

    getPendingOutbox(sessionId: string): SyncMutationV4[] {
        return this.readOutbox(sessionId);
    }

    getEntityRevision(sessionId: string, entityId: string): number {
        const raw = this.storage.getString(entityKey(
            sessionId,
            this.readActiveGeneration(sessionId),
            entityId,
        ));
        const cachedRevision = raw ? SyncEntitySnapshotV4Schema.parse(JSON.parse(raw)).revision : 0;
        return Math.max(cachedRevision, this.readRevisionWatermark(sessionId, entityId));
    }

    classifyChanges(sessionId: string, changes: SyncChangeV4[]): SyncV4ClassifiedChange[] {
        if (changes.length === 0) return [];
        const generation = this.readActiveGeneration(sessionId);
        let expectedSeq = this.readCursor(sessionId, generation) + 1;
        const virtual = new Map<string, SyncEntitySnapshotV4 | null>();
        const classified: SyncV4ClassifiedChange[] = [];
        for (const change of changes) {
            if (change.seq !== expectedSeq) {
                throw new Error(`Sync v4 changes have a gap before sequence ${change.seq}`);
            }
            expectedSeq += 1;
            let current = virtual.get(change.entityId);
            if (current === undefined) {
                current = this.readEntity(sessionId, generation, change.entityId);
            }
            if (!current || change.revision > current.revision) {
                const next = snapshotFromChange(change, current);
                virtual.set(change.entityId, next);
                classified.push({ kind: 'new', change });
                continue;
            }
            if (change.revision < current.revision) {
                classified.push({ kind: 'superseded', change });
                continue;
            }
            if (!isExactReplay(current, change)) {
                throw new SyncV4RevisionConflictError();
            }
            classified.push({ kind: 'exactReplay', change });
        }
        return classified;
    }

    stageChanges(sessionId: string, changes: SyncChangeV4[]): SyncEntitySnapshotV4[] {
        if (changes.length === 0) return [];
        const generation = this.readActiveGeneration(sessionId);
        let expectedSeq = this.readCursor(sessionId, generation) + 1;
        const applied: SyncEntitySnapshotV4[] = [];
        const indexes = new Map<number, Set<string>>();
        for (const change of changes) {
            if (change.seq !== expectedSeq) {
                throw new Error(`Sync v4 changes have a gap before sequence ${change.seq}`);
            }
            expectedSeq += 1;
            const key = entityKey(sessionId, generation, change.entityId);
            const currentRaw = this.storage.getString(key);
            const current = currentRaw ? SyncEntitySnapshotV4Schema.parse(JSON.parse(currentRaw)) : null;
            if (!current || change.revision > current.revision) {
                const next = snapshotFromChange(change, current);
                this.storage.set(key, JSON.stringify(next));
                this.writeRevisionWatermark(sessionId, change.entityId, change.revision);
                const bucket = indexBucket(change.entityId);
                const index = indexes.get(bucket)
                    ?? new Set(this.readStringIndexSafe(entityIndexBucketKey(sessionId, generation, bucket)));
                index.add(change.entityId);
                indexes.set(bucket, index);
                applied.push(next);
            }
        }
        for (const [bucket, index] of indexes) {
            this.writeStringIndex(entityIndexBucketKey(sessionId, generation, bucket), [...index]);
        }
        return applied;
    }

    advanceReceiveCursor(sessionId: string, seq: number): void {
        const generation = this.readActiveGeneration(sessionId);
        const current = this.readCursor(sessionId, generation);
        if (!Number.isSafeInteger(seq) || seq < current) {
            throw new Error('Sync v4 receive cursor must advance monotonically');
        }
        this.storage.set(cursorKey(sessionId, generation), seq);
    }

    applyChanges(sessionId: string, changes: SyncChangeV4[]): SyncEntitySnapshotV4[] {
        const applied = this.stageChanges(sessionId, changes);
        if (changes.length > 0) this.advanceReceiveCursor(sessionId, changes.at(-1)!.seq);
        return applied;
    }

    beginSnapshot(sessionId: string): string {
        const activeGeneration = this.readActiveGeneration(sessionId);
        const previousMarker = this.readSnapshotMarker(sessionId);
        if (previousMarker && previousMarker.generation !== activeGeneration) {
            this.deleteGeneration(sessionId, previousMarker.generation);
        }
        let generation = `snapshot-${this.generateId()}`;
        while (generation === activeGeneration || generation === previousMarker?.generation) {
            generation = `${generation}-next`;
        }
        this.deleteGeneration(sessionId, generation);
        this.storage.set(snapshotMarkerKey(sessionId), JSON.stringify({ generation }));
        return generation;
    }

    applySnapshotPage(sessionId: string, generation: string, entities: SyncEntitySnapshotV4[]): void {
        this.assertSnapshotGeneration(sessionId, generation);
        const indexes = new Map<number, Set<string>>();
        for (const entity of entities) {
            const parsed = SyncEntitySnapshotV4Schema.parse(entity);
            this.storage.set(entityKey(sessionId, generation, parsed.entityId), JSON.stringify(parsed));
            this.writeRevisionWatermark(sessionId, parsed.entityId, parsed.revision);
            const bucket = indexBucket(parsed.entityId);
            const index = indexes.get(bucket)
                ?? new Set(this.readStringIndexSafe(entityIndexBucketKey(sessionId, generation, bucket)));
            index.add(parsed.entityId);
            indexes.set(bucket, index);
        }
        for (const [bucket, index] of indexes) {
            this.writeStringIndex(entityIndexBucketKey(sessionId, generation, bucket), [...index]);
        }
    }

    finishSnapshot(sessionId: string, generation: string, highWatermark: number): void {
        this.assertSnapshotGeneration(sessionId, generation);
        if (!Number.isSafeInteger(highWatermark) || highWatermark < 0) {
            throw new Error('Sync v4 snapshot watermark is invalid');
        }
        this.storage.set(cursorKey(sessionId, generation), highWatermark);
        this.storage.set(activeGenerationKey(sessionId), generation);
        this.storage.delete(snapshotMarkerKey(sessionId));
    }

    clearSession(sessionId: string): void {
        const prefix = sessionPrefix(sessionId);
        for (const key of this.storage.getAllKeys()) {
            if (key.startsWith(prefix)) this.storage.delete(key);
        }
    }

    private readEntities(sessionId: string, generation: string): SyncEntitySnapshotV4[] {
        const indexed = Array.from({ length: INDEX_BUCKET_COUNT }, (_, bucket) => (
            this.readStringIndexSafe(entityIndexBucketKey(sessionId, generation, bucket))
        )).flat();
        const scanned = this.storage.getAllKeys()
            .filter((key) => key.startsWith(entityPrefix(sessionId, generation)))
            .map((key) => decodeURIComponent(key.slice(entityPrefix(sessionId, generation).length)));
        const entityIds = [...new Set([...indexed, ...scanned])].sort();
        const entities: SyncEntitySnapshotV4[] = [];
        for (const entityId of entityIds) {
            const raw = this.storage.getString(entityKey(sessionId, generation, entityId));
            if (!raw) continue;
            entities.push(SyncEntitySnapshotV4Schema.parse(JSON.parse(raw)));
        }
        this.rebuildBucketIndexes(
            (bucket) => entityIndexBucketKey(sessionId, generation, bucket),
            entities.map((entity) => entity.entityId),
        );
        return entities;
    }

    private readOutbox(sessionId: string): SyncMutationV4[] {
        const indexed = Array.from({ length: INDEX_BUCKET_COUNT }, (_, bucket) => (
            this.readStringIndexSafe(outboxIndexBucketKey(sessionId, bucket))
        )).flat();
        const scanned = this.storage.getAllKeys()
            .filter((key) => key.startsWith(outboxMutationPrefix(sessionId)))
            .map((key) => decodeURIComponent(key.slice(outboxMutationPrefix(sessionId).length)));
        const mutationIds = [...new Set([...indexed, ...scanned])];
        const records: Array<z.infer<typeof outboxRecordSchema>> = [];
        for (const mutationId of mutationIds) {
            const key = outboxMutationKey(sessionId, mutationId);
            const raw = this.storage.getString(key);
            if (!raw) continue;
            try {
                records.push(outboxRecordSchema.parse(JSON.parse(raw)));
            } catch {
                throw new SyncV4OutboxCorruptionError(key);
            }
        }
        records.sort((left, right) => left.order - right.order);
        this.rebuildBucketIndexes(
            (bucket) => outboxIndexBucketKey(sessionId, bucket),
            records.map((record) => record.mutation.mutationId),
        );
        return records.map((record) => record.mutation);
    }

    private readCursor(sessionId: string, generation: string): number {
        const cursor = this.storage.getNumber(cursorKey(sessionId, generation)) ?? 0;
        if (!Number.isSafeInteger(cursor) || cursor < 0) {
            this.beginSnapshot(sessionId);
            return 0;
        }
        return cursor;
    }

    private readRevisionWatermark(sessionId: string, entityId: string): number {
        const revision = this.storage.getNumber(revisionKey(sessionId, entityId)) ?? 0;
        if (!Number.isSafeInteger(revision) || revision < 0) {
            this.storage.delete(revisionKey(sessionId, entityId));
            return 0;
        }
        return revision;
    }

    private writeRevisionWatermark(sessionId: string, entityId: string, revision: number): void {
        const current = this.readRevisionWatermark(sessionId, entityId);
        if (revision > current) this.storage.set(revisionKey(sessionId, entityId), revision);
    }

    private readStringIndexSafe(key: string): string[] {
        const raw = this.storage.getString(key);
        if (!raw) return [];
        try {
            return z.array(z.string()).parse(JSON.parse(raw));
        } catch {
            this.storage.delete(key);
            return [];
        }
    }

    private writeStringIndex(key: string, values: string[]): void {
        if (values.length === 0) {
            this.storage.delete(key);
            return;
        }
        this.storage.set(key, JSON.stringify([...new Set(values)].sort()));
    }

    private rebuildBucketIndexes(keyForBucket: (bucket: number) => string, values: string[]): void {
        const buckets = new Map<number, string[]>();
        for (const value of values) {
            const bucket = indexBucket(value);
            const entries = buckets.get(bucket) ?? [];
            entries.push(value);
            buckets.set(bucket, entries);
        }
        for (let bucket = 0; bucket < INDEX_BUCKET_COUNT; bucket += 1) {
            this.writeStringIndex(keyForBucket(bucket), buckets.get(bucket) ?? []);
        }
    }

    private readActiveGeneration(sessionId: string): string {
        return this.storage.getString(activeGenerationKey(sessionId)) ?? LEGACY_GENERATION;
    }

    private readSnapshotMarker(sessionId: string): z.infer<typeof snapshotMarkerSchema> | null {
        const raw = this.storage.getString(snapshotMarkerKey(sessionId));
        if (!raw) return null;
        try {
            return snapshotMarkerSchema.parse(JSON.parse(raw));
        } catch {
            return null;
        }
    }

    private recoverSnapshotMarker(sessionId: string, activeGeneration: string): boolean {
        const raw = this.storage.getString(snapshotMarkerKey(sessionId));
        if (!raw) return false;
        const marker = this.readSnapshotMarker(sessionId);
        if (!marker) {
            this.storage.delete(snapshotMarkerKey(sessionId));
            this.beginSnapshot(sessionId);
            return true;
        }
        if (marker.generation === activeGeneration) {
            this.storage.delete(snapshotMarkerKey(sessionId));
            return false;
        }
        return true;
    }

    private assertSnapshotGeneration(sessionId: string, generation: string): void {
        if (this.readSnapshotMarker(sessionId)?.generation !== generation) {
            throw new Error('Sync v4 snapshot generation is no longer current');
        }
    }

    private readEntity(
        sessionId: string,
        generation: string,
        entityId: string,
    ): SyncEntitySnapshotV4 | null {
        const raw = this.storage.getString(entityKey(sessionId, generation, entityId));
        return raw ? SyncEntitySnapshotV4Schema.parse(JSON.parse(raw)) : null;
    }

    private deleteGeneration(sessionId: string, generation: string): void {
        if (generation === LEGACY_GENERATION || !generation.startsWith('snapshot-')) return;
        const prefix = generationPrefix(sessionId, generation);
        for (const key of this.storage.getAllKeys()) {
            if (key.startsWith(prefix)) this.storage.delete(key);
        }
    }
}

function sessionPrefix(sessionId: string): string {
    return `sync-v4:session:${encodeURIComponent(sessionId)}:`;
}

function activeGenerationKey(sessionId: string): string {
    return `${sessionPrefix(sessionId)}active-generation`;
}

function generationPrefix(sessionId: string, generation: string): string {
    return generation === LEGACY_GENERATION
        ? sessionPrefix(sessionId)
        : `${sessionPrefix(sessionId)}generation:${encodeURIComponent(generation)}:`;
}

function cursorKey(sessionId: string, generation: string): string {
    return `${generationPrefix(sessionId, generation)}cursor`;
}

function snapshotMarkerKey(sessionId: string): string {
    return `${sessionPrefix(sessionId)}snapshot-marker`;
}

function entityIndexBucketKey(sessionId: string, generation: string, bucket: number): string {
    return `${generationPrefix(sessionId, generation)}entity-index:${bucket}`;
}

function entityPrefix(sessionId: string, generation: string): string {
    return `${generationPrefix(sessionId, generation)}entity:`;
}

function entityKey(sessionId: string, generation: string, entityId: string): string {
    return `${entityPrefix(sessionId, generation)}${encodeURIComponent(entityId)}`;
}

function revisionKey(sessionId: string, entityId: string): string {
    return `${sessionPrefix(sessionId)}revision:${encodeURIComponent(entityId)}`;
}

function outboxIndexBucketKey(sessionId: string, bucket: number): string {
    return `${sessionPrefix(sessionId)}outbox-index:${bucket}`;
}

function outboxOrderKey(sessionId: string): string {
    return `${sessionPrefix(sessionId)}outbox-order`;
}

function outboxMutationPrefix(sessionId: string): string {
    return `${sessionPrefix(sessionId)}mutation:`;
}

function outboxMutationKey(sessionId: string, mutationId: string): string {
    return `${outboxMutationPrefix(sessionId)}${encodeURIComponent(mutationId)}`;
}

function snapshotFromChange(
    change: SyncChangeV4,
    current: SyncEntitySnapshotV4 | null,
): SyncEntitySnapshotV4 {
    return SyncEntitySnapshotV4Schema.parse({
        producerId: change.producerId,
        entityId: change.entityId,
        entityType: change.entityType,
        revision: change.revision,
        op: change.op,
        ciphertext: change.ciphertext,
        updatedSeq: change.seq,
        createdAt: current?.createdAt ?? change.createdAt,
        updatedAt: change.createdAt,
    });
}

function isExactReplay(current: SyncEntitySnapshotV4, change: SyncChangeV4): boolean {
    return current.producerId === change.producerId
        && current.entityId === change.entityId
        && current.entityType === change.entityType
        && current.revision === change.revision
        && current.op === change.op
        && current.ciphertext === change.ciphertext;
}

function indexBucket(value: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) % INDEX_BUCKET_COUNT;
}

function defaultRandomUUID(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    throw new Error('Sync v4 persistence requires a UUID generator');
}
