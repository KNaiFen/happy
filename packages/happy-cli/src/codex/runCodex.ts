import { render } from "ink";
import React from "react";
import { z } from 'zod';
import { createEnvelope } from '@slopus/happy-wire';
import { ApiClient } from '@/api/api';
import { CodexAppServerClient } from './codexAppServerClient';
import type { ReasoningEffort } from './protocol';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { MessageQueue2, type QueueItem } from '@/utils/MessageQueue2';
import { AsyncLock } from '@/utils/lock';
import { projectPath } from '@/projectPath';
import { join } from 'node:path';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import type { CodexModelCapability, Session as ApiSession, UserMessage } from '@/api/types';
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { PermissionMode } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { resolveCodexExecutionPolicy, shouldAutoApproveCodexApproval } from './executionPolicy';
import {
    mapCodexMcpMessageToSessionEnvelopes,
    mapCodexProcessorMessageToSessionEnvelopes,
} from './utils/sessionProtocolMapper';
import { resolveCodexResumeSyncStrategy, resumeExistingThread } from './resumeExistingThread';
import { emitReadyIfIdle } from './emitReadyIfIdle';
import { enqueueCodexUserText, isCodexClearText } from './codexClearCommand';
import { downloadCodexFileEventAttachment } from './utils/attachmentEvents';
import { prepareCodexImageInputItems } from './utils/imageInput';
import { createSerialAsyncHandler } from './utils/serialAsyncHandler';
import { buildCodexThreadBackfillEnvelopes } from './utils/threadImageBackfill';
import {
    buildCodexTurnPrompt,
    hashCodexEnhancedMode,
    type CodexEnhancedMode,
} from './codexPrompt';
import { discoverCodexSkillCommands } from './codexSkills';
import {
    codexGoalActionCapabilities,
    mapCodexGoalEventToAgentGoalStatus,
    parseCodexGoalActionParams,
    parseCodexGoalCommand,
    type CodexGoalCommand,
} from './codexGoalStatus';
import {
    loadCodexModelCapabilities,
    mergeCodexSessionModels,
} from './codexModelCapabilities';
import { resolveCodexEffortForModel } from './codexEffortValidation';
import { assertMinimumCodexCliVersion, formatCodexCliVersion } from './codexCliVersion';
import { CodexSyncV4Mapper } from './codexSyncV4Mapper';
import { CodexV4CommandProcessor } from './codexV4CommandProcessor';
import { CodexV4CommandExecutor } from './codexV4CommandExecutor';
import { CodexV4RequestBroker } from './codexV4RequestBroker';
import { CodexV4Migrator } from './codexV4Migration';
import {
    CodexV4ThreadRouter,
    type CodexV4SessionBinding,
} from './codexV4ThreadRouter';
import { deriveCodexV4ChildSessionIdentity } from './codexV4ChildIdentity';
import { CodexProtocolTraceRecorder } from './codexProtocolTrace';

/**
 * Extracts a human-readable error from a codex task_complete/turn_aborted event.
 * Returns null if the event represents a successful/clean completion.
 */
function describeCodexFailure(msg: any): string | null {
    const hasFailure = msg?.status === 'failed' || (msg?.error !== undefined && msg?.error !== null);
    if (!hasFailure) return null;
    const err = msg.error;
    if (typeof err === 'string' && err.length > 0) return err;
    if (err && typeof err === 'object' && typeof err.message === 'string' && err.message.length > 0) {
        return err.message;
    }
    return 'Unknown error';
}

function hasCodexSubagentReference(message: Record<string, unknown>): boolean {
    for (const key of ['subagent', 'parent_call_id', 'parentCallId', 'agent_thread_id', 'agentThreadId']) {
        const value = message[key];
        if (typeof value === 'string' && value.length > 0) {
            return true;
        }
    }
    return false;
}

const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const DEFAULT_CODEX_EFFORT: ReasoningEffort = 'medium';
const DEFAULT_CODEX_PERMISSION_MODE: PermissionMode = 'yolo';
const CodexQueuedMessageIdSchema = z.string().trim().min(1).max(200);
const CodexQueuedMessageUpdateSchema = z.object({
    id: CodexQueuedMessageIdSchema,
    text: z.string().trim().min(1).max(100_000),
}).strict();
const CodexQueuedMessageSteerSchema = z.object({
    id: CodexQueuedMessageIdSchema,
}).strict();

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    noSandbox?: boolean;
    resumeThreadId?: string;
    permissionMode?: PermissionMode;
    model?: string;
    effort?: ReasoningEffort;
}): Promise<void> {
    // Fail before creating remote state when the local protocol is unsupported.
    let codexCliVersion: ReturnType<typeof assertMinimumCodexCliVersion>;
    try {
        codexCliVersion = assertMinimumCodexCliVersion();
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Codex CLI version check failed.';
        console.error(`\n\x1b[1m\x1b[33m${message}\x1b[0m\n`);
        console.error('Please install Codex CLI using one of these methods:\n');
        console.error('\x1b[1mOption 1 - npm (recommended):\x1b[0m');
        console.error('  \x1b[36mnpm install -g @openai/codex\x1b[0m\n');
        console.error('\x1b[1mOption 2 - Homebrew (macOS):\x1b[0m');
        console.error('  \x1b[36mbrew install --cask codex\x1b[0m\n');
        console.error('Alternatively, use Claude Code:');
        console.error('  \x1b[36mhappy claude\x1b[0m\n');
        process.exit(1);
    }

    type EnhancedMode = CodexEnhancedMode;

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const api = await ApiClient.create(opts.credentials);
    const codexSyncV4Enabled = await api.isCodexSyncV4Enabled(formatCodexCliVersion(codexCliVersion));

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    const sandboxConfig = opts.noSandbox ? undefined : settings?.sandboxConfig;
    const client = new CodexAppServerClient(sandboxConfig);
    let protocolTraceRecorder: CodexProtocolTraceRecorder | null = null;
    const supportsQueueSteering = client.supportsTurnSteering();
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    const initialPermissionMode = opts.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE;
    // Lineage from the daemon's spawn RPC (set by app-side fork / duplicate).
    const forkedFromSessionId = process.env.HAPPY_FORKED_FROM_SESSION_ID;
    const forkedFromMessageId = process.env.HAPPY_FORKED_FROM_MESSAGE_ID;
    const isSideChat = process.env.HAPPY_SIDE_CHAT === '1';

    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy,
        sandbox: sandboxConfig,
        dangerouslySkipPermissions: initialPermissionMode === 'yolo' || initialPermissionMode === 'bypassPermissions',
        ...(forkedFromSessionId ? { parentSessionId: forkedFromSessionId } : {}),
        ...(forkedFromMessageId ? { forkedFromMessageId } : {}),
        ...(isSideChat ? { isSideChat: true } : {}),
    });
    if (codexSyncV4Enabled) metadata.codexSyncVersion = 4;
    metadata.codexCapabilities = { queueSteering: supportsQueueSteering };
    if (supportsQueueSteering) {
        state.codexMessageQueue = { revision: 0, messages: [] };
    }

    const skillCommands = await discoverCodexSkillCommands();
    if (skillCommands.length > 0) {
        metadata.skills = skillCommands;
        metadata.slashCommands = Array.from(new Set([...(metadata.slashCommands ?? []), ...skillCommands]));
    }

    // Check for session reconnection env vars (set by daemon for resume-in-place)
    const reconnectSessionId = process.env.HAPPY_RECONNECT_SESSION_ID;
    const reconnectKeyBase64 = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
    const reconnectVariant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;
    const reconnectSeq = process.env.HAPPY_RECONNECT_SEQ;
    const reconnectMetadataVersion = process.env.HAPPY_RECONNECT_METADATA_VERSION;
    const reconnectAgentStateVersion = process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;

    let response: ApiSession | null;
    if (reconnectSessionId && reconnectKeyBase64 && reconnectVariant) {
        logger.debug(`[START] Reconnecting to existing session ${reconnectSessionId}`);
        response = {
            id: reconnectSessionId,
            seq: parseInt(reconnectSeq || '0', 10),
            encryptionKey: decodeBase64(reconnectKeyBase64),
            encryptionVariant: reconnectVariant,
            metadata,
            metadataVersion: parseInt(reconnectMetadataVersion || '0', 10),
            agentState: state,
            agentStateVersion: parseInt(reconnectAgentStateVersion || '0', 10),
        };
    } else {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    }

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later at line ~385 after client setup)
    let permissionHandler: CodexPermissionHandler;
    let reasoningProcessor!: ReasoningProcessor;
    let abortInProgress: Promise<void> | null = null;
    const codexV4Runtime = {
        rootBinding: null as CodexV4SessionBinding | null,
        router: null as CodexV4ThreadRouter | null,
    };
    let boundCodexV4SessionId: string | null = null;
    let bindCodexV4Session: ((target: ApiSessionClient) => Promise<void>) | null = null;
    let pendingCodexV4Session: ApiSessionClient | null = null;
    let codexV4CanonicalActive = false;
    const closeCodexV4Runtime = async (): Promise<void> => {
        client.setStableNotificationHandler(null);
        client.setServerRequestHandler(null);
        client.setConnectionHandler(null);
        const router = codexV4Runtime.router;
        const rootBinding = codexV4Runtime.rootBinding;
        codexV4Runtime.router = null;
        codexV4Runtime.rootBinding = null;
        boundCodexV4SessionId = null;
        try {
            await router?.close();
        } finally {
            await rootBinding?.close();
        }
    };
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
            if (bindCodexV4Session) {
                void bindCodexV4Session(newSession).catch((error) => {
                    logger.warn('[Codex v4] Failed to bind reconnected session', {
                        errorName: error instanceof Error ? error.name : typeof error,
                    });
                });
            } else {
                pendingCodexV4Session = newSession;
            }
        }
    });
    session = initialSession;

    // On reconnect, un-archive the session and skip replaying old messages.
    if (reconnectSessionId) {
        session.suppressNextArchiveSignal();
        session.skipExistingMessages();
        session.updateMetadata((meta) => ({
            ...meta,
            lifecycleState: 'running',
            archivedBy: undefined,
        }));
    }

    // Always report to daemon if it exists (skip if offline)
    if (response) {
        try {
            logger.debug(`[START] Reporting session ${response.id} to daemon`);
            const result = await notifyDaemonSessionStarted(response.id, metadata, {
                encryptionKey: encodeBase64(response.encryptionKey),
                encryptionVariant: response.encryptionVariant,
                seq: response.seq,
                metadataVersion: response.metadataVersion,
                agentStateVersion: response.agentStateVersion,
            });
            if (result.error) {
                logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
            } else {
                logger.debug(`[START] Reported session ${response.id} to daemon`);
            }
        } catch (error) {
            logger.debug('[START] Failed to report to daemon (may not be running):', error);
        }
    }

    const messageQueue = new MessageQueue2<EnhancedMode>(hashCodexEnhancedMode);
    const queueOperations = new AsyncLock();
    let codexQueueRevision = 0;
    const publishCodexQueue = () => {
        if (!supportsQueueSteering) return;
        const revision = ++codexQueueRevision;
        const messages = messageQueue.trackedItems().map((item) => ({
            id: item.id,
            text: item.message,
            createdAt: item.createdAt,
        }));
        session.updateAgentState((currentState) => ({
            ...currentState,
            codexMessageQueue: {
                revision,
                messages,
            },
        }));
    };

    session.onFileEvent((fileEvent) => {
        const ev = fileEvent.content.data.ev;
        logger.debug('[Codex] File event received', {
            size: ev.size,
            hasMimeType: Boolean(ev.mimeType),
        });
        session.trackAttachmentDownload(downloadCodexFileEventAttachment(session, fileEvent));
    });

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;
    // True only while currentPermissionMode reflects an explicit user pick
    // (message meta), not the launch default or an abort-reset. The approval
    // handler's latest-mode check trusts only explicit picks — the launch
    // default for plain codex is yolo, and it must not wave through a
    // straggler approval after an abort.
    let currentPermissionModeExplicitlySet = false;
    const launchModel = opts.model ?? DEFAULT_CODEX_MODEL;
    let currentModel: string | undefined = launchModel;
    let currentEffort: ReasoningEffort | undefined = opts.effort ?? DEFAULT_CODEX_EFFORT;
    let codexModelCapabilities: CodexModelCapability[] | null = null;
    let currentAppendSystemPrompt: string | undefined = undefined;

    const resetCurrentModeDefaults = () => {
        // Reset to the mode the session was launched with. Note this is NOT
        // a safety guarantee by itself — for plain `happy codex` the launch
        // mode IS yolo; the post-abort grace window is protected by the
        // approval handler only trusting explicitly-picked modes.
        currentPermissionMode = initialPermissionMode;
        currentPermissionModeExplicitlySet = false;
        currentModel = launchModel;
        currentEffort = opts.effort ?? DEFAULT_CODEX_EFFORT;
        currentAppendSystemPrompt = undefined;
        logger.debug('[Codex] Reset current mode defaults after abort');
    };

    // Valid Codex permission modes from remote messages. Matches the modes
    // the mobile UI exposes for Codex sessions (see modelModeOptions.ts:
    // getCodexPermissionModes) and mirrors the Gemini validation pattern at
    // runGemini.ts:222. Anything outside this set is silently ignored — the
    // previous code blindly cast `message.meta.permissionMode as PermissionMode`
    // at runtime, meaning a crafted value like `'totally_unsafe'` would be
    // accepted and then fall through to the `default` branch in
    // resolveCodexExecutionPolicy() — or worse, an attacker-chosen valid value
    // could escalate sandbox scope (issue #1092).
    const VALID_REMOTE_PERMISSION_MODES: readonly PermissionMode[] = [
        'default',
        'read-only',
        'safe-yolo',
        'yolo',
    ];

    const handleUserMessage = createSerialAsyncHandler<UserMessage>(async (message) => {
        const attachmentsForThisMessage = await session.drainAttachmentsForUserMessage();

        // Resolve permission mode (validate against Codex-native modes)
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const incoming = message.meta.permissionMode as PermissionMode;
            if (VALID_REMOTE_PERMISSION_MODES.includes(incoming)) {
                messagePermissionMode = incoming;
                currentPermissionMode = messagePermissionMode;
                currentPermissionModeExplicitlySet = true;
                logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
            } else {
                logger.debug(`[Codex] Ignoring invalid permission mode from user message: ${String(message.meta.permissionMode)}`);
            }
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        // Resolve model; explicit null resets to the model used to launch this thread.
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || launchModel;
            currentModel = messageModel;
            logger.debug(`[Codex] Model updated from user message: ${messageModel}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve effort — passed straight to sendTurnAndWait. Validate the
        // incoming value against ReasoningEffort so a stale/garbage entry on
        // the wire doesn't poison the per-turn options.
        let messageEffort = currentEffort;
        if (message.meta?.hasOwnProperty('effort')) {
            const incoming = (message.meta as Record<string, unknown>).effort;
            if (incoming === null || incoming === undefined) {
                messageEffort = undefined;
                currentEffort = undefined;
                logger.debug(`[Codex] Effort reset to default`);
            } else if (typeof incoming === 'string') {
                messageEffort = incoming;
                currentEffort = messageEffort;
                logger.debug(`[Codex] Effort updated from user message: ${messageEffort}`);
            } else {
                logger.debug(`[Codex] Ignoring invalid effort from user message: ${String(incoming)}`);
            }
        } else {
            logger.debug(`[Codex] User message received with no effort override, using current: ${currentEffort ?? 'default'}`);
        }

        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined;
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[Codex] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[Codex] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
            appendSystemPrompt: messageAppendSystemPrompt,
            effort: messageEffort,
        };
        const enqueueResult = await queueOperations.inLock(() => {
            if (supportsQueueSteering && message.meta?.followUpMode === 'queue') {
                const parsedId = CodexQueuedMessageIdSchema.safeParse(message.localKey);
                let id = parsedId.success ? parsedId.data : randomUUID();
                while (messageQueue.getTracked(id)) {
                    id = randomUUID();
                }
                const clear = isCodexClearText(message.content.text);
                messageQueue.pushTracked({
                    id,
                    createdAt: Date.now(),
                    message: message.content.text,
                    mode: enhancedMode,
                    attachments: attachmentsForThisMessage,
                    isolate: clear,
                });
                publishCodexQueue();
                return clear ? 'clear' as const : 'queued' as const;
            }

            const trackedBefore = messageQueue.trackedItems().length;
            const result = enqueueCodexUserText({
                text: message.content.text,
                mode: enhancedMode,
                queue: messageQueue,
                attachments: attachmentsForThisMessage,
            });
            if (messageQueue.trackedItems().length !== trackedBefore) {
                publishCodexQueue();
            }
            return result;
        });
        if (enqueueResult === 'clear') {
            logger.debug('[Codex] /clear command pushed to isolated queue');
        }
    }, (error) => {
        logger.warn('[Codex] Failed to handle user message', {
            errorName: error instanceof Error ? error.name : typeof error,
        });
    });
    session.onUserMessage(handleUserMessage);
    let thinking = false;
    let currentTurnId: string | null = null;
    let codexStartedSubagents = new Set<string>();
    let codexActiveSubagents = new Set<string>();
    let codexProviderSubagentToSessionSubagent = new Map<string, string>();
    let codexSubagentTitles = new Map<string, string>();
    let codexCollabReceiverThreadIdsByCall = new Map<string, string[]>();
    let codexCollabToolByCall = new Map<string, string>();
    let activeTurnPermissionMode: PermissionMode | undefined = undefined;
    session.keepAlive(thinking, 'remote');
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendSessionNotification({
                kind: 'done',
                metadata: session.getMetadata(),
                data: {
                    sessionId: session.sessionId,
                    type: 'ready',
                    provider: 'codex',
                }
            });
        } catch (pushError) {
            logger.debug('[Codex] Failed to send ready push', pushError);
        }
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    // AbortController is used ONLY to wake messageQueue.waitForMessages when idle.
    // Turn cancellation uses client.interruptTurn() — no AbortController hack needed.
    let abortController = new AbortController();
    let shouldExit = false;

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        if (abortInProgress) {
            await abortInProgress;
            return;
        }

        logger.debug('[Codex] Abort requested - stopping current task');
        abortInProgress = (async () => {
            try {
                // Resolve any pending permission requests as 'abort' first.
                if (permissionHandler) {
                    permissionHandler.abortAll();
                }

                // Request interruption, then force-restart Codex app-server if
                // it doesn't settle quickly (long-running shell commands).
                if (client) {
                    const abortResult = await client.abortTurnWithFallback({
                        gracePeriodMs: 3000,
                        forceRestartOnTimeout: true,
                    });
                    if (abortResult.forcedRestart) {
                        logger.warn('[Codex] Forced app-server restart after interrupt timeout');
                        session.sendSessionEvent({
                            type: 'message',
                            message: abortResult.resumedThread
                                ? 'Force-stopped active task after interrupt timeout. Codex backend was restarted and the previous thread was resumed.'
                                : 'Force-stopped active task after interrupt timeout. Codex backend was restarted, but the previous thread could not be resumed.',
                        });
                    }
                }

                if (reasoningProcessor) {
                    reasoningProcessor.abort();
                }
                logger.debug('[Codex] Abort completed - session remains active');
            } catch (error) {
                logger.debug('[Codex] Error during abort:', error);
            } finally {
                resetCurrentModeDefaults();
                // Wake up message queue wait if idle
                abortController.abort();
                abortController = new AbortController();
            }
        })();

        await abortInProgress;
        abortInProgress = null;
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async () => {
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        try {
            await closeCodexV4Runtime();

            // Update lifecycle state to archived before closing
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));
                
                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Force close Codex transport (best-effort) so we don't leave stray processes
            try {
                await client.disconnect();
            } catch (e) {
                logger.debug('[Codex] Error disconnecting Codex during termination', e);
            }

            // Stop Happy MCP server
            happyServer.stop();

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', error);
            process.exit(1);
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    permissionHandler = new CodexPermissionHandler(session);
    // Drop any permission requests left in agent state from a previous CLI
    // process that died while a tool prompt was open — see the matching
    // call in claudeRemoteLauncher for the full rationale.
    permissionHandler.reset('Previous CLI process exited before responding');
    reasoningProcessor = new ReasoningProcessor((message) => {
        if (codexV4CanonicalActive) return;
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const diffProcessor = new DiffProcessor((message) => {
        if (codexV4CanonicalActive) return;
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const sendTrackedUserMessageToSession = async (item: QueueItem<EnhancedMode>) => {
        if (!item.id || codexV4CanonicalActive) return;

        const emittedAt = Date.now();
        for (const [index, attachment] of (item.attachments ?? []).entries()) {
            try {
                const envelope = await session.uploadLocalImageAttachmentEnvelope(attachment, {
                    id: `${item.id}:file:${index}`,
                    time: emittedAt + index,
                });
                session.sendSessionProtocolMessage(envelope);
            } catch (error) {
                logger.warn('[Codex] Failed to publish queued image in session history', {
                    queueId: item.id,
                    errorName: error instanceof Error ? error.name : typeof error,
                });
            }
        }

        if (item.message.trim().length > 0) {
            session.sendSessionProtocolMessage(createEnvelope('user', {
                t: 'text',
                text: item.message,
            }, {
                id: item.id,
                time: emittedAt + (item.attachments?.length ?? 0),
            }));
        }
    };

    session.rpcHandlerManager.registerHandler('codex-update-queued-message', async (params: unknown) => {
        const parsed = CodexQueuedMessageUpdateSchema.safeParse(params);
        if (!parsed.success) {
            throw new Error('Invalid queued message update');
        }

        return queueOperations.inLock(() => {
            if (!messageQueue.updateTracked(parsed.data.id, parsed.data.text)) {
                throw new Error('Queued message no longer exists');
            }
            publishCodexQueue();
            return { ok: true, revision: codexQueueRevision };
        });
    });

    session.rpcHandlerManager.registerHandler('codex-steer-queued-message', async (params: unknown) => {
        const parsed = CodexQueuedMessageSteerSchema.safeParse(params);
        if (!parsed.success) {
            throw new Error('Invalid queued message steer request');
        }
        if (!supportsQueueSteering) {
            throw new Error('Turn steering is not supported by this Codex runtime');
        }

        return queueOperations.inLock(async () => {
            const item = messageQueue.getTracked(parsed.data.id);
            if (!item) {
                throw new Error('Queued message no longer exists');
            }
            if (!thinking || !client.threadId || !client.turnId) {
                throw new Error('The active Codex turn already finished');
            }
            if (isCodexClearText(item.message)) {
                throw new Error('Queued control commands cannot steer an active turn');
            }

            const imageInputs = await prepareCodexImageInputItems(item.attachments, {
                sessionId: session.sessionId,
            });
            if ((item.attachments?.length ?? 0) > 0
                && imageInputs.inputItems.length === 0
                && item.message.trim().length === 0) {
                throw new Error('No supported queued input is available to steer');
            }

            await client.steerTurn(item.message, {
                clientUserMessageId: item.id,
                extraInputItems: imageInputs.inputItems,
            });
            if (!messageQueue.removeTracked(parsed.data.id)) {
                throw new Error('Queued message changed while steering');
            }
            publishCodexQueue();
            await sendTrackedUserMessageToSession(item);
            return { ok: true, revision: codexQueueRevision };
        });
    });

    const updateCodexGoalState = (message: Record<string, unknown>) => {
        const capabilities = codexGoalActionCapabilities(client.supportsGoalActions());
        const goalStatus = mapCodexGoalEventToAgentGoalStatus(
            message,
            client.threadId,
            capabilities ? { capabilities } : undefined,
        );
        if (!goalStatus) {
            return;
        }
        session.updateAgentState((currentState) => ({
            ...currentState,
            agentGoalStatus: goalStatus,
        }));
    };
    const handleCodexGoalCommand = async (
        command: CodexGoalCommand,
        threadId: string,
    ): Promise<boolean> => {
        try {
            if (command.type === 'clear') {
                const result = await client.clearGoal({ threadId });
                if (result.cleared !== false) {
                    updateCodexGoalState({
                        type: 'thread_goal_cleared',
                        threadId,
                    });
                }
                messageBuffer.addMessage('Goal cleared', 'status');
                return true;
            }

            const result = await client.setGoal({
                threadId,
                objective: command.objective,
            });
            updateCodexGoalState({
                type: 'thread_goal_updated',
                threadId,
                goal: result.goal,
            });
            messageBuffer.addMessage('Goal updated', 'status');
            return true;
        } catch (error) {
            logger.debug('[Codex] Goal command API failed; falling back to normal turn:', error);
            return false;
        }
    };
    session.rpcHandlerManager.registerHandler('goal-action', async (params: Record<string, unknown>) => {
        const command = parseCodexGoalActionParams(params);
        if (!command) {
            throw new Error('Unsupported Codex goal action');
        }

        const threadId = client.threadId;
        if (!threadId) {
            throw new Error('No active Codex thread');
        }

        const handled = await handleCodexGoalCommand(command, threadId);
        if (!handled) {
            throw new Error('Codex goal actions are not supported by this runtime');
        }

        return { ok: true };
    });

    // Approval handler: routes server → client approval requests to our permission handler
    client.setApprovalHandler(async (params) => {
        const toolName = params.type === 'exec'
            ? 'CodexBash'
            : params.type === 'patch'
                ? 'CodexPatch'
                : (params.toolName ?? 'McpTool');
        const input = params.type === 'exec'
            ? { command: params.command, cwd: params.cwd }
            : params.type === 'patch'
                ? { changes: params.fileChanges }
                : (params.input ?? {});
        const activePermissionMode = activeTurnPermissionMode ?? currentPermissionMode ?? DEFAULT_CODEX_PERMISSION_MODE;
        // Check the latest session mode too: a turn pinned under an untrusted
        // policy keeps prompting after the user flips to yolo mid-turn
        // otherwise. Only when the mode was EXPLICITLY picked by the user —
        // the abort-reset restores the launch default (yolo for plain codex),
        // and a straggler approval from the dying turn (the ~3s abort grace
        // window, when the pinned turn mode is still set) must not be waved
        // through by that reset value.
        const latestPermissionMode = currentPermissionModeExplicitlySet
            ? currentPermissionMode ?? DEFAULT_CODEX_PERMISSION_MODE
            : undefined;

        if (shouldAutoApproveCodexApproval(activePermissionMode, client.sandboxEnabled)
            || (latestPermissionMode !== undefined && shouldAutoApproveCodexApproval(latestPermissionMode, client.sandboxEnabled))) {
            logger.debug(`[Codex] Auto-approving ${params.type} approval in ${activePermissionMode} mode (latest: ${latestPermissionMode ?? 'n/a'})`);
            return 'approved';
        }

        try {
            const result = await permissionHandler.handleToolCall(params.callId, toolName, input);
            logger.debug('[Codex] Permission result:', result.decision);
            return result.decision;
        } catch (error) {
            logger.debug('[Codex] Error handling permission:', error);
            return 'denied';
        }
    });

    // Event handler: same EventMsg types as the legacy MCP server — no changes needed
    client.setEventHandler((msg) => {
        logger.debug(`[Codex] Event type: ${typeof msg.type === 'string' ? msg.type : 'unknown'}`);
        const isSubagentScopedEvent = hasCodexSubagentReference(msg as Record<string, unknown>);

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage((msg as any).message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning' && !isSubagentScopedEvent) {
            messageBuffer.addMessage(`[Thinking] ${(msg as any).text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${(msg as any).command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = (msg as any).output || (msg as any).error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            // Ready is emitted from the main loop's idle check so pushes only fire once
            // after the queue is actually drained.
            const failure = describeCodexFailure(msg);
            if (failure) {
                messageBuffer.addMessage(`Task failed: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Task completed', 'status');
            }
        } else if (msg.type === 'turn_aborted') {
            const failure = describeCodexFailure(msg);
            if (failure) {
                messageBuffer.addMessage(`Turn aborted: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Turn aborted', 'status');
            }
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break' && !isSubagentScopedEvent) {
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta' && !isSubagentScopedEvent) {
            reasoningProcessor.processDelta((msg as any).delta);
        }
        if (msg.type === 'agent_reasoning' && !isSubagentScopedEvent) {
            reasoningProcessor.complete((msg as any).text);
        }
        if (msg.type === 'patch_apply_begin') {
            const { changes } = msg as any;
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        }
        if (msg.type === 'patch_apply_end') {
            const { stdout, stderr, success } = msg as any;
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
        }
        if (msg.type === 'turn_diff') {
            if ((msg as any).unified_diff) {
                diffProcessor.processDiff((msg as any).unified_diff);
            }
        }
        if (msg.type === 'thread_goal_updated' || msg.type === 'thread_goal_cleared') {
            updateCodexGoalState(msg);
        }

        // Convert events into the unified session-protocol envelope stream.
        // Reasoning deltas are handled by ReasoningProcessor to avoid duplicate text output.
        // Subagent-scoped reasoning bypasses the processor, so only forward the
        // FINAL agent_reasoning for subagents — the mapper renders deltas and
        // the final text identically, and forwarding both would emit one
        // thinking bubble per fragment plus a duplicate full-text bubble.
        const isReasoningEvent = msg.type === 'agent_reasoning_delta'
            || msg.type === 'agent_reasoning'
            || msg.type === 'agent_reasoning_section_break';
        const isForwardableSubagentReasoning = isSubagentScopedEvent && msg.type === 'agent_reasoning';
        if (!codexV4CanonicalActive
            && msg.type !== 'turn_diff'
            && (!isReasoningEvent || isForwardableSubagentReasoning)) {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(msg, {
                currentTurnId,
                startedSubagents: codexStartedSubagents,
                activeSubagents: codexActiveSubagents,
                providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
                subagentTitles: codexSubagentTitles,
                collabReceiverThreadIdsByCall: codexCollabReceiverThreadIdsByCall,
                collabToolByCall: codexCollabToolByCall,
            });
            currentTurnId = mapped.currentTurnId;
            codexStartedSubagents = mapped.startedSubagents;
            codexActiveSubagents = mapped.activeSubagents;
            codexProviderSubagentToSessionSubagent = mapped.providerSubagentToSessionSubagent;
            codexSubagentTitles = mapped.subagentTitles;
            codexCollabReceiverThreadIdsByCall = mapped.collabReceiverThreadIdsByCall;
            codexCollabToolByCall = mapped.collabToolByCall;
            for (const envelope of mapped.envelopes) {
                session.sendSessionProtocolMessage(envelope);
            }
        }
    });

    // Start Happy MCP server (HTTP) and prepare STDIO bridge config for Codex
    const happyServer = await startHappyServer(session);
    // Launch the bridge via `node <path>` (rather than relying on the .mjs shebang)
    // so it works on Windows, where Windows can't execute shebang scripts directly.
    // codex would otherwise fail to start the MCP server, the change_title tool would
    // not be visible to the model, and the model would improvise with shell echoes.
    const bridgeEntrypoint = join(projectPath(), 'bin', 'happy-mcp.mjs');
    const mcpServers = {
        happy: {
            command: process.execPath,
            args: ['--no-warnings', '--no-deprecation', bridgeEntrypoint, '--url', happyServer.url]
        }
    } as const;
    let first = true;
    let appendSystemPromptInjected = false;
    const requiresCodexV4Migration = Boolean(opts.resumeThreadId);

    const createCodexV4Binding = async (bindingOptions: {
        target: ApiSessionClient;
        initialSyncState: 'pending' | 'ready';
        readOnly: boolean;
        closeSession: boolean;
        ownedThreadId?: string;
    }): Promise<CodexV4SessionBinding> => {
        let mapper: CodexSyncV4Mapper | null = null;
        let commandProcessor: CodexV4CommandProcessor | null = null;
        let requestBroker: CodexV4RequestBroker | null = null;
        const syncClient = await bindingOptions.target.enableSyncV4((sync) => {
            mapper = new CodexSyncV4Mapper(sync, {
                codexCliVersion: formatCodexCliVersion(codexCliVersion),
                initialSyncState: bindingOptions.initialSyncState,
                onError: (error) => {
                    logger.warn('[Codex v4] Entity projection failed', {
                        errorName: error instanceof Error ? error.name : typeof error,
                    });
                },
            });
            requestBroker = new CodexV4RequestBroker({ mapper });
            const commandExecutor = new CodexV4CommandExecutor({
                client,
                requestBroker,
                defaultCwd: process.cwd(),
                mcpServers,
                preparePrompt: (text, command) => {
                    const payload = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
                        ? command.payload as Record<string, unknown>
                        : {};
                    const appendSystemPrompt = typeof payload.appendSystemPrompt === 'string'
                        ? payload.appendSystemPrompt
                        : undefined;
                    return buildCodexTurnPrompt({
                        message: text,
                        mode: {
                            appendSystemPrompt,
                        },
                        includeAppendSystemPrompt: Boolean(appendSystemPrompt && !appendSystemPromptInjected),
                        includeTitleInstruction: first,
                    });
                },
                onTurnStarted: (command) => {
                    const payload = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
                        ? command.payload as Record<string, unknown>
                        : {};
                    first = false;
                    if (typeof payload.appendSystemPrompt === 'string' && payload.appendSystemPrompt.length > 0) {
                        appendSystemPromptInjected = true;
                    }
                },
                prepareAttachments: async (attachments) => {
                    const downloaded = [];
                    for (const attachment of attachments) {
                        const data = await bindingOptions.target.downloadAndDecryptAttachment(attachment.ref);
                        if (data) downloaded.push({
                            data,
                            mimeType: attachment.mimeType,
                            name: attachment.name,
                        });
                    }
                    return (await prepareCodexImageInputItems(downloaded, {
                        sessionId: bindingOptions.target.sessionId,
                    })).inputItems;
                },
                resolveExecutionPolicy: (permissionMode) => {
                    if (!VALID_REMOTE_PERMISSION_MODES.includes(permissionMode as PermissionMode)) {
                        throw new Error('Unsupported Codex permission mode');
                    }
                    activeTurnPermissionMode = permissionMode as PermissionMode;
                    return resolveCodexExecutionPolicy(
                        permissionMode as PermissionMode,
                        client.sandboxEnabled,
                    );
                },
                resolveEffort: (model, effort) => resolveCodexEffortForModel({
                    model,
                    effort,
                    models: codexModelCapabilities,
                }).effort,
            });
            const childAllowedCommands = new Set([
                'thread.read',
                'request.resolve',
                'skills.list',
                'mcp.status.list',
                'model.list',
            ]);
            commandProcessor = new CodexV4CommandProcessor({
                store: sync,
                execute: async (command) => {
                    if (bindingOptions.readOnly && !childAllowedCommands.has(command.command)) {
                        throw new Error('Provider-created Codex child sessions are read-only');
                    }
                    if (
                        bindingOptions.ownedThreadId
                        && command.threadId
                        && command.threadId !== bindingOptions.ownedThreadId
                    ) {
                        throw new Error('Codex command targets a thread owned by another Happy session');
                    }
                    const outcome = await commandExecutor.execute(command);
                    if (outcome.threadId && (
                        command.command === 'thread.start'
                        || command.command === 'thread.resume'
                        || command.command === 'turn.start'
                    )) {
                        bindingOptions.target.updateMetadata((currentMetadata) => ({
                            ...currentMetadata,
                            codexThreadId: outcome.threadId ?? undefined,
                        }));
                    }
                    return outcome;
                },
                reconcile: (command) => commandExecutor.reconcile(command),
                onError: (error) => {
                    logger.warn('[Codex v4] Command reconciliation failed', {
                        errorName: error instanceof Error ? error.name : typeof error,
                    });
                },
            });
            return (event) => commandProcessor!.handle(event);
        });
        if (!mapper || !commandProcessor || !requestBroker) {
            throw new Error('Codex Sync v4 binding was not initialized');
        }

        let closed = false;
        const binding: CodexV4SessionBinding = {
            sessionId: bindingOptions.target.sessionId,
            sessionKey: bindingOptions.target.syncV4SessionKey,
            mapper,
            syncClient,
            commandProcessor,
            requestBroker,
            close: async () => {
                if (closed) return;
                closed = true;
                commandProcessor!.close();
                try {
                    await requestBroker!.failPending('brokerClosed');
                    await mapper!.close();
                    await syncClient.flushOutboundOnce();
                } finally {
                    await syncClient.close();
                    if (bindingOptions.closeSession) await bindingOptions.target.close();
                }
            },
        };
        const recoveredProviderRequests = await binding.requestBroker.recoverPending(
            binding.syncClient.getPendingProviderRequests(),
        );
        if (recoveredProviderRequests > 0) {
            await binding.syncClient.flushOutboundOnce();
        }
        await binding.commandProcessor.recoverPending();
        return binding;
    };

    bindCodexV4Session = async (target) => {
        if (!codexSyncV4Enabled) return;
        // The offline session stub intentionally has no encryption material or
        // Sync v4 transport. The reconnection callback will bind the real
        // session once Happy Server is reachable again.
        if (typeof target.enableSyncV4 !== 'function') {
            pendingCodexV4Session = target;
            return;
        }
        if (boundCodexV4SessionId === target.sessionId) return;
        await closeCodexV4Runtime();

        const rootBinding = await createCodexV4Binding({
            target,
            initialSyncState: requiresCodexV4Migration && !codexV4CanonicalActive ? 'pending' : 'ready',
            readOnly: false,
            closeSession: false,
            ...(opts.resumeThreadId ? { ownedThreadId: opts.resumeThreadId } : {}),
        });
        if (opts.resumeThreadId && rootBinding.syncClient.getMigrationState(opts.resumeThreadId) === 'ready') {
            await rootBinding.mapper.setSyncState('ready');
            codexV4CanonicalActive = true;
        }
        const router = new CodexV4ThreadRouter({
            rootBinding,
            readThread: async (threadId) => (
                await client.readThreadComplete({ threadId, emitSnapshot: false })
            ).thread,
            readGoal: async (threadId) => (await client.getGoal({ threadId })).goal,
            createChildBinding: async (route, parentBinding) => {
                const identity = await deriveCodexV4ChildSessionIdentity({
                    parentSessionId: parentBinding.sessionId,
                    parentSessionKey: parentBinding.sessionKey,
                    childThreadId: route.thread.id,
                });
                const child = createSessionMetadata({
                    flavor: 'codex',
                    machineId,
                    startedBy: opts.startedBy,
                    sandbox: sandboxConfig,
                    dangerouslySkipPermissions: initialPermissionMode === 'yolo'
                        || initialPermissionMode === 'bypassPermissions',
                    parentSessionId: parentBinding.sessionId,
                    isSideChat: true,
                    codexReadOnly: true,
                });
                child.metadata.codexThreadId = route.thread.id;
                child.metadata.codexSyncVersion = 4;
                child.metadata.codexCapabilities = { queueSteering: false };
                const childResponse = await api.getOrCreateSession({
                    tag: identity.tag,
                    metadata: child.metadata,
                    state: child.state,
                    dataEncryptionKey: identity.sessionKey,
                });
                if (!childResponse) throw new Error('Happy Server is unavailable while creating a Codex child session');
                const childTarget = api.sessionSyncClient(childResponse);
                childTarget.skipExistingMessages();
                return await createCodexV4Binding({
                    target: childTarget,
                    initialSyncState: 'pending',
                    readOnly: true,
                    closeSession: true,
                    ownedThreadId: route.thread.id,
                });
            },
            onError: (error) => {
                logger.warn('[Codex v4] Thread routing failed', {
                    errorName: error instanceof Error ? error.name : typeof error,
                });
            },
        });

        codexV4Runtime.rootBinding = rootBinding;
        codexV4Runtime.router = router;
        client.setStableNotificationHandler((notification) => router.handleNotification(notification));
        client.setServerRequestHandler((request) => router.handleRequest(request));
        client.setConnectionHandler((event) => router.setConnection(event));
        boundCodexV4SessionId = target.sessionId;
        pendingCodexV4Session = null;
        if (!requiresCodexV4Migration) codexV4CanonicalActive = true;
    };

    const protocolTracePath = process.env.HAPPY_CODEX_TRACE_PATH;
    if (protocolTracePath) {
        try {
            protocolTraceRecorder = await CodexProtocolTraceRecorder.open(protocolTracePath);
            client.setProtocolTraceSink(protocolTraceRecorder);
            logger.info('[Codex] Redacted protocol trace enabled');
        } catch (error) {
            logger.warn('[Codex] Failed to open redacted protocol trace', {
                errorName: error instanceof Error ? error.name : typeof error,
            });
        }
    }

    try {
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');
        if (codexSyncV4Enabled) {
            await bindCodexV4Session(pendingCodexV4Session ?? session);
        }

        const discoveredModels = await loadCodexModelCapabilities(client);
        codexModelCapabilities = discoveredModels;
        if (discoveredModels) {
            session.updateMetadata((currentMetadata) => (
                mergeCodexSessionModels(currentMetadata, discoveredModels)
            ));
        }

        if (opts.resumeThreadId) {
            const rootBinding = codexV4Runtime.rootBinding;
            const migrationState = rootBinding?.syncClient.getMigrationState(opts.resumeThreadId);
            const resumeSyncStrategy = resolveCodexResumeSyncStrategy(codexSyncV4Enabled, migrationState);
            const router = codexV4Runtime.router;
            let migrator: CodexV4Migrator | null = null;
            if (codexSyncV4Enabled) {
                if (!router || !rootBinding) throw new Error('Codex Sync v4 router is unavailable during migration');
                router.registerRootThread(opts.resumeThreadId);
                if (resumeSyncStrategy.migrateToSyncV4) {
                    migrator = new CodexV4Migrator({
                        rootSink: router.migrationSinkForRoot(),
                        readThread: async (threadId) => (
                            await client.readThreadComplete({ threadId, emitSnapshot: false })
                        ).thread,
                        readGoal: async (threadId) => (await client.getGoal({ threadId })).goal,
                        resolveChildSink: (route) => router.migrationSinkForChild(route),
                    });
                    await migrator.prepareRoot(opts.resumeThreadId);
                }
            }
            const resumed = await resumeExistingThread({
                client,
                session,
                messageBuffer,
                threadId: opts.resumeThreadId,
                cwd: process.cwd(),
                mcpServers,
                emitSnapshot: resumeSyncStrategy.emitLegacySnapshot,
                // Side chats start empty — keep the resume notice out of the UI.
                announce: !isSideChat,
            });
            first = false;
            appendSystemPromptInjected = true;
            if (migrator) {
                await migrator.migrate(resumed.thread);
                codexV4CanonicalActive = true;
            } else if (codexSyncV4Enabled && rootBinding) {
                rootBinding.mapper.importThreadState(resumed.thread);
                rootBinding.mapper.importGoal(
                    resumed.threadId,
                    (await client.getGoal({ threadId: resumed.threadId })).goal,
                );
                await rootBinding.mapper.flush();
                await rootBinding.syncClient.flushOutboundOnce();
                codexV4CanonicalActive = true;
            }
        }

        const forkCodexThreadId = process.env.HAPPY_FORK_CODEX_THREAD_ID;
        if (!reconnectSessionId && forkCodexThreadId) {
            // Side chats inherit the forked thread's context inside the model
            // (thread/fork copies it), but we deliberately do NOT replay the
            // pre-fork history into the UI: a side chat starts empty from the
            // moment it was opened, so the user only sees the aside they began.
            if (!isSideChat && !codexV4CanonicalActive) {
                try {
                    const { thread } = await client.readThread({
                        threadId: forkCodexThreadId,
                        includeTurns: true,
                    });
                    const envelopes = await buildCodexThreadBackfillEnvelopes({
                        thread,
                        uploadLocalImage: (attachment, imageOpts) => (
                            session.uploadLocalImageAttachmentEnvelope(attachment, imageOpts)
                        ),
                    });
                    for (const envelope of envelopes) {
                        session.sendSessionProtocolMessage(envelope);
                    }
                    logger.debug(`[CODEX FORK BACKFILL] Replayed ${envelopes.length} historical envelopes from thread ${forkCodexThreadId}`);
                } catch (error) {
                    logger.debug(`[CODEX FORK BACKFILL] Failed to read thread ${forkCodexThreadId}:`, error);
                }
            }
            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                codexThreadId: forkCodexThreadId,
            }));
        }

        let pending: QueueItem<EnhancedMode> | null = null;

        while (!shouldExit) {
            logActiveHandles('loop-top');
            let message: QueueItem<EnhancedMode> | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const hasMessages = await messageQueue.waitForMessages(waitSignal);
                if (!hasMessages) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: hasMessages=${hasMessages}, shouldExit=${shouldExit}`);
                    break;
                }
                message = await queueOperations.inLock(() => {
                    const next = messageQueue.takeNext();
                    if (next?.id) {
                        publishCodexQueue();
                    }
                    return next;
                });
                // A concurrent steer may have consumed the item that woke us.
                if (!message) {
                    continue;
                }
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            if (message.id) {
                await sendTrackedUserMessageToSession(message);
            }

            if (isCodexClearText(message.message)) {
                logger.debug('[Codex] Handling /clear command - resetting Codex thread state');
                client.clearThreadState();
                currentTurnId = null;
                codexStartedSubagents = new Set<string>();
                codexActiveSubagents = new Set<string>();
                codexProviderSubagentToSessionSubagent = new Map<string, string>();
                codexSubagentTitles = new Map<string, string>();
                codexCollabReceiverThreadIdsByCall = new Map<string, string[]>();
                codexCollabToolByCall = new Map<string, string>();
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                appendSystemPromptInjected = false;
                thinking = false;
                session.keepAlive(thinking, 'remote');
                messageBuffer.addMessage('Context was reset', 'status');
                session.sendSessionEvent({ type: 'message', message: 'Context was reset' });
                session.updateMetadata((currentMetadata) => {
                    const nextMetadata = { ...currentMetadata };
                    delete nextMetadata.codexThreadId;
                    return nextMetadata;
                });
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                continue;
            }

            // Display user messages in the UI
            if (message.message.trim().length > 0) {
                messageBuffer.addMessage(message.message, 'user');
            }

            try {
                // Map permission mode to approval policy and sandbox.
                // With app-server, these are per-turn — no restart needed on mode change.
                const sandboxManagedByHappy = client.sandboxEnabled;
                const executionPolicy = resolveCodexExecutionPolicy(
                    message.mode.permissionMode,
                    sandboxManagedByHappy,
                );
                activeTurnPermissionMode = message.mode.permissionMode;

                // Start thread on first turn (thread persists across mode changes)
                let activeThreadId = client.threadId;
                if (!client.hasActiveThread() || !activeThreadId) {
                    const startedThread = await client.startThread({
                        model: message.mode.model,
                        cwd: process.cwd(),
                        approvalPolicy: executionPolicy.approvalPolicy,
                        sandbox: executionPolicy.sandbox,
                        mcpServers,
                    });
                    activeThreadId = startedThread.threadId;
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        codexThreadId: startedThread.threadId,
                    }));
                }

                const goalCommand = parseCodexGoalCommand(message.message);
                if (goalCommand && await handleCodexGoalCommand(goalCommand, activeThreadId)) {
                    continue;
                }

                const effortResolution = resolveCodexEffortForModel({
                    effort: message.mode.effort,
                    model: message.mode.model,
                    models: codexModelCapabilities,
                });
                const turnMode: EnhancedMode = {
                    ...message.mode,
                    effort: effortResolution.effort,
                };
                if (!effortResolution.accepted) {
                    logger.warn(
                        `[Codex] Rejected unsupported effort '${message.mode.effort ?? 'default'}' `
                        + `for model '${message.mode.model ?? 'default'}'; `
                        + `using '${effortResolution.effort ?? 'provider default'}'`,
                    );
                    currentEffort = effortResolution.effort;
                }

                const includeAppendSystemPrompt = Boolean(
                    turnMode.appendSystemPrompt && !appendSystemPromptInjected,
                );
                const imageInputs = await prepareCodexImageInputItems(message.attachments, {
                    sessionId: session.sessionId,
                });
                if ((message.attachments?.length ?? 0) > 0) {
                    logger.debug('[Codex] Prepared image inputs for turn', {
                        inputCount: imageInputs.inputItems.length,
                        skippedCount: imageInputs.skipped,
                    });
                }
                const hasUserText = message.message.trim().length > 0;
                if ((message.attachments?.length ?? 0) > 0 && imageInputs.inputItems.length === 0 && !hasUserText) {
                    session.sendSessionEvent({
                        type: 'message',
                        message: 'No supported images were available to send to Codex.',
                    });
                    continue;
                }
                const turnPrompt = buildCodexTurnPrompt({
                    message: message.message,
                    mode: turnMode,
                    includeAppendSystemPrompt,
                    includeTitleInstruction: first,
                });

                const result = await client.sendTurnAndWait(turnPrompt, {
                    model: message.mode.model,
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                    effort: turnMode.effort,
                    extraInputItems: imageInputs.inputItems,
                    ...(message.id ? { clientUserMessageId: message.id } : {}),
                });
                first = false;
                if (includeAppendSystemPrompt) {
                    appendSystemPromptInjected = true;
                }

                if (result.aborted) {
                    // Turn was aborted (user abort or permission cancel).
                    // UI handling already done by the event handler (turn_aborted).
                    logger.debug('[Codex] Turn aborted');
                }
            } catch (error) {
                // Only actual errors reach here (process crash, connection failure, etc.)
                logger.warn('Error in codex session:', error);
                messageBuffer.addMessage('Process exited unexpectedly', 'status');
                session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                activeTurnPermissionMode = undefined;
                thinking = false;
                session.keepAlive(thinking, 'remote');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } finally {
        // Clean up resources when main loop exits
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');

        // Cancel offline reconnection if still running
        if (reconnectionHandle) {
            logger.debug('[codex]: Cancelling offline reconnection');
            reconnectionHandle.cancel();
        }

        try {
            await closeCodexV4Runtime();
        } catch (error) {
            logger.warn('[Codex v4] Failed to flush during shutdown', {
                errorName: error instanceof Error ? error.name : typeof error,
            });
        }

        try {
            logger.debug('[codex]: sendSessionDeath');
            session.sendSessionDeath();
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch (e) {
            logger.debug('[codex]: Error while closing session', e);
        }
        logger.debug('[codex]: client.disconnect begin');
        try {
            await client.disconnect();
            logger.debug('[codex]: client.disconnect done');
        } finally {
            client.setProtocolTraceSink(null);
            try {
                await protocolTraceRecorder?.close();
            } catch (error) {
                logger.warn('[Codex] Failed to close redacted protocol trace', {
                    errorName: error instanceof Error ? error.name : typeof error,
                });
            }
        }
        // Stop Happy MCP server
        logger.debug('[codex]: happyServer.stop');
        happyServer.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        // Clear periodic keep-alive to avoid keeping event loop alive
        logger.debug('[codex]: clearInterval(keepAlive)');
        clearInterval(keepAliveInterval);
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
    }
}
