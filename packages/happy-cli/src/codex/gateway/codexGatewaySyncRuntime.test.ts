import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClientContract } from '@/api/apiSession';
import type { Metadata } from '@/api/types';
import type { CodexV4SessionBinding, CodexV4ThreadRouter } from '../codexV4ThreadRouter';
import type { Thread } from '../protocol';
import {
    CodexGatewaySyncRuntime,
    type CodexGatewaySyncRuntimeOptions,
} from './codexGatewaySyncRuntime';

function createHarness(overrides: Partial<CodexGatewaySyncRuntimeOptions> = {}) {
    let metadata: Metadata = {
        path: '/old',
        host: 'host',
        flavor: 'codex',
        codexSyncVersion: 4,
    } as Metadata;
    const calls: string[] = [];
    const session = {
        sessionId: 'session-1',
        updateMetadataAndWait: vi.fn(async (update: (value: Metadata) => Metadata) => {
            calls.push('metadata');
            metadata = update(metadata);
        }),
    } as unknown as ApiSessionClientContract;
    const mapper = {
        setGatewayState: vi.fn(async () => { calls.push('projection'); }),
        flush: vi.fn(async () => { calls.push('mapper.flush'); }),
    };
    const syncClient = {
        flushOutboundOnce: vi.fn(async () => { calls.push('sync.flush'); }),
        hasPendingOutbound: vi.fn(() => false),
        getPendingProviderRequests: vi.fn(() => []),
    };
    const commandProcessor = {
        hasPendingWork: vi.fn(() => false),
        flush: vi.fn(async () => { calls.push('commands.flush'); }),
    };
    const requestBroker = { pendingCount: vi.fn(() => 0) };
    const rootBinding = {
        mapper,
        syncClient,
        commandProcessor,
        requestBroker,
        recover: vi.fn(async () => { calls.push('binding.recover'); }),
        close: vi.fn(async () => { calls.push('binding.close'); }),
    } as unknown as CodexV4SessionBinding;
    const router = {
        registerRootThread: vi.fn(async () => { calls.push('router.register'); }),
        migrateRootSnapshot: vi.fn(async () => { calls.push('router.migrate'); }),
        recoverPendingNotifications: vi.fn(async () => { calls.push('router.pending'); }),
        recoverActiveThreads: vi.fn(async () => { calls.push('router.active'); }),
        handleNotificationAsync: vi.fn(async () => undefined),
        handleRequest: vi.fn(),
        setConnection: vi.fn(),
        ownsThread: vi.fn(() => false),
        hasActiveChildWork: vi.fn(() => false),
        flush: vi.fn(async () => { calls.push('router.flush'); }),
        close: vi.fn(async () => { calls.push('router.close'); }),
    } as unknown as CodexV4ThreadRouter;
    const archiveSession = vi.fn(async () => true);
    const options: CodexGatewaySyncRuntimeOptions = {
        gatewayId: 'gateway-1',
        origin: 'terminal',
        rootThreadId: 'thread-1',
        initialBinding: {
            role: 'recovering',
            generation: 4,
            previousSessionId: null,
            nextSessionId: null,
            changedAt: 100,
        },
        initialGatewayState: 'recovering',
        initialTerminalState: 'attached',
        session,
        rootBinding,
        router,
        archiveSession,
        now: () => 200,
        ...overrides,
    };
    return {
        runtime: new CodexGatewaySyncRuntime(options),
        session,
        mapper,
        syncClient,
        commandProcessor,
        requestBroker,
        rootBinding,
        router,
        archiveSession,
        calls,
        metadata: () => metadata,
    };
}

function thread(overrides: Partial<Thread> = {}): Thread {
    return {
        id: 'thread-1',
        cwd: '/workspace',
        preview: 'First real user message',
        name: null,
        turns: [],
        ...overrides,
    } as Thread;
}

describe('CodexGatewaySyncRuntime', () => {
    it('hydrates the authoritative snapshot before publishing thread metadata', async () => {
        const harness = createHarness();

        const snapshot = thread({ name: 'Official thread name' });
        await harness.runtime.activate(snapshot);

        expect(harness.calls).toEqual([
            'router.register',
            'router.migrate',
            'binding.recover',
            'router.pending',
            'router.active',
            'metadata',
        ]);
        expect(harness.metadata()).toMatchObject({
            path: '/workspace',
            name: 'Official thread name',
            codexThreadId: 'thread-1',
        });
        expect(harness.router.migrateRootSnapshot).toHaveBeenCalledWith('thread-1', snapshot);
    });

    it('persists the binding, publishes it, flushes it, and only then archives inactive history', async () => {
        const harness = createHarness();

        await harness.runtime.updateBinding({
            role: 'inactive',
            generation: 5,
            previousSessionId: 'previous',
            nextSessionId: null,
            changedAt: 300,
        });

        expect(harness.calls).toEqual([
            'metadata',
            'projection',
            'mapper.flush',
            'sync.flush',
        ]);
        expect(harness.archiveSession).toHaveBeenCalledWith('session-1');
        expect(harness.metadata().codexGatewayBinding).toEqual({
            gatewayId: 'gateway-1',
            generation: 5,
            origin: 'terminal',
            role: 'inactive',
            terminal: 'attached',
            previousSessionId: 'previous',
            changedAt: 300,
        });
        expect(harness.mapper.setGatewayState).toHaveBeenCalledWith({
            gateway: {
                gatewayId: 'gateway-1',
                generation: 5,
                origin: 'terminal',
                role: 'inactive',
                state: 'stopped',
            },
            terminal: { state: 'attached', detachedAt: null },
        });
    });

    it('keeps the prior binding when relay archive is pending so retirement can retry', async () => {
        const archiveSession = vi.fn(async () => false);
        const harness = createHarness({ archiveSession });

        await expect(harness.runtime.updateBinding({
            role: 'inactive',
            generation: 5,
            previousSessionId: null,
            nextSessionId: null,
            changedAt: 300,
        })).rejects.toThrow('archive is pending relay recovery');

        await harness.runtime.setGatewayLifecycle('running');
        expect(harness.mapper.setGatewayState).toHaveBeenLastCalledWith({
            gateway: expect.objectContaining({ role: 'recovering', generation: 4 }),
        });
    });

    it('rolls terminal state back when durable metadata cannot be updated', async () => {
        const harness = createHarness();
        vi.mocked(harness.session.updateMetadataAndWait).mockRejectedValueOnce(new Error('offline'));

        await expect(harness.runtime.setTerminalState('detached', 250)).rejects.toThrow('offline');
        await harness.runtime.setGatewayLifecycle('running');

        expect(harness.mapper.setGatewayState).toHaveBeenLastCalledWith({
            gateway: expect.any(Object),
        });
        await harness.runtime.updateBinding({
            role: 'current',
            generation: 4,
            previousSessionId: null,
            nextSessionId: null,
            changedAt: 400,
        });
        expect(harness.mapper.setGatewayState).toHaveBeenLastCalledWith(expect.objectContaining({
            terminal: { state: 'attached', detachedAt: null },
        }));
    });

    it('does not report drained while any provider-facing queue still owns work', async () => {
        const harness = createHarness();
        expect(await harness.runtime.isDrained()).toBe(true);

        vi.mocked(harness.router.hasActiveChildWork).mockReturnValueOnce(true);
        expect(await harness.runtime.isDrained()).toBe(false);
        vi.mocked(harness.commandProcessor.hasPendingWork).mockReturnValueOnce(true);
        expect(await harness.runtime.isDrained()).toBe(false);
        vi.mocked(harness.requestBroker.pendingCount).mockReturnValueOnce(1);
        expect(await harness.runtime.isDrained()).toBe(false);
        vi.mocked(harness.syncClient.hasPendingOutbound).mockReturnValueOnce(true);
        expect(await harness.runtime.isDrained()).toBe(false);
        vi.mocked(harness.syncClient.getPendingProviderRequests).mockReturnValueOnce([
            {} as ReturnType<typeof harness.syncClient.getPendingProviderRequests>[number],
        ]);
        expect(await harness.runtime.isDrained()).toBe(false);
    });

    it('flushes in provider-to-sync order and closes shared resources exactly once', async () => {
        const harness = createHarness();

        await harness.runtime.flush();
        await Promise.all([harness.runtime.close(), harness.runtime.close()]);

        expect(harness.calls).toEqual([
            'commands.flush',
            'router.flush',
            'mapper.flush',
            'sync.flush',
            'router.close',
            'binding.close',
        ]);
        expect(harness.router.close).toHaveBeenCalledTimes(1);
        expect(harness.rootBinding.close).toHaveBeenCalledTimes(1);
    });
});
