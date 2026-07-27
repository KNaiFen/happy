import { describe, expect, it } from 'vitest';
import {
    CodexV4ClientRegistry,
    type CodexV4RegistryClient,
} from './codexV4ClientRegistry';

interface TestEvent {
    value: string;
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

class TestClient implements CodexV4RegistryClient {
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

describe('CodexV4ClientRegistry', () => {
    it('does not register a client when the session stops being Codex during startup', async () => {
        let eligible = true;
        const client = new TestClient();
        const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
            createClient: async () => client,
            isEligible: () => eligible,
            onEntity: async () => undefined,
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
        const received: TestEvent[] = [];
        const client = new TestClient();
        const registry = new CodexV4ClientRegistry<TestClient, TestEvent>({
            createClient: async (options) => {
                deliver = options.onEntity;
                return client;
            },
            isEligible: () => eligible,
            onEntity: async (_sessionId, event) => {
                received.push(event);
            },
        });

        registry.reconcile([session]);
        await Promise.resolve();
        expect(deliver).not.toBeNull();
        await deliver!({ value: 'before-delete' });

        eligible = false;
        registry.reconcile([]);
        await deliver!({ value: 'after-delete' });
        client.started.resolve();
        await Promise.resolve();

        expect(received).toEqual([{ value: 'before-delete' }]);
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
});
