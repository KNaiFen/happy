import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { classifySyncV4DiagnosticError, type CodexCommandEntityV4 } from '@slopus/happy-wire';
import { ApiClient } from '@/api/api';
import { decodeBase64 } from '@/api/encryption';
import { initialMachineMetadata } from '@/daemon/initialMachineMetadata';
import { readCredentials, readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { scopeCredentialsToCurrentRelay } from '@/ui/auth';
import { AsyncLock } from '@/utils/lock';
import { configuration } from '@/configuration';
import { CodexAppServerClient, CodexRpcOutcomeUnknownError } from '../codexAppServerClient';
import {
    assertMinimumCodexCliVersion,
    readCodexCliVersion,
} from '../codexCliVersion';
import { loadCodexModelCapabilities } from '../codexModelCapabilities';
import { discoverCodexSkillCommands } from '../codexSkills';
import type { ReasoningEffort, Thread } from '../protocol';
import { resolveCodexExecutionPolicy } from '../executionPolicy';
import type { CodexAppServerWebSocketEndpoint } from '../codexAppServerWebSocket';
import { CodexGatewayAttachmentManager } from './codexGatewayAttachment';
import {
    CodexGatewayCoordinator,
    CodexGatewayRootBindingError,
    type CodexGatewayRootRuntimeFactoryOptions,
} from './codexGatewayCoordinator';
import {
    startCodexGatewayControlServer,
    type CodexGatewayOpenRootInput,
    type CodexGatewayOpenRootResult,
    type CodexGatewayControlHandlers,
} from './codexGatewayControl';
import { CodexGatewayDeferredRuntime } from './codexGatewayDeferredRuntime';
import { CodexGatewayJournal, type CodexGatewayBootstrap } from './codexGatewayJournal';
import { CodexGatewayThreadLeaseRegistry } from './codexGatewayLease';
import { CodexGatewayProvider } from './codexGatewayProvider';
import {
    inspectCodexGatewayProviderProcess,
    isExpectedCodexGatewayProviderProcess,
    isExpectedCodexGatewayWorkerProcess,
} from './codexGatewayProcessIdentity';
import {
    CodexGatewayProxy,
    type CodexGatewayRootRequest,
} from './codexGatewayProxy';
import {
    CodexGatewayRuntimeFactory,
    type CodexGatewayRootSessionConfig,
} from './codexGatewayRuntimeFactory';
import {
    codexGatewayPaths,
    CodexGatewaySocketPathTooLongError,
    readCodexGatewayDescriptor,
    readCodexGatewaySecret,
    writeCodexGatewayDescriptor,
    type CodexGatewayBinding,
    type CodexGatewayDescriptor,
    type CodexGatewayPaths,
} from './codexGatewayState';

const HEARTBEAT_MS = 2_000;
const RELAY_REQUEST_TIMEOUT_MS = 1_500;
const EXISTING_SESSION_LOOKUP_TIMEOUT_MS = 15_000;
const GRACEFUL_STOP_WAIT_MS = 10_000;
const GRACEFUL_STOP_POLL_MS = 250;
const GRACEFUL_STOP_RETRY_MS = 2_000;
const PROVIDER_BRIDGE_RETRY_DELAYS_MS = [50, 100, 250, 500, 1_000, 2_000] as const;
const FRESH_SUBSCRIPTION_RETRY_DELAYS_MS = [0, 50, 100, 250, 500, 1_000, 2_000] as const;

interface DeferredRoot {
    runtime: CodexGatewayDeferredRuntime;
    factoryOptions: CodexGatewayRootRuntimeFactoryOptions;
}

type RootSessionBootstrapConfig = Pick<
    CodexGatewayBootstrap,
    | 'cwd'
    | 'model'
    | 'permissionMode'
    | 'effortLevel'
    | 'parentSessionId'
    | 'forkedFromMessageId'
    | 'isSideChat'
    | 'happySessionId'
    | 'dataEncryptionKey'
>;

type CodexGatewayStartupStage =
    | 'state'
    | 'journal'
    | 'authentication'
    | 'configuration'
    | 'relay'
    | 'control'
    | 'provider'
    | 'bridge'
    | 'proxy'
    | 'ready';

export async function runCodexGatewayWorker(options: {
    gatewayId: string;
    happyHomeDir?: string;
    runtimeRoot?: string;
    heartbeatMs?: number;
}): Promise<void> {
    const startup: {
        stage: CodexGatewayStartupStage;
        earlyCleanup: (() => Promise<void>) | null;
    } = {
        stage: 'state',
        earlyCleanup: null,
    };
    const markStartupStage = (stage: CodexGatewayStartupStage): void => {
        if (startup.stage !== 'ready') startup.stage = stage;
    };
    try {
        await runCodexGatewayWorkerInternal(
            options,
            markStartupStage,
            () => startup.stage,
            (cleanup) => { startup.earlyCleanup = cleanup; },
        );
    } catch (error) {
        const cleanup = startup.earlyCleanup;
        startup.earlyCleanup = null;
        if (cleanup) await cleanup().catch(() => undefined);
        if (startup.stage !== 'ready') {
            await persistCodexGatewayStartupFailure(options, startup.stage, error)
                .catch(() => undefined);
        }
        throw error;
    }
}

async function runCodexGatewayWorkerInternal(
    options: {
        gatewayId: string;
        happyHomeDir?: string;
        runtimeRoot?: string;
        heartbeatMs?: number;
    },
    markStartupStage: (stage: CodexGatewayStartupStage) => void,
    currentStartupStage: () => CodexGatewayStartupStage,
    setEarlyCleanup: (cleanup: (() => Promise<void>) | null) => void,
): Promise<void> {
    const paths = codexGatewayPaths(options.gatewayId, {
        happyHomeDir: options.happyHomeDir,
        runtimeRoot: options.runtimeRoot,
    });
    const initialDescriptor = await readCodexGatewayDescriptor(paths.descriptorPath);
    const secret = await readCodexGatewaySecret(paths.secretPath);
    if (!initialDescriptor || !secret || initialDescriptor.gatewayId !== secret.gatewayId) {
        throw new Error('Codex Gateway state is unavailable or inconsistent');
    }
    if (initialDescriptor.state === 'stopped') {
        throw new Error('A stopped Codex Gateway cannot be restarted');
    }
    if (
        !initialDescriptor.providerSocketPath
        && (!initialDescriptor.providerPort || !secret.providerToken)
    ) {
        throw new Error('Codex Gateway provider endpoint is unavailable');
    }
    if (!initialDescriptor.tuiSocketPath && !initialDescriptor.tuiPort) {
        throw new Error('Codex Gateway TUI endpoint is unavailable');
    }
    const gatewayOrigin = initialDescriptor.origin;
    const gatewayCwd = initialDescriptor.cwd;
    const resumeGracefulStop = initialDescriptor.state === 'stopping';

    markStartupStage('journal');
    const journal = await CodexGatewayJournal.open({
        path: paths.journalPath,
        isProcessAlive: (pid) => isExpectedCodexGatewayWorkerProcess({
            pid,
            gatewayId: options.gatewayId,
        }),
    });
    setEarlyCleanup(() => journal.close());

    const descriptorStore = new CodexGatewayDescriptorStore(paths, {
        ...initialDescriptor,
        pid: process.pid,
        processStartedAt: Date.now(),
        heartbeatAt: Date.now(),
        state: 'starting',
        terminalState: initialDescriptor.origin === 'app' ? 'headless' : 'detached',
        terminalDetachedAt: initialDescriptor.origin === 'app' ? null : Date.now(),
        lastError: null,
    });
    await descriptorStore.persist();

    const rootSessionConfigs = new Map<string, RootSessionBootstrapConfig>();
    for (const bootstrap of journal.pendingBootstraps()) {
        rootSessionConfigs.set(bootstrap.resolvedThreadId, rootConfigFromBootstrap(bootstrap));
    }
    markStartupStage('authentication');
    const credentials = await readCredentials();
    if (!credentials) throw new Error('Happy authentication is required before starting Codex Gateway');
    const scopedCredentials = await scopeCredentialsToCurrentRelay(credentials, {
        skipProbeForBoundOrigin: true,
    });
    markStartupStage('configuration');
    const settings = await readSettings();
    if (!settings.machineId) throw new Error('Happy machine registration is missing');
    const codexCliVersion = assertMinimumCodexCliVersion(readCodexCliVersion());
    markStartupStage('relay');
    const api = await ApiClient.create(scopedCredentials);
    await api.getOrCreateMachine({
        machineId: settings.machineId,
        metadata: initialMachineMetadata,
    }).catch((error) => {
        logger.debug('[Codex Gateway] Initial machine refresh deferred', {
            errorKind: classifySyncV4DiagnosticError(error),
        });
        return null;
    });

    const providerEndpoint: CodexAppServerWebSocketEndpoint = initialDescriptor.providerSocketPath
        ? { socketPath: initialDescriptor.providerSocketPath }
        : {
            url: `ws://127.0.0.1:${initialDescriptor.providerPort}`,
            bearerToken: secret.providerToken!,
        };
    const tuiEndpoint: CodexAppServerWebSocketEndpoint = initialDescriptor.tuiSocketPath
        ? { socketPath: initialDescriptor.tuiSocketPath }
        : { url: `ws://127.0.0.1:${initialDescriptor.tuiPort}` };
    const providerListenEndpoint = initialDescriptor.providerSocketPath
        ? `unix://${initialDescriptor.providerSocketPath}`
        : `ws://127.0.0.1:${initialDescriptor.providerPort}`;
    const providerTokenFilePath = providerEndpoint.url ? paths.providerTokenPath : undefined;
    const client = new CodexAppServerClient(
        settings.sandboxConfig,
        codexCliVersion,
        { webSocketEndpoint: providerEndpoint },
    );
    const leases = new CodexGatewayThreadLeaseRegistry({
        happyHomeDir: options.happyHomeDir,
        pid: process.pid,
    });
    const deferredRoots = new Map<string, DeferredRoot>();
    const rootReservations = new Map<string, { threadId: string; release: boolean }>();
    const pendingFreshSubscriptions = new Set<string>();
    const freshSubscriptionTasks = new Map<string, Promise<void>>();
    const freshSubscriptionRetryWaiters = new Map<string, () => void>();
    let runtimeFactory: CodexGatewayRuntimeFactory | null = null;
    let coordinator: CodexGatewayCoordinator | null = null;
    let stopping = false;
    let freshSubscriptionRetriesClosed = false;
    let forceShutdownRequested = false;
    let shutdownPromise: Promise<void> | null = null;
    let wakeShutdownRetry: (() => void) | null = null;
    let controlServer: Awaited<ReturnType<typeof startCodexGatewayControlServer>> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let providerStarted = false;
    let preserveProviderEndpoint = false;
    const rootOpenLock = new AsyncLock();

    const terminal = new CodexGatewayAttachmentManager({
        origin: initialDescriptor.origin,
        initialState: initialDescriptor.origin === 'app' ? 'headless' : 'detached',
        onStateChanged: (state, detachedAt) => {
            void updateTerminalState(state, detachedAt);
        },
        onNormalExit: (action) => {
            if (action === 'stop') void requestShutdown(false);
        },
    });

    const requireCoordinator = (): CodexGatewayCoordinator => {
        if (!coordinator) throw new Error('Codex Gateway bridge is not ready');
        return coordinator;
    };

    const rootHandoff = {
        reserve: async (input: {
            command: CodexCommandEntityV4;
            requestedThreadId: string | null;
        }) => {
            if (!input.requestedThreadId) return null;
            const owner = await leases.owner(input.requestedThreadId);
            await leases.acquire(input.requestedThreadId, options.gatewayId);
            const newlyAcquired = owner !== options.gatewayId;
            return {
                release: async () => {
                    if (newlyAcquired) {
                        await leases.release(input.requestedThreadId!, options.gatewayId);
                    }
                },
            };
        },
        bind: async (input: {
            command: CodexCommandEntityV4;
            sourceThreadId: string;
            sourceGeneration: number;
            targetThreadId: string;
        }) => {
            await journal.recordHandoff({
                commandId: input.command.commandId,
                sourceThreadId: input.sourceThreadId,
                targetThreadId: input.targetThreadId,
                generation: input.sourceGeneration + 1,
                state: 'providerAccepted',
                updatedAt: Date.now(),
            });
            const bound = await requireCoordinator().bindRoot(input.targetThreadId, {
                subscription: input.command.command === 'thread.start'
                    ? 'bridgeStartedNewThread'
                    : 'resume',
            });
            syncPendingFreshSubscriptions();
            await journal.recordHandoff({
                commandId: input.command.commandId,
                sourceThreadId: input.sourceThreadId,
                targetThreadId: input.targetThreadId,
                generation: bound.generation,
                state: 'bound',
                updatedAt: Date.now(),
            });
            await syncDescriptorBindings({ clearRootBindingError: true });
        },
        reconcile: async (command: CodexCommandEntityV4) => {
            const handoff = journal.handoff(command.commandId);
            if (!handoff) return null;
            if (handoff.state === 'bound') {
                return { action: 'succeeded' as const, threadId: handoff.targetThreadId };
            }
            try {
                const bound = await requireCoordinator().bindRoot(handoff.targetThreadId, {
                    subscription: command.command === 'thread.start'
                        ? 'deferredNewThread'
                        : 'resume',
                });
                if (command.command === 'thread.start') {
                    await requireCoordinator().subscribeMaterializedRoot(handoff.targetThreadId);
                }
                syncPendingFreshSubscriptions();
                await journal.recordHandoff({
                    ...handoff,
                    generation: bound.generation,
                    state: 'bound',
                    updatedAt: Date.now(),
                });
                await syncDescriptorBindings({ clearRootBindingError: true });
                return { action: 'succeeded' as const, threadId: handoff.targetThreadId };
            } catch (error) {
                recordWorkerError(error);
                return { action: 'pending' as const };
            }
        },
    };

    const provider = new CodexGatewayProvider({
        cwd: initialDescriptor.cwd,
        endpoint: providerEndpoint,
        tokenFilePath: providerTokenFilePath,
        codexCliVersion,
        ...(initialDescriptor.providerPid ? {
            adoptExisting: {
                pid: initialDescriptor.providerPid,
                inspect: (pid: number) => inspectCodexGatewayProviderProcess({
                    pid,
                    listenEndpoint: providerListenEndpoint,
                    tokenFilePath: providerTokenFilePath,
                }),
                terminate: (pid: number) => terminateVerifiedProvider(pid),
            },
        } : {}),
        hooks: {
            processChanged: async ({ pid }) => {
                await descriptorStore.update((descriptor) => ({
                    ...descriptor,
                    providerPid: pid,
                    heartbeatAt: Date.now(),
                }));
            },
            stateChanged: (state) => {
                const lifecycle = state === 'recovering' ? 'recovering'
                    : state === 'stopping' ? 'stopping'
                        : state === 'stopped' ? 'stopped'
                            : state === 'running' ? 'running'
                                : 'starting';
                void updateGatewayLifecycle(lifecycle);
            },
            ready: async ({ epoch, recovered }) => {
                markStartupStage('bridge');
                if (!coordinator) {
                    await connectCodexGatewayProviderBridge(
                        client,
                        () => provider.currentEpoch === epoch && provider.pid !== null,
                    );
                    const models = await loadCodexModelCapabilities(client) ?? [];
                    const defaultModel = models.find((model) => model.isDefault) ?? models[0];
                    const modelCode = defaultModel?.code ?? 'gpt-5.5';
                    const defaultEffort = (defaultModel?.defaultThinkingLevel ?? 'medium') as ReasoningEffort;
                    const skills = await discoverCodexSkillCommands({ cwd: initialDescriptor.cwd });
                    runtimeFactory = new CodexGatewayRuntimeFactory({
                        gatewayId: options.gatewayId,
                        sessionKeySeed: secret.sessionKeySeed,
                        origin: initialDescriptor.origin,
                        machineId: settings.machineId!,
                        cwd: initialDescriptor.cwd,
                        api,
                        client,
                        codexCliVersion,
                        defaultPermissionMode: 'default',
                        defaultModel: modelCode,
                        defaultEffort,
                        modelCapabilities: models,
                        terminalState: () => ({
                            state: terminal.state,
                            detachedAt: terminal.state === 'detached' ? terminal.detachedAt : null,
                        }),
                        rootHandoff,
                        sandboxConfig: settings.sandboxConfig,
                        skillCommands: skills,
                        transportSecurity: relayTransportSecurity(),
                        relayRequestTimeoutMs: RELAY_REQUEST_TIMEOUT_MS,
                        existingSessionLookupTimeoutMs: EXISTING_SESSION_LOOKUP_TIMEOUT_MS,
                        resolveRootSessionConfig: (threadId) => {
                            const configured = rootSessionConfigs.get(threadId);
                            if (!configured) return null;
                            return {
                                cwd: configured.cwd,
                                permissionMode: configured.permissionMode,
                                model: configured.model ?? modelCode,
                                effort: (configured.effortLevel ?? defaultEffort) as ReasoningEffort,
                                ...(configured.parentSessionId
                                    ? { parentSessionId: configured.parentSessionId }
                                    : {}),
                                ...(configured.forkedFromMessageId
                                    ? { forkedFromMessageId: configured.forkedFromMessageId }
                                    : {}),
                                ...(configured.isSideChat ? { isSideChat: true } : {}),
                                ...(configured.happySessionId && configured.dataEncryptionKey
                                    ? {
                                        existingSession: {
                                            sessionId: configured.happySessionId,
                                            dataEncryptionKey: decodeRootSessionKey(
                                                configured.dataEncryptionKey,
                                            ),
                                        },
                                    }
                                    : {}),
                            } satisfies CodexGatewayRootSessionConfig;
                        },
                        onError: recordWorkerError,
                    });
                    coordinator = new CodexGatewayCoordinator({
                        gatewayId: options.gatewayId,
                        client,
                        leases,
                        initialGeneration: initialDescriptor.current?.generation ?? 0,
                        createRuntime: createRootRuntime,
                        onError: recordWorkerError,
                    });
                    await coordinator.connect();
                    const recoveredBindings = [
                        ...initialDescriptor.draining.map((binding) => ({
                            threadId: binding.threadId,
                            sessionId: binding.sessionId,
                            generation: binding.generation,
                            role: 'draining' as const,
                        })),
                        ...(initialDescriptor.current ? [{
                            threadId: initialDescriptor.current.threadId,
                            sessionId: initialDescriptor.current.sessionId,
                            generation: initialDescriptor.current.generation,
                            role: 'current' as const,
                        }] : []),
                    ];
                    await coordinator.restoreBindings(recoveredBindings);
                } else if (recovered) {
                    await coordinator.connect(true);
                }
                syncPendingFreshSubscriptions();
                await coordinator.setGatewayLifecycle('running');
                await coordinator.setTerminalState(terminal.state, terminal.detachedAt);
                await materializeDeferredRoots();
            },
            exited: ({ unexpected }) => {
                if (unexpected) void updateGatewayLifecycle('recovering');
            },
        },
    });

    const proxy = new CodexGatewayProxy(tuiEndpoint, providerEndpoint, {
        claimTerminal: (connectionId, bearerToken) => terminal.claim(connectionId, bearerToken),
        beforeRootRequest: async (request) => {
            if (!request.requestedThreadId) return;
            const owner = await leases.owner(request.requestedThreadId);
            await leases.acquire(request.requestedThreadId, options.gatewayId);
            rootReservations.set(rootRequestKey(request), {
                threadId: request.requestedThreadId,
                release: owner !== options.gatewayId,
            });
        },
        rootBound: async (binding) => {
            const reservation = rootReservations.get(rootRequestKey(binding));
            rootReservations.delete(rootRequestKey(binding));
            try {
                await requireCoordinator().bindRoot(binding.threadId, {
                    subscription: binding.providerSnapshot
                        ? 'terminalRootResponse'
                        : binding.method === 'thread/start'
                            ? 'deferredNewThread'
                            : 'resume',
                    ...(binding.providerSnapshot ? { providerSnapshot: binding.providerSnapshot } : {}),
                });
                syncPendingFreshSubscriptions();
            } catch (error) {
                const diagnosed = error instanceof CodexGatewayRootBindingError
                    ? error
                    : new CodexGatewayRootBindingError('runtime', error);
                await persistWorkerError(diagnosed);
                throw diagnosed;
            }
            if (reservation?.release && reservation.threadId !== binding.threadId) {
                try {
                    await leases.release(reservation.threadId, options.gatewayId);
                } catch (error) {
                    const diagnosed = new CodexGatewayRootBindingError('reservationRelease', error);
                    await persistWorkerError(diagnosed);
                    throw diagnosed;
                }
            }
            try {
                await syncDescriptorBindings({ clearRootBindingError: true });
            } catch (error) {
                const diagnosed = new CodexGatewayRootBindingError('descriptor', error);
                await persistWorkerError(diagnosed);
                throw diagnosed;
            }
        },
        threadMaterialized: (threadId) => {
            noteFreshSubscriptionActivity(threadId);
        },
        terminalNotification: (notification) => {
            requireCoordinator().observeTerminalNotification(notification);
        },
        rootFailed: async (request) => {
            const reservation = rootReservations.get(rootRequestKey(request));
            rootReservations.delete(rootRequestKey(request));
            if (reservation?.release) {
                await leases.release(reservation.threadId, options.gatewayId);
            }
        },
        terminalDisconnected: (connectionId) => terminal.disconnect(connectionId),
        protocolError: recordWorkerError,
    });

    const controlHandlers: CodexGatewayControlHandlers = {
        status: () => descriptorStore.snapshot(),
        terminalAttached: (input) => terminal.register(input),
        normalExit: (input) => terminal.normalExit(input),
        stop: (input) => {
            void requestShutdown(input.force);
            return { stopping: true, force: input.force };
        },
        openRoot: (input) => rootOpenLock.inLock(() => openHeadlessRoot(input)),
    };

    const stopSignal = () => { void requestShutdown(true); };
    process.once('SIGTERM', stopSignal);
    process.once('SIGINT', stopSignal);

    try {
        setEarlyCleanup(null);
        markStartupStage('control');
        controlServer = await startCodexGatewayControlServer({
            socketPath: initialDescriptor.controlSocketPath ?? undefined,
            port: initialDescriptor.controlSocketPath ? undefined : 0,
            token: secret.controlToken,
            handlers: controlHandlers,
        });
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            controlSocketPath: controlServer!.socketPath,
            controlPort: controlServer!.port,
        }));
        markStartupStage('provider');
        await provider.start();
        providerStarted = true;
        markStartupStage('proxy');
        await proxy.start();
        await updateGatewayLifecycle('running');
        markStartupStage('ready');
        heartbeat = setInterval(() => { void heartbeatOnce(); }, options.heartbeatMs ?? HEARTBEAT_MS);
        if (resumeGracefulStop) void requestShutdown(false);
        await new Promise<void>((resolve, reject) => {
            const poll = setInterval(() => {
                if (!shutdownPromise) return;
                clearInterval(poll);
                void shutdownPromise.then(resolve, reject);
            }, 10);
            poll.unref();
        });
    } catch (error) {
        preserveProviderEndpoint = provider.mustPreserveEndpoint || (
            !providerStarted
            && initialDescriptor.providerPid !== null
            && descriptorStore.snapshot().providerPid === initialDescriptor.providerPid
        );
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            state: preserveProviderEndpoint ? 'recovering' : 'stopped',
            lastError: startupFailureKind(currentStartupStage(), error),
            heartbeatAt: Date.now(),
        })).catch(() => undefined);
        throw error;
    } finally {
        process.off('SIGTERM', stopSignal);
        process.off('SIGINT', stopSignal);
        if (heartbeat) clearInterval(heartbeat);
        closeFreshSubscriptionRetries();
        terminal.dispose();
        const coordinatorAtShutdown = coordinator as CodexGatewayCoordinator | null;
        preserveProviderEndpoint ||= provider.requiresConservativeRecovery;
        const providerShutdown = preserveProviderEndpoint
            ? Promise.resolve(provider.releaseForWorkerRecovery())
            : provider.stop();
        await Promise.allSettled([
            proxy.close(),
            coordinatorAtShutdown?.stop({ force: true }) ?? Promise.resolve(),
            providerShutdown,
        ]);
        await Promise.allSettled([...freshSubscriptionTasks.values()]);
        await syncDescriptorBindings().catch(() => undefined);
        await controlServer?.close().catch(() => undefined);
        await journal.close().catch(() => undefined);
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            state: preserveProviderEndpoint ? 'recovering' : 'stopped',
            terminalState: descriptor.origin === 'app' ? 'headless' : descriptor.terminalState,
            heartbeatAt: Date.now(),
        })).catch(() => undefined);
        await Promise.all([
            rm(paths.tuiSocketPath, { force: true }),
            rm(paths.controlSocketPath, { force: true }),
            ...(preserveProviderEndpoint ? [] : [
                rm(paths.providerSocketPath, { force: true }),
                rm(paths.providerTokenPath, { force: true }),
            ]),
        ]).catch(() => undefined);
    }

    async function createRootRuntime(
        factoryOptions: CodexGatewayRootRuntimeFactoryOptions,
    ) {
        if (!runtimeFactory) throw new Error('Codex Gateway runtime factory is not ready');
        const materialized = await runtimeFactory.tryCreate(factoryOptions);
        if (materialized) return materialized;
        const deferred = new CodexGatewayDeferredRuntime({
            threadId: factoryOptions.threadId,
            journal,
            initialBinding: {
                role: 'recovering',
                generation: factoryOptions.generation,
                previousSessionId: factoryOptions.previousSessionId,
                nextSessionId: null,
                changedAt: Date.now(),
            },
            initialGatewayLifecycle: descriptorStore.snapshot().state,
            initialTerminalState: terminal.state,
            initialTerminalDetachedAt: terminal.detachedAt,
            readSnapshot: async () => (
                await client.readThreadComplete({
                    threadId: factoryOptions.threadId,
                    emitSnapshot: false,
                })
            ).thread,
        });
        deferredRoots.set(factoryOptions.threadId, { runtime: deferred, factoryOptions });
        return deferred;
    }

    async function openHeadlessRoot(
        input: CodexGatewayOpenRootInput,
    ): Promise<CodexGatewayOpenRootResult> {
        if (gatewayOrigin !== 'app') {
            throw new Error('Root control is only available for App-origin Gateways');
        }
        if (stopping) throw new Error('Codex Gateway is stopping');
        if (resolve(input.cwd) !== resolve(gatewayCwd)) {
            throw new Error('Root control working directory does not match the Gateway');
        }
        if (input.dataEncryptionKey) decodeRootSessionKey(input.dataEncryptionKey);
        const activeCoordinator = requireCoordinator();
        const existing = journal.bootstrap(input.operationId);
        let bridgeStartedNewThread = false;
        let threadId: string;
        if (existing) {
            await journal.recordBootstrap({
                ...bootstrapRecordInput(input, existing.resolvedThreadId),
                state: existing.state,
                updatedAt: Date.now(),
            });
            threadId = existing.resolvedThreadId;
        } else {
            const policy = resolveCodexExecutionPolicy(input.permissionMode, false);
            let releaseResumeLease = false;
            if (input.action === 'resume') {
                const requestedThreadId = input.threadId!;
                const owner = await leases.owner(requestedThreadId);
                await leases.acquire(requestedThreadId, options.gatewayId);
                releaseResumeLease = owner !== options.gatewayId;
            }
            try {
                const opened = input.action === 'start'
                    ? await client.startThread({
                        cwd: input.cwd,
                        model: input.model ?? undefined,
                        approvalPolicy: policy.approvalPolicy,
                        sandbox: policy.sandbox,
                    })
                    : await client.resumeThread({
                        threadId: input.threadId!,
                        cwd: input.cwd,
                        model: input.model ?? undefined,
                        approvalPolicy: policy.approvalPolicy,
                        sandbox: policy.sandbox,
                        emitSnapshot: false,
                    });
                threadId = opened.threadId;
                bridgeStartedNewThread = input.action === 'start';
            } catch (error) {
                if (releaseResumeLease && !(error instanceof CodexRpcOutcomeUnknownError)) {
                    await leases.release(input.threadId!, options.gatewayId).catch(() => false);
                }
                throw error;
            }
            const accepted = {
                ...bootstrapRecordInput(input, threadId),
                state: 'providerAccepted' as const,
                updatedAt: Date.now(),
            };
            await journal.recordBootstrap(accepted);
            rootSessionConfigs.set(threadId, rootConfigFromBootstrap(accepted));
        }

        const bound = await activeCoordinator.bindRoot(threadId, {
            subscription: input.action === 'start'
                ? bridgeStartedNewThread
                    ? 'bridgeStartedNewThread'
                    : 'deferredNewThread'
                : 'resume',
        });
        if (input.action === 'start' && !bridgeStartedNewThread) {
            try {
                await activeCoordinator.subscribeMaterializedRoot(threadId);
            } catch (error) {
                await persistWorkerError(error);
                throw error;
            }
        }
        syncPendingFreshSubscriptions();
        await journal.recordBootstrap({
            ...bootstrapRecordInput(input, threadId),
            state: 'bound',
            updatedAt: Date.now(),
        });
        await materializeDeferredRoots();
        await syncDescriptorBindings({ clearRootBindingError: true });
        const current = activeCoordinator.bindingSnapshot().find((binding) => (
            binding.threadId === threadId && binding.role === 'current'
        ));
        const sessionId = current?.sessionId ?? bound.sessionId;
        if (!sessionId) {
            throw new Error('Happy relay is unavailable after the Codex thread was accepted');
        }
        return {
            gatewayId: options.gatewayId,
            threadId,
            sessionId,
            generation: current?.generation ?? bound.generation,
        };
    }

    async function materializeDeferredRoots(): Promise<void> {
        if (!runtimeFactory || !coordinator) return;
        for (const [threadId, deferred] of deferredRoots) {
            if (deferred.runtime.isMaterialized) {
                await deferred.runtime.replayDeferred();
                deferredRoots.delete(threadId);
                continue;
            }
            const materialized = await runtimeFactory.tryCreate(deferred.factoryOptions);
            if (!materialized) continue;
            await deferred.runtime.materialize(materialized);
            deferredRoots.delete(threadId);
        }
        await coordinator.refreshBindingLinks();
        await syncDescriptorBindings();
    }

    function syncPendingFreshSubscriptions(): void {
        pendingFreshSubscriptions.clear();
        for (const threadId of coordinator?.pendingSubscriptionThreadIds() ?? []) {
            pendingFreshSubscriptions.add(threadId);
        }
        for (const threadId of pendingFreshSubscriptions) {
            scheduleFreshSubscriptionReconciliation(threadId);
        }
        for (const threadId of freshSubscriptionTasks.keys()) {
            if (!pendingFreshSubscriptions.has(threadId)) {
                wakeFreshSubscriptionRetry(threadId);
            }
        }
    }

    function noteFreshSubscriptionActivity(threadId: string): void {
        if (stopping || freshSubscriptionRetriesClosed) return;
        syncPendingFreshSubscriptions();
        scheduleFreshSubscriptionReconciliation(threadId);
        wakeFreshSubscriptionRetry(threadId);
    }

    function scheduleFreshSubscriptionReconciliation(threadId: string): void {
        if (
            stopping
            || freshSubscriptionRetriesClosed
            || !pendingFreshSubscriptions.has(threadId)
            || freshSubscriptionTasks.has(threadId)
        ) return;
        const task = reconcileFreshSubscription(threadId);
        freshSubscriptionTasks.set(threadId, task);
        const finish = () => {
            if (freshSubscriptionTasks.get(threadId) === task) {
                freshSubscriptionTasks.delete(threadId);
            }
        };
        void task.then(finish, (error) => {
            finish();
            if (!freshSubscriptionRetriesClosed) recordWorkerError(error);
        });
    }

    async function reconcileFreshSubscription(threadId: string): Promise<void> {
        for (let attempt = 0; ; attempt += 1) {
            await waitForFreshSubscriptionRetry(
                threadId,
                freshSubscriptionRetryDelay(attempt),
            );
            if (
                stopping
                || freshSubscriptionRetriesClosed
                || !pendingFreshSubscriptions.has(threadId)
            ) return;

            let subscribed: boolean;
            try {
                subscribed = await requireCoordinator().subscribeMaterializedRoot(threadId);
            } catch (error) {
                await persistObserverRetryError(error).catch(() => undefined);
                await reconcilePendingFreshSubscriptionSnapshot(threadId);
                syncPendingFreshSubscriptions();
                if (await finishFreshSubscriptionIfSettled(threadId)) return;
                continue;
            }

            if (!subscribed) {
                await reconcilePendingFreshSubscriptionSnapshot(threadId);
                syncPendingFreshSubscriptions();
                if (await finishFreshSubscriptionIfSettled(threadId)) return;
                continue;
            }

            syncPendingFreshSubscriptions();
            if (stopping || freshSubscriptionRetriesClosed) return;
            try {
                await syncDescriptorBindings({
                    clearRootBindingError: true,
                    clearObserverRetryError: true,
                });
            } catch (error) {
                const diagnosed = error instanceof CodexGatewayRootBindingError
                    ? error
                    : new CodexGatewayRootBindingError('descriptor', error);
                await persistWorkerError(diagnosed).catch(() => undefined);
            }
            return;
        }
    }

    async function reconcilePendingFreshSubscriptionSnapshot(threadId: string): Promise<void> {
        if (stopping || freshSubscriptionRetriesClosed || !pendingFreshSubscriptions.has(threadId)) return;
        try {
            await requireCoordinator().reconcilePendingRootSnapshot(threadId);
        } catch (error) {
            if (!stopping && !freshSubscriptionRetriesClosed) {
                await persistObserverRetryError(error).catch(() => undefined);
            }
        }
    }

    async function finishFreshSubscriptionIfSettled(threadId: string): Promise<boolean> {
        if (stopping || freshSubscriptionRetriesClosed || pendingFreshSubscriptions.has(threadId)) {
            return false;
        }
        await syncDescriptorBindings({ clearObserverRetryError: true }).catch(() => undefined);
        return true;
    }

    function freshSubscriptionRetryDelay(attempt: number): number {
        return FRESH_SUBSCRIPTION_RETRY_DELAYS_MS[
            Math.min(attempt, FRESH_SUBSCRIPTION_RETRY_DELAYS_MS.length - 1)
        ] ?? 2_000;
    }

    async function waitForFreshSubscriptionRetry(
        threadId: string,
        delayMs: number,
    ): Promise<void> {
        if (delayMs === 0 || freshSubscriptionRetriesClosed) {
            await Promise.resolve();
            return;
        }
        await new Promise<void>((resolveRetry) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (freshSubscriptionRetryWaiters.get(threadId) === finish) {
                    freshSubscriptionRetryWaiters.delete(threadId);
                }
                resolveRetry();
            };
            const timer = setTimeout(finish, delayMs);
            freshSubscriptionRetryWaiters.set(threadId, finish);
        });
    }

    function wakeFreshSubscriptionRetry(threadId: string): void {
        freshSubscriptionRetryWaiters.get(threadId)?.();
    }

    function closeFreshSubscriptionRetries(): void {
        if (freshSubscriptionRetriesClosed) return;
        freshSubscriptionRetriesClosed = true;
        for (const finish of [...freshSubscriptionRetryWaiters.values()]) finish();
    }

    async function updateGatewayLifecycle(
        state: CodexGatewayDescriptor['state'],
    ): Promise<void> {
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            state,
            heartbeatAt: Date.now(),
        }));
        await coordinator?.setGatewayLifecycle(state);
    }

    async function updateTerminalState(
        state: CodexGatewayDescriptor['terminalState'],
        detachedAt: number | null,
    ): Promise<void> {
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            terminalState: state,
            terminalDetachedAt: detachedAt,
            heartbeatAt: Date.now(),
        }));
        await coordinator?.setTerminalState(state, detachedAt);
    }

    async function syncDescriptorBindings(
        options: {
            clearRootBindingError?: boolean;
            clearObserverRetryError?: boolean;
        } = {},
    ): Promise<void> {
        if (!coordinator) return;
        const bindings = coordinator.bindingSnapshot();
        const current = bindings.find((binding) => binding.role === 'current') ?? null;
        const draining = bindings.filter((binding) => binding.role === 'draining');
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            current: current ? descriptorBinding(current) : null,
            draining: draining.map(descriptorBinding),
            heartbeatAt: Date.now(),
            lastError: (
                (options.clearRootBindingError && descriptor.lastError?.startsWith('rootBinding:'))
                || (options.clearObserverRetryError && descriptor.lastError?.startsWith('observerRetry:'))
            ) ? null : descriptor.lastError,
        }));
    }

    async function heartbeatOnce(): Promise<void> {
        if (stopping) return;
        try {
            await materializeDeferredRoots();
            await coordinator?.retireDrainingRoots();
            syncPendingFreshSubscriptions();
            const activeThreads = new Set(
                coordinator?.bindingSnapshot().map((binding) => binding.threadId) ?? [],
            );
            for (const handoff of journal.pendingHandoffs()) {
                if (handoff.state === 'bound' && !activeThreads.has(handoff.sourceThreadId)) {
                    await journal.completeHandoff(handoff.commandId);
                }
            }
            await syncDescriptorBindings();
            await descriptorStore.update((descriptor) => ({
                ...descriptor,
                heartbeatAt: Date.now(),
                lastError: isPersistentGatewayDiagnostic(descriptor.lastError)
                    ? descriptor.lastError
                    : null,
            }));
        } catch (error) {
            recordWorkerError(error);
        }
    }

    async function requestShutdown(force: boolean): Promise<void> {
        if (force) {
            forceShutdownRequested = true;
            wakeShutdownRetry?.();
        }
        if (shutdownPromise) {
            wakeShutdownRetry?.();
            return await shutdownPromise;
        }
        stopping = true;
        closeFreshSubscriptionRetries();
        shutdownPromise = (async () => {
            // Persist the externally visible lifecycle before taking any root lock.
            // A hanging observer read/resume can hold that lock until its transport
            // is closed below.
            await descriptorStore.update((descriptor) => ({
                ...descriptor,
                state: 'stopping',
                heartbeatAt: Date.now(),
            })).catch(() => undefined);
            if (!forceShutdownRequested) {
                await interruptCurrentTurnAndWait().catch(recordWorkerError);
            }
            // A pending observer resume/read holds the coordinator's root lock. This
            // connection is only the Gateway observer, so closing it cancels that
            // safe reconciliation RPC without implying anything about turn outcome.
            await client.disconnect().catch(recordWorkerError);
            await coordinator?.setGatewayLifecycle('stopping').catch(recordWorkerError);
            while (coordinator) {
                try {
                    if (!forceShutdownRequested) await materializeDeferredRoots();
                    await coordinator.stop({ force: forceShutdownRequested });
                    return;
                } catch (error) {
                    recordWorkerError(error);
                    if (forceShutdownRequested) {
                        await coordinator.stop({ force: true });
                        return;
                    }
                    await descriptorStore.update((descriptor) => ({
                        ...descriptor,
                        state: 'stopping',
                        heartbeatAt: Date.now(),
                    })).catch(() => undefined);
                    await waitForShutdownRetry();
                }
            }
        })();
        await shutdownPromise;
    }

    async function waitForShutdownRetry(): Promise<void> {
        await new Promise<void>((resolveRetry) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (wakeShutdownRetry === finish) wakeShutdownRetry = null;
                resolveRetry();
            };
            const timer = setTimeout(finish, GRACEFUL_STOP_RETRY_MS);
            wakeShutdownRetry = finish;
        });
    }

    async function interruptCurrentTurnAndWait(): Promise<void> {
        const threadId = coordinator?.currentThreadId;
        if (!threadId) return;
        const initial = await client.readThreadComplete({ threadId, emitSnapshot: false });
        const turnId = activeTurnId(initial.thread);
        if (!turnId) return;
        await client.interruptTurnOnThread(threadId, turnId, {
            timeoutMs: 5_000,
            propagateErrors: true,
        }).catch(() => undefined);
        const deadline = Date.now() + GRACEFUL_STOP_WAIT_MS;
        while (!forceShutdownRequested && Date.now() < deadline) {
            const snapshot = await client.readThreadComplete({ threadId, emitSnapshot: false });
            if (!activeTurnId(snapshot.thread)) return;
            await new Promise((resolve) => setTimeout(resolve, GRACEFUL_STOP_POLL_MS));
        }
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            lastError: 'turnOutcomeUnknown',
        }));
    }

    async function persistWorkerError(error: unknown): Promise<void> {
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            lastError: safeErrorKind(error),
            heartbeatAt: Date.now(),
        }));
    }

    async function persistObserverRetryError(error: unknown): Promise<void> {
        const diagnostic = observerRetryDiagnostic(error);
        if (descriptorStore.snapshot().lastError === diagnostic) return;
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            lastError: diagnostic,
            heartbeatAt: Date.now(),
        }));
    }

    function recordWorkerError(error: unknown): void {
        void persistWorkerError(error);
    }

    async function terminateVerifiedProvider(pid: number): Promise<void> {
        const isExpected = () => isExpectedCodexGatewayProviderProcess({
            pid,
            listenEndpoint: providerListenEndpoint,
            tokenFilePath: providerTokenFilePath,
        });
        if (!isExpected()) {
            throw new Error('Refusing to terminate an unverified Codex app-server process');
        }
        try {
            process.kill(pid, 'SIGTERM');
        } catch (error) {
            if (!processAlive(pid)) return;
            throw error;
        }
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
            if (!processAlive(pid)) return;
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        }
        if (!isExpected()) return;
        process.kill(pid, 'SIGKILL');
    }
}

class CodexGatewayDescriptorStore {
    private readonly lock = new AsyncLock();

    constructor(
        private readonly paths: CodexGatewayPaths,
        private descriptor: CodexGatewayDescriptor,
    ) {}

    snapshot(): CodexGatewayDescriptor {
        return structuredClone(this.descriptor);
    }

    async persist(): Promise<void> {
        await this.lock.inLock(async () => {
            await writeCodexGatewayDescriptor(this.paths, this.descriptor);
        });
    }

    async update(
        updater: (descriptor: CodexGatewayDescriptor) => CodexGatewayDescriptor,
    ): Promise<void> {
        await this.lock.inLock(async () => {
            const next = updater(structuredClone(this.descriptor));
            await writeCodexGatewayDescriptor(this.paths, next);
            this.descriptor = next;
        });
    }
}

function descriptorBinding(input: {
    threadId: string;
    sessionId: string | null;
    generation: number;
    role: 'current' | 'draining' | 'inactive' | 'recovering';
    title: string | null;
}): CodexGatewayBinding {
    return {
        threadId: input.threadId,
        sessionId: input.sessionId,
        generation: input.generation,
        role: input.role,
        title: input.title,
        changedAt: Date.now(),
    };
}

function rootRequestKey(request: Pick<CodexGatewayRootRequest, 'connectionId' | 'requestId'>): string {
    return `${request.connectionId}:${String(request.requestId)}`;
}

function bootstrapRecordInput(
    input: CodexGatewayOpenRootInput,
    resolvedThreadId: string,
): Omit<CodexGatewayBootstrap, 'state' | 'updatedAt'> {
    return {
        operationId: input.operationId,
        action: input.action,
        requestedThreadId: input.threadId,
        resolvedThreadId,
        cwd: input.cwd,
        model: input.model,
        permissionMode: input.permissionMode,
        effortLevel: input.effortLevel,
        parentSessionId: input.parentSessionId,
        forkedFromMessageId: input.forkedFromMessageId,
        isSideChat: input.isSideChat,
        happySessionId: input.happySessionId,
        dataEncryptionKey: input.dataEncryptionKey,
    };
}

function rootConfigFromBootstrap(
    bootstrap: CodexGatewayBootstrap,
): RootSessionBootstrapConfig {
    return {
        cwd: bootstrap.cwd,
        model: bootstrap.model,
        permissionMode: bootstrap.permissionMode,
        effortLevel: bootstrap.effortLevel,
        parentSessionId: bootstrap.parentSessionId,
        forkedFromMessageId: bootstrap.forkedFromMessageId,
        isSideChat: bootstrap.isSideChat,
        happySessionId: bootstrap.happySessionId,
        dataEncryptionKey: bootstrap.dataEncryptionKey,
    };
}

function decodeRootSessionKey(encoded: string): Uint8Array {
    const decoded = decodeBase64(encoded);
    if (decoded.length !== 32) throw new Error('Invalid Gateway session data key');
    return decoded;
}

function activeTurnId(thread: Thread): string | null {
    if (thread.status.type !== 'active') return null;
    for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
        const turn = thread.turns[index];
        if (turn?.status === 'inProgress') return turn.id;
    }
    return null;
}

function relayTransportSecurity(): 'https' | 'insecureHttp' {
    return new URL(configuration.serverUrl).protocol === 'http:' ? 'insecureHttp' : 'https';
}

async function connectCodexGatewayProviderBridge(
    client: Pick<CodexAppServerClient, 'connect'>,
    isCurrentProvider: () => boolean,
): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            await client.connect();
            return;
        } catch (error) {
            const kind = classifySyncV4DiagnosticError(error);
            const delayMs = PROVIDER_BRIDGE_RETRY_DELAYS_MS[attempt];
            if (
                delayMs === undefined
                || (kind !== 'network' && kind !== 'timeout')
                || !isCurrentProvider()
            ) {
                throw error;
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
            if (!isCurrentProvider()) throw error;
        }
    }
}

async function persistCodexGatewayStartupFailure(
    options: {
        gatewayId: string;
        happyHomeDir?: string;
        runtimeRoot?: string;
    },
    stage: Exclude<CodexGatewayStartupStage, 'ready'>,
    error: unknown,
): Promise<void> {
    const paths = codexGatewayPaths(options.gatewayId, {
        happyHomeDir: options.happyHomeDir,
        runtimeRoot: options.runtimeRoot,
    });
    const descriptor = await readCodexGatewayDescriptor(paths.descriptorPath);
    if (!descriptor || descriptor.state === 'running' || descriptor.state === 'stopping') return;
    await writeCodexGatewayDescriptor(paths, {
        ...descriptor,
        state: descriptor.state === 'starting' ? 'stopped' : descriptor.state,
        lastError: startupFailureKind(stage, error),
        heartbeatAt: Date.now(),
    });
}

function startupFailureKind(stage: CodexGatewayStartupStage, error: unknown): string {
    const kind = safeErrorKind(error);
    return stage === 'ready' ? kind : `startup:${stage}:${kind}`;
}

function safeErrorKind(error: unknown): string {
    if (error instanceof CodexGatewaySocketPathTooLongError) return 'socketPathTooLong';
    if (error instanceof CodexGatewayRootBindingError) {
        const causeKind = classifySyncV4DiagnosticError(error.diagnosticCause);
        return `rootBinding:${error.phase}:${causeKind}`;
    }
    const classified = classifySyncV4DiagnosticError(error);
    return [...classified].slice(0, 128).join('');
}

function observerRetryDiagnostic(error: unknown): string {
    const cause = error instanceof CodexGatewayRootBindingError
        ? error.diagnosticCause
        : error;
    return `observerRetry:${classifySyncV4DiagnosticError(cause)}`;
}

function isPersistentGatewayDiagnostic(value: string | null): boolean {
    return value?.startsWith('rootBinding:') === true
        || value?.startsWith('observerRetry:') === true;
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
