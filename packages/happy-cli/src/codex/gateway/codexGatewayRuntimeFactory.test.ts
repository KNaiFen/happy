import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    type CodexCommandEntityV4,
} from '@slopus/happy-wire';
import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClientContract } from '@/api/apiSession';
import type { Metadata, Session as ApiSession } from '@/api/types';
import type { SyncV4Client, SyncV4AppliedEntity } from '@/api/syncV4Client';
import type { SyncV4CommandJournalStatus, SyncV4CodexThreadRoute } from '@/api/syncV4Journal';
import {
    CodexRpcOutcomeUnknownError,
    type CodexAppServerClient,
} from '../codexAppServerClient';
import { CodexV4CommandCancelledError } from '../codexV4CommandProcessor';
import { CodexV4NotificationRoutingError } from '../codexV4ThreadRouter';
import type { Thread } from '../protocol';
import {
    CodexGatewayRuntimeFactory,
    type CodexGatewayRuntimeFactoryApi,
} from './codexGatewayRuntimeFactory';
import { CodexGatewayArchivedSessionError } from './codexGatewayPresence';

function command(
    name: string,
    payload: CodexCommandEntityV4['payload'],
    overrides: Partial<CodexCommandEntityV4> & { bindingGeneration?: number } = {},
): CodexCommandEntityV4 {
    return {
        schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
        entityType: 'codex.command',
        providerId: `command-${name}`,
        createdAt: 100,
        updatedAt: 100,
        commandId: `command-${name}`,
        threadId: 'thread-a',
        expectedTurnId: null,
        command: name,
        payload,
        clientUserMessageId: `command-${name}`,
        replacesCommandId: null,
        bindingGeneration: 3,
        ...overrides,
    } as CodexCommandEntityV4;
}

function thread(id = 'thread-a'): Thread {
    return {
        id,
        cwd: '/workspace',
        preview: 'hello',
        name: null,
        parentThreadId: null,
        status: { type: 'idle' },
        turns: [],
    } as unknown as Thread;
}

function threadWithHistory(id = 'thread-a'): Thread {
    return {
        ...thread(id),
        turns: [{
            id: 'turn-history',
            status: 'completed',
            items: [],
        }],
    } as unknown as Thread;
}

function createHarness(options: {
    relayAvailable?: boolean;
    existingSession?: boolean;
    archivedSession?: boolean;
} = {}) {
    const routes = new Map<string, SyncV4CodexThreadRoute>();
    const commandStatuses = new Map<string, SyncV4CommandJournalStatus>();
    let entityHandler: ((event: SyncV4AppliedEntity) => Promise<void>) | null = null;
    let capturedCreateOptions: Parameters<CodexGatewayRuntimeFactoryApi['getOrCreateSession']>[0] | null = null;
    let sessionMetadata = {} as Metadata;
    const order: string[] = [];
    const sync = {
        diagnosticSessionHash: 'session-hash',
        getCodexThreadRoutes: () => routes,
        getPendingCodexNotifications: () => [],
        getPendingProviderRequests: () => [],
        getPendingCommands: () => [],
        getCommandStatus: (commandId: string) => commandStatuses.get(commandId),
        getMigrationState: () => 'ready',
        setMigrationState: vi.fn(async () => undefined),
        persistCodexThreadRoute: vi.fn(async (route: SyncV4CodexThreadRoute) => {
            routes.set(route.threadId, route);
        }),
        publishEntity: vi.fn(async () => ({})),
        publishEntities: vi.fn(async () => []),
        publishProviderRequestTransition: vi.fn(async () => ({})),
        persistProviderRequestTransition: vi.fn(async () => undefined),
        publishCommandTransition: vi.fn(async (
            pending: CodexCommandEntityV4,
            _result: unknown,
            status: SyncV4CommandJournalStatus,
        ) => {
            commandStatuses.set(pending.commandId, status);
            if (pending.command === 'thread.rollback') {
                order.push(`rollback.command.${status}`);
            }
            return {};
        }),
        flushOutboundOnce: vi.fn(async () => undefined),
        hasPendingOutbound: vi.fn(() => false),
        close: vi.fn(async () => undefined),
    } as unknown as SyncV4Client;
    const session = {
        sessionId: 'session-a',
        syncV4SessionKey: new Uint8Array(32).fill(9),
        on: vi.fn(),
        updateMetadataAndWait: vi.fn(async (update: (metadata: Metadata) => Metadata) => {
            sessionMetadata = update(sessionMetadata);
        }),
        enableSyncV4: vi.fn(async (createHandler: (
            client: SyncV4Client,
        ) => (event: SyncV4AppliedEntity) => Promise<void>) => {
            entityHandler = createHandler(sync);
            return sync;
        }),
        downloadAndDecryptAttachment: vi.fn(),
        close: vi.fn(async () => undefined),
    } as unknown as ApiSessionClientContract;
    const apiSession = (metadata: Metadata): ApiSession => ({
        id: 'session-a',
        seq: 0,
        encryptionKey: new Uint8Array(32).fill(9),
        encryptionVariant: 'dataKey',
        metadata,
        metadataVersion: 0,
        agentState: { controlledByUser: false },
        agentStateVersion: 0,
    });
    const api: CodexGatewayRuntimeFactoryApi = {
        getOrCreateSession: vi.fn(async (createOptions) => {
            capturedCreateOptions = createOptions;
            sessionMetadata = createOptions.metadata;
            return options.relayAvailable === false ? null : apiSession(createOptions.metadata);
        }),
        sessionSyncClient: vi.fn((apiSession) => {
            sessionMetadata = apiSession.metadata;
            return session;
        }),
        getMachineSessionSnapshot: vi.fn(async () => options.relayAvailable === false ? null : ({
            ...apiSession({
                path: '/workspace',
                flavor: 'codex',
                codexSyncVersion: 4,
                codexThreadId: 'thread-a',
            } as Metadata),
            active: false,
            archivedAt: options.archivedSession ? 1_000 : null,
            originMachineId: 'machine-a',
            machineDeletedAt: null,
            hasIndependentDataKey: true,
        })),
    };
    const releasePresence = vi.fn(async () => undefined);
    const presence = {
        claim: vi.fn(async (sessionId: string) => ({
            sessionId,
            leaseId: `lease-${sessionId}`,
            onTerminated: vi.fn(),
            release: releasePresence,
        })),
        terminateSession: vi.fn(async () => undefined),
    };
    const providerThread = thread();
    const client = {
        threadId: 'thread-a',
        sandboxEnabled: false,
        supportsTurnSteering: () => true,
        readThreadComplete: vi.fn(async ({ threadId }: { threadId: string }) => ({
            thread: threadId === 'thread-a' ? providerThread : thread(threadId),
        })),
        rollbackThread: vi.fn(async () => ({ thread: thread() })),
        getGoal: vi.fn(async () => ({ goal: null })),
        startTurnOnThread: vi.fn(async (_threadId, text) => {
            order.push(`provider.turn:${text}`);
            return { turnId: 'turn-a' };
        }),
        resumeThread: vi.fn(async ({ threadId }: { threadId: string }) => {
            order.push(`provider.resume:${threadId}`);
            return { threadId, model: 'gpt-test' };
        }),
    } as unknown as CodexAppServerClient;
    const assertCurrentGeneration = vi.fn((generation: number | undefined) => {
        order.push(`generation:${generation ?? 'missing'}`);
        if (generation !== 3) {
            throw new CodexV4CommandCancelledError(
                'bindingSuperseded',
                'stale generation',
            );
        }
    });
    const rootHandoff = {
        reserve: vi.fn(async ({ requestedThreadId }: { requestedThreadId: string | null }) => {
            order.push(`reserve:${requestedThreadId ?? 'new'}`);
            return { release: vi.fn(async () => { order.push('reservation.release'); }) };
        }),
        bind: vi.fn(async ({ targetThreadId }: { targetThreadId: string }) => {
            order.push(`handoff:${targetThreadId}`);
        }),
        reconcile: vi.fn(async () => null),
    };
    const reportSessionStarted = vi.fn(async () => ({}));
    const awaitNotificationBarrier = vi.fn(async () => {
        order.push('rollback.notificationBarrier.drained');
    });
    const factory = new CodexGatewayRuntimeFactory({
        gatewayId: 'gateway-a',
        sessionKeySeed: Buffer.alloc(32, 5).toString('base64url'),
        origin: 'terminal',
        machineId: 'machine-a',
        cwd: '/workspace',
        api,
        presence,
        client,
        codexCliVersion: { major: 0, minor: 145, patch: 0 },
        defaultPermissionMode: 'default',
        defaultModel: 'gpt-test',
        defaultEffort: 'high',
        modelCapabilities: [],
        terminalState: () => ({ state: 'attached', detachedAt: null }),
        awaitNotificationBarrier,
        rootHandoff,
        reportSessionStarted,
        resolveRootSessionConfig: options.existingSession ? () => ({
            cwd: '/workspace',
            permissionMode: 'safe-yolo',
            model: 'gpt-resumed',
            effort: 'max',
            existingSession: {
                sessionId: 'session-a',
                dataEncryptionKey: new Uint8Array(32).fill(9),
            },
        }) : undefined,
        now: () => 200,
    });
    return {
        factory,
        api,
        presence,
        releasePresence,
        session,
        sync,
        client,
        rootHandoff,
        awaitNotificationBarrier,
        reportSessionStarted,
        assertCurrentGeneration,
        order,
        routes,
        commandStatuses,
        capturedCreateOptions: () => capturedCreateOptions,
        sessionMetadata: () => sessionMetadata,
        emit: async (pending: CodexCommandEntityV4) => {
            if (!entityHandler) throw new Error('Sync handler was not initialized');
            await entityHandler({
                op: 'upsert',
                entity: pending,
            } as SyncV4AppliedEntity);
        },
    };
}

describe('CodexGatewayRuntimeFactory', () => {
    it('returns a deferred signal without constructing a partial Sync runtime while relay is offline', async () => {
        const harness = createHarness({ relayAvailable: false });

        const runtime = await harness.factory.tryCreate({
            threadId: 'thread-a',
            generation: 3,
            previousSessionId: null,
            registerThreadOwnership: vi.fn(),
            assertCurrentGeneration: harness.assertCurrentGeneration,
        });

        expect(runtime).toBeNull();
        expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
        expect(harness.capturedCreateOptions()).toMatchObject({
            tag: expect.stringMatching(/^codex-gateway-root-v1-/),
            metadata: expect.objectContaining({
                flavor: 'codex',
                codexSyncVersion: 4,
                codexThreadId: 'thread-a',
            }),
        });
    });

    it('loads a verified existing Sync v4 session without implicitly unarchiving it', async () => {
        const harness = createHarness({ existingSession: true });
        const runtime = await harness.factory.tryCreate({
            threadId: 'thread-a',
            generation: 4,
            previousSessionId: null,
            registerThreadOwnership: vi.fn(),
            assertCurrentGeneration: harness.assertCurrentGeneration,
        });

        expect(runtime?.sessionId).toBe('session-a');
        expect(harness.api.getMachineSessionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-a',
            machineId: 'machine-a',
            encryptionVariant: 'dataKey',
            timeoutMs: undefined,
        }));
        expect(harness.api.getOrCreateSession).not.toHaveBeenCalled();
        expect(harness.presence.claim).toHaveBeenCalledWith('session-a');
        expect(harness.sessionMetadata()).toMatchObject({
            permissionMode: 'safe-yolo',
            modelMode: 'gpt-resumed',
            effortLevel: 'max',
        });
        await runtime?.close();
        expect(harness.releasePresence).toHaveBeenCalledOnce();
    });

    it('rejects an archived existing session instead of implicitly reviving its tombstone', async () => {
        const harness = createHarness({ existingSession: true, archivedSession: true });

        await expect(harness.factory.tryCreate({
            threadId: 'thread-a',
            generation: 4,
            previousSessionId: null,
            registerThreadOwnership: vi.fn(),
            assertCurrentGeneration: harness.assertCurrentGeneration,
        })).rejects.toBeInstanceOf(CodexGatewayArchivedSessionError);

        expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
        expect(harness.presence.claim).not.toHaveBeenCalled();
    });

    it('runs raw App text through the current root and coordinates root switches outside the source router', async () => {
        const harness = createHarness();
        const runtime = await harness.factory.tryCreate({
            threadId: 'thread-a',
            generation: 3,
            previousSessionId: 'session-old',
            registerThreadOwnership: vi.fn(),
            assertCurrentGeneration: harness.assertCurrentGeneration,
        });
        expect(runtime).not.toBeNull();
        await runtime!.activate(thread());

        await harness.emit(command('turn.start', { text: 'plain user text' }));
        await harness.emit(command('thread.resume', { threadId: 'thread-b' }, {
            commandId: 'command-resume',
            providerId: 'command-resume',
            clientUserMessageId: 'command-resume',
            threadId: 'thread-b',
        }));

        expect(harness.order).toEqual([
            'generation:3',
            'provider.turn:plain user text',
            'generation:3',
            'reserve:thread-b',
            'generation:3',
            'provider.resume:thread-b',
            'handoff:thread-b',
        ]);
        expect(harness.client.startTurnOnThread).toHaveBeenCalledWith(
            'thread-a',
            'plain user text',
            expect.objectContaining({ clientUserMessageId: 'command-turn.start' }),
        );
        expect(harness.rootHandoff.bind).toHaveBeenCalledWith(expect.objectContaining({
            sourceThreadId: 'thread-a',
            sourceGeneration: 3,
            targetThreadId: 'thread-b',
        }));
        expect(harness.routes.has('thread-b')).toBe(false);
        expect(harness.commandStatuses.get('command-resume')).toBe('succeeded');
        expect(harness.sessionMetadata().codexGatewayBinding).toMatchObject({
            gatewayId: 'gateway-a',
            generation: 3,
            role: 'recovering',
        });
        expect(harness.reportSessionStarted).toHaveBeenCalledOnce();
        await runtime!.close();
    });

    it('publishes rollback success only after the authoritative snapshot is durable', async () => {
        const harness = createHarness();
        const runtime = await harness.factory.tryCreate({
            threadId: 'thread-a',
            generation: 3,
            previousSessionId: null,
            registerThreadOwnership: vi.fn(),
            assertCurrentGeneration: harness.assertCurrentGeneration,
        });
        await runtime!.activate(thread());
        let releaseNotificationBarrier!: () => void;
        const notificationBarrierGate = new Promise<void>((resolve) => {
            releaseNotificationBarrier = resolve;
        });
        harness.awaitNotificationBarrier.mockImplementationOnce(async () => {
            harness.order.push('rollback.notificationBarrier.started');
            await notificationBarrierGate;
            harness.order.push('rollback.notificationBarrier.drained');
        });
        vi.mocked(harness.client.readThreadComplete).mockImplementationOnce(async () => {
            harness.order.push('rollback.provider.responded');
            return { thread: thread() };
        });
        let releaseSnapshot!: () => void;
        const snapshotGate = new Promise<void>((resolve) => {
            releaseSnapshot = resolve;
        });
        vi.mocked(harness.sync.publishEntities).mockImplementationOnce(async () => {
            harness.order.push('rollback.snapshot.started');
            await snapshotGate;
            harness.order.push('rollback.snapshot.persisted');
            return [];
        });
        const clear = command('thread.rollback', { allTurns: true }, {
            commandId: 'command-clear',
            providerId: 'command-clear',
            clientUserMessageId: 'command-clear',
        });

        const pending = harness.emit(clear);
        await vi.waitFor(() => expect(harness.order).toContain('rollback.notificationBarrier.started'));
        expect(harness.order).not.toContain('rollback.snapshot.started');
        expect(harness.commandStatuses.get('command-clear')).toBe('executing');

        releaseNotificationBarrier();
        await vi.waitFor(() => expect(harness.order).toContain('rollback.snapshot.started'));
        expect(harness.commandStatuses.get('command-clear')).toBe('executing');

        releaseSnapshot();
        await pending;

        expect(harness.order).toContain('rollback.snapshot.persisted');
        expect(harness.commandStatuses.get('command-clear')).toBe('succeeded');
        expect(harness.order).toEqual([
            'rollback.command.received',
            'rollback.command.executing',
            'generation:3',
            'rollback.provider.responded',
            'rollback.notificationBarrier.started',
            'rollback.notificationBarrier.drained',
            'rollback.snapshot.started',
            'rollback.snapshot.persisted',
            'rollback.command.succeeded',
        ]);
        await runtime!.close();
    });

    it('retries local rollback coordination after snapshot persistence fails without replaying the provider RPC', async () => {
        const harness = createHarness();
        const runtime = await harness.factory.tryCreate({
            threadId: 'thread-a',
            generation: 3,
            previousSessionId: null,
            registerThreadOwnership: vi.fn(),
            assertCurrentGeneration: harness.assertCurrentGeneration,
        });
        await runtime!.activate(thread());
        vi.mocked(harness.client.readThreadComplete).mockResolvedValueOnce({
            thread: threadWithHistory(),
        });
        vi.mocked(harness.sync.publishEntities)
            .mockRejectedValueOnce(new Error('snapshot journal write failed'));

        await harness.emit(command('thread.rollback', { allTurns: true }, {
            commandId: 'command-clear-retry',
            providerId: 'command-clear-retry',
            clientUserMessageId: 'command-clear-retry',
        }));

        expect(harness.awaitNotificationBarrier).toHaveBeenCalledTimes(1);
        expect(harness.commandStatuses.get('command-clear-retry')).toBe('succeeded');
        expect(harness.client.readThreadComplete).toHaveBeenCalledTimes(1);
        expect(harness.client.rollbackThread).toHaveBeenCalledTimes(1);
        await runtime!.close();
    });

    it('marks rollback result unknown when the captured notification prefix is uncertain', async () => {
        const harness = createHarness();
        const runtime = await harness.factory.tryCreate({
            threadId: 'thread-a',
            generation: 3,
            previousSessionId: null,
            registerThreadOwnership: vi.fn(),
            assertCurrentGeneration: harness.assertCurrentGeneration,
        });
        await runtime!.activate(thread());
        const publishCount = vi.mocked(harness.sync.publishEntities).mock.calls.length;
        harness.awaitNotificationBarrier.mockRejectedValueOnce(
            new Error('notification pipeline failed'),
        );

        await harness.emit(command('thread.rollback', { allTurns: true }, {
            commandId: 'command-clear-unknown',
            providerId: 'command-clear-unknown',
            clientUserMessageId: 'command-clear-unknown',
        }));

        expect(harness.commandStatuses.get('command-clear-unknown')).toBe('resultUnknown');
        expect(harness.awaitNotificationBarrier).toHaveBeenCalledTimes(1);
        expect(vi.mocked(harness.sync.publishEntities)).toHaveBeenCalledTimes(publishCount);
        await runtime!.close();
    });

    it('does not retry rollback after an undurable notification failure', async () => {
        const harness = createHarness();
        const runtime = await harness.factory.tryCreate({
            threadId: 'thread-a',
            generation: 3,
            previousSessionId: null,
            registerThreadOwnership: vi.fn(),
            assertCurrentGeneration: harness.assertCurrentGeneration,
        });
        await runtime!.activate(thread());
        const fatal = new CodexV4NotificationRoutingError(
            'thread-a',
            false,
            new Error('orphan journal unavailable'),
        );
        vi.mocked(harness.client.readThreadComplete).mockResolvedValueOnce({
            thread: threadWithHistory(),
        });
        harness.awaitNotificationBarrier.mockRejectedValue(fatal);

        await harness.emit(command('thread.rollback', { allTurns: true }, {
            commandId: 'command-clear-undurable',
            providerId: 'command-clear-undurable',
            clientUserMessageId: 'command-clear-undurable',
        }));

        expect(harness.awaitNotificationBarrier).toHaveBeenCalledTimes(1);
        expect(harness.commandStatuses.get('command-clear-undurable')).toBe('resultUnknown');
        expect(harness.client.rollbackThread).toHaveBeenCalledTimes(1);
        await runtime!.close();
    });

    it('cancels a stale command before any provider side effect', async () => {
        const harness = createHarness();
        const runtime = await harness.factory.tryCreate({
            threadId: 'thread-a',
            generation: 3,
            previousSessionId: null,
            registerThreadOwnership: vi.fn(),
            assertCurrentGeneration: harness.assertCurrentGeneration,
        });
        await runtime!.activate(thread());

        await harness.emit(command('turn.start', { text: 'must not run' }, {
            bindingGeneration: 2,
        }));

        expect(harness.client.startTurnOnThread).not.toHaveBeenCalled();
        expect(harness.commandStatuses.get('command-turn.start')).toBe('cancelled');
        await runtime!.close();
    });

    it('releases a resume reservation after a known provider rejection but keeps it for an unknown outcome', async () => {
        const harness = createHarness();
        const runtime = await harness.factory.tryCreate({
            threadId: 'thread-a',
            generation: 3,
            previousSessionId: null,
            registerThreadOwnership: vi.fn(),
            assertCurrentGeneration: harness.assertCurrentGeneration,
        });
        await runtime!.activate(thread());
        vi.mocked(harness.client.resumeThread)
            .mockRejectedValueOnce(new Error('known rejection'))
            .mockRejectedValueOnce(new CodexRpcOutcomeUnknownError(
                'thread/resume',
                'transport closed after write',
            ));

        await harness.emit(command('thread.resume', { threadId: 'thread-b' }, {
            commandId: 'command-known',
            providerId: 'command-known',
            clientUserMessageId: 'command-known',
            threadId: 'thread-b',
        }));
        await harness.emit(command('thread.resume', { threadId: 'thread-c' }, {
            commandId: 'command-unknown',
            providerId: 'command-unknown',
            clientUserMessageId: 'command-unknown',
            threadId: 'thread-c',
        }));

        expect(harness.order.filter((entry) => entry === 'reservation.release')).toHaveLength(1);
        expect(harness.commandStatuses.get('command-known')).toBe('failed');
        expect(harness.commandStatuses.get('command-unknown')).toBe('resultUnknown');
        await runtime!.close();
    });
});
