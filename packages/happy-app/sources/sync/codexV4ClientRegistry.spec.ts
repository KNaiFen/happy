import { describe, expect, it, vi } from 'vitest';
import {
    CodexV4ClientRegistry,
    codexV4PollIntervalMsForLifecycle,
    isCodexV4SyncActive,
    isCodexV4SyncEligible,
    type CodexV4RegistryClient,
} from './codexV4ClientRegistry';
import { AppSyncV4Client, type AppSyncV4Crypto } from './syncV4Client';
import { AppSyncV4DiagnosticStore, type SyncV4DiagnosticStorage } from './syncV4Diagnostics';
import { SyncV4Persistence, type SyncV4KeyValueStorage } from './syncV4Persistence';

interface TestEvent {
    value: string;
}

class Deferred<T> {
    readonly promise: Promise<T>;
    resolve!: (value: T) => void;
    reject!: (error: unknown) => void;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}

class TestClient implements CodexV4RegistryClient {
    readonly diagnosticSessionId = 'opaque_session_123';
    readonly started = new Deferred<void>();
    stopCount = 0;
    invalidations: Array<number | undefined> = [];

    start(): Promise<void> {
        return this.started.promise;
    }

    stop(options?: { silent?: boolean }): void {
        this.stopCount += 1;
        this.lastStopWasSilent = options?.silent === true;
    }

    lastStopWasSilent = false;

    invalidate(highWatermark?: number): void {
        this.invalidations.push(highWatermark);
    }
}

class SharedStorage implements SyncV4KeyValueStorage, SyncV4DiagnosticStorage {
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

const session = { sessionId: 'session-1', sessionKey: new Uint8Array(32) };

describe('isCodexV4SyncEligible', () => {
    it('requires both the Codex flavor and the encrypted v4 cutover marker', () => {
        expect(isCodexV4SyncEligible({ flavor: 'codex', codexSyncVersion: 4 })).toBe(true);
        expect(isCodexV4SyncEligible({ flavor: 'codex' })).toBe(false);
        expect(isCodexV4SyncEligible({ flavor: 'claude', codexSyncVersion: 4 })).toBe(false);
        expect(isCodexV4SyncEligible({ flavor: null, codexSyncVersion: 4 })).toBe(false);
        expect(isCodexV4SyncEligible(undefined)).toBe(false);
    });
});

describe('isCodexV4SyncActive', () => {
    it('falls back to v3 as soon as the cutover marker is removed', () => {
        const activatedProjection = { activated: true };

        expect(isCodexV4SyncActive(
            { flavor: 'codex', codexSyncVersion: 4 },
            activatedProjection,
        )).toBe(true);
        expect(isCodexV4SyncActive(
            { flavor: 'codex' },
            activatedProjection,
        )).toBe(false);
    });

    it('does not switch before the local v4 projection is ready', () => {
        expect(isCodexV4SyncActive(
            { flavor: 'codex', codexSyncVersion: 4 },
            { activated: false },
        )).toBe(false);
    });
});

describe('codexV4PollIntervalMsForLifecycle', () => {
    it('polls only active, unarchived sessions continuously', () => {
        expect(codexV4PollIntervalMsForLifecycle({ active: true, archivedAt: null })).toBe(5_000);
        expect(codexV4PollIntervalMsForLifecycle({ active: true })).toBe(5_000);
        expect(codexV4PollIntervalMsForLifecycle({ active: false, archivedAt: null })).toBeNull();
        expect(codexV4PollIntervalMsForLifecycle({ active: true, archivedAt: 100 })).toBeNull();
    });
});

describe('CodexV4ClientRegistry', () => {
    it('stops every client and clears queued on-demand starts', async () => {
        const createdSessionIds: string[] = [];
        const clients = new Map<string, TestClient>();
        const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
            createClient: async (options) => {
                createdSessionIds.push(options.sessionId);
                const client = new TestClient();
                clients.set(options.sessionId, client);
                return client;
            },
            isEligible: () => true,
            onEntity: async () => undefined,
            onSnapshotReset: async () => undefined,
        });

        registry.invalidate('dormant-session');
        registry.reconcile([session]);
        await Promise.resolve();

        const startingClient = clients.get(session.sessionId)!;
        expect(registry.hasStartingClient(session.sessionId)).toBe(true);
        registry.stopAll();

        startingClient.started.resolve();
        await startingClient.started.promise;
        await Promise.resolve();
        registry.reconcile([{
            sessionId: 'dormant-session',
            sessionKey: new Uint8Array(32),
            pollIntervalMs: null,
        }]);
        await Promise.resolve();

        expect(startingClient.stopCount).toBe(1);
        expect(registry.hasClient(session.sessionId)).toBe(false);
        expect(registry.hasStartingClient(session.sessionId)).toBe(false);
        expect(createdSessionIds).toEqual([session.sessionId]);
        registry.stopAll();
    });

    it('silently disposes a client that finishes creating after account shutdown', async () => {
        const created = new Deferred<TestClient>();
        const diagnostics: unknown[] = [];
        let factoryKey: Uint8Array | null = null;
        const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
            createClient: async (options) => {
                factoryKey = options.sessionKey;
                return created.promise;
            },
            isEligible: () => true,
            onEntity: async () => undefined,
            onSnapshotReset: async () => undefined,
            diagnostics: { record: (input) => diagnostics.push(input) },
        });

        registry.reconcile([session]);
        await Promise.resolve();
        registry.stopAll({ silent: true });
        expect(factoryKey).toEqual(new Uint8Array(32));
        const client = new TestClient();
        created.resolve(client);
        await Promise.resolve();
        await Promise.resolve();

        expect(client.stopCount).toBe(1);
        expect(client.lastStopWasSilent).toBe(true);
        expect(factoryKey).toEqual(new Uint8Array(32));
        expect(diagnostics).not.toContainEqual(expect.objectContaining({
            component: 'app.sync',
            event: 'lifecycle',
            state: 'stopped',
        }));
    });

    it('does not repopulate real v4 persistence or diagnostics after silent shutdown', async () => {
        const created = new Deferred<void>();
        const storage = new SharedStorage();
        const persistence = new SyncV4Persistence(storage, () => '00000000-0000-4000-8000-000000000001');
        const diagnostics = new AppSyncV4DiagnosticStore(storage, 4, () => 100);
        const dispose = vi.fn();
        const crypto: AppSyncV4Crypto = {
            opaqueEntityId: async () => 'opaque-session',
            encryptEntity: async () => 'ciphertext',
            decryptEntity: async () => { throw new Error('unused'); },
            dispose,
        };
        const registry = new CodexV4ClientRegistry<AppSyncV4Client, TestEvent>({
            createClient: async (options) => {
                await created.promise;
                return AppSyncV4Client.create({
                    sessionId: options.sessionId,
                    sessionKey: options.sessionKey,
                    appVersion: '1.11.12',
                    persistence,
                    transport: {} as never,
                    crypto,
                    onEntity: async () => undefined,
                    onSnapshotReset: async () => undefined,
                });
            },
            isEligible: () => true,
            onEntity: async () => undefined,
            onSnapshotReset: async () => undefined,
            diagnostics,
        });

        registry.reconcile([session]);
        await Promise.resolve();
        registry.stopAll({ silent: true });

        persistence.loadProducerId();
        diagnostics.record({
            level: 'info',
            component: 'app.sync',
            event: 'lifecycle',
            phase: 'started',
            state: 'starting',
        });
        persistence.clearAll();
        diagnostics.clear();

        created.resolve();
        await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));

        expect(storage.getAllKeys().filter((key) => key.startsWith('sync-v4:'))).toEqual([]);
        expect(storage.getAllKeys().filter((key) => key.startsWith('sync-v4-diagnostics:'))).toEqual([]);
    });

    it('keeps 150 dormant sessions uninstantiated and wakes only the invalidated target', async () => {
        const clients = new Map<string, TestClient>();
        const createdSessionIds: string[] = [];
        const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
            createClient: async (options) => {
                createdSessionIds.push(options.sessionId);
                const client = new TestClient();
                clients.set(options.sessionId, client);
                return client;
            },
            isEligible: () => true,
            onEntity: async () => undefined,
            onSnapshotReset: async () => undefined,
        });
        const dormantSessions = Array.from({ length: 150 }, (_, index) => ({
            sessionId: `session-${index}`,
            sessionKey: new Uint8Array(32),
            pollIntervalMs: null,
        }));

        registry.invalidate('session-73', 42);
        expect(createdSessionIds).toEqual([]);

        registry.reconcile(dormantSessions);
        await Promise.resolve();
        expect(createdSessionIds).toEqual(['session-73']);
        expect(registry.hasStartingClient('session-73')).toBe(true);

        const target = clients.get('session-73')!;
        target.started.resolve();
        await target.started.promise;
        await Promise.resolve();
        registry.invalidateAll();

        expect(createdSessionIds).toEqual(['session-73']);
        expect(target.invalidations).toEqual([undefined]);
        registry.reconcile([]);
    });

    it('does not register a client when the session stops being Codex during startup', async () => {
        let eligible = true;
        const client = new TestClient();
        const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
            createClient: async () => client,
            isEligible: () => eligible,
            onEntity: async () => undefined,
            onSnapshotReset: async () => undefined,
        });

        registry.reconcile([session]);
        await Promise.resolve();
        expect(registry.hasStartingClient(session.sessionId)).toBe(true);

        eligible = false;
        client.started.resolve();
        await client.started.promise;
        await Promise.resolve();

        expect(registry.hasClient(session.sessionId)).toBe(false);
        expect(client.stopCount).toBe(1);
    });

    it('drops callbacks from a client canceled by session deletion', async () => {
        let eligible = true;
        let deliver: ((event: TestEvent) => Promise<void>) | null = null;
        let deliverBatch: ((events: readonly TestEvent[]) => Promise<void>) | null = null;
        let reset: (() => Promise<void>) | null = null;
        const received: TestEvent[] = [];
        let resetCount = 0;
        const client = new TestClient();
        const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
            createClient: async (options) => {
                deliver = options.onEntity;
                deliverBatch = options.onEntities;
                reset = options.onSnapshotReset;
                return client;
            },
            isEligible: () => eligible,
            onEntity: async (_sessionId, event) => {
                received.push(event);
            },
            onEntities: async (_sessionId, events) => {
                received.push(...events);
            },
            onSnapshotReset: async () => {
                resetCount += 1;
            },
        });

        registry.reconcile([session]);
        await Promise.resolve();
        expect(deliver).not.toBeNull();
        await deliver!({ value: 'before-delete' });
        await deliverBatch!([{ value: 'before-delete-batch' }]);
        await reset!();

        eligible = false;
        registry.reconcile([]);
        await deliver!({ value: 'after-delete' });
        await deliverBatch!([{ value: 'after-delete-batch' }]);
        await reset!();
        client.started.resolve();
        await Promise.resolve();

        expect(received).toEqual([
            { value: 'before-delete' },
            { value: 'before-delete-batch' },
        ]);
        expect(resetCount).toBe(1);
        expect(registry.hasClient(session.sessionId)).toBe(false);
        expect(registry.hasStartingClient(session.sessionId)).toBe(false);
    });

    it('keeps a replacement client when an older startup settles later', async () => {
        let eligible = true;
        const clients = [new TestClient(), new TestClient()];
        let createIndex = 0;
        const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
            createClient: async () => clients[createIndex++],
            isEligible: () => eligible,
            onEntity: async () => undefined,
            onSnapshotReset: async () => undefined,
        });

        registry.reconcile([session]);
        await Promise.resolve();
        eligible = false;
        registry.reconcile([]);
        eligible = true;
        registry.reconcile([session]);
        await Promise.resolve();

        clients[1].started.resolve();
        await clients[1].started.promise;
        await Promise.resolve();
        clients[0].started.resolve();
        await clients[0].started.promise;
        await Promise.resolve();
        registry.invalidate(session.sessionId, 42);

        expect(registry.hasClient(session.sessionId)).toBe(true);
        expect(clients[0].invalidations).toEqual([]);
        expect(clients[1].invalidations).toEqual([42]);
    });

    it('starts an on-demand client for a durable publish without waiting for hydration', async () => {
        const client = new TestClient();
        const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
            createClient: async () => client,
            isEligible: () => true,
            onEntity: async () => undefined,
            onSnapshotReset: async () => undefined,
        });
        registry.reconcile([{ ...session, pollIntervalMs: null }]);
        expect(registry.hasStartingClient(session.sessionId)).toBe(false);

        const published = await registry.withClient(session.sessionId, async (startingClient) => {
            expect(startingClient).toBe(client);
            return 'persisted';
        });

        expect(published).toBe('persisted');
        expect(registry.hasStartingClient(session.sessionId)).toBe(true);
        client.started.resolve();
        await client.started.promise;
        await Promise.resolve();
    });

    it('stops and recreates a client when its polling mode changes', async () => {
        const clients = [new TestClient(), new TestClient()];
        let createIndex = 0;
        const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
            createClient: async () => clients[createIndex++],
            isEligible: () => true,
            onEntity: async () => undefined,
            onSnapshotReset: async () => undefined,
        });

        registry.reconcile([{ ...session, pollIntervalMs: 5_000 }]);
        await Promise.resolve();
        clients[0].started.resolve();
        await clients[0].started.promise;
        await Promise.resolve();
        expect(registry.hasClient(session.sessionId)).toBe(true);

        registry.reconcile([{ ...session, pollIntervalMs: null }]);
        expect(clients[0].stopCount).toBe(1);
        expect(registry.hasClient(session.sessionId)).toBe(false);
        expect(createIndex).toBe(1);

        registry.reconcile([{ ...session, pollIntervalMs: 5_000 }]);
        await Promise.resolve();
        expect(createIndex).toBe(2);
        clients[1].started.resolve();
        await clients[1].started.promise;
        await Promise.resolve();
        expect(registry.hasClient(session.sessionId)).toBe(true);
        registry.reconcile([]);
    });

    it('stops an active client before publishing after eligibility is revoked', async () => {
        let eligible = true;
        const client = new TestClient();
        const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
            createClient: async () => client,
            isEligible: () => eligible,
            onEntity: async () => undefined,
            onSnapshotReset: async () => undefined,
        });
        registry.reconcile([session]);
        await Promise.resolve();
        client.started.resolve();
        await client.started.promise;
        await Promise.resolve();

        eligible = false;
        await expect(registry.withClient(session.sessionId, async () => 'published'))
            .rejects.toThrow('no longer eligible');
        expect(client.stopCount).toBe(1);
        expect(registry.hasClient(session.sessionId)).toBe(false);
    });

    it('retries failed startup with bounded backoff and exposes sync health', async () => {
        vi.useFakeTimers();
        try {
            const clients = [new TestClient(), new TestClient()];
            let createIndex = 0;
            const states: string[] = [];
            const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
                createClient: async () => clients[createIndex++],
                isEligible: () => true,
                onEntity: async () => undefined,
                onSnapshotReset: async () => undefined,
                onSyncState: (_sessionId, state) => {
                    states.push(state.type);
                },
                retryBaseMs: 100,
                retryMaxMs: 1_000,
                random: () => 0.5,
            });

            registry.reconcile([session]);
            await Promise.resolve();
            clients[0].started.reject(new Error('relay unavailable'));
            await Promise.resolve();
            await Promise.resolve();

            expect(states).toEqual(['starting', 'unknown']);
            expect(registry.hasClient(session.sessionId)).toBe(false);

            await vi.advanceTimersByTimeAsync(100);
            expect(states).toEqual(['starting', 'unknown', 'retrying']);
            clients[1].started.resolve();
            await clients[1].started.promise;
            await Promise.resolve();

            expect(states).toEqual(['starting', 'unknown', 'retrying', 'ready']);
            expect(registry.hasClient(session.sessionId)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries an on-demand startup only after another explicit invalidation', async () => {
        vi.useFakeTimers();
        try {
            const clients = [new TestClient(), new TestClient()];
            let createIndex = 0;
            const states: string[] = [];
            const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
                createClient: async () => clients[createIndex++],
                isEligible: () => true,
                onEntity: async () => undefined,
                onSnapshotReset: async () => undefined,
                onSyncState: (_sessionId, state) => states.push(state.type),
                retryBaseMs: 100,
                random: () => 0.5,
            });

            registry.reconcile([{ ...session, pollIntervalMs: null }]);
            registry.invalidate(session.sessionId);
            await Promise.resolve();
            clients[0].started.reject(new Error('offline'));
            await Promise.resolve();
            await Promise.resolve();

            expect(createIndex).toBe(1);
            expect(states).toEqual(['starting', 'unknown']);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(createIndex).toBe(1);

            registry.invalidate(session.sessionId);
            await Promise.resolve();
            expect(createIndex).toBe(2);
            expect(states).toEqual(['starting', 'unknown', 'retrying']);
            clients[1].started.resolve();
            await clients[1].started.promise;
            await Promise.resolve();
            expect(states).toEqual(['starting', 'unknown', 'retrying', 'ready']);
            registry.reconcile([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('records bounded retry diagnostics without retaining startup error text', async () => {
        vi.useFakeTimers();
        try {
            const secret = 'prompt-reasoning-tool-output-secret';
            const records: unknown[] = [];
            const client = new TestClient();
            const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
                createClient: async () => client,
                isEligible: () => true,
                onEntity: async () => undefined,
                onSnapshotReset: async () => undefined,
                diagnostics: { record: (input) => records.push(input) },
                softwareVersion: '1.11.10',
                retryBaseMs: 100,
                random: () => 0.5,
            });

            registry.reconcile([session]);
            await Promise.resolve();
            client.started.reject(Object.assign(new Error(secret), { code: 'ECONNRESET' }));
            await Promise.resolve();
            await Promise.resolve();

            expect(records).toContainEqual(expect.objectContaining({
                component: 'app.registry',
                event: 'lifecycle',
                phase: 'failed',
                sessionHash: client.diagnosticSessionId,
                errorKind: 'network',
            }));
            expect(records).toContainEqual(expect.objectContaining({
                component: 'app.registry',
                event: 'retry',
                phase: 'scheduled',
                durationMs: 100,
            }));
            expect(JSON.stringify(records)).not.toContain(secret);
            registry.reconcile([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('writes a degraded terminal summary from persistent sink counters', async () => {
        const records: unknown[] = [];
        const client = new TestClient();
        const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
            createClient: async () => client,
            isEligible: () => true,
            onEntity: async () => undefined,
            onSnapshotReset: async () => undefined,
            diagnostics: { record: (input) => records.push(input) },
            diagnosticStats: () => ({
                count: 2_000,
                droppedRecords: 4,
                invalidRecords: 3,
                writeFailures: 2,
                listenerFailures: 1,
            }),
        });

        registry.reconcile([session]);
        await Promise.resolve();
        client.started.resolve();
        await client.started.promise;
        await Promise.resolve();
        registry.reconcile([]);

        expect(records).toContainEqual(expect.objectContaining({
            component: 'app.registry',
            event: 'lifecycle',
            phase: 'failed',
            state: 'degraded',
            count: 2_000,
            dropped: 4,
            invalid: 3,
            writeFailures: 2,
            listenerFailures: 1,
        }));
    });

    it('wakes a failed startup on foreground invalidation and cancels retry after removal', async () => {
        vi.useFakeTimers();
        try {
            const clients = [new TestClient(), new TestClient()];
            let createIndex = 0;
            const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
                createClient: async () => clients[createIndex++],
                isEligible: () => true,
                onEntity: async () => undefined,
                onSnapshotReset: async () => undefined,
                retryBaseMs: 60_000,
                random: () => 0.5,
            });

            registry.reconcile([session]);
            await Promise.resolve();
            clients[0].started.reject(new Error('offline'));
            await Promise.resolve();
            await Promise.resolve();

            registry.invalidateAll();
            await Promise.resolve();
            expect(createIndex).toBe(2);

            registry.reconcile([]);
            clients[1].started.resolve();
            await Promise.resolve();
            await vi.runAllTimersAsync();

            expect(registry.hasClient(session.sessionId)).toBe(false);
            expect(registry.hasStartingClient(session.sessionId)).toBe(false);
            expect(clients[1].stopCount).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
