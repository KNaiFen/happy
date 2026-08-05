import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClientContract } from '@/api/apiSession';
import type { Metadata } from '@/api/types';
import type { CodexGatewayRuntimeProjection } from '../codexSyncV4Mapper';
import type { CodexV4SessionBinding, CodexV4ThreadRouter } from '../codexV4ThreadRouter';
import type { Thread } from '../protocol';
import {
    CodexGatewayCoordinator,
    CodexGatewayRootBindingError,
    type CodexGatewayRootRuntimeFactoryOptions,
} from './codexGatewayCoordinator';
import { CodexGatewaySyncRuntime } from './codexGatewaySyncRuntime';

describe('Codex Gateway durable handoff rollback', () => {
    it('restores the target durable binding before removing a failed handoff runtime', async () => {
        const harness = createDurableHarness();
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-a');
        harness.failTargetCurrentOnceFor = 'thread-b';

        const failure = await harness.coordinator.bindRoot('thread-b').then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CodexGatewayRootBindingError);
        expect(failure).toMatchObject({ phase: 'targetBinding', recoveryRequired: false });
        expect(currentMetadataThreads(harness)).toEqual(['thread-a']);
        expect(harness.controls.get('thread-b')!.metadata().codexGatewayBinding).toEqual({
            gatewayId: 'gateway-1',
            generation: 2,
            origin: 'terminal',
            role: 'recovering',
            terminal: 'unattached',
            previousSessionId: 'session-thread-a',
            changedAt: 20,
        });
        expect(harness.controls.get('thread-b')!.close).toHaveBeenCalledOnce();
        expect(harness.leases.release).toHaveBeenCalledWith('thread-b', 'gateway-1');
    });

    it('blocks the source and recovers forward when its current rollback fails', async () => {
        const harness = createDurableHarness();
        await harness.coordinator.connect();
        await harness.coordinator.bindRoot('thread-a');
        harness.controls.get('thread-a')!.failCurrentAfterDraining = true;
        harness.failTargetCurrentOnceFor = 'thread-b';

        const failure = await harness.coordinator.bindRoot('thread-b').then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toMatchObject({ phase: 'sourceBinding', recoveryRequired: true });
        expect(harness.coordinator.bindingSnapshot()).toEqual(expect.arrayContaining([
            expect.objectContaining({ threadId: 'thread-a', role: 'draining' }),
            expect.objectContaining({ threadId: 'thread-b', role: 'recovering' }),
        ]));
        expect(currentMetadataThreads(harness)).toEqual([]);
        expect(harness.controls.get('thread-b')!.lastGateway()).toMatchObject({
            role: 'recovering',
            state: 'recovering',
        });

        await expect(harness.coordinator.recoverPendingBinding()).resolves.toBe(true);

        expect(currentMetadataThreads(harness)).toEqual(['thread-b']);
        expect(harness.controls.get('thread-b')!.lastGateway()).toMatchObject({
            role: 'current',
            state: 'running',
        });
        expect(harness.leases.release).not.toHaveBeenCalledWith('thread-b', 'gateway-1');
    });
});

interface DurableRuntimeControl {
    failCurrentAfterDraining: boolean;
    metadata(): Metadata;
    lastGateway(): CodexGatewayRuntimeProjection | null;
    close: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function createDurableHarness() {
    const threads = new Map([
        ['thread-a', thread('thread-a')],
        ['thread-b', thread('thread-b')],
    ]);
    const controls = new Map<string, DurableRuntimeControl>();
    let connectionHandler: ((event: unknown) => void) | null = null;
    const client = {
        connect: vi.fn(async () => connectionHandler?.({
            connection: 'connected',
            statusUnknown: false,
            error: null,
        })),
        disconnect: vi.fn(async () => undefined),
        subscribeThread: vi.fn(async (threadId: string) => ({
            threadId,
            model: 'gpt-test',
            thread: threads.get(threadId)!,
        })),
        subscribeThreadIfMaterialized: vi.fn(async (threadId: string) => ({
            threadId,
            model: 'gpt-test',
            thread: threads.get(threadId)!,
        })),
        readThread: vi.fn(async ({ threadId }: { threadId: string }) => ({
            thread: threads.get(threadId)!,
        })),
        readThreadComplete: vi.fn(async ({ threadId }: { threadId: string }) => ({
            thread: threads.get(threadId)!,
        })),
        adoptThreadSnapshot: vi.fn(),
        setStableNotificationHandler: vi.fn(),
        setServerRequestHandler: vi.fn(),
        setConnectionHandler: vi.fn((handler: (event: unknown) => void) => {
            connectionHandler = handler;
        }),
    };
    const leases = {
        acquire: vi.fn(async () => undefined),
        release: vi.fn(async () => true),
    };
    const harness = {
        controls,
        leases,
        failTargetCurrentOnceFor: null as string | null,
        coordinator: null as unknown as CodexGatewayCoordinator,
    };
    harness.coordinator = new CodexGatewayCoordinator({
        gatewayId: 'gateway-1',
        client: client as never,
        leases,
        now: () => 20,
        createRuntime: async (options) => createDurableRuntime(harness, options),
    });
    return harness;
}

function createDurableRuntime(
    harness: ReturnType<typeof createDurableHarness>,
    options: CodexGatewayRootRuntimeFactoryOptions,
): CodexGatewaySyncRuntime {
    let metadata = {
        path: '/workspace',
        host: 'host',
        flavor: 'codex',
        codexSyncVersion: 4,
        codexThreadId: options.threadId,
        codexGatewayBinding: {
            gatewayId: 'gateway-1',
            generation: options.generation,
            origin: 'terminal',
            role: 'recovering',
            terminal: 'unattached',
            ...(options.previousSessionId ? { previousSessionId: options.previousSessionId } : {}),
            changedAt: 20,
        },
    } as Metadata;
    let lastGateway: CodexGatewayRuntimeProjection | null = null;
    let sawDraining = false;
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const control: DurableRuntimeControl = {
        failCurrentAfterDraining: false,
        metadata: () => metadata,
        lastGateway: () => lastGateway,
        close,
    };
    const session = {
        sessionId: `session-${options.threadId}`,
        updateMetadataAndWait: vi.fn(async (update: (value: Metadata) => Metadata) => {
            const next = update(metadata);
            const role = next.codexGatewayBinding?.role;
            if (role === 'current' && sawDraining && control.failCurrentAfterDraining) {
                control.failCurrentAfterDraining = false;
                throw new Error('source current rollback failed');
            }
            metadata = next;
            if (role === 'draining') sawDraining = true;
        }),
    } as unknown as ApiSessionClientContract;
    const mapper = {
        setGatewayState: vi.fn(async (state: { gateway?: CodexGatewayRuntimeProjection }) => {
            if (state.gateway) lastGateway = state.gateway;
        }),
        flush: vi.fn(async () => {
            if (
                harness.failTargetCurrentOnceFor === options.threadId
                && lastGateway?.role === 'current'
            ) {
                harness.failTargetCurrentOnceFor = null;
                throw new Error('target mapper flush failed');
            }
        }),
    };
    const syncClient = {
        flushOutboundOnce: vi.fn(async () => undefined),
        hasPendingOutbound: vi.fn(() => false),
        getPendingProviderRequests: vi.fn(() => []),
    };
    const commandProcessor = {
        hasPendingWork: vi.fn(() => false),
        flush: vi.fn(async () => undefined),
    };
    const rootBinding = {
        mapper,
        syncClient,
        commandProcessor,
        requestBroker: { pendingCount: vi.fn(() => 0) },
        recover: vi.fn(async () => undefined),
        close,
    } as unknown as CodexV4SessionBinding;
    const router = {
        registerRootThread: vi.fn(async () => undefined),
        migrateRootSnapshot: vi.fn(async () => undefined),
        recoverPendingNotifications: vi.fn(async () => undefined),
        recoverActiveThreads: vi.fn(async () => undefined),
        handleNotificationAsync: vi.fn(async () => undefined),
        handleRequest: vi.fn(),
        setConnection: vi.fn(),
        ownsThread: vi.fn(() => false),
        hasActiveChildWork: vi.fn(() => false),
        flush: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
    } as unknown as CodexV4ThreadRouter;
    const runtime = new CodexGatewaySyncRuntime({
        gatewayId: 'gateway-1',
        origin: 'terminal',
        rootThreadId: options.threadId,
        initialBinding: {
            role: 'recovering',
            generation: options.generation,
            previousSessionId: options.previousSessionId,
            nextSessionId: null,
            changedAt: 20,
        },
        initialGatewayState: 'running',
        initialTerminalState: 'headless',
        session,
        rootBinding,
        router,
        now: () => 20,
    });
    harness.controls.set(options.threadId, control);
    return runtime;
}

function currentMetadataThreads(harness: ReturnType<typeof createDurableHarness>): string[] {
    return [...harness.controls.entries()]
        .filter(([, control]) => control.metadata().codexGatewayBinding?.role === 'current')
        .map(([threadId]) => threadId)
        .sort();
}

function thread(id: string): Thread {
    return {
        id,
        parentThreadId: null,
        status: { type: 'idle' },
        turns: [],
    } as unknown as Thread;
}
