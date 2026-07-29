import { describe, expect, it, vi } from 'vitest';
import {
    CodexV4ClientRegistry,
    isCodexV4SyncActive,
    isCodexV4SyncEligible,
    type CodexV4RegistryClient,
} from './codexV4ClientRegistry';

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

    stop(): void {
        this.stopCount += 1;
    }

    invalidate(highWatermark?: number): void {
        this.invalidations.push(highWatermark);
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

describe('CodexV4ClientRegistry', () => {
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

    it('allows a durable publish while client hydration is still starting', async () => {
        const client = new TestClient();
        const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
            createClient: async () => client,
            isEligible: () => true,
            onEntity: async () => undefined,
            onSnapshotReset: async () => undefined,
        });
        registry.reconcile([session]);

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
