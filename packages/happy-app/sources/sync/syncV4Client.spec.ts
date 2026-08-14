import {
    SyncChangesResponseV4Schema,
    MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE,
    SyncSnapshotResponseV4Schema,
    type CodexCommandEntityV4,
    type CodexEntityV4,
    type SyncChangeV4,
    type SyncMutationBatchResponseV4,
    type SyncMutationV4,
    type SyncSnapshotResponseV4,
    type SyncV4Capabilities,
    type SyncV4Aad,
    type SyncV4DiagnosticInput,
    type SyncV4DiagnosticSink,
} from '@slopus/happy-wire';
import { describe, expect, it, vi } from 'vitest';
import {
    AppSyncV4Client,
    AppSyncV4MutationPersistedError,
    AppSyncV4SessionReadOnlyError,
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
import type { AppSyncV4DiagnosticStatsProvider } from './syncV4Diagnostics';

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

class FaultInjectingStorage extends MemoryStorage {
    private nextSetFailure: ((key: string) => boolean) | null = null;

    failNextSetMatching(predicate: (key: string) => boolean): void {
        this.nextSetFailure = predicate;
    }

    override set(key: string, value: string | number | boolean): void {
        if (this.nextSetFailure?.(key)) {
            this.nextSetFailure = null;
            throw new Error('prompt-reasoning-tool-output-storage-secret');
        }
        super.set(key, value);
    }
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

const happyAgentCompatibility = { minimumHappyAgentVersion: '0.1.3' } as const;

class FakeTransport implements AppSyncV4Transport {
    readonly posted: SyncMutationV4[][] = [];
    readonly committed = new Map<string, number>();
    changes: SyncChangeV4[] = [];
    snapshots: SyncSnapshotResponseV4[] = [];
    readonly snapshotLimits: number[] = [];
    requireSnapshot = false;
    failAfterCommit = false;
    capabilities: SyncV4Capabilities = {
        codex: {
            enabled: true,
            protocolVersion: 4,
            minimumHappyCliVersion: '1.4.7',
            minimumHappyAppVersion: '1.11.12',
            ...happyAgentCompatibility,
            minimumCodexCliVersion: '0.145.0',
        },
    };

    async getCapabilities(_traceId?: string): Promise<SyncV4Capabilities> {
        return this.capabilities;
    }

    async postMutations(
        _sessionId: string,
        mutations: SyncMutationV4[],
        _traceId?: string,
    ): Promise<SyncMutationBatchResponseV4> {
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

    async getChanges(
        _sessionId: string,
        afterSeq: number,
        limit: number,
        _traceId?: string,
    ) {
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

    async getSnapshot(
        _sessionId: string,
        _cursor: string | null,
        limit: number,
        _traceId?: string,
    ): Promise<SyncSnapshotResponseV4> {
        this.snapshotLimits.push(limit);
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
    diagnostics?: SyncV4DiagnosticSink,
    generateTraceId?: () => string,
    diagnosticStats?: AppSyncV4DiagnosticStatsProvider,
    canSendOutbound?: () => boolean,
): Promise<AppSyncV4Client> {
    return AppSyncV4Client.create({
        sessionId: 'session-1',
        sessionKey: new Uint8Array(32),
        appVersion: '1.11.12',
        persistence: persistence(storage),
        transport,
        crypto,
        generateMutationId: () => `00000000-0000-4000-8000-${String(++mutationCounter).padStart(12, '0')}`,
        generateTraceId,
        diagnostics,
        diagnosticStats,
        transportSecurity: 'insecureHttp',
        canSendOutbound,
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
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const transport = new FakeTransport();
        transport.capabilities = {
            ...transport.capabilities,
            codex: { ...transport.capabilities.codex, enabled: false },
        };
        const receiver = await client(
            new MemoryStorage(),
            transport,
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            { record: (input) => diagnostics.push(input) },
            () => '00000000000000000000000000000001',
        );

        await expect(receiver.start()).rejects.toThrow('disabled by Happy Server');
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: 'transport',
            phase: 'failed',
            transportOperation: 'capabilities',
            traceId: '00000000000000000000000000000001',
            state: 'stopped',
            errorKind: 'protocol',
            featureEnabled: false,
            transportSecurity: 'insecureHttp',
        }));
        expect(diagnostics).not.toContainEqual(expect.objectContaining({
            event: 'transport',
            phase: 'completed',
            transportOperation: 'capabilities',
            traceId: '00000000000000000000000000000001',
        }));
    });

    it('hydrates once without installing a periodic poll in on-demand mode', async () => {
        vi.useFakeTimers();
        try {
            const storage = new MemoryStorage();
            const transport = new FakeTransport();
            const getChanges = vi.spyOn(transport, 'getChanges');
            let failNextPull = false;
            getChanges.mockImplementation(async (_sessionId, afterSeq) => {
                if (failNextPull) {
                    failNextPull = false;
                    throw new Error('offline');
                }
                return SyncChangesResponseV4Schema.parse({
                    changes: [],
                    hasMore: false,
                    highWatermark: afterSeq,
                });
            });
            const receiver = await AppSyncV4Client.create({
                sessionId: 'session-1',
                sessionKey: new Uint8Array(32),
                appVersion: '1.11.28',
                persistence: persistence(storage),
                transport,
                crypto: fakeCrypto,
                pollIntervalMs: null,
                onEntity: async () => undefined,
                onSnapshotReset: async () => undefined,
            });

            await receiver.start();
            expect(getChanges).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(20_000);
            expect(getChanges).toHaveBeenCalledTimes(1);

            failNextPull = true;
            receiver.invalidate();
            await Promise.resolve();
            await Promise.resolve();
            expect(getChanges).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(getChanges).toHaveBeenCalledTimes(2);

            receiver.invalidate();
            await Promise.resolve();
            await Promise.resolve();
            expect(getChanges).toHaveBeenCalledTimes(3);
            receiver.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps configured periodic polling for continuous mode', async () => {
        vi.useFakeTimers();
        try {
            const storage = new MemoryStorage();
            const transport = new FakeTransport();
            const getChanges = vi.spyOn(transport, 'getChanges');
            const receiver = await AppSyncV4Client.create({
                sessionId: 'session-1',
                sessionKey: new Uint8Array(32),
                appVersion: '1.11.28',
                persistence: persistence(storage),
                transport,
                crypto: fakeCrypto,
                pollIntervalMs: 5_000,
                onEntity: async () => undefined,
                onSnapshotReset: async () => undefined,
            });

            await receiver.start();
            expect(getChanges).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(getChanges).toHaveBeenCalledTimes(2);
            receiver.stop();
        } finally {
            vi.useRealTimers();
        }
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

    it('writes degraded terminal counters when the persistent diagnostic sink lost data', async () => {
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const receiver = await client(
            new MemoryStorage(),
            new FakeTransport(),
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            { record: (input) => diagnostics.push(input) },
            undefined,
            () => ({
                count: 2_000,
                droppedRecords: 7,
                invalidRecords: 2,
                writeFailures: 1,
                listenerFailures: 3,
            }),
        );

        receiver.stop();

        expect(diagnostics).toContainEqual(expect.objectContaining({
            component: 'app.sync',
            event: 'lifecycle',
            phase: 'failed',
            state: 'degraded',
            count: 2_000,
            dropped: 7,
            invalid: 2,
            writeFailures: 1,
            listenerFailures: 3,
        }));
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

    it('rejects new entities before persisting when outbound sync is disabled', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const applied: AppSyncV4AppliedEntity[] = [];
        const sender = await client(
            storage,
            transport,
            applied,
            undefined,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            undefined,
            undefined,
            undefined,
            () => false,
        );

        await expect(sender.publishEntity(command('read-only-command')))
            .rejects.toBeInstanceOf(AppSyncV4SessionReadOnlyError);
        expect(persistence(storage).loadSession('session-1').outbox).toHaveLength(0);
        expect(applied).toHaveLength(0);
        expect(transport.posted).toHaveLength(0);
    });

    it('hydrates and pulls history while preserving a frozen durable outbox', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const writer = await client(storage, transport);
        await writer.publishEntity(command('pending-before-delete'));
        const remotePublisher = await client(new MemoryStorage(), transport);
        const remoteMutation = await remotePublisher.publishEntity(command('remote-history'));
        transport.changes = [toChange(remoteMutation, 1)];

        const applied: AppSyncV4AppliedEntity[] = [];
        const receiver = await client(
            storage,
            transport,
            applied,
            undefined,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            undefined,
            undefined,
            undefined,
            () => false,
        );
        await receiver.start();

        expect(transport.posted).toHaveLength(0);
        expect(persistence(storage).loadSession('session-1').outbox).toHaveLength(1);
        expect(applied.map((event) => event.entity.providerId)).toEqual([
            'pending-before-delete',
            'remote-history',
        ]);
        expect(receiver.receiveCursor).toBe(1);
        receiver.stop();
    });

    it('rebuilds a snapshot when the cursor survived but the entity cache did not', async () => {
        const storage = new MemoryStorage();
        const localPersistence = persistence(storage);
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        const remoteMutation = await publisher.publishEntity(command('snapshot-recovered'));
        localPersistence.applyChanges('session-1', [toChange(remoteMutation, 1)]);
        for (const key of storage.getAllKeys()) {
            if (key.includes(':entity:')) storage.delete(key);
        }
        const { mutationId: _mutationId, ...snapshotEntity } = remoteMutation;
        transport.snapshots = [{
            entities: [{
                ...snapshotEntity,
                updatedSeq: 1,
                createdAt: 101,
                updatedAt: 101,
            }],
            highWatermark: 1,
            nextCursor: null,
        }];
        const applied: AppSyncV4AppliedEntity[] = [];
        const receiver = await client(storage, transport, applied);

        await receiver.start();

        expect(applied).toContainEqual(expect.objectContaining({
            entity: expect.objectContaining({ providerId: 'snapshot-recovered' }),
            source: 'snapshot',
        }));
        expect(persistence(storage).loadSession('session-1')).toMatchObject({
            receiveCursor: 1,
            snapshotRequired: false,
            entities: [expect.objectContaining({ entityId: remoteMutation.entityId })],
        });
        receiver.stop();
    });

    it('keeps pulling when the server reports a session became read-only', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const sender = await client(storage, transport);
        await sender.publishEntity(command('raced-with-delete'));
        transport.postMutations = async () => {
            throw new AppSyncV4SessionReadOnlyError();
        };

        await expect(sender.start()).resolves.toBeUndefined();
        expect(persistence(storage).loadSession('session-1').outbox).toHaveLength(1);
        sender.stop();
    });

    it('records a protocol failure when a successful POST returns mismatched acknowledgements', async () => {
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const transport = new FakeTransport();
        transport.postMutations = async (_sessionId, mutations) => ({
            acknowledgements: mutations.map((mutation, index) => ({
                mutationId: `wrong-${index}`,
                seq: index + 1,
                revision: mutation.revision,
                status: 'accepted' as const,
            })),
        });
        const sender = await client(
            new MemoryStorage(),
            transport,
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            { record: (input) => diagnostics.push(input) },
            () => '00000000000000000000000000000001',
        );
        await sender.publishEntity(command('bad-ack'));

        await expect(sender.flushOutboundOnce()).rejects.toThrow('acknowledgement');
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: 'ack',
            phase: 'failed',
            traceId: '00000000000000000000000000000001',
            errorKind: 'protocol',
        }));
        expect(diagnostics).not.toContainEqual(expect.objectContaining({
            event: 'transport',
            phase: 'completed',
            traceId: '00000000000000000000000000000001',
        }));
    });

    it('records a protocol failure when changes contain a sequence gap', async () => {
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const transport = new FakeTransport();
        transport.getChanges = async () => SyncChangesResponseV4Schema.parse({
            changes: [],
            hasMore: true,
            highWatermark: 1,
        });
        const receiver = await client(
            new MemoryStorage(),
            transport,
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            { record: (input) => diagnostics.push(input) },
            () => '00000000000000000000000000000002',
        );

        await expect(receiver.pullChangesOnce()).rejects.toThrow('sequence gap');
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: 'changes',
            phase: 'failed',
            traceId: '00000000000000000000000000000002',
            errorKind: 'protocol',
        }));
        expect(diagnostics).not.toContainEqual(expect.objectContaining({
            event: 'transport',
            phase: 'completed',
            traceId: '00000000000000000000000000000002',
        }));
    });

    it('records decryption failure after transport success without persisting error text', async () => {
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        const mutation = await publisher.publishEntity(command('encrypted-change'));
        transport.changes = [toChange(mutation, 1)];
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const secret = 'prompt-reasoning-tool-output-secret';
        const crypto: AppSyncV4Crypto = {
            ...fakeCrypto,
            decryptEntity: async () => {
                const error = new Error(secret);
                error.name = 'SyncV4DecryptionError';
                throw error;
            },
        };
        const receiver = await client(
            new MemoryStorage(),
            transport,
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            crypto,
            { record: (input) => diagnostics.push(input) },
            () => '00000000000000000000000000000003',
        );

        await expect(receiver.pullChangesOnce()).rejects.toThrow(secret);
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: 'transport',
            phase: 'completed',
            transportOperation: 'changes',
            traceId: '00000000000000000000000000000003',
        }));
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: 'changes',
            phase: 'failed',
            transportOperation: 'changes',
            traceId: '00000000000000000000000000000003',
            errorKind: 'crypto',
        }));
        expect(JSON.stringify(diagnostics)).not.toContain(secret);
    });

    it('rejects non-canonical entities before encryption or outbox persistence', async () => {
        const storage = new MemoryStorage();
        const encryptEntity = vi.fn(fakeCrypto.encryptEntity);
        const sender = await client(
            storage,
            new FakeTransport(),
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            { ...fakeCrypto, encryptEntity },
        );
        const secret = 'prompt-reasoning-tool-output-secret';

        await expect(sender.publishEntity({
            ...command('invalid-command'),
            unexpectedPayload: secret,
        } as never)).rejects.toThrow();

        expect(encryptEntity).not.toHaveBeenCalled();
        expect(persistence(storage).loadSession('session-1').outbox).toEqual([]);
        expect(JSON.stringify([...storage.values.values()])).not.toContain(secret);
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
            .rejects.toBeInstanceOf(AppSyncV4MutationPersistedError);
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

    it('records storage failure when staging a change and does not project or advance', async () => {
        const storage = new FaultInjectingStorage();
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        const mutation = await publisher.publishEntity(command('stage-storage-failure'));
        transport.changes = [toChange(mutation, 1)];
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const projection = vi.fn(async () => undefined);
        const receiver = await client(
            storage,
            transport,
            [],
            projection,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            { record: (input) => diagnostics.push(input) },
            () => '00000000000000000000000000000011',
        );
        storage.failNextSetMatching((key) => key.includes(':entity:'));

        await expect(receiver.pullChangesOnce())
            .rejects.toThrow('prompt-reasoning-tool-output-storage-secret');

        expect(projection).not.toHaveBeenCalled();
        expect(receiver.receiveCursor).toBe(0);
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: 'changes',
            phase: 'failed',
            traceId: '00000000000000000000000000000011',
            errorKind: 'storage',
        }));
        expect(JSON.stringify(diagnostics)).not.toContain('prompt-reasoning-tool-output-storage-secret');
    });

    it('records storage failure when committing a changes cursor and safely replays', async () => {
        const storage = new FaultInjectingStorage();
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        const mutation = await publisher.publishEntity(command('cursor-storage-failure'));
        transport.changes = [toChange(mutation, 1)];
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const projected: AppSyncV4AppliedEntity[] = [];
        const receiver = await client(
            storage,
            transport,
            projected,
            undefined,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            { record: (input) => diagnostics.push(input) },
            () => '00000000000000000000000000000012',
        );
        storage.failNextSetMatching((key) => key.endsWith(':cursor'));

        await expect(receiver.pullChangesOnce())
            .rejects.toThrow('prompt-reasoning-tool-output-storage-secret');

        expect(projected).toHaveLength(1);
        expect(receiver.receiveCursor).toBe(0);
        expect(persistence(storage).loadSession('session-1').entities).toHaveLength(1);
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: 'cursor',
            phase: 'failed',
            traceId: '00000000000000000000000000000012',
            errorKind: 'storage',
        }));
        expect(JSON.stringify(diagnostics)).not.toContain('prompt-reasoning-tool-output-storage-secret');

        await receiver.pullChangesOnce();
        expect(projected).toHaveLength(2);
        expect(receiver.receiveCursor).toBe(1);
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
    }, 15_000);

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
        expect(transport.snapshotLimits).toEqual([
            MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE,
            MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE,
        ]);

        const hydrated: AppSyncV4AppliedEntity[] = [];
        await (await client(storage, transport, hydrated)).hydrate();
        expect(hydrated.map((event) => event.source)).toEqual(['cache', 'cache']);
    });

    it('rejects duplicate entities across snapshot pages before projection or cursor commit', async () => {
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        const mutation = await publisher.publishEntity(command('duplicate-snapshot-command'));
        const { mutationId: _mutationId, ...snapshot } = mutation;
        transport.requireSnapshot = true;
        transport.snapshots = [
            {
                entities: [{ ...snapshot, updatedSeq: 1, createdAt: 100, updatedAt: 100 }],
                highWatermark: 2,
                nextCursor: 'page-2',
            },
            {
                entities: [{ ...snapshot, updatedSeq: 1, createdAt: 100, updatedAt: 100 }],
                highWatermark: 2,
                nextCursor: null,
            },
        ];
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const replace = vi.fn(async () => undefined);
        const traceIds = [
            '00000000000000000000000000000004',
            '00000000000000000000000000000005',
            '00000000000000000000000000000006',
        ];
        const receiver = await client(
            new MemoryStorage(),
            transport,
            [],
            undefined,
            undefined,
            undefined,
            replace,
            fakeCrypto,
            { record: (input) => diagnostics.push(input) },
            () => traceIds.shift()!,
        );

        await expect(receiver.pullChangesOnce()).rejects.toThrow('repeated an entity');
        expect(replace).not.toHaveBeenCalled();
        expect(receiver.receiveCursor).toBe(0);
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: 'snapshot',
            phase: 'failed',
            traceId: '00000000000000000000000000000006',
            page: 1,
            errorKind: 'protocol',
        }));
        expect(diagnostics).not.toContainEqual(expect.objectContaining({
            event: 'transport',
            phase: 'completed',
            traceId: '00000000000000000000000000000006',
        }));
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

    it('records storage failure when finishing a snapshot without committing its cursor', async () => {
        const storage = new FaultInjectingStorage();
        const transport = new FakeTransport();
        const publisher = await client(new MemoryStorage(), transport);
        const mutation = await publisher.publishEntity(command('snapshot-finish-storage-failure'));
        const { mutationId: _mutationId, ...snapshot } = mutation;
        transport.requireSnapshot = true;
        transport.snapshots = [{
            entities: [{ ...snapshot, updatedSeq: 1, createdAt: 100, updatedAt: 100 }],
            highWatermark: 1,
            nextCursor: null,
        }];
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const replace = vi.fn(async () => undefined);
        const traceIds = [
            '00000000000000000000000000000013',
            '00000000000000000000000000000014',
        ];
        const receiver = await client(
            storage,
            transport,
            [],
            undefined,
            undefined,
            undefined,
            replace,
            fakeCrypto,
            { record: (input) => diagnostics.push(input) },
            () => traceIds.shift()!,
        );
        storage.failNextSetMatching((key) => key.endsWith(':cursor'));

        await expect(receiver.pullChangesOnce())
            .rejects.toThrow('prompt-reasoning-tool-output-storage-secret');

        expect(replace).toHaveBeenCalledOnce();
        expect(receiver.receiveCursor).toBe(0);
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: 'cursor',
            phase: 'failed',
            highWatermark: 1,
            errorKind: 'storage',
        }));
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: 'snapshot',
            phase: 'failed',
            errorKind: 'storage',
        }));
        expect(JSON.stringify(diagnostics)).not.toContain('prompt-reasoning-tool-output-storage-secret');
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

    it('keeps a publish that becomes durable while a snapshot replacement is being prepared', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const replayStarted = new Deferred<void>();
        const resumeReplay = new Deferred<void>();
        let blockInitialReplay = true;
        const crypto: AppSyncV4Crypto = {
            ...fakeCrypto,
            decryptEntity: async (aad, ciphertext) => {
                const entity = await fakeCrypto.decryptEntity(aad, ciphertext);
                if (blockInitialReplay && entity.providerId === 'pending-before-snapshot') {
                    blockInitialReplay = false;
                    replayStarted.resolve();
                    await resumeReplay.promise;
                }
                return entity;
            },
        };
        let projection: CodexV4Projection = createCodexV4Projection();
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
                projection = resetCodexV4Projection(projection);
                for (const event of events) {
                    projection = applyCodexV4ProjectionUpdate(projection, event);
                }
            },
            crypto,
        );
        await receiver.publishEntity(command('pending-before-snapshot'));
        transport.requireSnapshot = true;
        transport.snapshots = [{ entities: [], highWatermark: 0, nextCursor: null }];

        const snapshot = receiver.pullChangesOnce();
        await replayStarted.promise;
        await receiver.publishEntity(command('published-during-snapshot'));
        expect(projection.entities['codex.command']['published-during-snapshot']).toBeDefined();
        resumeReplay.resolve();
        await snapshot;

        expect(projection.entities['codex.command']['pending-before-snapshot']).toBeDefined();
        expect(projection.entities['codex.command']['published-during-snapshot']).toBeDefined();
        expect(persistence(storage).loadSession('session-1').outbox).toHaveLength(2);
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

    it('does not send a second outbound batch when the account fence closes during the first POST', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        let outboundAllowed = true;
        const sender = await client(
            storage,
            transport,
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            undefined,
            undefined,
            undefined,
            () => outboundAllowed,
        );
        for (let index = 0; index < 101; index += 1) {
            await sender.publishEntity(command(`queued-command-${index}`));
        }
        const postStarted = new Deferred<void>();
        const postResponse = new Deferred<SyncMutationBatchResponseV4>();
        transport.postMutations = async (_sessionId, mutations) => {
            transport.posted.push(mutations);
            postStarted.resolve();
            return await postResponse.promise;
        };

        const flush = sender.flushOutboundOnce();
        await postStarted.promise;
        outboundAllowed = false;
        postResponse.resolve({
            acknowledgements: transport.posted[0].map((mutation, index) => ({
                mutationId: mutation.mutationId,
                seq: index + 1,
                revision: mutation.revision,
                status: 'accepted' as const,
            })),
        });
        await flush;

        expect(transport.posted).toHaveLength(1);
        expect(transport.posted[0]).toHaveLength(100);
        expect(persistence(storage).loadSession('session-1').outbox).toHaveLength(1);
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

    it('samples healthy empty polls while preserving per-request trace IDs', async () => {
        const records: SyncV4DiagnosticInput[] = [];
        const traceIds = ['00000000000000000000000000000001', '00000000000000000000000000000002'];
        const seenTraceIds: Array<string | undefined> = [];
        const transport = new FakeTransport();
        transport.getChanges = async (_sessionId, afterSeq, _limit, traceId) => {
            seenTraceIds.push(traceId);
            return SyncChangesResponseV4Schema.parse({
                changes: [],
                hasMore: false,
                highWatermark: afterSeq,
            });
        };
        const receiver = await client(
            new MemoryStorage(),
            transport,
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            { record: (input) => records.push(input) },
            () => traceIds.shift()!,
        );

        await receiver.pullChangesOnce();
        await receiver.pullChangesOnce();

        expect(seenTraceIds).toEqual([
            '00000000000000000000000000000001',
            '00000000000000000000000000000002',
        ]);
        expect(records.filter((record) => (
            record.event === 'transport'
            && record.transportOperation === 'changes'
            && record.phase === 'completed'
        ))).toHaveLength(1);
        expect(records.find((record) => (
            record.event === 'transport'
            && record.transportOperation === 'changes'
            && record.phase === 'completed'
        ))).not.toHaveProperty('dropped');
        receiver.stop();
        expect(records).toContainEqual(expect.objectContaining({
            event: 'changes',
            phase: 'completed',
            source: 'poll',
            suppressed: 1,
            transportSecurity: 'insecureHttp',
        }));
        expect(records).toContainEqual(expect.objectContaining({
            event: 'lifecycle',
            phase: 'completed',
            state: 'stopped',
            suppressed: 1,
            featureEnabled: true,
            transportSecurity: 'insecureHttp',
        }));
    });

    it('records projection batches and classifies failures without persisting error text', async () => {
        const records: SyncV4DiagnosticInput[] = [];
        const diagnostics: SyncV4DiagnosticSink = {
            record: (input) => records.push(input),
        };
        const sender = await client(
            new MemoryStorage(),
            new FakeTransport(),
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            diagnostics,
        );
        await sender.publishEntity(command('diagnostic-command'));

        const secret = 'prompt-reasoning-tool-output-secret';
        const failingTransport = new FakeTransport();
        failingTransport.getChanges = async () => {
            throw Object.assign(new Error(secret), { code: 'ECONNRESET' });
        };
        const receiver = await client(
            new MemoryStorage(),
            failingTransport,
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            diagnostics,
            () => '00000000000000000000000000000003',
        );
        await expect(receiver.pullChangesOnce()).rejects.toThrow(secret);

        expect(records).toContainEqual(expect.objectContaining({
            component: 'app.projection',
            event: 'projection',
            phase: 'applied',
            count: 1,
        }));
        expect(records).toContainEqual(expect.objectContaining({
            component: 'app.sync',
            event: 'transport',
            phase: 'failed',
            errorKind: 'network',
        }));
        expect(JSON.stringify(records)).not.toContain(secret);
    });

    it('classifies projection callback failures independently from storage', async () => {
        const records: SyncV4DiagnosticInput[] = [];
        const transport = new FakeTransport();
        const entity = command('projection-failure');
        transport.changes = [{
            mutationId: '00000000-0000-4000-8000-000000000099',
            producerId: '00000000-0000-4000-8000-000000000098',
            entityId: 'opaque:codex.command:projection-failure',
            entityType: entity.entityType,
            revision: 1,
            op: 'upsert',
            ciphertext: JSON.stringify(entity),
            seq: 1,
            createdAt: 100,
        }];
        const secret = 'projection-prompt-reasoning-tool-output-secret';
        const receiver = await client(
            new MemoryStorage(),
            transport,
            [],
            undefined,
            undefined,
            async () => {
                throw new Error(secret);
            },
            undefined,
            fakeCrypto,
            { record: (input) => records.push(input) },
            () => '00000000000000000000000000000004',
        );

        await expect(receiver.pullChangesOnce()).rejects.toThrow(secret);

        expect(records).toContainEqual(expect.objectContaining({
            component: 'app.projection',
            event: 'projection',
            phase: 'failed',
            errorKind: 'projection',
        }));
        expect(JSON.stringify(records)).not.toContain(secret);
    });

    it('keeps synchronization running when the diagnostic sink fails', async () => {
        const storage = new MemoryStorage();
        const transport = new FakeTransport();
        const receiver = await client(
            storage,
            transport,
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            {
                record: () => {
                    throw new Error('diagnostic sink unavailable');
                },
            },
            () => '00000000000000000000000000000001',
        );

        await expect(receiver.start()).resolves.toBeUndefined();
        await expect(receiver.publishEntity(command('sink-failure'))).resolves.toBeDefined();
        await expect(receiver.flushOutboundOnce()).resolves.toBeUndefined();
        receiver.stop();
    });

    it('rejects malformed generated trace IDs before calling the transport', async () => {
        const transport = new FakeTransport();
        const getCapabilities = vi.spyOn(transport, 'getCapabilities');
        const receiver = await client(
            new MemoryStorage(),
            transport,
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            fakeCrypto,
            undefined,
            () => 'prompt-reasoning-secret',
        );

        await expect(receiver.start()).rejects.toThrow('128-bit lowercase hex');
        expect(getCapabilities).not.toHaveBeenCalled();
    });
});
