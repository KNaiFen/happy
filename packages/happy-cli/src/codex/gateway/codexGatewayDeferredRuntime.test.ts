import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    CodexConnectionEvent,
    CodexManagedServerResponse,
    CodexServerRequest,
} from '../codexAppServerClient';
import type { ServerNotification, Thread } from '../protocol';
import type {
    CodexGatewayRootRuntime,
    CodexGatewayRuntimeBinding,
} from './codexGatewayCoordinator';
import { CodexGatewayDeferredRuntime } from './codexGatewayDeferredRuntime';
import { CodexGatewayJournal } from './codexGatewayJournal';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex Gateway deferred runtime', () => {
    it('replays a durable snapshot marker and notifications when the relay recovers', async () => {
        const harness = await createHarness();
        const active = statusNotification('active');
        await harness.runtime.activate(harness.snapshot);
        await harness.runtime.handleNotification(active);
        expect(harness.runtime.sessionId).toBeNull();

        const materialized = new FakeRuntime('session-a');
        await harness.runtime.materialize(materialized);

        expect(harness.runtime.sessionId).toBe('session-a');
        expect(materialized.activated).toEqual([harness.snapshot]);
        expect(materialized.reconciled).toEqual([harness.snapshot]);
        expect(materialized.notifications).toEqual([active]);
        expect(harness.journal.pendingEntries('thread-a')).toEqual([]);
        await harness.runtime.close();
        await harness.journal.close();
    });

    it('leaves a provider request unanswered when the TUI resolves it while offline', async () => {
        const harness = await createHarness();
        const request = providerRequest('42');
        const pending = harness.runtime.handleRequest(request);
        await harness.runtime.handleNotification({
            method: 'serverRequest/resolved',
            params: { threadId: 'thread-a', requestId: 42 },
        } as ServerNotification);

        await expect(pending).resolves.toBeNull();
        await harness.runtime.close();
        await harness.journal.close();
    });

    it('delegates a request that was waiting when materialization completed', async () => {
        const harness = await createHarness();
        const request = providerRequest('43');
        const pending = harness.runtime.handleRequest(request);
        const materialized = new FakeRuntime('session-a');
        await harness.runtime.materialize(materialized);

        await expect(pending).resolves.toMatchObject({ response: { decision: 'accept' } });
        expect(materialized.requests).toEqual([request]);
        await harness.runtime.close();
        await harness.journal.close();
    });

    it('does not become inactive before a Happy session exists to archive', async () => {
        const harness = await createHarness();

        await expect(harness.runtime.updateBinding({
            ...binding(),
            role: 'inactive',
        })).rejects.toThrow('pending relay recovery');

        expect(harness.runtime.sessionId).toBeNull();
        await harness.runtime.close();
        await harness.journal.close();
    });
});

async function createHarness() {
    const root = await mkdtemp(join(tmpdir(), 'happy-gateway-deferred-'));
    roots.push(root);
    const journal = await CodexGatewayJournal.open({ path: join(root, 'gateway.jsonl') });
    const snapshot = thread();
    const runtime = new CodexGatewayDeferredRuntime({
        threadId: 'thread-a',
        journal,
        initialBinding: binding(),
        initialGatewayLifecycle: 'running',
        initialTerminalState: 'detached',
        initialTerminalDetachedAt: 100,
        readSnapshot: async () => snapshot,
    });
    return { journal, runtime, snapshot };
}

class FakeRuntime implements CodexGatewayRootRuntime {
    readonly activated: Thread[] = [];
    readonly reconciled: Thread[] = [];
    readonly notifications: ServerNotification[] = [];
    readonly requests: CodexServerRequest[] = [];

    constructor(readonly sessionId: string) {}

    async handleNotification(notification: ServerNotification): Promise<void> {
        this.notifications.push(notification);
    }

    async handleRequest(request: CodexServerRequest): Promise<CodexManagedServerResponse> {
        this.requests.push(request);
        return managedResponse();
    }

    setConnection(_event: CodexConnectionEvent): void {}
    async activate(snapshot: Thread): Promise<void> { this.activated.push(snapshot); }
    async reconcile(snapshot: Thread): Promise<void> { this.reconciled.push(snapshot); }
    async updateBinding(_binding: CodexGatewayRuntimeBinding): Promise<void> {}
    async setGatewayLifecycle(_state: 'starting' | 'running' | 'recovering' | 'stopping' | 'stopped'): Promise<void> {}
    async setTerminalState(
        _state: 'attached' | 'pendingDetach' | 'detached' | 'headless',
        _detachedAt: number | null,
    ): Promise<void> {}
    ownsThread(threadId: string): boolean { return threadId === 'thread-a'; }
    async isDrained(): Promise<boolean> { return true; }
    async flush(): Promise<void> {}
    async close(): Promise<void> {}
}

function binding(): CodexGatewayRuntimeBinding {
    return {
        role: 'recovering',
        generation: 1,
        previousSessionId: null,
        nextSessionId: null,
        changedAt: 100,
    };
}

function thread(): Thread {
    return {
        id: 'thread-a',
        parentThreadId: null,
        status: { type: 'idle' },
        turns: [],
    } as unknown as Thread;
}

function statusNotification(type: 'active' | 'idle'): ServerNotification {
    return {
        method: 'thread/status/changed',
        params: {
            threadId: 'thread-a',
            status: type === 'active' ? { type, activeFlags: [] } : { type },
        },
    } as ServerNotification;
}

function providerRequest(requestId: string): CodexServerRequest {
    return {
        requestId,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a' },
    };
}

function managedResponse(): CodexManagedServerResponse {
    return {
        response: { decision: 'accept' },
        markResponseSupplied: vi.fn(async () => undefined),
        markDelivered: vi.fn(async () => undefined),
        markAbandoned: vi.fn(async () => undefined),
    };
}
