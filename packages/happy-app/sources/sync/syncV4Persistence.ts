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

export class SyncV4Persistence {
    constructor(
        private readonly storage: SyncV4KeyValueStorage,
        private readonly generateId: () => string = defaultRandomUUID,
    ) {}

    loadSession(sessionId: string): SyncV4PersistentSession {
        const producerId = this.loadProducerId();
        let snapshotRequired = this.storage.getString(snapshotMarkerKey(sessionId)) !== undefined;
        let entities: SyncEntitySnapshotV4[] = [];
        let receiveCursor = 0;
        if (!snapshotRequired) {
            try {
                entities = this.readEntities(sessionId);
                receiveCursor = this.readCursor(sessionId);
                snapshotRequired = this.storage.getString(snapshotMarkerKey(sessionId)) !== undefined;
                if (snapshotRequired) entities = [];
            } catch {
                this.beginSnapshot(sessionId);
                entities = [];
                snapshotRequired = true;
            }
        }
        return {
            producerId,
            receiveCursor: snapshotRequired ? 0 : receiveCursor,
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
        return this.readCursor(sessionId);
    }

    nextRevision(sessionId: string, entityId: string): number {
        const cached = this.storage.getString(entityKey(sessionId, entityId));
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
        const index = new Set(this.readStringIndex(outboxIndexKey(sessionId)));
        for (const mutation of mutations) {
            order += 1;
            this.storage.set(outboxOrderKey(sessionId), order);
            this.storage.set(outboxMutationKey(sessionId, mutation.mutationId), JSON.stringify({ order, mutation }));
            this.writeRevisionWatermark(sessionId, mutation.entityId, mutation.revision);
            index.add(mutation.mutationId);
        }
        this.writeStringIndex(outboxIndexKey(sessionId), [...index]);
    }

    acknowledgeMutations(sessionId: string, acknowledgements: SyncAckV4[]): void {
        const index = new Set(this.readStringIndex(outboxIndexKey(sessionId)));
        for (const acknowledgement of acknowledgements) {
            this.storage.delete(outboxMutationKey(sessionId, acknowledgement.mutationId));
            index.delete(acknowledgement.mutationId);
        }
        this.writeStringIndex(outboxIndexKey(sessionId), [...index]);
    }

    getPendingOutbox(sessionId: string): SyncMutationV4[] {
        return this.readOutbox(sessionId);
    }

    getEntityRevision(sessionId: string, entityId: string): number {
        const raw = this.storage.getString(entityKey(sessionId, entityId));
        const cachedRevision = raw ? SyncEntitySnapshotV4Schema.parse(JSON.parse(raw)).revision : 0;
        return Math.max(cachedRevision, this.readRevisionWatermark(sessionId, entityId));
    }

    stageChanges(sessionId: string, changes: SyncChangeV4[]): SyncEntitySnapshotV4[] {
        if (changes.length === 0) return [];
        let expectedSeq = this.readCursor(sessionId) + 1;
        const applied: SyncEntitySnapshotV4[] = [];
        const index = new Set(this.readStringIndex(entityIndexKey(sessionId)));
        for (const change of changes) {
            if (change.seq !== expectedSeq) {
                throw new Error(`Sync v4 changes have a gap before sequence ${change.seq}`);
            }
            expectedSeq += 1;
            const key = entityKey(sessionId, change.entityId);
            const currentRaw = this.storage.getString(key);
            const current = currentRaw ? SyncEntitySnapshotV4Schema.parse(JSON.parse(currentRaw)) : null;
            if (!current || change.revision > current.revision) {
                const next = SyncEntitySnapshotV4Schema.parse({
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
                this.storage.set(key, JSON.stringify(next));
                this.writeRevisionWatermark(sessionId, change.entityId, change.revision);
                index.add(change.entityId);
                applied.push(next);
            }
        }
        this.writeStringIndex(entityIndexKey(sessionId), [...index]);
        return applied;
    }

    advanceReceiveCursor(sessionId: string, seq: number): void {
        const current = this.readCursor(sessionId);
        if (!Number.isSafeInteger(seq) || seq < current) {
            throw new Error('Sync v4 receive cursor must advance monotonically');
        }
        this.storage.set(cursorKey(sessionId), seq);
    }

    applyChanges(sessionId: string, changes: SyncChangeV4[]): SyncEntitySnapshotV4[] {
        const applied = this.stageChanges(sessionId, changes);
        if (changes.length > 0) this.advanceReceiveCursor(sessionId, changes.at(-1)!.seq);
        return applied;
    }

    beginSnapshot(sessionId: string): void {
        this.storage.set(snapshotMarkerKey(sessionId), 'rebuilding');
        for (const key of this.storage.getAllKeys()) {
            if (key.startsWith(entityPrefix(sessionId))) this.storage.delete(key);
        }
        this.storage.delete(entityIndexKey(sessionId));
        this.storage.delete(cursorKey(sessionId));
    }

    applySnapshotPage(sessionId: string, entities: SyncEntitySnapshotV4[]): void {
        const index = new Set(this.readStringIndex(entityIndexKey(sessionId)));
        for (const entity of entities) {
            const parsed = SyncEntitySnapshotV4Schema.parse(entity);
            this.storage.set(entityKey(sessionId, parsed.entityId), JSON.stringify(parsed));
            this.writeRevisionWatermark(sessionId, parsed.entityId, parsed.revision);
            index.add(parsed.entityId);
        }
        this.writeStringIndex(entityIndexKey(sessionId), [...index]);
    }

    finishSnapshot(sessionId: string, highWatermark: number): void {
        this.storage.set(cursorKey(sessionId), highWatermark);
        this.storage.delete(snapshotMarkerKey(sessionId));
    }

    clearSession(sessionId: string): void {
        const prefix = sessionPrefix(sessionId);
        for (const key of this.storage.getAllKeys()) {
            if (key.startsWith(prefix)) this.storage.delete(key);
        }
    }

    private readEntities(sessionId: string): SyncEntitySnapshotV4[] {
        const indexed = this.readStringIndex(entityIndexKey(sessionId));
        const scanned = this.storage.getAllKeys()
            .filter((key) => key.startsWith(entityPrefix(sessionId)))
            .map((key) => decodeURIComponent(key.slice(entityPrefix(sessionId).length)));
        const entityIds = [...new Set([...indexed, ...scanned])].sort();
        const entities: SyncEntitySnapshotV4[] = [];
        for (const entityId of entityIds) {
            const raw = this.storage.getString(entityKey(sessionId, entityId));
            if (!raw) continue;
            entities.push(SyncEntitySnapshotV4Schema.parse(JSON.parse(raw)));
        }
        this.writeStringIndex(entityIndexKey(sessionId), entities.map((entity) => entity.entityId));
        return entities;
    }

    private readOutbox(sessionId: string): SyncMutationV4[] {
        const indexed = this.readStringIndex(outboxIndexKey(sessionId));
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
        this.writeStringIndex(outboxIndexKey(sessionId), records.map((record) => record.mutation.mutationId));
        return records.map((record) => record.mutation);
    }

    private readCursor(sessionId: string): number {
        const cursor = this.storage.getNumber(cursorKey(sessionId)) ?? 0;
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

    private readStringIndex(key: string): string[] {
        const raw = this.storage.getString(key);
        if (!raw) return [];
        return z.array(z.string()).parse(JSON.parse(raw));
    }

    private writeStringIndex(key: string, values: string[]): void {
        this.storage.set(key, JSON.stringify(values));
    }
}

function sessionPrefix(sessionId: string): string {
    return `sync-v4:session:${encodeURIComponent(sessionId)}:`;
}

function cursorKey(sessionId: string): string {
    return `${sessionPrefix(sessionId)}cursor`;
}

function snapshotMarkerKey(sessionId: string): string {
    return `${sessionPrefix(sessionId)}snapshot-marker`;
}

function entityIndexKey(sessionId: string): string {
    return `${sessionPrefix(sessionId)}entities`;
}

function entityPrefix(sessionId: string): string {
    return `${sessionPrefix(sessionId)}entity:`;
}

function entityKey(sessionId: string, entityId: string): string {
    return `${entityPrefix(sessionId)}${encodeURIComponent(entityId)}`;
}

function revisionKey(sessionId: string, entityId: string): string {
    return `${sessionPrefix(sessionId)}revision:${encodeURIComponent(entityId)}`;
}

function outboxIndexKey(sessionId: string): string {
    return `${sessionPrefix(sessionId)}outbox`;
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

function defaultRandomUUID(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    throw new Error('Sync v4 persistence requires a UUID generator');
}
