import type {
    CodexCommandEntityV4,
    SyncV4DiagnosticSink,
    SyncV4DiagnosticTransportSecurity,
} from '@slopus/happy-wire';
import type { ApiClient } from '@/api/api';
import type { ApiSessionClientContract } from '@/api/apiSession';
import type {
    CodexModelCapability,
    PermissionMode,
    Session as ApiSession,
    MachineSessionSnapshot,
} from '@/api/types';
import { encodeBase64 } from '@/api/encryption';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import type { SandboxConfig } from '@/persistence';
import { logger } from '@/ui/logger';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { classifySyncV4DiagnosticError } from '@slopus/happy-wire';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { CodexRpcOutcomeUnknownError } from '../codexAppServerClient';
import { formatCodexCliVersion, type CodexCliVersion } from '../codexCliVersion';
import { resolveCodexEffortForModel } from '../codexEffortValidation';
import { resolveCodexExecutionPolicy } from '../executionPolicy';
import { prepareCodexImageInputItems } from '../utils/imageInput';
import { CodexSyncV4Mapper } from '../codexSyncV4Mapper';
import { closeCodexV4BindingResources } from '../codexShutdown';
import { deriveCodexV4ChildSessionIdentity } from '../codexV4ChildIdentity';
import { CodexV4CommandExecutor } from '../codexV4CommandExecutor';
import type {
    CodexV4CommandOutcome,
    CodexV4CommandReconciliation,
} from '../codexV4CommandProcessor';
import { CodexV4CommandProcessor } from '../codexV4CommandProcessor';
import {
    assertCodexV4CommandThreadOwnership,
    assertCodexV4ReadOnlyCommand,
    codexV4CommandTargetThreadId,
    reconcileCodexV4CoordinatedRoute,
    registerCodexV4CommandOutcome,
} from '../codexV4CommandRouting';
import { CodexV4RequestBroker } from '../codexV4RequestBroker';
import {
    CodexV4ThreadRouter,
    type CodexV4SessionBinding,
} from '../codexV4ThreadRouter';
import type { CodexTerminalRuntimeProjection } from '../codexSyncV4Mapper';
import type { ReasoningEffort } from '../protocol';
import {
    CodexGatewaySyncRuntime,
    type CodexGatewayLifecycleState,
} from './codexGatewaySyncRuntime';
import type {
    CodexGatewayRootRuntime,
    CodexGatewayRootRuntimeFactoryOptions,
} from './codexGatewayCoordinator';
import { deriveCodexGatewayRootSessionIdentity } from './codexGatewayIdentity';

const ROOT_HANDOFF_COMMANDS = new Set([
    'thread.start',
    'thread.resume',
    'thread.fork',
]);
const GATEWAY_PERMISSION_MODES = new Set<PermissionMode>([
    'default',
    'read-only',
    'safe-yolo',
    'yolo',
]);

export interface CodexGatewayRuntimeFactoryApi {
    getOrCreateSession(options: Parameters<ApiClient['getOrCreateSession']>[0]): Promise<ApiSession | null>;
    unarchiveSession(sessionId: string, timeoutMs?: number): Promise<boolean>;
    sessionSyncClient(session: ApiSession): ApiSessionClientContract;
    archiveSessionV4(sessionId: string): Promise<boolean>;
    getMachineSessionSnapshot?(options: Parameters<ApiClient['getMachineSessionSnapshot']>[0]): Promise<MachineSessionSnapshot | null>;
}

export interface CodexGatewayRootHandoffHooks {
    reserve?(input: {
        command: CodexCommandEntityV4;
        sourceThreadId: string;
        sourceGeneration: number;
        requestedThreadId: string | null;
    }): Promise<{ release(): Promise<void> } | null>;
    bind(input: {
        command: CodexCommandEntityV4;
        sourceThreadId: string;
        sourceGeneration: number;
        targetThreadId: string;
        outcome: CodexV4CommandOutcome;
    }): Promise<void>;
    reconcile(command: CodexCommandEntityV4): Promise<CodexV4CommandReconciliation | null>;
}

export interface CodexGatewayRootSessionConfig {
    cwd: string;
    permissionMode: PermissionMode;
    model: string;
    effort: ReasoningEffort;
    parentSessionId?: string;
    forkedFromMessageId?: string;
    isSideChat?: boolean;
    existingSession?: {
        sessionId: string;
        dataEncryptionKey: Uint8Array;
    };
}

export interface CodexGatewayRuntimeFactoryOptions {
    gatewayId: string;
    sessionKeySeed: string;
    origin: 'terminal' | 'app';
    machineId: string;
    cwd: string;
    api: CodexGatewayRuntimeFactoryApi;
    client: CodexAppServerClient;
    codexCliVersion: CodexCliVersion;
    defaultPermissionMode: PermissionMode;
    defaultModel: string;
    defaultEffort: ReasoningEffort;
    modelCapabilities: readonly CodexModelCapability[];
    terminalState(): CodexTerminalRuntimeProjection;
    rootHandoff: CodexGatewayRootHandoffHooks;
    sandboxConfig?: SandboxConfig;
    skillCommands?: string[];
    diagnostics?: SyncV4DiagnosticSink;
    transportSecurity?: SyncV4DiagnosticTransportSecurity;
    initialGatewayState?: CodexGatewayLifecycleState;
    now?: () => number;
    onError?: (error: unknown) => void;
    onSessionMaterialized?: (input: {
        threadId: string;
        session: ApiSession;
    }) => Promise<void> | void;
    onSessionArchived?: (sessionId: string) => void;
    reportSessionStarted?: typeof notifyDaemonSessionStarted;
    relayRequestTimeoutMs?: number;
    existingSessionLookupTimeoutMs?: number;
    resolveRootSessionConfig?(threadId: string): CodexGatewayRootSessionConfig | null;
}

/** Creates fully materialized Sync v4 runtimes. Relay-offline roots stay in the worker journal. */
export class CodexGatewayRuntimeFactory {
    constructor(private readonly options: CodexGatewayRuntimeFactoryOptions) {}

    async tryCreate(
        factoryOptions: CodexGatewayRootRuntimeFactoryOptions,
    ): Promise<CodexGatewayRootRuntime | null> {
        const rootConfig = this.options.resolveRootSessionConfig?.(factoryOptions.threadId) ?? {
            cwd: this.options.cwd,
            permissionMode: this.options.defaultPermissionMode,
            model: this.options.defaultModel,
            effort: this.options.defaultEffort,
        };
        const created = createSessionMetadata({
            flavor: 'codex',
            machineId: this.options.machineId,
            cwd: rootConfig.cwd,
            startedBy: this.options.origin === 'app' ? 'daemon' : 'terminal',
            sandbox: this.options.sandboxConfig,
            dangerouslySkipPermissions: isDangerousPermissionMode(
                rootConfig.permissionMode,
            ),
            parentSessionId: rootConfig.parentSessionId,
            forkedFromMessageId: rootConfig.forkedFromMessageId,
            isSideChat: rootConfig.isSideChat,
        });
        const terminal = this.options.terminalState();
        created.metadata.codexThreadId = factoryOptions.threadId;
        created.metadata.codexSyncVersion = 4;
        created.metadata.codexCapabilities = {
            queueSteering: this.options.client.supportsTurnSteering(),
        };
        created.metadata.permissionMode = rootConfig.permissionMode;
        created.metadata.modelMode = rootConfig.model;
        created.metadata.effortLevel = rootConfig.effort;
        created.metadata.codexGatewayBinding = {
            gatewayId: this.options.gatewayId,
            generation: factoryOptions.generation,
            origin: this.options.origin,
            role: 'recovering',
            terminal: terminal.state === 'attached' ? 'attached' : 'unattached',
            ...(factoryOptions.previousSessionId
                ? { previousSessionId: factoryOptions.previousSessionId }
                : {}),
            changedAt: this.now(),
        };
        if (this.options.skillCommands?.length) {
            created.metadata.skills = [...this.options.skillCommands];
            created.metadata.slashCommands = Array.from(new Set([
                ...(created.metadata.slashCommands ?? []),
                ...this.options.skillCommands,
            ]));
        }

        let session: ApiSession | null;
        if (rootConfig.existingSession) {
            if (!this.options.api.getMachineSessionSnapshot) {
                throw new Error('Existing Gateway session loading is unavailable');
            }
            const snapshot = await this.options.api.getMachineSessionSnapshot({
                sessionId: rootConfig.existingSession.sessionId,
                machineId: this.options.machineId,
                encryptionKey: rootConfig.existingSession.dataEncryptionKey,
                encryptionVariant: 'dataKey',
                timeoutMs: this.options.existingSessionLookupTimeoutMs,
            });
            if (snapshot && (
                snapshot.metadata.flavor !== 'codex'
                || snapshot.metadata.codexSyncVersion !== 4
                || snapshot.metadata.codexThreadId !== factoryOptions.threadId
            )) {
                throw new Error('Existing Happy session does not match the Codex Gateway thread');
            }
            session = snapshot ? {
                ...snapshot,
                metadata: {
                    ...snapshot.metadata,
                    ...created.metadata,
                },
            } : null;
        } else {
            const identity = await deriveCodexGatewayRootSessionIdentity({
                gatewayId: this.options.gatewayId,
                sessionKeySeed: this.options.sessionKeySeed,
                threadId: factoryOptions.threadId,
            });
            session = await this.options.api.getOrCreateSession({
                tag: identity.tag,
                metadata: created.metadata,
                state: created.state,
                dataEncryptionKey: identity.sessionKey,
                timeoutMs: this.options.relayRequestTimeoutMs,
            });
        }
        if (!session) return null;
        if (!await this.options.api.unarchiveSession(
            session.id,
            this.options.relayRequestTimeoutMs,
        )) return null;

        const target = this.options.api.sessionSyncClient(session);
        target.skipExistingMessages();
        target.on('archived', () => this.options.onSessionArchived?.(target.sessionId));
        let rootBinding: CodexV4SessionBinding | null = null;
        let router: CodexV4ThreadRouter | null = null;
        try {
            rootBinding = await this.createBinding({
                target,
                rootThreadId: factoryOptions.threadId,
                generation: factoryOptions.generation,
                readOnly: false,
                closeSession: true,
                router: () => router,
                assertCurrentGeneration: factoryOptions.assertCurrentGeneration,
                defaultCwd: rootConfig.cwd,
            });
            router = new CodexV4ThreadRouter({
                rootBinding,
                readThread: async (threadId) => (
                    await this.options.client.readThreadComplete({
                        threadId,
                        emitSnapshot: false,
                    })
                ).thread,
                readGoal: async (threadId) => (
                    await this.options.client.getGoal({ threadId })
                ).goal,
                createChildBinding: async (route, parentBinding) => (
                    await this.createChildBinding(route.thread, parentBinding)
                ),
                onError: (error) => this.reportError(error),
                diagnostics: this.options.diagnostics,
                diagnosticSessionHash: rootBinding.syncClient.diagnosticSessionHash,
                softwareVersion: created.metadata.version,
                codexVersion: formatCodexCliVersion(this.options.codexCliVersion),
                transportSecurity: this.options.transportSecurity,
                onRouteRegistered: factoryOptions.registerThreadOwnership,
            });
            const runtime = new CodexGatewaySyncRuntime({
                gatewayId: this.options.gatewayId,
                origin: this.options.origin,
                rootThreadId: factoryOptions.threadId,
                initialBinding: {
                    role: 'recovering',
                    generation: factoryOptions.generation,
                    previousSessionId: factoryOptions.previousSessionId,
                    nextSessionId: null,
                    changedAt: this.now(),
                },
                initialGatewayState: this.options.initialGatewayState ?? 'running',
                initialTerminalState: terminal.state,
                initialTerminalDetachedAt: terminal.detachedAt,
                session: target,
                rootBinding,
                router,
                archiveSession: (sessionId) => this.options.api.archiveSessionV4(sessionId),
                now: this.options.now,
            });
            await this.reportSession(session, created.metadata);
            await this.options.onSessionMaterialized?.({
                threadId: factoryOptions.threadId,
                session,
            });
            return runtime;
        } catch (error) {
            await router?.close().catch(() => undefined);
            await rootBinding?.close().catch(() => undefined);
            if (!rootBinding) await target.close().catch(() => undefined);
            throw error;
        }
    }

    private async createChildBinding(
        thread: import('../protocol').Thread,
        parentBinding: CodexV4SessionBinding,
    ): Promise<CodexV4SessionBinding> {
        const identity = await deriveCodexV4ChildSessionIdentity({
            parentSessionId: parentBinding.sessionId,
            parentSessionKey: parentBinding.sessionKey,
            childThreadId: thread.id,
        });
        const child = createSessionMetadata({
            flavor: 'codex',
            machineId: this.options.machineId,
            cwd: thread.cwd || this.options.cwd,
            startedBy: this.options.origin === 'app' ? 'daemon' : 'terminal',
            sandbox: this.options.sandboxConfig,
            dangerouslySkipPermissions: isDangerousPermissionMode(
                this.options.defaultPermissionMode,
            ),
            parentSessionId: parentBinding.sessionId,
            isSideChat: true,
            codexReadOnly: true,
        });
        child.metadata.codexThreadId = thread.id;
        child.metadata.codexSyncVersion = 4;
        child.metadata.codexCapabilities = { queueSteering: false };
        const response = await this.options.api.getOrCreateSession({
            tag: identity.tag,
            metadata: child.metadata,
            state: child.state,
            dataEncryptionKey: identity.sessionKey,
            timeoutMs: this.options.relayRequestTimeoutMs,
        });
        if (!response) throw new Error('Happy relay is unavailable while creating a Codex child session');
        if (!await this.options.api.unarchiveSession(
            response.id,
            this.options.relayRequestTimeoutMs,
        )) {
            throw new Error('Happy relay is unavailable while restoring a Codex child session');
        }
        const target = this.options.api.sessionSyncClient(response);
        target.skipExistingMessages();
        try {
            return await this.createBinding({
                target,
                rootThreadId: thread.id,
                generation: null,
                readOnly: true,
                closeSession: true,
                router: () => null,
                assertCurrentGeneration: () => undefined,
                defaultCwd: thread.cwd || this.options.cwd,
            });
        } catch (error) {
            await target.close().catch(() => undefined);
            throw error;
        }
    }

    private async createBinding(options: {
        target: ApiSessionClientContract;
        rootThreadId: string;
        generation: number | null;
        readOnly: boolean;
        closeSession: boolean;
        router(): CodexV4ThreadRouter | null;
        assertCurrentGeneration(bindingGeneration: number | undefined): void;
        defaultCwd: string;
    }): Promise<CodexV4SessionBinding> {
        let mapper: CodexSyncV4Mapper | null = null;
        let commandProcessor: CodexV4CommandProcessor | null = null;
        let requestBroker: CodexV4RequestBroker | null = null;
        const syncClient = await options.target.enableSyncV4((sync) => {
            mapper = new CodexSyncV4Mapper(sync, {
                codexCliVersion: formatCodexCliVersion(this.options.codexCliVersion),
                initialSyncState: 'pending',
                diagnostics: this.options.diagnostics,
                diagnosticSessionHash: sync.diagnosticSessionHash,
                onError: (error) => this.reportError(error),
            });
            requestBroker = new CodexV4RequestBroker({ mapper });
            const commandExecutor = new CodexV4CommandExecutor({
                client: this.options.client,
                requestBroker,
                defaultCwd: options.defaultCwd,
                prepareAttachments: async (attachments) => {
                    const downloaded: Array<{ data: Uint8Array; mimeType: string; name: string }> = [];
                    for (const attachment of attachments) {
                        const data = await options.target.downloadAndDecryptAttachment(attachment.ref);
                        if (data) downloaded.push({
                            data,
                            mimeType: attachment.mimeType,
                            name: attachment.name,
                        });
                    }
                    return (await prepareCodexImageInputItems(downloaded, {
                        sessionId: options.target.sessionId,
                    })).inputItems;
                },
                resolveExecutionPolicy: (permissionMode) => {
                    if (!GATEWAY_PERMISSION_MODES.has(permissionMode as PermissionMode)) {
                        throw new Error('Unsupported Codex permission mode');
                    }
                    return resolveCodexExecutionPolicy(permissionMode as PermissionMode, false);
                },
                resolveEffort: (model, effort) => resolveCodexEffortForModel({
                    model,
                    effort,
                    models: [...this.options.modelCapabilities],
                }).effort,
                beforeProviderCall: (command) => {
                    if (options.readOnly) return;
                    options.assertCurrentGeneration((command as CodexCommandEntityV4 & {
                        bindingGeneration?: number;
                    }).bindingGeneration);
                },
            });
            commandProcessor = new CodexV4CommandProcessor({
                store: sync,
                startPaused: true,
                execute: async (command) => {
                    if (options.readOnly) assertCodexV4ReadOnlyCommand(command);
                    assertCodexV4CommandThreadOwnership(command, {
                        readOnly: options.readOnly,
                        ownedThreadId: options.rootThreadId,
                        routes: sync.getCodexThreadRoutes(),
                    });
                    assertGatewayTurnTarget(command, options.rootThreadId, options.readOnly);
                    let reservation: { release(): Promise<void> } | null = null;
                    let providerAccepted = false;
                    if (!options.readOnly && ROOT_HANDOFF_COMMANDS.has(command.command)) {
                        options.assertCurrentGeneration((command as CodexCommandEntityV4 & {
                            bindingGeneration?: number;
                        }).bindingGeneration);
                        reservation = await this.options.rootHandoff.reserve?.({
                            command,
                            sourceThreadId: options.rootThreadId,
                            sourceGeneration: options.generation!,
                            requestedThreadId: codexV4CommandTargetThreadId(command),
                        }) ?? null;
                    }
                    let outcome: CodexV4CommandOutcome;
                    try {
                        outcome = await commandExecutor.execute(command);
                        providerAccepted = true;
                    } catch (error) {
                        if (
                            reservation
                            && !providerAccepted
                            && !(error instanceof CodexRpcOutcomeUnknownError)
                        ) {
                            await reservation.release().catch((releaseError) => {
                                this.reportError(releaseError);
                            });
                        }
                        throw error;
                    }
                    const router = options.router();
                    try {
                        if (!options.readOnly && ROOT_HANDOFF_COMMANDS.has(command.command)) {
                            if (!outcome.threadId || options.generation === null) {
                                throw new Error('Codex root handoff omitted its target binding');
                            }
                            await this.options.rootHandoff.bind({
                                command,
                                sourceThreadId: options.rootThreadId,
                                sourceGeneration: options.generation,
                                targetThreadId: outcome.threadId,
                                outcome,
                            });
                        } else if (router) {
                            await registerCodexV4CommandOutcome(router, command, outcome);
                        }
                    } catch (error) {
                        if (error instanceof CodexRpcOutcomeUnknownError) throw error;
                        throw new CodexRpcOutcomeUnknownError(
                            command.command,
                            'Provider command completed but Gateway route coordination is uncertain',
                        );
                    }
                    return outcome;
                },
                reconcile: async (command) => {
                    if (!options.readOnly && ROOT_HANDOFF_COMMANDS.has(command.command)) {
                        const handoff = await this.options.rootHandoff.reconcile(command);
                        if (handoff) return handoff;
                    }
                    const router = options.router();
                    if (router) {
                        const coordinated = reconcileCodexV4CoordinatedRoute(
                            command,
                            sync.getCodexThreadRoutes(),
                        );
                        if (coordinated) return coordinated;
                    }
                    return await commandExecutor.reconcile(command);
                },
                onError: (error) => this.reportError(error),
            });
            return (event) => commandProcessor!.handle(event);
        }, this.options.diagnostics);
        if (!mapper || !commandProcessor || !requestBroker) {
            throw new Error('Codex Gateway Sync v4 binding was not initialized');
        }

        let closed = false;
        let recoveryPromise: Promise<void> | null = null;
        const binding: CodexV4SessionBinding = {
            sessionId: options.target.sessionId,
            sessionKey: options.target.syncV4SessionKey,
            mapper,
            syncClient,
            commandProcessor,
            requestBroker,
            recover: async () => {
                if (recoveryPromise) return await recoveryPromise;
                const recovery = (async () => {
                    const recoveredRequests = await binding.requestBroker.recoverPending(
                        binding.syncClient.getPendingProviderRequests(),
                    );
                    if (recoveredRequests > 0) await binding.syncClient.flushOutboundOnce();
                    await binding.commandProcessor.resumeExecution();
                })();
                recoveryPromise = recovery;
                try {
                    await recovery;
                } finally {
                    if (recoveryPromise === recovery) recoveryPromise = null;
                }
            },
            close: async () => {
                if (closed) return;
                closed = true;
                await closeCodexV4BindingResources({
                    commandProcessor: commandProcessor!,
                    requestBroker: requestBroker!,
                    mapper: mapper!,
                    syncClient,
                    ...(options.closeSession ? { session: options.target } : {}),
                });
            },
        };
        return binding;
    }

    private async reportSession(
        session: ApiSession,
        metadata: ApiSession['metadata'],
    ): Promise<void> {
        const report = this.options.reportSessionStarted ?? notifyDaemonSessionStarted;
        try {
            await report(session.id, metadata, {
                encryptionKey: encodeBase64(session.encryptionKey),
                encryptionVariant: session.encryptionVariant,
                seq: session.seq,
                metadataVersion: session.metadataVersion,
                agentStateVersion: session.agentStateVersion,
            });
        } catch (error) {
            this.reportError(error);
        }
    }

    private reportError(error: unknown): void {
        if (this.options.onError) {
            this.options.onError(error);
            return;
        }
        logger.warn('[Codex Gateway] Runtime factory operation failed', {
            errorKind: classifySyncV4DiagnosticError(error),
        });
    }

    private now(): number {
        return Math.max(0, Math.trunc(this.options.now?.() ?? Date.now()));
    }
}

function assertGatewayTurnTarget(
    command: CodexCommandEntityV4,
    rootThreadId: string,
    readOnly: boolean,
): void {
    if (readOnly || command.command !== 'turn.start') return;
    const target = codexV4CommandTargetThreadId(command);
    if (target !== rootThreadId) {
        throw new Error('Codex Gateway turn.start requires the current root thread');
    }
}

function isDangerousPermissionMode(permissionMode: PermissionMode): boolean {
    return permissionMode === 'yolo' || permissionMode === 'bypassPermissions';
}
