import { describe, expect, it } from 'vitest';
import {
    SyncV4OutboxCorruptionError,
    SyncV4Persistence,
    type SyncV4KeyValueStorage,
} from './syncV4Persistence';

class MemoryStorage implements SyncV4KeyValueStorage {
    readonly values = new Map<string, string | number | boolean>();

    getString(key: string): string | undefined {
        const value = this.values.get(key);
        return typeof value === 'string' ? value : undefined;
    }

    getNumber(key: string): number | undefined {
        const value = this.values.get(key);
        return typeof value === 'number' ? value : undefined;
    }

    set(key: string, value: string | number | boolean): void {
        this.values.set(key, value);
    }

    delete(key: string): void {
        this.values.delete(key);
    }

    getAllKeys(): string[] {
        return [...this.values.keys()];
    }
}

class CrashStorage extends MemoryStorage {
    failAfterSet: ((key: string) => boolean) | null = null;
    failAfterDelete: ((key: string) => boolean) | null = null;

    override set(key: string, value: string | number | boolean): void {
        super.set(key, value);
        if (!this.failAfterSet?.(key)) return;
        this.failAfterSet = null;
        throw new Error('simulated process stop after set');
    }

    override delete(key: string): void {
        super.delete(key);
        if (!this.failAfterDelete?.(key)) return;
        this.failAfterDelete = null;
        throw new Error('simulated process stop after delete');
    }
}

const mutation = {
    mutationId: 'mutation-1',
    producerId: 'producer-1',
    entityId: 'entity-1',
    entityType: 'codex.command' as const,
    revision: 1,
    op: 'upsert' as const,
    ciphertext: 'ciphertext-1',
};

describe('SyncV4Persistence', () => {
    it('keeps outbox FIFO and recovers a mutation written before its index', () => {
        const storage = new MemoryStorage();
        const persistence = new SyncV4Persistence(storage);
        persistence.enqueueMutations('session-1', [
            mutation,
            { ...mutation, mutationId: 'mutation-2', entityId: 'entity-2' },
        ]);
        const indexKey = [...storage.values.keys()].find((key) => key.endsWith(':outbox'))!;
        storage.delete(indexKey);

        expect(persistence.getPendingOutbox('session-1').map((entry) => entry.mutationId)).toEqual([
            'mutation-1',
            'mutation-2',
        ]);
        persistence.acknowledgeMutations('session-1', [{
            mutationId: 'mutation-1',
            seq: 1,
            revision: 1,
            status: 'accepted',
        }]);
        expect(persistence.getPendingOutbox('session-1').map((entry) => entry.mutationId)).toEqual(['mutation-2']);
    });

    it('persists each FIFO order before writing its mutation record', () => {
        const storage = new MemoryStorage();
        const writes: string[] = [];
        const originalSet = storage.set.bind(storage);
        storage.set = (key, value) => {
            writes.push(key);
            originalSet(key, value);
        };
        const persistence = new SyncV4Persistence(storage);
        persistence.enqueueMutations('session-1', [
            mutation,
            { ...mutation, mutationId: 'mutation-2' },
        ]);

        const orderWrites = writes
            .map((key, index) => ({ key, index }))
            .filter(({ key }) => key.endsWith(':outbox-order'));
        const mutationWrites = writes
            .map((key, index) => ({ key, index }))
            .filter(({ key }) => key.includes(':mutation:'));
        expect(orderWrites).toHaveLength(2);
        expect(mutationWrites).toHaveLength(2);
        expect(orderWrites[0].index).toBeLessThan(mutationWrites[0].index);
        expect(orderWrites[1].index).toBeLessThan(mutationWrites[1].index);
    });

    it('writes entity cache before advancing the receive cursor', () => {
        const storage = new MemoryStorage();
        const writes: string[] = [];
        const originalSet = storage.set.bind(storage);
        storage.set = (key, value) => {
            writes.push(key);
            originalSet(key, value);
        };
        const persistence = new SyncV4Persistence(storage);
        const applied = persistence.applyChanges('session-1', [{
            ...mutation,
            mutationId: 'remote-1',
            seq: 1,
            createdAt: 100,
        }]);

        expect(applied).toHaveLength(1);
        expect(writes.findIndex((key) => key.includes(':entity:')))
            .toBeLessThan(writes.findIndex((key) => key.endsWith(':cursor')));
        expect(persistence.getReceiveCursor('session-1')).toBe(1);
    });

    it('keeps tombstones and ignores lower revisions while consuming their seq', () => {
        const persistence = new SyncV4Persistence(new MemoryStorage());
        persistence.applyChanges('session-1', [{
            ...mutation,
            mutationId: 'remote-1',
            revision: 3,
            op: 'delete',
            seq: 1,
            createdAt: 100,
        }]);
        const stale = persistence.applyChanges('session-1', [{
            ...mutation,
            mutationId: 'remote-2',
            revision: 2,
            seq: 2,
            createdAt: 101,
        }]);

        expect(stale).toEqual([]);
        const session = persistence.loadSession('session-1');
        expect(session.receiveCursor).toBe(2);
        expect(session.entities).toEqual([expect.objectContaining({ revision: 3, op: 'delete' })]);
    });

    it('marks an interrupted snapshot for rebuild without deleting outbox', () => {
        const storage = new MemoryStorage();
        const persistence = new SyncV4Persistence(storage);
        persistence.enqueueMutations('session-1', [mutation]);
        persistence.applyChanges('session-1', [{ ...mutation, seq: 1, createdAt: 100 }]);
        const generation = persistence.beginSnapshot('session-1');

        const interrupted = persistence.loadSession('session-1');
        expect(interrupted.snapshotRequired).toBe(true);
        expect(interrupted.entities).toEqual([
            expect.objectContaining({ entityId: mutation.entityId, revision: 1 }),
        ]);
        expect(interrupted.receiveCursor).toBe(1);
        expect(interrupted.outbox).toEqual([mutation]);

        persistence.applySnapshotPage('session-1', generation, [{
            producerId: mutation.producerId,
            entityId: mutation.entityId,
            entityType: mutation.entityType,
            revision: mutation.revision,
            op: mutation.op,
            ciphertext: mutation.ciphertext,
            updatedSeq: 4,
            createdAt: 100,
            updatedAt: 100,
        }]);
        persistence.finishSnapshot('session-1', generation, 4);
        expect(persistence.loadSession('session-1')).toMatchObject({
            snapshotRequired: false,
            receiveCursor: 4,
        });
    });

    it('fails closed on a corrupt unsent command', () => {
        const storage = new MemoryStorage();
        const persistence = new SyncV4Persistence(storage);
        persistence.enqueueMutations('session-1', [mutation]);
        const mutationKey = [...storage.values.keys()].find((key) => key.includes(':mutation:'))!;
        storage.set(mutationKey, '{broken');
        expect(() => persistence.loadSession('session-1')).toThrow(SyncV4OutboxCorruptionError);
    });

    it('recovers an outbox record when the process stops before its index write', () => {
        const storage = new CrashStorage();
        const beforeCrash = new SyncV4Persistence(storage);
        storage.failAfterSet = (key) => key.includes(':mutation:');
        expect(() => beforeCrash.enqueueMutations('session-1', [mutation]))
            .toThrow('simulated process stop after set');

        const recovered = new SyncV4Persistence(storage);
        expect(recovered.getPendingOutbox('session-1')).toEqual([mutation]);
    });

    it('recovers an ACK when the process stops before its stale index is rewritten', () => {
        const storage = new CrashStorage();
        const beforeCrash = new SyncV4Persistence(storage);
        beforeCrash.enqueueMutations('session-1', [mutation]);
        storage.failAfterDelete = (key) => key.includes(':mutation:');
        expect(() => beforeCrash.acknowledgeMutations('session-1', [{
            mutationId: mutation.mutationId,
            seq: 1,
            revision: 1,
            status: 'accepted',
        }])).toThrow('simulated process stop after delete');

        expect(new SyncV4Persistence(storage).getPendingOutbox('session-1')).toEqual([]);
    });

    it('hydrates a staged entity and replays its change when the cursor was not written', () => {
        const storage = new CrashStorage();
        const beforeCrash = new SyncV4Persistence(storage);
        storage.failAfterSet = (key) => key.includes(':entity:');
        expect(() => beforeCrash.stageChanges('session-1', [{
            ...mutation,
            mutationId: 'remote-1',
            seq: 1,
            createdAt: 100,
        }])).toThrow('simulated process stop after set');

        const recovered = new SyncV4Persistence(storage);
        expect(recovered.loadSession('session-1')).toMatchObject({
            receiveCursor: 0,
            entities: [expect.objectContaining({ entityId: mutation.entityId, revision: 1 })],
        });
        expect(recovered.applyChanges('session-1', [{
            ...mutation,
            mutationId: 'remote-1',
            seq: 1,
            createdAt: 100,
        }])).toEqual([]);
        expect(recovered.getReceiveCursor('session-1')).toBe(1);
    });

    it('classifies changes before decryption and rejects same-revision conflicts', () => {
        const persistence = new SyncV4Persistence(new MemoryStorage());
        const original = {
            ...mutation,
            mutationId: 'remote-1',
            revision: 2,
            seq: 1,
            createdAt: 100,
        };
        persistence.stageChanges('session-1', [original]);

        expect(persistence.classifyChanges('session-1', [original]).map((entry) => entry.kind))
            .toEqual(['exactReplay']);
        expect(persistence.classifyChanges('session-1', [{
            ...original,
            mutationId: 'remote-2',
            revision: 1,
            seq: 1,
        }]).map((entry) => entry.kind)).toEqual(['superseded']);
        expect(persistence.classifyChanges('session-1', [{
            ...original,
            mutationId: 'remote-3',
            revision: 3,
            seq: 1,
        }]).map((entry) => entry.kind)).toEqual(['new']);
        expect(() => persistence.classifyChanges('session-1', [{
            ...original,
            ciphertext: 'conflicting-ciphertext',
        }])).toThrow('same revision');
    });

    it('rebuilds corrupt derived indexes from independent entity and outbox records', () => {
        const storage = new MemoryStorage();
        const persistence = new SyncV4Persistence(storage);
        persistence.enqueueMutations('session-1', [mutation]);
        persistence.applyChanges('session-1', [{
            ...mutation,
            mutationId: 'remote-1',
            seq: 1,
            createdAt: 100,
        }]);
        for (const key of storage.getAllKeys()) {
            if (key.includes(':entity-index:') || key.includes(':outbox-index:')) {
                storage.set(key, '{broken');
            }
        }

        const recovered = new SyncV4Persistence(storage);
        expect(recovered.loadSession('session-1')).toMatchObject({
            receiveCursor: 1,
            entities: [expect.objectContaining({ entityId: mutation.entityId })],
            outbox: [mutation],
            snapshotRequired: false,
        });
        const repairedIndexes = storage.getAllKeys()
            .filter((key) => key.includes(':entity-index:') || key.includes(':outbox-index:'));
        expect(repairedIndexes.length).toBeGreaterThan(0);
        for (const key of repairedIndexes) {
            expect(() => JSON.parse(storage.getString(key)!)).not.toThrow();
        }
    });

    it('keeps an interrupted snapshot marked for a full rebuild when only its cursor was written', () => {
        const storage = new CrashStorage();
        const beforeCrash = new SyncV4Persistence(storage);
        beforeCrash.enqueueMutations('session-1', [mutation]);
        const generation = beforeCrash.beginSnapshot('session-1');
        beforeCrash.applySnapshotPage('session-1', generation, [{
            producerId: mutation.producerId,
            entityId: mutation.entityId,
            entityType: mutation.entityType,
            revision: mutation.revision,
            op: mutation.op,
            ciphertext: mutation.ciphertext,
            updatedSeq: 4,
            createdAt: 100,
            updatedAt: 100,
        }]);
        storage.failAfterSet = (key) => key.endsWith(':cursor');
        expect(() => beforeCrash.finishSnapshot('session-1', generation, 4))
            .toThrow('simulated process stop after set');

        expect(new SyncV4Persistence(storage).loadSession('session-1')).toMatchObject({
            receiveCursor: 0,
            entities: [],
            outbox: [mutation],
            snapshotRequired: true,
        });
    });

    it('keeps the old generation visible until a complete snapshot commits', () => {
        const storage = new MemoryStorage();
        const persistence = new SyncV4Persistence(storage);
        persistence.applyChanges('session-1', [{
            ...mutation,
            mutationId: 'old-change',
            seq: 1,
            createdAt: 100,
        }]);
        const generation = persistence.beginSnapshot('session-1');
        persistence.applySnapshotPage('session-1', generation, [{
            producerId: mutation.producerId,
            entityId: 'replacement-entity',
            entityType: mutation.entityType,
            revision: 1,
            op: mutation.op,
            ciphertext: 'replacement-ciphertext',
            updatedSeq: 2,
            createdAt: 101,
            updatedAt: 101,
        }]);

        expect(persistence.loadSession('session-1')).toMatchObject({
            snapshotRequired: true,
            receiveCursor: 1,
            entities: [expect.objectContaining({ entityId: mutation.entityId })],
        });

        persistence.finishSnapshot('session-1', generation, 2);
        expect(persistence.loadSession('session-1')).toMatchObject({
            snapshotRequired: false,
            receiveCursor: 2,
            entities: [expect.objectContaining({ entityId: 'replacement-entity' })],
        });
    });
});
