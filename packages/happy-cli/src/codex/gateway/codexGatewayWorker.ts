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
import {
    CodexAppServerClient,
    classifyCodexRpcFailure,
    isCodexThreadUnavailableRpcResponse,
} from '../codexAppServerClient';
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
    CodexGatewayControlOperationError,
    startCodexGatewayControlServer,
    type CodexGatewayOpenRootInput,
    type CodexGatewayOpenRootResult,
    type CodexGatewayControlHandlers,
} from './codexGatewayControl';
import { CodexGatewayDeferredRuntime } from './codexGatewayDeferredRuntime';
import { CodexGatewayJournal, type CodexGatewayBootstrap } from './codexGatewayJournal';
import { CodexGatewayThreadLeaseRegistry } from './codexGatewayLease';
import { CodexGatewayPresenceRegistry } from './codexGatewayPresence';
import { CodexGatewayProvider } from './codexGatewayProvider';
import {
    inspectCodexGatewayProviderProcess,
    isExpectedCodexGatewayProviderProcess,
    isExpectedCodexGatewayWorkerProcess,
} from './codexGatewayProcessIdentity';
import {
    CodexGatewayProxy,
    type CodexGatewayProxyErrorContext,
    type CodexGatewayRootRequest,
} from './codexGatewayProxy';
import {
    CodexGatewayRuntimeFactory,
    type CodexGatewayRootSessionConfig,
} from './codexGatewayRuntimeFactory';
import { CodexGatewayRuntimeBindingUpdateError } from './codexGatewaySyncRuntime';
import {
    codexGatewayPaths,
    CodexGatewaySocketPathTooLongError,
    ensureCodexGatewayRuntimeDirectories,
    readCodexGatewayDescriptor,
    readCodexGatewaySecret,
    writeCodexGatewayDescriptor,
    type CodexGatewayBinding,
    type CodexGatewayDescriptor,
    type CodexGatewayPaths,
    type CodexGatewayResumeBootstrap,
} from './codexGatewayState';

const HEARTBEAT_MS = 2_000;
const PRESENCE_TOUCH_MS = 60_000;
const RELAY_REQUEST_TIMEOUT_MS = 1_500;
const EXISTING_SESSION_LOOKUP_TIMEOUT_MS = 15_000;
const GRACEFUL_STOP_WAIT_MS = 10_000;
const GRACEFUL_STOP_POLL_MS = 250;
const GRACEFUL_STOP_RETRY_MS = 2_000;
const PROVIDER_BRIDGE_RETRY_DELAYS_MS = [50, 100, 250, 500, 1_000, 2_000] as const;
const FRESH_SUBSCRIPTION_RETRY_DELAYS_MS = [0, 50, 100, 250, 500, 1_000, 2_000] as const;
const DEFERRED_ROOT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;

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
    presenceTouchMs?: number;
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
        presenceTouchMs?: number;
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
    await ensureCodexGatewayRuntimeDirectories(paths);
    const gatewayOrigin = initialDescriptor.origin;
    const gatewayCwd = initialDescriptor.cwd;
    const gatewayBootstrapOperationId = initialDescriptor.bootstrapOperationId;
    const gatewayResumeBootstrap = secret.resumeBootstrap;
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

    const workerStartedAt = Date.now();
    const descriptorStore = new CodexGatewayDescriptorStore(paths, {
        ...initialDescriptor,
        pid: process.pid,
        processStartedAt: workerStartedAt,
        heartbeatAt: workerStartedAt,
        state: 'starting',
        terminalState: initialDescriptor.origin === 'app' ? 'headless' : 'detached',
        terminalDetachedAt: initialDescriptor.origin === 'app' ? null : Date.now(),
        lastError: null,
        lifecycle: {
            ...initialDescriptor.lifecycle,
            controlledStartedAt: workerStartedAt,
            lastHeartbeatAt: workerStartedAt,
        },
    });
    await descriptorStore.persist();

    const rootSessionConfigs = new Map<string, RootSessionBootstrapConfig>();
    if (gatewayResumeBootstrap) {
        if (resolve(gatewayResumeBootstrap.cwd) !== resolve(gatewayCwd)) {
            throw new Error('Codex Gateway private resume working directory is inconsistent');
        }
        decodeRootSessionKey(gatewayResumeBootstrap.dataEncryptionKey);
        rootSessionConfigs.set(
            gatewayResumeBootstrap.threadId,
            rootConfigFromResumeBootstrap(gatewayResumeBootstrap),
        );
    }
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
    const presence = new CodexGatewayPresenceRegistry({
        api,
        requestTimeoutMs: RELAY_REQUEST_TIMEOUT_MS,
        onError: recordWorkerError,
    });
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
    const deferredRootTasks = new Map<string, Promise<void>>();
    const deferredRootAttempts = new Map<string, Promise<boolean>>();
    const deferredRootRetryWaiters = new Map<string, () => void>();
    const rootReservations = new Map<string, { threadId: string; release: boolean }>();
    const pendingFreshSubscriptions = new Set<string>();
    const freshSubscriptionTasks = new Map<string, Promise<void>>();
    const freshSubscriptionRetryWaiters = new Map<string, () => void>();
    let runtimeFactory: CodexGatewayRuntimeFactory | null = null;
    let coordinator: CodexGatewayCoordinator | null = null;
    let stopping = false;
    let freshSubscriptionRetriesClosed = false;
    let deferredRootRetriesClosed = false;
    let forceShutdownRequested = false;
    let shutdownPromise: Promise<void> | null = null;
    let wakeShutdownRetry: (() => void) | null = null;
    let controlServer: Awaited<ReturnType<typeof startCodexGatewayControlServer>> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let presenceHeartbeat: ReturnType<typeof setInterval> | null = null;
    let heartbeatPromise: Promise<void> | null = null;
    let presenceTouchPromise: Promise<void> | null = null;
    let periodicTicksClosed = false;
    let providerStarted = false;
    let preserveProviderEndpoint = false;
    const rootOpenLock = new AsyncLock();
    const cancelledRootOpenOperations = new Set<string>();
    const indeterminateRootStartOperations = new Set<string>();
    const rootOpenThreadIds = new Map<string, string>();

    const terminal = new CodexGatewayAttachmentManager({
        origin: initialDescriptor.origin,
        initialState: initialDescriptor.origin === 'app' ? 'headless' : 'detached',
        onStateChanged: (state, detachedAt) => {
            void updateTerminalState(state, detachedAt);
        },
        onNormalExit: (action) => {
            void recordLifecycleTimestamp('normalExitedAt');
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
                        presence,
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
                        onRootPresenceTerminated: async ({ threadId, sessionId }) => {
                            deferredRoots.delete(threadId);
                            const removed = await coordinator?.relinquishSession(sessionId) ?? false;
                            if (removed) await syncDescriptorBindings();
                        },
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
                wakeDeferredRootRetries();
                await materializeDeferredRoots();
            },
            exited: ({ unexpected }) => {
                void recordLifecycleTimestamp('providerExitedAt');
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
                await syncDescriptorBindings({
                    clearRootBindingError: true,
                    clearProxyError: true,
                });
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
        protocolError: (error, context) => {
            if (!context.closesTransport) {
                recordWorkerError(error);
                return;
            }
            void persistWorkerProxyError(error, context);
        },
    });

    const controlHandlers: CodexGatewayControlHandlers = {
        status: () => descriptorStore.snapshot(),
        terminalAttached: (input) => terminal.register(input),
        presenceReconcile: async ({ sessionId }) => {
            const reconciled = await presence.reconcile(sessionId);
            if (!reconciled) throw new Error('Codex Gateway session presence could not be reconciled');
            return { reconciled: true };
        },
        normalExit: (input) => terminal.normalExit(input),
        stop: (input) => {
            void recordLifecycleTimestamp('normalExitedAt');
            void requestShutdown(input.force);
            return { stopping: true, force: input.force };
        },
        cancelRoot: ({ operationId }) => cancelHeadlessRootOpen(operationId),
        openRoot: (input) => rootOpenLock.inLock(() => openHeadlessRoot(input)),
    };

    const stopSignal = () => {
        void recordLifecycleTimestamp('signalStoppedAt');
        void requestShutdown(true);
    };
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
            onError: () => { void recordLifecycleTimestamp('controlChannelErrorAt'); },
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
        heartbeat = setInterval(runHeartbeatTick, options.heartbeatMs ?? HEARTBEAT_MS);
        presenceHeartbeat = setInterval(runPresenceTouchTick, options.presenceTouchMs ?? PRESENCE_TOUCH_MS);
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
        closePeriodicTicks();
        await settlePeriodicTicks();
        closeFreshSubscriptionRetries();
        closeDeferredRootRetries();
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
        await presence.releaseAll().catch(recordWorkerError);
        await Promise.allSettled([...freshSubscriptionTasks.values()]);
        await Promise.allSettled([...deferredRootTasks.values()]);
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
        scheduleDeferredRootMaterialization(factoryOptions.threadId);
        return deferred;
    }

    async function cancelHeadlessRootOpen(operationId: string): Promise<{
        cancelled: true;
        relinquished: boolean;
    }> {
        assertRootOperationMatchesGateway(operationId);
        cancelledRootOpenOperations.add(operationId);
        const threadId = rootThreadIdForOperation(operationId);
        const relinquished = threadId
            ? await relinquishHeadlessRoot(threadId)
            : false;
        if (threadId && !relinquished) {
            await leases.release(threadId, options.gatewayId).catch((error) => {
                recordWorkerError(error);
                return false;
            });
        }
        rootOpenThreadIds.delete(operationId);
        return { cancelled: true, relinquished };
    }

    function rootThreadIdForOperation(operationId: string): string | null {
        const pendingThreadId = rootOpenThreadIds.get(operationId);
        if (pendingThreadId) return pendingThreadId;
        if (gatewayBootstrapOperationId === operationId && gatewayResumeBootstrap) {
            return gatewayResumeBootstrap.threadId;
        }
        return journal.bootstrap(operationId)?.resolvedThreadId ?? null;
    }

    function assertRootOpenNotCancelled(operationId: string): void {
        if (cancelledRootOpenOperations.has(operationId)) {
            throw new CodexGatewayControlOperationError('conflict');
        }
    }

    function assertRootOperationMatchesGateway(operationId: string): void {
        if (gatewayBootstrapOperationId && gatewayBootstrapOperationId !== operationId) {
            throw new CodexGatewayControlOperationError('conflict');
        }
    }

    async function abortCancelledRootOpen(operationId: string, threadId: string): Promise<void> {
        if (!cancelledRootOpenOperations.has(operationId)) return;
        const relinquished = await relinquishHeadlessRoot(threadId);
        if (!relinquished) {
            await leases.release(threadId, options.gatewayId).catch((error) => {
                recordWorkerError(error);
                return false;
            });
        }
        rootOpenThreadIds.delete(operationId);
        throw new CodexGatewayControlOperationError('conflict');
    }

    async function relinquishHeadlessRoot(threadId: string): Promise<boolean> {
        deferredRoots.delete(threadId);
        deferredRootRetryWaiters.get(threadId)?.();
        const relinquished = await coordinator?.relinquishThread(threadId) ?? false;
        if (relinquished) await syncDescriptorBindings();
        return relinquished;
    }

    async function openHeadlessRoot(
        input: CodexGatewayOpenRootInput,
    ): Promise<CodexGatewayOpenRootResult> {
        if (gatewayOrigin !== 'app') {
            throw new CodexGatewayControlOperationError('conflict');
        }
        if (stopping) throw new CodexGatewayControlOperationError('conflict');
        assertRootOperationMatchesGateway(input.operationId);
        assertRootOpenNotCancelled(input.operationId);
        if (indeterminateRootStartOperations.has(input.operationId)) {
            throw new CodexGatewayControlOperationError('outcomeUnknown');
        }
        const privateResume = input.action === 'resume' ? gatewayResumeBootstrap : null;
        if (gatewayResumeBootstrap && input.action !== 'resume') {
            throw new CodexGatewayControlOperationError('conflict');
        }
        if (
            privateResume
            && gatewayBootstrapOperationId !== input.operationId
        ) {
            throw new CodexGatewayControlOperationError('conflict');
        }
        if (privateResume && (
            input.threadId !== null
            || input.cwd !== null
            || input.model !== null
            || input.permissionMode !== 'default'
            || input.effortLevel !== null
            || input.parentSessionId !== null
            || input.forkedFromMessageId !== null
            || input.isSideChat
        )) {
            throw new CodexGatewayControlOperationError('conflict');
        }
        const effectiveInput: CodexGatewayOpenRootInput = privateResume
            ? {
                ...input,
                threadId: privateResume.threadId,
                cwd: privateResume.cwd,
                model: privateResume.model,
                permissionMode: privateResume.permissionMode,
                effortLevel: privateResume.effortLevel,
            }
            : {
                ...input,
                cwd: input.cwd ?? gatewayCwd,
            };
        if (effectiveInput.action === 'resume' && !effectiveInput.threadId) {
            throw new CodexGatewayControlOperationError('conflict');
        }
        const effectiveCwd = effectiveInput.cwd ?? gatewayCwd;
        if (resolve(effectiveCwd) !== resolve(gatewayCwd)) {
            throw new CodexGatewayControlOperationError('conflict');
        }
        const activeCoordinator = requireCoordinator();
        const currentPrivateBinding = privateResume
            ? activeCoordinator.bindingSnapshot().find((binding) => (
                binding.role === 'current' && binding.threadId === privateResume.threadId
            )) ?? null
            : null;
        if (
            currentPrivateBinding?.sessionId
            && currentPrivateBinding.sessionId !== privateResume?.happySessionId
        ) {
            throw new CodexGatewayControlOperationError('conflict');
        }
        const existing = privateResume ? null : journal.bootstrap(input.operationId);
        let bridgeStartedNewThread = false;
        let threadId: string;
        let providerAccepted = Boolean(currentPrivateBinding || existing);
        try {
            if (currentPrivateBinding && privateResume) {
                threadId = privateResume.threadId;
            } else if (existing) {
                await journal.recordBootstrap({
                    ...bootstrapRecordInput(effectiveInput, existing.resolvedThreadId, gatewayCwd),
                    state: existing.state,
                    updatedAt: Date.now(),
                });
                threadId = existing.resolvedThreadId;
            } else {
                const policy = resolveCodexExecutionPolicy(effectiveInput.permissionMode, false);
                let releaseResumeLease = false;
                if (effectiveInput.action === 'resume') {
                    const requestedThreadId = effectiveInput.threadId!;
                    rootOpenThreadIds.set(input.operationId, requestedThreadId);
                    assertRootOpenNotCancelled(input.operationId);
                    const owner = await leases.owner(requestedThreadId);
                    await leases.acquire(requestedThreadId, options.gatewayId);
                    releaseResumeLease = owner !== options.gatewayId;
                    await abortCancelledRootOpen(input.operationId, requestedThreadId);
                }
                try {
                    assertRootOpenNotCancelled(input.operationId);
                    const opened = effectiveInput.action === 'start'
                        ? await client.startThread({
                            cwd: effectiveCwd,
                            model: effectiveInput.model ?? undefined,
                            approvalPolicy: policy.approvalPolicy,
                            sandbox: policy.sandbox,
                        })
                        : await client.resumeThread({
                            threadId: effectiveInput.threadId!,
                            cwd: effectiveCwd,
                            model: effectiveInput.model ?? undefined,
                            approvalPolicy: policy.approvalPolicy,
                            sandbox: policy.sandbox,
                            emitSnapshot: false,
                        });
                    threadId = opened.threadId;
                    providerAccepted = true;
                    rootOpenThreadIds.set(input.operationId, threadId);
                    await abortCancelledRootOpen(input.operationId, threadId);
                    if (privateResume && threadId !== privateResume.threadId) {
                        throw new Error('Codex provider resumed a different thread identity');
                    }
                    bridgeStartedNewThread = effectiveInput.action === 'start';
                } catch (error) {
                    if (error instanceof CodexGatewayControlOperationError) throw error;
                    const failure = classifyCodexRpcFailure(error);
                    if (failure === 'outcomeUnknown' && effectiveInput.action === 'start') {
                        indeterminateRootStartOperations.add(input.operationId);
                    }
                    if (releaseResumeLease && failure !== 'outcomeUnknown') {
                        await leases.release(effectiveInput.threadId!, options.gatewayId).catch(() => false);
                        rootOpenThreadIds.delete(input.operationId);
                    }
                    throw new CodexGatewayControlOperationError(
                        failure === 'outcomeUnknown'
                            ? 'outcomeUnknown'
                            : effectiveInput.action === 'resume'
                                && isCodexThreadUnavailableRpcResponse(error, effectiveInput.threadId!)
                                ? 'threadUnavailable'
                                : 'operationFailed',
                    );
                }
                if (!privateResume) {
                    const accepted = {
                        ...bootstrapRecordInput(effectiveInput, threadId, gatewayCwd),
                        state: 'providerAccepted' as const,
                        updatedAt: Date.now(),
                    };
                    await journal.recordBootstrap(accepted);
                    rootSessionConfigs.set(threadId, rootConfigFromBootstrap(accepted));
                }
            }

            await abortCancelledRootOpen(input.operationId, threadId);
            const bound = await activeCoordinator.bindRoot(threadId, {
                subscription: effectiveInput.action === 'start'
                    ? bridgeStartedNewThread
                        ? 'bridgeStartedNewThread'
                        : 'deferredNewThread'
                    : 'resume',
            });
            await abortCancelledRootOpen(input.operationId, threadId);
            if (effectiveInput.action === 'start' && !bridgeStartedNewThread) {
                try {
                    await activeCoordinator.subscribeMaterializedRoot(threadId);
                } catch (error) {
                    await persistWorkerError(error);
                    throw error;
                }
            }
            syncPendingFreshSubscriptions();
            if (!privateResume) {
                await journal.recordBootstrap({
                    ...bootstrapRecordInput(effectiveInput, threadId, gatewayCwd),
                    state: 'bound',
                    updatedAt: Date.now(),
                });
            }
            await materializeDeferredRoots();
            await syncDescriptorBindings({ clearRootBindingError: true });
            await abortCancelledRootOpen(input.operationId, threadId);
            const current = activeCoordinator.bindingSnapshot().find((binding) => (
                binding.threadId === threadId && binding.role === 'current'
            ));
            const sessionId = current?.sessionId ?? bound.sessionId;
            if (!sessionId) {
                throw new Error('Happy relay is unavailable after the Codex thread was accepted');
            }
            if (privateResume && sessionId !== privateResume.happySessionId) {
                throw new Error('Codex Gateway resumed a different Happy session identity');
            }
            return {
                gatewayId: options.gatewayId,
                threadId,
                sessionId,
                generation: current?.generation ?? bound.generation,
            };
        } catch (error) {
            if (error instanceof CodexGatewayControlOperationError) throw error;
            throw new CodexGatewayControlOperationError(
                providerAccepted ? 'outcomeUnknown' : 'operationFailed',
            );
        }
    }

    async function materializeDeferredRoots(): Promise<void> {
        if (!runtimeFactory || !coordinator) return;
        await Promise.all([...deferredRoots.keys()].map((threadId) => (
            materializeDeferredRootOnce(threadId)
        )));
    }

    async function materializeDeferredRootOnce(threadId: string): Promise<boolean> {
        const pending = deferredRootAttempts.get(threadId);
        if (pending) return await pending;
        const attempt = (async () => {
            if (!runtimeFactory || !coordinator) return false;
            const deferred = deferredRoots.get(threadId);
            if (!deferred) return true;
            if (deferred.runtime.isMaterialized) {
                await deferred.runtime.replayDeferred();
                await coordinator.refreshBindingLinks();
                await syncDescriptorBindings();
                deferredRoots.delete(threadId);
                return true;
            }
            const materialized = await runtimeFactory.tryCreate(deferred.factoryOptions);
            if (!materialized) return false;
            await deferred.runtime.materialize(materialized);
            await coordinator.refreshBindingLinks();
            await syncDescriptorBindings();
            deferredRoots.delete(threadId);
            return true;
        })();
        deferredRootAttempts.set(threadId, attempt);
        try {
            return await attempt;
        } finally {
            if (deferredRootAttempts.get(threadId) === attempt) {
                deferredRootAttempts.delete(threadId);
            }
        }
    }

    function scheduleDeferredRootMaterialization(threadId: string): void {
        if (stopping || deferredRootRetriesClosed || deferredRootTasks.has(threadId)) return;
        const task = reconcileDeferredRoot(threadId);
        deferredRootTasks.set(threadId, task);
        const finish = () => {
            if (deferredRootTasks.get(threadId) === task) deferredRootTasks.delete(threadId);
        };
        void task.then(finish, (error) => {
            finish();
            if (!deferredRootRetriesClosed) recordWorkerError(error);
        });
    }

    async function reconcileDeferredRoot(threadId: string): Promise<void> {
        for (let attempt = 0; ; attempt += 1) {
            await waitForDeferredRootRetry(threadId, deferredRootRetryDelay(attempt));
            if (stopping || deferredRootRetriesClosed || !deferredRoots.has(threadId)) return;
            try {
                if (await materializeDeferredRootOnce(threadId)) return;
            } catch (error) {
                await persistObserverRetryError(error).catch(() => undefined);
            }
        }
    }

    function deferredRootRetryDelay(attempt: number): number {
        return DEFERRED_ROOT_RETRY_DELAYS_MS[
            Math.min(attempt, DEFERRED_ROOT_RETRY_DELAYS_MS.length - 1)
        ] ?? 30_000;
    }

    async function waitForDeferredRootRetry(threadId: string, delayMs: number): Promise<void> {
        if (deferredRootRetriesClosed) return;
        await new Promise<void>((resolveRetry) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (deferredRootRetryWaiters.get(threadId) === finish) {
                    deferredRootRetryWaiters.delete(threadId);
                }
                resolveRetry();
            };
            const timer = setTimeout(finish, delayMs);
            deferredRootRetryWaiters.set(threadId, finish);
        });
    }

    function wakeDeferredRootRetries(): void {
        for (const threadId of deferredRoots.keys()) {
            scheduleDeferredRootMaterialization(threadId);
            deferredRootRetryWaiters.get(threadId)?.();
        }
    }

    function closeDeferredRootRetries(): void {
        if (deferredRootRetriesClosed) return;
        deferredRootRetriesClosed = true;
        for (const finish of [...deferredRootRetryWaiters.values()]) finish();
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
            clearProxyError?: boolean;
        } = {},
    ): Promise<void> {
        if (!coordinator) return;
        const bindings = coordinator.bindingSnapshot();
        const current = bindings.find((binding) => binding.role === 'current') ?? null;
        const draining = bindings
            .filter((binding) => binding.role === 'draining')
            .sort((left, right) => left.generation - right.generation);
        await descriptorStore.update((descriptor) => {
            const previousBindings = new Map(
                [descriptor.current, ...descriptor.draining]
                    .filter((binding): binding is CodexGatewayBinding => binding !== null)
                    .map((binding) => [binding.threadId, binding]),
            );
            return {
                ...descriptor,
                current: current
                    ? descriptorBinding(current, previousBindings.get(current.threadId))
                    : null,
                draining: draining.map((binding) => (
                    descriptorBinding(binding, previousBindings.get(binding.threadId))
                )),
                heartbeatAt: Date.now(),
                lastError: (
                    (options.clearRootBindingError && descriptor.lastError?.startsWith('rootBinding:'))
                    || (options.clearObserverRetryError && descriptor.lastError?.startsWith('observerRetry:'))
                    || (options.clearProxyError && descriptor.lastError?.startsWith('proxy:'))
                ) ? null : descriptor.lastError,
            };
        });
    }

    async function heartbeatOnce(): Promise<void> {
        if (stopping) return;
        try {
            const recoveredBinding = await coordinator?.recoverPendingBinding() ?? false;
            if (recoveredBinding) {
                syncPendingFreshSubscriptions();
                await syncDescriptorBindings({ clearRootBindingError: true });
            }
            const heartbeatAt = Date.now();
            await descriptorStore.update((descriptor) => ({
                ...descriptor,
                heartbeatAt,
                lastError: isPersistentGatewayDiagnostic(descriptor.lastError)
                    ? descriptor.lastError
                    : null,
                lifecycle: {
                    ...descriptor.lifecycle,
                    lastHeartbeatAt: heartbeatAt,
                },
            }));
        } catch (error) {
            await persistWorkerError(error).catch(() => undefined);
        }
    }

    function runHeartbeatTick(): void {
        if (stopping || periodicTicksClosed || heartbeatPromise) return;
        const task = heartbeatOnce();
        heartbeatPromise = task;
        void task.then(
            () => {
                if (heartbeatPromise === task) heartbeatPromise = null;
            },
            () => {
                if (heartbeatPromise === task) heartbeatPromise = null;
            },
        );
    }

    function runPresenceTouchTick(): void {
        if (stopping || periodicTicksClosed || presenceTouchPromise) return;
        const task = presence.touchAll().catch(async (error) => {
            await persistWorkerError(error).catch(() => undefined);
        });
        presenceTouchPromise = task;
        void task.then(
            () => {
                if (presenceTouchPromise === task) presenceTouchPromise = null;
            },
            () => {
                if (presenceTouchPromise === task) presenceTouchPromise = null;
            },
        );
    }

    function closePeriodicTicks(): void {
        if (periodicTicksClosed) return;
        periodicTicksClosed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (presenceHeartbeat) clearInterval(presenceHeartbeat);
    }

    async function settlePeriodicTicks(): Promise<void> {
        await Promise.allSettled([
            heartbeatPromise ?? Promise.resolve(),
            presenceTouchPromise ?? Promise.resolve(),
        ]);
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
        closePeriodicTicks();
        closeFreshSubscriptionRetries();
        shutdownPromise = (async () => {
            await settlePeriodicTicks();
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

    async function persistWorkerProxyError(
        error: unknown,
        context: CodexGatewayProxyErrorContext,
    ): Promise<void> {
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            lastError: `proxy:${context.phase}:${safeProxyTransportErrorKind(error)}`,
            heartbeatAt: Date.now(),
        }));
    }

    function recordWorkerError(error: unknown): void {
        void persistWorkerError(error);
    }

    async function recordLifecycleTimestamp(
        field: 'normalExitedAt' | 'signalStoppedAt' | 'providerExitedAt' | 'controlChannelErrorAt',
    ): Promise<void> {
        const occurredAt = Date.now();
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            lifecycle: {
                ...descriptor.lifecycle,
                [field]: occurredAt,
            },
        })).catch(() => undefined);
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
}, previous?: CodexGatewayBinding): CodexGatewayBinding {
    if (
        previous
        && previous.threadId === input.threadId
        && previous.sessionId === input.sessionId
        && previous.generation === input.generation
        && previous.role === input.role
        && previous.title === input.title
    ) {
        return previous;
    }
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
    fallbackCwd: string,
): Omit<CodexGatewayBootstrap, 'state' | 'updatedAt'> {
    return {
        operationId: input.operationId,
        action: input.action,
        requestedThreadId: input.threadId,
        resolvedThreadId,
        cwd: input.cwd ?? fallbackCwd,
        model: input.model,
        permissionMode: input.permissionMode,
        effortLevel: input.effortLevel,
        parentSessionId: input.parentSessionId,
        forkedFromMessageId: input.forkedFromMessageId,
        isSideChat: input.isSideChat,
        happySessionId: null,
        dataEncryptionKey: null,
    };
}

function rootConfigFromResumeBootstrap(
    bootstrap: CodexGatewayResumeBootstrap,
): RootSessionBootstrapConfig {
    return {
        cwd: bootstrap.cwd,
        model: bootstrap.model,
        permissionMode: bootstrap.permissionMode,
        effortLevel: bootstrap.effortLevel,
        parentSessionId: null,
        forkedFromMessageId: null,
        isSideChat: false,
        happySessionId: bootstrap.happySessionId,
        dataEncryptionKey: bootstrap.dataEncryptionKey,
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
    const nodeErrorCode = safeNodeErrorCode(error);
    if (nodeErrorCode) return nodeErrorCode;
    if (error instanceof CodexGatewaySocketPathTooLongError) return 'socketPathTooLong';
    if (error instanceof CodexGatewayRootBindingError) {
        if (error.diagnosticCause instanceof CodexGatewayRuntimeBindingUpdateError) {
            const causeKind = classifySyncV4DiagnosticError(
                error.diagnosticCause.diagnosticCause,
            );
            return `rootBinding:${error.phase}:${error.diagnosticCause.phase}:${causeKind}`;
        }
        const causeKind = classifySyncV4DiagnosticError(error.diagnosticCause);
        return `rootBinding:${error.phase}:${causeKind}`;
    }
    const classified = classifySyncV4DiagnosticError(error);
    return [...classified].slice(0, 128).join('');
}

const SAFE_NODE_ERROR_CODES = new Set([
    'ENOENT',
    'EACCES',
    'ENOTDIR',
    'EEXIST',
    'EPERM',
    'EROFS',
    'ELOOP',
    'ENOSPC',
    'EIO',
    'EADDRINUSE',
]);

function safeNodeErrorCode(error: unknown): string | null {
    try {
        if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
        const code = (error as { code?: unknown }).code;
        return typeof code === 'string' && SAFE_NODE_ERROR_CODES.has(code) ? code : null;
    } catch {
        return null;
    }
}

function safeProxyTransportErrorKind(error: unknown): string {
    const record = error && typeof error === 'object' && !Array.isArray(error)
        ? error as Record<string, unknown>
        : {};
    const code = typeof record.code === 'string' ? record.code : '';
    switch (code) {
        case 'EPIPE':
            return 'brokenPipe';
        case 'ECONNRESET':
            return 'connectionReset';
        case 'ECONNREFUSED':
            return 'connectionRefused';
        case 'ERR_STREAM_WRITE_AFTER_END':
            return 'writeAfterEnd';
        case 'WS_ERR_EXPECTED_FIN':
            return 'expectedFinalFrame';
        case 'WS_ERR_EXPECTED_MASK':
            return 'expectedMask';
        case 'WS_ERR_INVALID_CLOSE_CODE':
            return 'invalidCloseCode';
        case 'WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH':
            return 'invalidControlPayloadLength';
        case 'WS_ERR_INVALID_OPCODE':
            return 'invalidOpcode';
        case 'WS_ERR_INVALID_UTF8':
            return 'invalidUtf8';
        case 'WS_ERR_UNEXPECTED_MASK':
            return 'unexpectedMask';
        case 'WS_ERR_UNEXPECTED_RSV_1':
            return 'unexpectedRsv1';
        case 'WS_ERR_UNEXPECTED_RSV_2_3':
            return 'unexpectedRsv23';
        case 'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH':
            return 'unsupportedDataPayloadLength';
        case 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH':
            return 'unsupportedMessageLength';
        default:
            return safeErrorKind(error);
    }
}

function observerRetryDiagnostic(error: unknown): string {
    const cause = error instanceof CodexGatewayRootBindingError
        ? error.diagnosticCause
        : error;
    return `observerRetry:${classifySyncV4DiagnosticError(cause)}`;
}

function isPersistentGatewayDiagnostic(value: string | null): boolean {
    return value?.startsWith('rootBinding:') === true
        || value?.startsWith('observerRetry:') === true
        || value?.startsWith('proxy:') === true;
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
