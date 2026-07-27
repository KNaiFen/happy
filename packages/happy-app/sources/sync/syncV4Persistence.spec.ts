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
        persistence.beginSnapshot('session-1');

        const interrupted = persistence.loadSession('session-1');
        expect(interrupted.snapshotRequired).toBe(true);
        expect(interrupted.entities).toEqual([]);
        expect(interrupted.outbox).toEqual([mutation]);

        persistence.applySnapshotPage('session-1', [{
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
        persistence.finishSnapshot('session-1', 4);
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
});
