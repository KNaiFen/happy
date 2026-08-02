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
    type CodexGatewayRootRuntime,
    type CodexGatewayRootRuntimeFactoryOptions,
    type CodexGatewayRuntimeBinding,
} from './codexGatewayCoordinator';

describe('Codex Gateway coordinator', () => {
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

    it('does not create a new generation when attach resumes the current root', async () => {
        const harness = createHarness({ 'thread-a': thread('thread-a', 'idle') });
        await harness.coordinator.connect();
        const first = await harness.coordinator.bindRoot('thread-a');
        const attached = await harness.coordinator.bindRoot('thread-a');

        expect(first.generation).toBe(1);
        expect(attached).toMatchObject({ generation: 1, changed: false });
        expect(harness.client.resumeThread).toHaveBeenCalledOnce();
        expect(harness.leases.acquire).toHaveBeenCalledOnce();
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
        harness.client.resumeThread.mockClear();

        await harness.coordinator.connect(true);

        expect(harness.client.reconnectExternalTransportPreservingThreads).toHaveBeenCalledOnce();
        expect(harness.client.resumeThread.mock.calls.map(([options]) => options.threadId)).toEqual([
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

        await expect(harness.coordinator.bindRoot('thread-b')).rejects.toThrow('binding update failed');

        expect(harness.coordinator.currentThreadId).toBe('thread-a');
        expect(harness.coordinator.currentGeneration).toBe(1);
        expect(harness.runtimes.get('thread-a')!.bindings.at(-1)?.role).toBe('current');
        expect(harness.runtimes.get('thread-b')!.close).toHaveBeenCalledOnce();
        expect(harness.leases.release).toHaveBeenCalledWith('thread-b', 'gateway-1');
    });

    it('releases every lease on stop even when a runtime cannot flush or close', async () => {
        const errors: unknown[] = [];
        const harness = createHarness(
            { 'thread-a': thread('thread-a', 'idle') },
            { onError: (error) => errors.push(error) },
        );
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-a');
        const runtime = harness.runtimes.get('thread-a')!;
        runtime.flush.mockRejectedValueOnce(new Error('flush failed'));
        runtime.close.mockRejectedValueOnce(new Error('close failed'));

        await harness.coordinator.stop();

        expect(harness.leases.release).toHaveBeenCalledWith('thread-a', 'gateway-1');
        expect(errors).toHaveLength(2);
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
    drained = true;
    onNotification: ((notification: ServerNotification) => Promise<void>) | null = null;
    readonly close = vi.fn<() => Promise<void>>(async () => undefined);
    readonly flush = vi.fn<() => Promise<void>>(async () => undefined);
    readonly reconcile = vi.fn(async (_snapshot: Thread) => undefined);

    constructor(
        readonly sessionId: string,
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
    async activate(_snapshot: Thread): Promise<void> {}
    async updateBinding(binding: CodexGatewayRuntimeBinding): Promise<void> {
        this.bindings.push(binding);
    }
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
    readonly resumeThread = vi.fn(async (options: { threadId: string }) => ({
        threadId: options.threadId,
        model: 'gpt-test',
        thread: this.threads.get(options.threadId)!,
    }));
    readonly readThreadComplete = vi.fn(async (options: { threadId: string }) => ({
        thread: this.threads.get(options.threadId)!,
    }));

    constructor(private readonly threads: Map<string, Thread>) {}

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
                `session-${factoryOptions.threadId}`,
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
