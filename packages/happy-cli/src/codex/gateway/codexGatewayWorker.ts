import { rm } from 'node:fs/promises';
import { classifySyncV4DiagnosticError, type CodexCommandEntityV4 } from '@slopus/happy-wire';
import { ApiClient } from '@/api/api';
import { initialMachineMetadata } from '@/daemon/run';
import { readCredentials, readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { scopeCredentialsToCurrentRelay } from '@/ui/auth';
import { AsyncLock } from '@/utils/lock';
import { configuration } from '@/configuration';
import { CodexAppServerClient } from '../codexAppServerClient';
import {
    assertMinimumCodexCliVersion,
    readCodexCliVersion,
} from '../codexCliVersion';
import { loadCodexModelCapabilities } from '../codexModelCapabilities';
import { discoverCodexSkillCommands } from '../codexSkills';
import type { ReasoningEffort, Thread } from '../protocol';
import { CodexGatewayAttachmentManager } from './codexGatewayAttachment';
import {
    CodexGatewayCoordinator,
    type CodexGatewayRootRuntimeFactoryOptions,
} from './codexGatewayCoordinator';
import {
    startCodexGatewayControlServer,
    type CodexGatewayControlHandlers,
} from './codexGatewayControl';
import { CodexGatewayDeferredRuntime } from './codexGatewayDeferredRuntime';
import { CodexGatewayJournal } from './codexGatewayJournal';
import { CodexGatewayThreadLeaseRegistry } from './codexGatewayLease';
import { CodexGatewayProvider } from './codexGatewayProvider';
import {
    CodexGatewayProxy,
    type CodexGatewayRootRequest,
} from './codexGatewayProxy';
import { CodexGatewayRuntimeFactory } from './codexGatewayRuntimeFactory';
import {
    codexGatewayPaths,
    readCodexGatewayDescriptor,
    readCodexGatewaySecret,
    writeCodexGatewayDescriptor,
    type CodexGatewayBinding,
    type CodexGatewayDescriptor,
    type CodexGatewayPaths,
} from './codexGatewayState';

const HEARTBEAT_MS = 2_000;
const RELAY_REQUEST_TIMEOUT_MS = 1_500;
const GRACEFUL_STOP_WAIT_MS = 10_000;
const GRACEFUL_STOP_POLL_MS = 250;

interface DeferredRoot {
    runtime: CodexGatewayDeferredRuntime;
    factoryOptions: CodexGatewayRootRuntimeFactoryOptions;
}

export async function runCodexGatewayWorker(options: {
    gatewayId: string;
    happyHomeDir?: string;
    runtimeRoot?: string;
    heartbeatMs?: number;
}): Promise<void> {
    const paths = codexGatewayPaths(options.gatewayId, {
        happyHomeDir: options.happyHomeDir,
        runtimeRoot: options.runtimeRoot,
    });
    const initialDescriptor = await readCodexGatewayDescriptor(paths.descriptorPath);
    const secret = await readCodexGatewaySecret(paths.secretPath);
    if (!initialDescriptor || !secret || initialDescriptor.gatewayId !== secret.gatewayId) {
        throw new Error('Codex Gateway state is unavailable or inconsistent');
    }
    if (!initialDescriptor.providerSocketPath || !initialDescriptor.tuiSocketPath) {
        throw new Error('Codex Gateway worker currently requires private Unix sockets');
    }

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

    const journal = await CodexGatewayJournal.open({ path: paths.journalPath });
    const credentials = await readCredentials();
    if (!credentials) throw new Error('Happy authentication is required before starting Codex Gateway');
    const scopedCredentials = await scopeCredentialsToCurrentRelay(credentials, {
        skipProbeForBoundOrigin: true,
    });
    const settings = await readSettings();
    if (!settings.machineId) throw new Error('Happy machine registration is missing');
    const codexCliVersion = assertMinimumCodexCliVersion(readCodexCliVersion());
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

    const providerEndpoint = { socketPath: initialDescriptor.providerSocketPath };
    const tuiEndpoint = { socketPath: initialDescriptor.tuiSocketPath };
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
    let runtimeFactory: CodexGatewayRuntimeFactory | null = null;
    let coordinator: CodexGatewayCoordinator | null = null;
    let stopping = false;
    let shutdownPromise: Promise<void> | null = null;
    let controlServer: Awaited<ReturnType<typeof startCodexGatewayControlServer>> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

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
            const bound = await requireCoordinator().bindRoot(input.targetThreadId);
            await journal.recordHandoff({
                commandId: input.command.commandId,
                sourceThreadId: input.sourceThreadId,
                targetThreadId: input.targetThreadId,
                generation: bound.generation,
                state: 'bound',
                updatedAt: Date.now(),
            });
            await syncDescriptorBindings();
        },
        reconcile: async (command: CodexCommandEntityV4) => {
            const handoff = journal.handoff(command.commandId);
            if (!handoff) return null;
            if (handoff.state === 'bound') {
                return { action: 'succeeded' as const, threadId: handoff.targetThreadId };
            }
            try {
                const bound = await requireCoordinator().bindRoot(handoff.targetThreadId);
                await journal.recordHandoff({
                    ...handoff,
                    generation: bound.generation,
                    state: 'bound',
                    updatedAt: Date.now(),
                });
                await syncDescriptorBindings();
                return { action: 'succeeded' as const, threadId: handoff.targetThreadId };
            } catch {
                return { action: 'pending' as const };
            }
        },
    };

    const provider = new CodexGatewayProvider({
        cwd: initialDescriptor.cwd,
        endpoint: providerEndpoint,
        codexCliVersion,
        hooks: {
            stateChanged: (state) => {
                const lifecycle = state === 'recovering' ? 'recovering'
                    : state === 'stopping' ? 'stopping'
                        : state === 'stopped' ? 'stopped'
                            : state === 'running' ? 'running'
                                : 'starting';
                void updateGatewayLifecycle(lifecycle);
            },
            ready: async ({ recovered }) => {
                if (!coordinator) {
                    await client.connect();
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
            await requireCoordinator().bindRoot(binding.threadId);
            if (reservation?.release && reservation.threadId !== binding.threadId) {
                await leases.release(reservation.threadId, options.gatewayId);
            }
            await syncDescriptorBindings();
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
    };

    const stopSignal = () => { void requestShutdown(true); };
    process.once('SIGTERM', stopSignal);
    process.once('SIGINT', stopSignal);

    try {
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
        await provider.start();
        await proxy.start();
        await updateGatewayLifecycle('running');
        heartbeat = setInterval(() => { void heartbeatOnce(); }, options.heartbeatMs ?? HEARTBEAT_MS);
        await new Promise<void>((resolve, reject) => {
            const poll = setInterval(() => {
                if (!shutdownPromise) return;
                clearInterval(poll);
                void shutdownPromise.then(resolve, reject);
            }, 10);
            poll.unref();
        });
    } catch (error) {
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            state: 'stopped',
            lastError: safeErrorKind(error),
            heartbeatAt: Date.now(),
        })).catch(() => undefined);
        throw error;
    } finally {
        process.off('SIGTERM', stopSignal);
        process.off('SIGINT', stopSignal);
        if (heartbeat) clearInterval(heartbeat);
        terminal.dispose();
        const coordinatorAtShutdown = coordinator as CodexGatewayCoordinator | null;
        await Promise.allSettled([
            proxy.close(),
            coordinatorAtShutdown?.stop() ?? Promise.resolve(),
            provider.stop(),
        ]);
        await syncDescriptorBindings().catch(() => undefined);
        await controlServer?.close().catch(() => undefined);
        await journal.close().catch(() => undefined);
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            state: 'stopped',
            terminalState: descriptor.origin === 'app' ? 'headless' : descriptor.terminalState,
            heartbeatAt: Date.now(),
        })).catch(() => undefined);
        await Promise.all([
            rm(paths.providerSocketPath, { force: true }),
            rm(paths.tuiSocketPath, { force: true }),
            rm(paths.controlSocketPath, { force: true }),
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

    async function materializeDeferredRoots(): Promise<void> {
        if (!runtimeFactory || !coordinator || stopping) return;
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

    async function syncDescriptorBindings(): Promise<void> {
        if (!coordinator) return;
        const bindings = coordinator.bindingSnapshot();
        const current = bindings.find((binding) => binding.role === 'current') ?? null;
        const draining = bindings.filter((binding) => binding.role === 'draining');
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            current: current ? descriptorBinding(current) : null,
            draining: draining.map(descriptorBinding),
            heartbeatAt: Date.now(),
        }));
    }

    async function heartbeatOnce(): Promise<void> {
        if (stopping) return;
        try {
            await materializeDeferredRoots();
            await coordinator?.retireDrainingRoots();
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
                lastError: null,
            }));
        } catch (error) {
            recordWorkerError(error);
        }
    }

    async function requestShutdown(force: boolean): Promise<void> {
        if (shutdownPromise) return await shutdownPromise;
        stopping = true;
        shutdownPromise = (async () => {
            await updateGatewayLifecycle('stopping').catch(() => undefined);
            if (!force) await interruptCurrentTurnAndWait().catch(recordWorkerError);
        })();
        await shutdownPromise;
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
        while (Date.now() < deadline) {
            const snapshot = await client.readThreadComplete({ threadId, emitSnapshot: false });
            if (!activeTurnId(snapshot.thread)) return;
            await new Promise((resolve) => setTimeout(resolve, GRACEFUL_STOP_POLL_MS));
        }
        await descriptorStore.update((descriptor) => ({
            ...descriptor,
            lastError: 'turnOutcomeUnknown',
        }));
    }

    function recordWorkerError(error: unknown): void {
        void descriptorStore.update((descriptor) => ({
            ...descriptor,
            lastError: safeErrorKind(error),
            heartbeatAt: Date.now(),
        }));
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

function safeErrorKind(error: unknown): string {
    const classified = classifySyncV4DiagnosticError(error);
    return [...classified].slice(0, 128).join('');
}
