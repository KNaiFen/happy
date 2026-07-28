import {
    SyncChangesResponseV4Schema,
    SyncSnapshotResponseV4Schema,
    type CodexCommandEntityV4,
    type CodexEntityV4,
    type SyncChangeV4,
    type SyncMutationBatchResponseV4,
    type SyncMutationV4,
    type SyncSnapshotResponseV4,
    type SyncV4Capabilities,
    type SyncV4Aad,
} from '@slopus/happy-wire';
import { describe, expect, it, vi } from 'vitest';
import {
    AppSyncV4Client,
    AppSyncV4SnapshotRequiredError,
    type AppSyncV4AppliedEntity,
    type AppSyncV4Crypto,
    type AppSyncV4Transport,
} from './syncV4Client';
import {
    applyCodexV4ProjectionUpdate,
    createCodexV4Projection,
    resetCodexV4Projection,
    type CodexV4Projection,
} from './codexV4Projection';
import { SyncV4Persistence, type SyncV4KeyValueStorage } from './syncV4Persistence';

vi.mock('./syncV4Crypto', () => ({
    SyncV4Crypto: { create: vi.fn() },
}));

class MemoryStorage implements SyncV4KeyValueStorage {
    readonly values = new Map<string, string | number | boolean>();
    getString(key: string) { const value = this.values.get(key); return typeof value === 'string' ? value : undefined; }
    getNumber(key: string) { const value = this.values.get(key); return typeof value === 'number' ? value : undefined; }
    set(key: string, value: string | number | boolean) { this.values.set(key, value); }
    delete(key: string) { this.values.delete(key); }
    getAllKeys() { return [...this.values.keys()]; }
}

class Deferred<T> {
    readonly promise: Promise<T>;
    resolve!: (value: T) => void;

    constructor() {
        this.promise = new Promise<T>((resolve) => {
            this.resolve = resolve;
        });
    }
}

const fakeCrypto: AppSyncV4Crypto = {
    opaqueEntityId: async (entityType, providerId) => `opaque:${entityType}:${providerId}`,
    encryptEntity: async (_aad, entity) => JSON.stringify(entity),
    decryptEntity: async (_aad, ciphertext) => JSON.parse(ciphertext) as CodexEntityV4,
};

class FakeTransport implements AppSyncV4Transport {
    readonly posted: SyncMutationV4[][] = [];
    readonly committed = new Map<string, number>();
    changes: SyncChangeV4[] = [];
    snapshots: SyncSnapshotResponseV4[] = [];
    requireSnapshot = false;
    failAfterCommit = false;
    capabilities: SyncV4Capabilities = {
        codex: {
            enabled: true,
            protocolVersion: 4,
            minimumHappyCliVersion: '1.4.2',
            minimumHappyAppVersion: '1.11.4',
            minimumCodexCliVersion: '0.145.0',
        },
    };

    async getCapabilities(): Promise<SyncV4Capabilities> {
        return this.capabilities;
    }

    async postMutations(_sessionId: string, mutations: SyncMutationV4[]): Promise<SyncMutationBatchResponseV4> {
        this.posted.push(mutations);
        const acknowledgements = mutations.map((mutation) => {
            const previous = this.committed.get(mutation.mutationId);
            if (previous) {
                return { mutationId: mutation.mutationId, seq: previous, revision: mutation.revision, status: 'duplicate' as const };
            }
            const seq = this.committed.size + 1;
            this.committed.set(mutation.mutationId, seq);
            return { mutationId: mutation.mutationId, seq, revision: mutation.revision, status: 'accepted' as const };
        });
        if (this.failAfterCommit) {
            this.failAfterCommit = false;
            throw new Error('network lost');
        }
        return { acknowledgements };
    }

    async getChanges(_sessionId: string, afterSeq: number, limit: number) {
        if (this.requireSnapshot) {
            this.requireSnapshot = false;
            throw new AppSyncV4SnapshotRequiredError(1, this.changes.at(-1)?.seq ?? 0);
        }
        const remaining = this.changes.filter((change) => change.seq > afterSeq);
        const page = remaining.slice(0, limit);
        return SyncChangesResponseV4Schema.parse({
            changes: page,
            hasMore: remaining.length > page.length,
            highWatermark: this.changes.at(-1)?.seq ?? afterSeq,
        });
    }

    async getSnapshot(): Promise<SyncSnapshotResponseV4> {
        const page = this.snapshots.shift();
        if (!page) throw new Error('missing snapshot');
        return SyncSnapshotResponseV4Schema.parse(page);
    }
}

function command(commandId: string): CodexCommandEntityV4 {
    return {
        schemaVersion: 1,
        entityType: 'codex.command',
        providerId: commandId,
        createdAt: 10,
        updatedAt: 10,
        commandId,
        threadId: 'thread-1',
        expectedTurnId: null,
        command: 'turn.start',
        payload: { text: commandId },
        clientUserMessageId: commandId,
        replacesCommandId: null,
    };
}

function persistence(storage: MemoryStorage): SyncV4Persistence {
    return new SyncV4Persistence(storage, () => '00000000-0000-4000-8000-000000000001');
}

let mutationCounter = 0;
async function client(
    storage: MemoryStorage,
    transport: AppSyncV4Transport,
    applied: AppSyncV4AppliedEntity[] = [],
    handler?: (event: AppSyncV4AppliedEntity) => Promise<void>,
    snapshotReset?: () => Promise<void>,
    batchHandler?: (events: readonly AppSyncV4AppliedEntity[]) => Promise<void>,
    snapshotReplace?: (events: readonly AppSyncV4AppliedEntity[]) => Promise<void>,
    crypto: AppSyncV4Crypto = fakeCrypto,
): Promise<AppSyncV4Client> {
    return AppSyncV4Client.create({
        sessionId: 'session-1',
        sessionKey: new Uint8Array(32),
        appVersion: '1.11.4',
        persistence: persistence(storage),
        transport,
        crypto,
        generateMutationId: () => `00000000-0000-4000-8000-${String(++mutationCounter).padStart(12, '0')}`,
        onEntity: handler ?? (async (event) => { applied.push(event); }),
        onEntities: batchHandler,
        onSnapshotReset: snapshotReset ?? (async () => undefined),
        onSnapshotReplace: snapshotReplace,
    });
}

function toChange(mutation: SyncMutationV4, seq: number): SyncChangeV4 {
    return { ...mutation, seq, createdAt: 100 + seq };
}

describe('AppSyncV4Client', () => {
    it('does not hydrate or pull when the coordinated cutover is disabled', async () => {
        const transport = new FakeTransport();
        transport.capabilities = {
            ...transport.capabilities,
            codex: { ...transport.capabilities.codex, enabled: false },
        };
        const receiver = await client(new MemoryStorage(), transport);

        await expect(receiver.start()).rejects.toThrow('disabled by Happy Server');
    });

    it('refuses a v4 session when the App is below the advertised minimum', async () => {
        const transport = new FakeTransport();
        transport.capabilities = {
            ...transport.capabilities,
            codex: { ...transport.capabilities.codex, minimumHappyAppVersion: '1.12.0' },
        };
        const receiver = await client(new MemoryStorage(), transport);

        await expect(receiver.start()).rejects.toThrow('Happy App 1.12.0 or newer');
    });

    it('projects a local command immediately after its outbox write', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const applied: AppSyncV4AppliedEntity[] = [];
        const sender = await client(storage, transport, applied);

        await sender.publishEntity(command('local-command'));

        expect(applied).toMatchObject([{
            entity: { commandId: 'local-command' },
            source: 'cache',
            revision: 1,
            seq: null,
        }]);
        expect(persistence(storage).loadSession('session-1').outbox).toHaveLength(1);
    });

    it('delivers a published entity group through one projection batch', async () => {
        const storage = new MemoryStorage();
        const batches: Array<readonly AppSyncV4AppliedEntity[]> = [];
        const sender = await client(
            storage,
            new FakeTransport(),
            [],
            undefined,
            undefined,
            async (events) => { batches.push(events); },
        );

        await sender.publishEntities([
            { entity: command('batched-command-1') },
            { entity: command('batched-command-2') },
        ]);

        expect(batches).toHaveLength(1);
        expect(batches[0].map((event) => event.entity.providerId)).toEqual([
            'batched-command-1',
            'batched-command-2',
        ]);
    });

    it('hydrates an unacknowledged command from the outbox after restart', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const first = await client(storage, transport);
        await first.publishEntity(command('pending-command'));

        const hydrated: AppSyncV4AppliedEntity[] = [];
        const reopened = await client(storage, transport, hydrated);
        await reopened.hydrate();

        expect(hydrated).toMatchObject([{
            entity: { commandId: 'pending-command' },
            source: 'cache',
            revision: 1,
            seq: null,
        }]);
    });

    it('recovers a durable command when optimistic projection stops the process', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const beforeCrash = await client(storage, transport, [], async () => {
            throw new Error('projection stopped');
        });
        await expect(beforeCrash.publishEntity(command('projection-crash')))
            .rejects.toThrow('projection stopped');
        expect(persistence(storage).loadSession('session-1').outbox).toHaveLength(1);

        const recovered: AppSyncV4AppliedEntity[] = [];
        await (await client(storage, transport, recovered)).hydrate();
        expect(recovered).toMatchObject([{
            entity: { commandId: 'projection-crash' },
            source: 'cache',
            revision: 1,
        }]);
    });

    it('keeps consecutive revisions for one entity across a batch and its ACK', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const sender = await client(storage, transport);
        const batched = await sender.publishEntities([
            { entity: command('same-command') },
            { entity: { ...command('same-command'), updatedAt: 11 } },
        ]);

        expect(batched.map((mutation) => mutation.revision)).toEqual([1, 2]);
        await sender.flushOutboundOnce();
        const afterAck = await sender.publishEntity({ ...command('same-command'), updatedAt: 12 });
        expect(afterAck.revision).toBe(3);
    });

    it('keeps a command in outbox across an uncertain POST and retries the same ID', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const first = await client(storage, transport);
        const mutation = await first.publishEntity(command('command-1'));
        transport.failAfterCommit = true;
        await expect(first.flushOutboundOnce()).rejects.toThrow('network lost');

        const reopened = await client(storage, transport);
        await reopened.flushOutboundOnce();
        expect(transport.posted[1][0].mutationId).toBe(mutation.mutationId);
        expect(transport.committed.size).toBe(1);
    });

    it('stages encrypted cache before handler success and advances cursor only afterward', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        const mutation = await publisher.publishEntity(command('remote-1'));
        transport.changes = [toChange(mutation, 1)];
        const failing = await client(storage, transport, [], async () => { throw new Error('render failed'); });
        await expect(failing.pullChangesOnce()).rejects.toThrow('render failed');
        expect(failing.receiveCursor).toBe(0);
        expect(persistence(storage).loadSession('session-1').entities).toHaveLength(1);

        const applied: AppSyncV4AppliedEntity[] = [];
        const reopened = await client(storage, transport, applied);
        await reopened.hydrate();
        await reopened.pullChangesOnce();
        expect(applied.map((event) => event.source)).toEqual(['cache', 'change']);
        expect(reopened.receiveCursor).toBe(1);
    });

    it('classifies superseded changes before decryption and still consumes their sequence', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const current = {
            ...(await (await client(new MemoryStorage(), transport)).publishEntity(command('current'))),
            revision: 2,
        };
        persistence(storage).applyChanges('session-1', [toChange(current, 1)]);
        transport.changes = [
            toChange(current, 1),
            {
                ...toChange(current, 2),
                mutationId: 'stale-change',
                revision: 1,
                ciphertext: 'must-not-be-decrypted',
            },
        ];
        let decryptCount = 0;
        const crypto: AppSyncV4Crypto = {
            ...fakeCrypto,
            decryptEntity: async (aad, ciphertext) => {
                decryptCount += 1;
                return fakeCrypto.decryptEntity(aad, ciphertext);
            },
        };
        const receiver = await client(storage, transport, [], undefined, undefined, undefined, undefined, crypto);

        await receiver.pullChangesOnce();

        expect(decryptCount).toBe(0);
        expect(receiver.receiveCursor).toBe(2);
    });

    it('rejects a same-revision conflict before decrypting untrusted ciphertext', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const current = await (await client(new MemoryStorage(), transport)).publishEntity(command('current'));
        persistence(storage).applyChanges('session-1', [toChange(current, 1)]);
        transport.changes = [
            toChange(current, 1),
            {
                ...toChange(current, 2),
                mutationId: 'conflicting-change',
                ciphertext: 'conflicting-ciphertext',
            },
        ];
        let decryptCount = 0;
        const crypto: AppSyncV4Crypto = {
            ...fakeCrypto,
            decryptEntity: async (aad, ciphertext) => {
                decryptCount += 1;
                return fakeCrypto.decryptEntity(aad, ciphertext);
            },
        };
        const receiver = await client(storage, transport, [], undefined, undefined, undefined, undefined, crypto);

        await expect(receiver.pullChangesOnce()).rejects.toThrow('same revision');
        expect(decryptCount).toBe(0);
        expect(receiver.receiveCursor).toBe(1);
    });

    it('pulls 225 changes in pages when every socket invalidation is lost', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        for (let index = 0; index < 225; index += 1) {
            transport.changes.push(toChange(await publisher.publishEntity(command(`remote-${index}`)), index + 1));
        }
        const applied: AppSyncV4AppliedEntity[] = [];
        const receiver = await client(storage, transport, applied);
        await receiver.pullChangesOnce();
        expect(applied).toHaveLength(225);
        expect(receiver.receiveCursor).toBe(225);
    });

    it('rebuilds a paginated snapshot after 410 and hydrates it after restart', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        const first = await publisher.publishEntity(command('snapshot-1'));
        const second = await publisher.publishEntity(command('snapshot-2'));
        const { mutationId: _firstId, ...firstSnapshot } = first;
        const { mutationId: _secondId, ...secondSnapshot } = second;
        transport.requireSnapshot = true;
        transport.snapshots = [
            {
                entities: [{ ...firstSnapshot, updatedSeq: 1, createdAt: 100, updatedAt: 100 }],
                highWatermark: 2,
                nextCursor: 'next',
            },
            {
                entities: [{ ...secondSnapshot, updatedSeq: 2, createdAt: 101, updatedAt: 101 }],
                highWatermark: 2,
                nextCursor: null,
            },
        ];
        const applied: AppSyncV4AppliedEntity[] = [];
        const receiver = await client(storage, transport, applied);
        await receiver.pullChangesOnce();
        expect(applied.map((event) => event.source)).toEqual(['snapshot', 'snapshot']);
        expect(receiver.receiveCursor).toBe(2);

        const hydrated: AppSyncV4AppliedEntity[] = [];
        await (await client(storage, transport, hydrated)).hydrate();
        expect(hydrated.map((event) => event.source)).toEqual(['cache', 'cache']);
    });

    it('keeps the previous cache and projection when a shadow snapshot fails mid-page', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        const old = await publisher.publishEntity(command('old-command'));
        transport.changes = [toChange(old, 1)];
        let projection: CodexV4Projection = createCodexV4Projection();
        let replacementCount = 0;
        const receiver = await client(
            storage,
            transport,
            [],
            async (event) => {
                projection = applyCodexV4ProjectionUpdate(projection, event);
            },
            undefined,
            undefined,
            async (events) => {
                replacementCount += 1;
                projection = resetCodexV4Projection(projection);
                for (const event of events) {
                    projection = applyCodexV4ProjectionUpdate(projection, event);
                }
            },
        );
        await receiver.pullChangesOnce();
        expect(projection.entities['codex.command']['old-command']).toBeDefined();

        const replacement = await publisher.publishEntity(command('replacement-command'));
        const { mutationId: _mutationId, ...snapshot } = replacement;
        transport.requireSnapshot = true;
        transport.snapshots = [{
            entities: [{ ...snapshot, updatedSeq: 2, createdAt: 101, updatedAt: 101 }],
            highWatermark: 2,
            nextCursor: 'missing-page',
        }];

        await expect(receiver.pullChangesOnce()).rejects.toThrow('missing snapshot');

        expect(replacementCount).toBe(0);
        expect(projection.entities['codex.command']['old-command']).toBeDefined();
        expect(persistence(storage).loadSession('session-1')).toMatchObject({
            snapshotRequired: true,
            receiveCursor: 1,
            entities: [expect.objectContaining({ entityId: old.entityId })],
        });
    });

    it('rebuilds from snapshot when an authenticated cache entity cannot be decrypted', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        const valid = await publisher.publishEntity(command('recovered-command'));
        persistence(storage).applyChanges('session-1', [{
            ...toChange(valid, 1),
            ciphertext: 'corrupt-cache-ciphertext',
        }]);
        const { mutationId: _mutationId, ...snapshot } = valid;
        transport.snapshots = [{
            entities: [{ ...snapshot, updatedSeq: 1, createdAt: 100, updatedAt: 100 }],
            highWatermark: 1,
            nextCursor: null,
        }];
        const applied: AppSyncV4AppliedEntity[] = [];
        let resetCount = 0;
        const receiver = await client(storage, transport, applied, undefined, async () => {
            resetCount += 1;
        });

        await receiver.hydrate();

        expect(resetCount).toBe(1);
        expect(applied).toMatchObject([{
            entity: { commandId: 'recovered-command' },
            source: 'snapshot',
            revision: 1,
        }]);
        expect(receiver.receiveCursor).toBe(1);
    });

    it('removes entities omitted from a replacement snapshot projection', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        const stale = await publisher.publishEntity(command('stale-command'));
        transport.changes = [toChange(stale, 1)];

        let projection: CodexV4Projection = createCodexV4Projection();
        const receiver = await client(
            storage,
            transport,
            [],
            async (event) => {
                projection = applyCodexV4ProjectionUpdate(projection, event);
            },
            async () => {
                projection = resetCodexV4Projection(projection);
            },
        );
        await receiver.pullChangesOnce();
        expect(projection.entities['codex.command']['stale-command']).toBeDefined();

        const fresh = await publisher.publishEntity(command('fresh-command'));
        const { mutationId: _mutationId, ...snapshot } = fresh;
        transport.requireSnapshot = true;
        transport.snapshots = [{
            entities: [{ ...snapshot, updatedSeq: 1, createdAt: 101, updatedAt: 101 }],
            highWatermark: 1,
            nextCursor: null,
        }];
        await receiver.pullChangesOnce();

        expect(projection.entities['codex.command']['stale-command']).toBeUndefined();
        expect(projection.entities['codex.command']['fresh-command']).toBeDefined();
    });

    it('reprojects unacknowledged outbox entities after a snapshot reset', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        let projection: CodexV4Projection = createCodexV4Projection();
        let resetCount = 0;
        const receiver = await client(
            storage,
            transport,
            [],
            async (event) => {
                projection = applyCodexV4ProjectionUpdate(projection, event);
            },
            async () => {
                resetCount += 1;
                projection = resetCodexV4Projection(projection);
            },
        );
        await receiver.publishEntity(command('pending-command'));

        transport.requireSnapshot = true;
        transport.snapshots = [{ entities: [], highWatermark: 0, nextCursor: null }];
        await receiver.pullChangesOnce();

        expect(resetCount).toBe(1);
        expect(projection.entities['codex.command']['pending-command']).toBeDefined();
        expect(persistence(storage).loadSession('session-1').outbox).toHaveLength(1);
    });

    it('does not acknowledge an in-flight POST after stop and session cleanup', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const sender = await client(storage, transport);
        const mutation = await sender.publishEntity(command('pending-command'));
        const postStarted = new Deferred<void>();
        const postResponse = new Deferred<SyncMutationBatchResponseV4>();
        transport.postMutations = async () => {
            postStarted.resolve();
            return await postResponse.promise;
        };

        const flush = sender.flushOutboundOnce();
        await postStarted.promise;
        sender.stop();
        persistence(storage).clearSession('session-1');
        postResponse.resolve({
            acknowledgements: [{
                mutationId: mutation.mutationId,
                seq: 1,
                revision: mutation.revision,
                status: 'accepted',
            }],
        });
        await flush;

        expect(storage.getAllKeys().filter((key) => key.startsWith('sync-v4:session:'))).toEqual([]);
    });

    it('does not stage changes or advance the cursor after stop and session cleanup', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        const mutation = await publisher.publishEntity(command('late-change'));
        const changeStarted = new Deferred<void>();
        const changeResponse = new Deferred<ReturnType<typeof SyncChangesResponseV4Schema.parse>>();
        transport.getChanges = async () => {
            changeStarted.resolve();
            return await changeResponse.promise;
        };
        const applied: AppSyncV4AppliedEntity[] = [];
        const receiver = await client(storage, transport, applied);

        const pull = receiver.pullChangesOnce();
        await changeStarted.promise;
        receiver.stop();
        persistence(storage).clearSession('session-1');
        changeResponse.resolve(SyncChangesResponseV4Schema.parse({
            changes: [toChange(mutation, 1)],
            hasMore: false,
            highWatermark: 1,
        }));
        await pull;

        expect(applied).toEqual([]);
        expect(storage.getAllKeys().filter((key) => key.startsWith('sync-v4:session:'))).toEqual([]);
    });

    it('does not finish an in-flight snapshot after stop and session cleanup', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        const mutation = await publisher.publishEntity(command('late-snapshot'));
        const { mutationId: _mutationId, ...snapshot } = mutation;
        transport.requireSnapshot = true;
        const snapshotStarted = new Deferred<void>();
        const snapshotResponse = new Deferred<SyncSnapshotResponseV4>();
        transport.getSnapshot = async () => {
            snapshotStarted.resolve();
            return await snapshotResponse.promise;
        };
        const applied: AppSyncV4AppliedEntity[] = [];
        let resetCount = 0;
        const receiver = await client(storage, transport, applied, undefined, async () => {
            resetCount += 1;
        });

        const pull = receiver.pullChangesOnce();
        await snapshotStarted.promise;
        receiver.stop();
        persistence(storage).clearSession('session-1');
        snapshotResponse.resolve(SyncSnapshotResponseV4Schema.parse({
            entities: [{ ...snapshot, updatedSeq: 1, createdAt: 100, updatedAt: 100 }],
            highWatermark: 1,
            nextCursor: null,
        }));
        await pull;

        expect(resetCount).toBe(0);
        expect(applied).toEqual([]);
        expect(storage.getAllKeys().filter((key) => key.startsWith('sync-v4:session:'))).toEqual([]);
    });
});
