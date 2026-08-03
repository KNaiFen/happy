import { describe, expect, it, vi } from 'vitest';
import type {
    CodexConnectionEvent,
    CodexManagedServerResponse,
    CodexServerRequest,
} from '../codexAppServerClient';
import { CodexV4CommandCancelledError } from '../codexV4CommandProcessor';
import type { ServerNotification, Thread } from '../protocol';
import {
    CodexGatewayCoordinator,
    CodexGatewayRootBindingError,
    type CodexGatewayRootRuntime,
    type CodexGatewayRootRuntimeFactoryOptions,
    type CodexGatewayRuntimeBinding,
} from './codexGatewayCoordinator';

describe('Codex Gateway coordinator', () => {
    it('restores exact current and draining generations before accepting new work', async () => {
        const harness = createHarness({
            'thread-a': thread('thread-a', 'active', 'turn-a'),
            'thread-b': thread('thread-b', 'idle'),
        });
        await harness.coordinator.connect();
        await harness.coordinator.restoreBindings([
            { threadId: 'thread-a', sessionId: 'session-thread-a', generation: 4, role: 'draining' },
            { threadId: 'thread-b', sessionId: 'session-thread-b', generation: 5, role: 'current' },
        ]);

        expect(harness.coordinator.currentThreadId).toBe('thread-b');
        expect(harness.coordinator.currentGeneration).toBe(5);
        expect(harness.coordinator.bindingSnapshot()).toEqual([
            expect.objectContaining({ threadId: 'thread-b', generation: 5, role: 'current' }),
            expect.objectContaining({ threadId: 'thread-a', generation: 4, role: 'draining' }),
        ]);
        await expect(harness.coordinator.bindRoot('thread-b')).resolves.toEqual({
            sessionId: 'session-thread-b',
            generation: 5,
            changed: false,
        });
    });

    it('rejects a recovered binding set whose current root is not newest', async () => {
        const harness = createHarness({
            'thread-a': thread('thread-a', 'idle'),
            'thread-b': thread('thread-b', 'idle'),
        });
        await expect(harness.coordinator.restoreBindings([
            { threadId: 'thread-a', sessionId: 'session-a', generation: 1, role: 'current' },
            { threadId: 'thread-b', sessionId: 'session-b', generation: 2, role: 'draining' },
        ])).rejects.toThrow('newest generation');
        expect(harness.leases.acquire).not.toHaveBeenCalled();
    });

    it('keeps the prior root draining until its authoritative turn completes', async () => {
        const harness = createHarness({
            'thread-a': thread('thread-a', 'active', 'turn-a'),
            'thread-b': thread('thread-b', 'idle'),
        });
        await harness.coordinator.connect();
        const first = await harness.coordinator.bindRoot('thread-a');
        const second = await harness.coordinator.bindRoot('thread-b');
        const runtimeA = harness.runtimes.get('thread-a')!;
        const runtimeB = harness.runtimes.get('thread-b')!;

        expect(first).toMatchObject({ generation: 1, changed: true });
        expect(second).toMatchObject({ generation: 2, changed: true });
        expect(runtimeA.bindings.at(-1)?.role).toBe('draining');
        expect(runtimeA.close).not.toHaveBeenCalled();
        expect(runtimeB.bindings.at(-1)?.role).toBe('current');

        runtimeA.drained = true;
        harness.client.emitNotification(turnCompleted('thread-a', 'turn-a'));
        await harness.coordinator.flush();

        expect(runtimeA.bindings.at(-1)?.role).toBe('inactive');
        expect(runtimeA.close).toHaveBeenCalledOnce();
        expect(harness.leases.release).toHaveBeenCalledWith('thread-a', 'gateway-1');
        expect(runtimeB.close).not.toHaveBeenCalled();
        expect(harness.coordinator.currentThreadId).toBe('thread-b');
    });

    it('retries retirement when the first authoritative archive attempt is offline', async () => {
        const errors: unknown[] = [];
        const harness = createHarness(
            {
                'thread-a': thread('thread-a', 'idle'),
                'thread-b': thread('thread-b', 'idle'),
            },
            { onError: (error) => errors.push(error) },
        );
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-a');
        const runtimeA = harness.runtimes.get('thread-a')!;
        const updateBinding = runtimeA.updateBinding.bind(runtimeA);
        let failArchiveOnce = true;
        runtimeA.updateBinding = async (binding) => {
            if (binding.role === 'inactive' && failArchiveOnce) {
                failArchiveOnce = false;
                throw new Error('relay offline');
            }
            await updateBinding(binding);
        };

        await harness.coordinator.bindRoot('thread-b');

        expect(errors).toEqual([expect.objectContaining({ message: 'relay offline' })]);
        expect(runtimeA.bindings.at(-1)?.role).toBe('draining');
        expect(runtimeA.close).not.toHaveBeenCalled();

        harness.client.emitNotification(threadStatus('thread-a', 'idle'));
        await harness.coordinator.flush();

        expect(runtimeA.bindings.at(-1)?.role).toBe('inactive');
        expect(runtimeA.close).toHaveBeenCalledOnce();
        expect(harness.leases.release).toHaveBeenCalledWith('thread-a', 'gateway-1');
    });

    it('fills the source handoff link after an offline target materializes', async () => {
        const harness = createHarness({
            'thread-a': thread('thread-a', 'active', 'turn-a'),
            'thread-b': thread('thread-b', 'idle'),
        }, {
            sessionIdForThread: (threadId) => threadId === 'thread-b' ? null : `session-${threadId}`,
        });
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-a');
        await harness.coordinator.bindRoot('thread-b');
        const source = harness.runtimes.get('thread-a')!;
        const target = harness.runtimes.get('thread-b')!;
        expect(source.bindings.at(-1)?.nextSessionId).toBeNull();

        target.sessionId = 'session-thread-b';
        await harness.coordinator.refreshBindingLinks();

        expect(source.bindings.at(-1)?.nextSessionId).toBe('session-thread-b');
        expect(target.bindings.at(-1)?.previousSessionId).toBe('session-thread-a');
    });

    it('does not create a new generation when attach resumes the current root', async () => {
        const harness = createHarness({ 'thread-a': thread('thread-a', 'idle') });
        await harness.coordinator.connect();
        const first = await harness.coordinator.bindRoot('thread-a');
        const attached = await harness.coordinator.bindRoot('thread-a');

        expect(first.generation).toBe(1);
        expect(attached).toMatchObject({ generation: 1, changed: false });
        expect(harness.client.subscribeThread).toHaveBeenCalledOnce();
        expect(harness.leases.acquire).toHaveBeenCalledOnce();
    });

    it('binds a bridge-started thread without issuing thread/resume', async () => {
        const fresh = thread('thread-fresh', 'idle');
        const harness = createHarness({ 'thread-fresh': fresh });
        await harness.coordinator.connect();

        await expect(harness.coordinator.bindRoot('thread-fresh', {
            subscription: 'bridgeStartedNewThread',
        })).resolves.toMatchObject({ generation: 1, changed: true });

        expect(harness.client.subscribeThread).not.toHaveBeenCalled();
        expect(harness.client.subscribeThreadIfMaterialized).not.toHaveBeenCalled();
        expect(harness.client.readThread).toHaveBeenCalledWith({
            threadId: 'thread-fresh',
            includeTurns: false,
            emitSnapshot: false,
        });
        expect(harness.runtimes.get('thread-fresh')!.activatedSnapshots).toEqual([fresh]);
        expect(harness.coordinator.pendingSubscriptionThreadIds()).toEqual([]);
    });

    it('activates a terminal root from its successful response without rereading it', async () => {
        const fresh = thread('thread-fresh', 'idle');
        const harness = createHarness({ 'thread-fresh': fresh });
        await harness.coordinator.connect();

        await expect(harness.coordinator.bindRoot('thread-fresh', {
            subscription: 'terminalRootResponse',
            providerSnapshot: fresh,
        })).resolves.toMatchObject({ generation: 1, changed: true });

        expect(harness.client.readThread).not.toHaveBeenCalled();
        expect(harness.client.subscribeThread).not.toHaveBeenCalled();
        expect(harness.runtimes.get('thread-fresh')!.activatedSnapshots).toEqual([fresh]);
        expect(harness.coordinator.pendingSubscriptionThreadIds()).toEqual(['thread-fresh']);
    });

    it('rejects a terminal response snapshot with a different thread ID', async () => {
        const harness = createHarness({
            'thread-a': thread('thread-a', 'idle'),
            'thread-b': thread('thread-b', 'idle'),
        });

        await expect(harness.coordinator.bindRoot('thread-a', {
            subscription: 'terminalRootResponse',
            providerSnapshot: thread('thread-b', 'idle'),
        })).rejects.toMatchObject({ phase: 'providerSnapshot' });
        expect(harness.leases.acquire).not.toHaveBeenCalled();
        expect(harness.client.readThread).not.toHaveBeenCalled();
    });

    it('reconciles a terminal-started root after its first turn materializes', async () => {
        const fresh = thread('thread-fresh', 'idle');
        const materialized = thread('thread-fresh', 'active', 'turn-1');
        const harness = createHarness({ 'thread-fresh': fresh });
        harness.client.unmaterializedThreads.add('thread-fresh');
        await harness.coordinator.connect();

        await harness.coordinator.bindRoot('thread-fresh', {
            subscription: 'deferredNewThread',
        });

        expect(harness.coordinator.pendingSubscriptionThreadIds()).toEqual(['thread-fresh']);
        await expect(harness.coordinator.subscribeMaterializedRoot('thread-fresh'))
            .resolves.toBe(false);
        expect(harness.runtimes.get('thread-fresh')!.reconcile).not.toHaveBeenCalled();

        harness.client.unmaterializedThreads.delete('thread-fresh');
        harness.client.setThread(materialized);
        await expect(harness.coordinator.subscribeMaterializedRoot('thread-fresh'))
            .resolves.toBe(true);

        expect(harness.runtimes.get('thread-fresh')!.reconcile).toHaveBeenCalledWith(materialized);
        expect(harness.coordinator.pendingSubscriptionThreadIds()).toEqual([]);
    });

    it('imports an authoritative snapshot while a terminal root still awaits stable subscription', async () => {
        const fresh = thread('thread-fresh', 'idle');
        const materialized = thread('thread-fresh', 'active', 'turn-1');
        const harness = createHarness({ 'thread-fresh': fresh });
        harness.client.unmaterializedThreads.add('thread-fresh');
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-fresh', {
            subscription: 'deferredNewThread',
        });
        harness.client.setThread(materialized);

        await expect(harness.coordinator.reconcilePendingRootSnapshot('thread-fresh'))
            .resolves.toBe(true);

        expect(harness.client.readThreadComplete).toHaveBeenCalledWith({
            threadId: 'thread-fresh',
            emitSnapshot: false,
        });
        expect(harness.runtimes.get('thread-fresh')!.reconcile).toHaveBeenCalledWith(materialized);
        expect(harness.coordinator.pendingSubscriptionThreadIds()).toEqual(['thread-fresh']);
    });

    it('does not retire a draining root before its deferred subscription reconciles', async () => {
        const initial = thread('thread-a', 'idle');
        const materialized = thread('thread-a', 'idle');
        materialized.turns = [{
            id: 'turn-1',
            status: 'completed',
            items: [],
        }] as unknown as Thread['turns'];
        const harness = createHarness({
            'thread-a': initial,
            'thread-b': thread('thread-b', 'idle'),
        });
        harness.client.unmaterializedThreads.add('thread-a');
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-a', {
            subscription: 'deferredNewThread',
        });
        const runtimeA = harness.runtimes.get('thread-a')!;

        await harness.coordinator.bindRoot('thread-b');
        await harness.coordinator.retireDrainingRoots();

        expect(runtimeA.bindings.at(-1)?.role).toBe('draining');
        expect(runtimeA.close).not.toHaveBeenCalled();
        expect(harness.coordinator.pendingSubscriptionThreadIds()).toEqual(['thread-a']);

        harness.client.unmaterializedThreads.delete('thread-a');
        harness.client.setThread(materialized);
        await expect(harness.coordinator.subscribeMaterializedRoot('thread-a'))
            .resolves.toBe(true);
        await harness.coordinator.retireDrainingRoots();

        expect(runtimeA.reconcile).toHaveBeenCalledWith(materialized);
        expect(runtimeA.bindings.at(-1)?.role).toBe('inactive');
        expect(runtimeA.close).toHaveBeenCalledOnce();
    });

    it('does not replay a bridge notification through a materialized snapshot', async () => {
        const fresh = thread('thread-fresh', 'idle');
        const harness = createHarness({ 'thread-fresh': fresh });
        harness.client.unmaterializedThreads.add('thread-fresh');
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-fresh', {
            subscription: 'deferredNewThread',
        });

        harness.client.emitNotification(threadStatus('thread-fresh', 'active'));
        await harness.coordinator.flush();

        expect(harness.client.subscribeThreadIfMaterialized).not.toHaveBeenCalled();
        expect(harness.coordinator.pendingSubscriptionThreadIds()).toEqual([]);
        expect(harness.runtimes.get('thread-fresh')!.notifications).toEqual([
            threadStatus('thread-fresh', 'active'),
        ]);
    });

    it('does not flush a draining source while its root handoff command is still in flight', async () => {
        const harness = createHarness({
            'thread-a': thread('thread-a', 'idle'),
            'thread-b': thread('thread-b', 'idle'),
        });
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-a');
        const runtimeA = harness.runtimes.get('thread-a')!;
        runtimeA.drained = false;

        await harness.coordinator.bindRoot('thread-b');

        expect(runtimeA.bindings.at(-1)?.role).toBe('draining');
        expect(runtimeA.flush).not.toHaveBeenCalled();
        runtimeA.drained = true;
        await harness.coordinator.retireDrainingRoots();
        expect(runtimeA.flush).toHaveBeenCalledOnce();
        expect(runtimeA.close).toHaveBeenCalledOnce();
    });

    it('cancels commands from a superseded or missing binding generation', async () => {
        const harness = createHarness({
            'thread-a': thread('thread-a', 'idle'),
            'thread-b': thread('thread-b', 'idle'),
        });
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-a');
        const runtimeA = harness.runtimes.get('thread-a')!;
        expect(() => runtimeA.assertCurrentGeneration(1)).not.toThrow();

        await harness.coordinator.bindRoot('thread-b');
        expect(() => runtimeA.assertCurrentGeneration(1))
            .toThrow(CodexV4CommandCancelledError);
        expect(() => harness.runtimes.get('thread-b')!.assertCurrentGeneration(undefined))
            .toThrow(CodexV4CommandCancelledError);
        expect(() => harness.runtimes.get('thread-b')!.assertCurrentGeneration(2)).not.toThrow();
    });

    it('reconnects and resubscribes current and draining roots after provider restart', async () => {
        const harness = createHarness({
            'thread-a': thread('thread-a', 'active', 'turn-a'),
            'thread-b': thread('thread-b', 'idle'),
        });
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-a');
        await harness.coordinator.bindRoot('thread-b');
        harness.client.subscribeThread.mockClear();

        await harness.coordinator.connect(true);

        expect(harness.client.reconnectExternalTransportPreservingThreads).toHaveBeenCalledOnce();
        expect(harness.client.subscribeThread.mock.calls.map(([threadId]) => threadId)).toEqual([
            'thread-b',
            'thread-a',
        ]);
        expect(harness.runtimes.get('thread-a')!.reconcile).toHaveBeenCalledOnce();
        expect(harness.runtimes.get('thread-b')!.reconcile).toHaveBeenCalledOnce();
    });

    it('serializes parent route discovery ahead of an immediately following child notification', async () => {
        const harness = createHarness({ 'thread-a': thread('thread-a', 'idle') });
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-a');
        const runtime = harness.runtimes.get('thread-a')!;
        runtime.onNotification = async (notification) => {
            if (notification.method === 'item/started') {
                runtime.ownedThreads.add('thread-child');
                runtime.registerThreadOwnership('thread-child');
            }
        };

        harness.client.emitNotification(itemStarted('thread-a'));
        harness.client.emitNotification(threadStatus('thread-child', 'active'));
        await harness.coordinator.flush();

        expect(runtime.notifications.map((notification) => notification.method)).toEqual([
            'item/started',
            'thread/status/changed',
        ]);
    });

    it('buffers a root notification that races ahead of the root RPC response', async () => {
        const harness = createHarness({ 'thread-a': thread('thread-a', 'idle') });
        await harness.coordinator.connect();
        harness.client.emitNotification(threadStatus('thread-a', 'active'));
        await harness.coordinator.flush();

        await harness.coordinator.bindRoot('thread-a');

        expect(harness.runtimes.get('thread-a')!.notifications).toContainEqual(
            threadStatus('thread-a', 'active'),
        );
    });

    it('restores the prior current binding when the target binding update fails', async () => {
        const harness = createHarness({
            'thread-a': thread('thread-a', 'idle'),
            'thread-b': thread('thread-b', 'idle'),
        });
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-a');
        harness.failBindingForThread = 'thread-b';

        const failure = await harness.coordinator.bindRoot('thread-b').then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CodexGatewayRootBindingError);
        expect(failure).toMatchObject({ phase: 'targetBinding' });

        expect(harness.coordinator.currentThreadId).toBe('thread-a');
        expect(harness.coordinator.currentGeneration).toBe(1);
        expect(harness.runtimes.get('thread-a')!.bindings.at(-1)?.role).toBe('current');
        expect(harness.runtimes.get('thread-b')!.close).toHaveBeenCalledOnce();
        expect(harness.leases.release).toHaveBeenCalledWith('thread-b', 'gateway-1');
    });

    it('classifies a root snapshot failure without exposing provider payloads', async () => {
        const harness = createHarness({ 'thread-a': thread('thread-a', 'idle') });
        await harness.coordinator.connect();
        harness.client.subscribeThread.mockRejectedValueOnce(Object.assign(
            new Error('provider payload must remain private'),
            { code: 'ECONNRESET' },
        ));

        const failure = await harness.coordinator.bindRoot('thread-a').then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CodexGatewayRootBindingError);
        expect(failure).toMatchObject({ phase: 'providerSnapshot' });
        expect((failure as Error).message).not.toContain('provider payload');
        expect(harness.leases.release).toHaveBeenCalledWith('thread-a', 'gateway-1');
    });

    it('keeps roots and leases while graceful stop cannot persist inactive state', async () => {
        const harness = createHarness({ 'thread-a': thread('thread-a', 'idle') });
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-a');
        const runtime = harness.runtimes.get('thread-a')!;
        const updateBinding = runtime.updateBinding.bind(runtime);
        runtime.updateBinding = vi.fn(async (binding) => {
            if (binding.role === 'inactive') throw new Error('relay offline');
            await updateBinding(binding);
        });

        await expect(harness.coordinator.stop()).rejects.toThrow('relay offline');

        expect(runtime.close).not.toHaveBeenCalled();
        expect(harness.leases.release).not.toHaveBeenCalled();
        expect(harness.coordinator.currentThreadId).toBe('thread-a');

        runtime.updateBinding = updateBinding;
        await harness.coordinator.stop();
        expect(runtime.close).toHaveBeenCalledOnce();
        expect(harness.leases.release).toHaveBeenCalledWith('thread-a', 'gateway-1');
    });

    it('releases every lease on force stop even when a runtime cannot close', async () => {
        const errors: unknown[] = [];
        const harness = createHarness(
            { 'thread-a': thread('thread-a', 'idle') },
            { onError: (error) => errors.push(error) },
        );
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-a');
        const runtime = harness.runtimes.get('thread-a')!;
        runtime.close.mockRejectedValueOnce(new Error('close failed'));

        await harness.coordinator.stop({ force: true });

        expect(harness.leases.release).toHaveBeenCalledWith('thread-a', 'gateway-1');
        expect(errors).toHaveLength(1);
    });

    it('accepts child ownership registered while the runtime factory is still resolving', async () => {
        const harness = createHarness(
            { 'thread-a': thread('thread-a', 'idle') },
            { registerDuringCreation: 'thread-child' },
        );
        await harness.coordinator.connect();

        await expect(harness.coordinator.bindRoot('thread-a')).resolves.toMatchObject({ changed: true });
        harness.client.emitNotification(threadStatus('thread-child', 'active'));
        await harness.coordinator.flush();

        expect(harness.runtimes.get('thread-a')!.notifications).toContainEqual(
            threadStatus('thread-child', 'active'),
        );
    });
});

class FakeRuntime implements CodexGatewayRootRuntime {
    readonly bindings: CodexGatewayRuntimeBinding[] = [];
    readonly notifications: ServerNotification[] = [];
    readonly ownedThreads = new Set<string>();
    readonly activatedSnapshots: Thread[] = [];
    drained = true;
    onNotification: ((notification: ServerNotification) => Promise<void>) | null = null;
    readonly close = vi.fn<() => Promise<void>>(async () => undefined);
    readonly flush = vi.fn<() => Promise<void>>(async () => undefined);
    readonly reconcile = vi.fn(async (_snapshot: Thread) => undefined);

    constructor(
        public sessionId: string | null,
        readonly registerThreadOwnership: (threadId: string) => void,
        readonly assertCurrentGeneration: (generation: number | undefined) => void,
        rootThreadId: string,
    ) {
        this.ownedThreads.add(rootThreadId);
    }

    async handleNotification(notification: ServerNotification): Promise<void> {
        this.notifications.push(notification);
        await this.onNotification?.(notification);
    }

    async handleRequest(_request: CodexServerRequest): Promise<CodexManagedServerResponse> {
        return {
            response: { decision: 'decline' },
            markResponseSupplied: async () => undefined,
            markDelivered: async () => undefined,
            markAbandoned: async () => undefined,
        };
    }

    setConnection(_event: CodexConnectionEvent): void {}
    async activate(snapshot: Thread): Promise<void> {
        this.activatedSnapshots.push(snapshot);
    }
    async updateBinding(binding: CodexGatewayRuntimeBinding): Promise<void> {
        this.bindings.push(binding);
    }
    async setGatewayLifecycle(_state: 'starting' | 'running' | 'recovering' | 'stopping' | 'stopped'): Promise<void> {}
    async setTerminalState(
        _state: 'attached' | 'pendingDetach' | 'detached' | 'headless',
        _detachedAt: number | null,
    ): Promise<void> {}
    ownsThread(threadId: string): boolean {
        return this.ownedThreads.has(threadId);
    }
    async isDrained(): Promise<boolean> {
        return this.drained;
    }
}

class FakeClient {
    private notificationHandler: ((notification: ServerNotification) => void) | null = null;
    private requestHandler: ((request: CodexServerRequest) => Promise<CodexManagedServerResponse>) | null = null;
    private connectionHandler: ((event: CodexConnectionEvent) => void) | null = null;

    readonly connect = vi.fn(async () => {
        this.connectionHandler?.({ connection: 'connected', statusUnknown: false, error: null });
    });
    readonly disconnect = vi.fn(async () => undefined);
    readonly reconnectExternalTransportPreservingThreads = vi.fn(async () => {
        this.connectionHandler?.({ connection: 'connected', statusUnknown: true, error: null });
    });
    readonly subscribeThread = vi.fn(async (threadId: string) => ({
        threadId,
        model: 'gpt-test',
        thread: this.threads.get(threadId)!,
    }));
    readonly unmaterializedThreads = new Set<string>();
    readonly subscribeThreadIfMaterialized = vi.fn(async (threadId: string) => (
        this.unmaterializedThreads.has(threadId)
            ? null
            : await this.subscribeThread(threadId)
    ));
    readonly readThread = vi.fn(async (options: { threadId: string }) => ({
        thread: this.threads.get(options.threadId)!,
    }));
    readonly readThreadComplete = vi.fn(async (options: { threadId: string }) => ({
        thread: this.threads.get(options.threadId)!,
    }));

    constructor(private readonly threads: Map<string, Thread>) {}

    setThread(value: Thread): void {
        this.threads.set(value.id, value);
    }

    setStableNotificationHandler(handler: ((notification: ServerNotification) => void) | null): void {
        this.notificationHandler = handler;
    }
    setServerRequestHandler(
        handler: ((request: CodexServerRequest) => Promise<CodexManagedServerResponse>) | null,
    ): void {
        this.requestHandler = handler;
    }
    setConnectionHandler(handler: ((event: CodexConnectionEvent) => void) | null): void {
        this.connectionHandler = handler;
    }
    emitNotification(notification: ServerNotification): void {
        this.notificationHandler?.(notification);
    }
}

function createHarness(
    threads: Record<string, Thread>,
    options: {
        onError?: (error: unknown) => void;
        registerDuringCreation?: string;
        sessionIdForThread?: (threadId: string) => string | null;
    } = {},
) {
    const client = new FakeClient(new Map(Object.entries(threads)));
    const runtimes = new Map<string, FakeRuntime>();
    const leases = {
        acquire: vi.fn(async () => undefined),
        release: vi.fn(async () => true),
    };
    let failBindingForThread: string | null = null;
    const coordinator = new CodexGatewayCoordinator({
        gatewayId: 'gateway-1',
        client: client as unknown as import('../codexAppServerClient').CodexAppServerClient,
        leases,
        onError: options.onError,
        createRuntime: async (factoryOptions: CodexGatewayRootRuntimeFactoryOptions) => {
            const runtime = new FakeRuntime(
                options.sessionIdForThread
                    ? options.sessionIdForThread(factoryOptions.threadId)
                    : `session-${factoryOptions.threadId}`,
                factoryOptions.registerThreadOwnership,
                factoryOptions.assertCurrentGeneration,
                factoryOptions.threadId,
            );
            if (options.registerDuringCreation) {
                runtime.ownedThreads.add(options.registerDuringCreation);
                factoryOptions.registerThreadOwnership(options.registerDuringCreation);
            }
            const updateBinding = runtime.updateBinding.bind(runtime);
            runtime.updateBinding = async (binding) => {
                if (failBindingForThread === factoryOptions.threadId && binding.role === 'current') {
                    throw new Error('binding update failed');
                }
                await updateBinding(binding);
            };
            runtimes.set(factoryOptions.threadId, runtime);
            return runtime;
        },
    });
    return {
        client,
        runtimes,
        leases,
        coordinator,
        get failBindingForThread() {
            return failBindingForThread;
        },
        set failBindingForThread(threadId: string | null) {
            failBindingForThread = threadId;
        },
    };
}

function thread(id: string, status: 'active' | 'idle', turnId?: string): Thread {
    return {
        id,
        parentThreadId: null,
        status: status === 'active'
            ? { type: 'active', activeFlags: [] }
            : { type: 'idle' },
        turns: turnId ? [{ id: turnId, status: 'inProgress', items: [] }] : [],
    } as unknown as Thread;
}

function turnCompleted(threadId: string, turnId: string): ServerNotification {
    return {
        method: 'turn/completed',
        params: {
            threadId,
            turn: { id: turnId, status: 'completed', items: [] },
        },
    } as unknown as ServerNotification;
}

function threadStatus(threadId: string, type: 'active' | 'idle'): ServerNotification {
    return {
        method: 'thread/status/changed',
        params: {
            threadId,
            status: type === 'active' ? { type, activeFlags: [] } : { type },
        },
    } as ServerNotification;
}

function itemStarted(threadId: string): ServerNotification {
    return {
        method: 'item/started',
        params: {
            threadId,
            turnId: 'turn-a',
            item: { id: 'item-spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['thread-child'] },
        },
    } as unknown as ServerNotification;
}
