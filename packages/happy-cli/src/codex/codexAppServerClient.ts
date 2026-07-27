/**
 * Codex App Server Client — drives Codex via the v2 JSON-RPC protocol
 * (`codex app-server`), replacing the legacy MCP-based CodexMcpClient.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON).
 * Reference: codex-rs/app-server/README.md in the openai/codex repo.
 *
 * WARNING: @openai/codex-sdk (v0.118.0) exists but only wraps `codex exec`
 * (non-interactive, fire-and-forget). It has NO support for `app-server`,
 * interactive approvals, or bidirectional JSON-RPC. We need app-server for
 * mobile approval routing (exec:request, patch:request, mcp:call), which is
 * why this client is hand-rolled. Re-evaluate if the SDK ever adds an
 * app-server wrapper or approval callbacks. See docs/plans/codex-app-server-migration.md.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn as crossSpawn } from 'cross-spawn';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { logger } from '@/ui/logger';
import type {
    InitializeParams,
    NewConversationParams,
    NewConversationResponse,
    ResumeConversationParams,
    ResumeConversationResponse,
    ForkConversationParams,
    ForkConversationResponse,
    ReadConversationParams,
    ReadConversationResponse,
    RollbackConversationParams,
    RollbackConversationResponse,
    InjectItemsParams,
    InjectItemsResponse,
    ThreadGoalSetParams,
    ThreadGoalSetResponse,
    ThreadGoalGetParams,
    ThreadGoalGetResponse,
    ThreadGoalClearParams,
    ThreadGoalClearResponse,
    Thread,
    InterruptConversationParams,
    ReviewDecision,
    EventMsg,
    JsonRpcRequest,
    JsonRpcResponse,
    ApprovalPolicy,
    SandboxMode,
    InputItem,
    ReasoningEffort,
    McpServerElicitationRequestResponse,
    Model,
    ModelListParams,
    ModelListResponse,
} from './codexAppServerTypes';
import type { SandboxConfig } from '@/persistence';
import { initializeSandbox, wrapForMcpTransport } from '@/sandbox/manager';
import packageJson from '../../package.json';
import {
    assertMinimumCodexCliVersion,
    isCodexCliVersionAtLeast,
    readCodexCliVersion,
} from './codexCliVersion';
import { CodexThreadRegistry } from './codexThreadRegistry';
import type { CodexProtocolTraceDirection, CodexProtocolTraceSink } from './codexProtocolTrace';
import type {
    ServerNotification,
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse,
    ReviewStartParams,
    ReviewStartResponse,
    SkillsListParams,
    SkillsListResponse,
    ThreadCompactStartResponse,
    Thread as ProtocolThread,
    ThreadStatus as ProtocolThreadStatus,
    Turn as ProtocolTurn,
    TurnStatus as ProtocolTurnStatus,
} from './protocol';

type PendingRequest = {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    onResult?: (result: unknown) => void;
    method: string;
    epoch: number;
};

type LegacyPatchChanges = Record<string, Record<string, unknown>>;

type ThreadDefaults = {
    model?: string;
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
    mcpServers?: Record<string, unknown>;
};

export class CodexRpcOutcomeUnknownError extends Error {
    constructor(
        public readonly method: string,
        message: string,
    ) {
        super(message);
        this.name = 'CodexRpcOutcomeUnknownError';
    }
}

export type ApprovalHandler = (params: {
    type: 'exec' | 'patch' | 'mcp';
    callId: string;
    itemId?: string | null;
    threadId?: string | null;
    turnId?: string | null;
    approvalId?: string | null;
    command?: string[];
    cwd?: string;
    fileChanges?: Record<string, unknown>;
    reason?: string | null;
    toolName?: string;
    input?: unknown;
    serverName?: string;
    message?: string;
}) => Promise<ReviewDecision>;

export interface CodexServerRequest {
    requestId: string;
    method:
        | 'item/commandExecution/requestApproval'
        | 'item/fileChange/requestApproval'
        | 'item/permissions/requestApproval'
        | 'item/tool/requestUserInput'
        | 'mcpServer/elicitation/request';
    params: unknown;
}

export type CodexServerRequestHandler = (request: CodexServerRequest) => Promise<unknown>;

export interface CodexConnectionEvent {
    connection: 'connecting' | 'connected' | 'disconnected' | 'error';
    statusUnknown: boolean;
    error: string | null;
}

export type CodexConnectionHandler = (event: CodexConnectionEvent) => void;

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function errorKind(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
}

function isStableServerRequestMethod(method: string): method is CodexServerRequest['method'] {
    return method === 'item/commandExecution/requestApproval'
        || method === 'item/fileChange/requestApproval'
        || method === 'item/permissions/requestApproval'
        || method === 'item/tool/requestUserInput'
        || method === 'mcpServer/elicitation/request';
}

// Codex item ids are per-thread counters, so items from collab subagent
// threads collide with the main thread's. Scoping with the thread id keeps
// them unique — but the SAME scoped id must be used both for the tool-call
// events and for the approval requests of an item: the app attaches a
// permission card to its tool call by exact id equality.
function formatScopedItemKey(threadId: string | null, itemId: string): string {
    return threadId ? `${threadId}:${itemId}` : itemId;
}

function isGoalActionsAvailable(): boolean {
    return isCodexCliVersionAtLeast(readCodexCliVersion(), { major: 0, minor: 140, patch: 0 });
}

function isTurnSteeringAvailable(): boolean {
    return isCodexCliVersionAtLeast(readCodexCliVersion(), { major: 0, minor: 145, patch: 0 });
}

function normalizeRawFileChangeList(changes: unknown): LegacyPatchChanges | undefined {
    if (!Array.isArray(changes)) {
        return undefined;
    }

    const normalized: LegacyPatchChanges = {};
    for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
            continue;
        }

        const path = typeof change.path === 'string' ? change.path : null;
        if (!path) {
            continue;
        }

        const entry: Record<string, unknown> = {};
        const changeRecord = change as Record<string, unknown>;
        const kind = changeRecord.kind && typeof changeRecord.kind === 'object' && !Array.isArray(changeRecord.kind)
            ? changeRecord.kind as Record<string, unknown>
            : null;
        const type = typeof changeRecord.type === 'string'
            ? changeRecord.type
            : (typeof kind?.type === 'string' ? kind.type : null);
        const movePath = changeRecord.move_path ?? kind?.move_path ?? null;

        if (kind) {
            entry.kind = kind;
        } else if (type) {
            entry.kind = { type, move_path: movePath };
        }

        const diff = typeof changeRecord.diff === 'string'
            ? changeRecord.diff
            : (typeof changeRecord.unified_diff === 'string' ? changeRecord.unified_diff : null);
        if (diff !== null) {
            entry.diff = diff;
        }

        if (changeRecord.add && typeof changeRecord.add === 'object' && !Array.isArray(changeRecord.add)) {
            entry.add = changeRecord.add;
        }
        if (changeRecord.modify && typeof changeRecord.modify === 'object' && !Array.isArray(changeRecord.modify)) {
            entry.modify = changeRecord.modify;
        }
        if (changeRecord.delete && typeof changeRecord.delete === 'object' && !Array.isArray(changeRecord.delete)) {
            entry.delete = changeRecord.delete;
        }

        const content = typeof changeRecord.content === 'string' ? changeRecord.content : null;
        if (type === 'add' && content !== null) {
            entry.add = { content };
        }
        if (type === 'delete' && content !== null) {
            entry.delete = { content };
        }

        const oldContent = typeof changeRecord.oldContent === 'string'
            ? changeRecord.oldContent
            : (typeof changeRecord.old_content === 'string' ? changeRecord.old_content : null);
        const newContent = typeof changeRecord.newContent === 'string'
            ? changeRecord.newContent
            : (typeof changeRecord.new_content === 'string' ? changeRecord.new_content : null);
        if ((oldContent !== null || newContent !== null) && type !== 'add' && type !== 'delete') {
            entry.modify = {
                old_content: oldContent ?? '',
                new_content: newContent ?? '',
            };
        }

        normalized[path] = entry;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export class CodexAppServerClient {
    private process: ChildProcess | null = null;
    private readline: ReadlineInterface | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private processEpoch = 0;
    private connected = false;
    private intentionalTransportClose = false;
    private sandboxConfig?: SandboxConfig;
    private sandboxCleanup: (() => Promise<void>) | null = null;
    public sandboxEnabled = false;

    private readonly threads = new CodexThreadRegistry();
    private readonly threadDefaults = new Map<string, ThreadDefaults>();

    private readonly pendingInterrupts = new Map<string, Promise<void>>();
    private readonly unknownTurnReconciliations = new Map<string, Promise<void>>();
    private recoveryPromise: Promise<boolean> | null = null;
    private notificationProtocol: 'unknown' | 'legacy' | 'raw' = 'unknown';
    private completedTurnIds = new Set<string>();
    private rawFileChangesByItemId = new Map<string, LegacyPatchChanges>();
    private rawSubagentActivitySignaturesByItemId = new Map<string, Set<string>>();
    // Approval callIds currently awaiting an answer. One codex item can raise
    // several approval callbacks (approvalId exists to disambiguate them);
    // the bare scoped key is kept for the first so the app's permission ↔
    // tool-call join works, and only a concurrent second approval for the
    // same item gets a disambiguating suffix.
    private pendingApprovalCallIds = new Set<string>();

    // Handlers set by the consumer (runCodex.ts)
    private eventHandler: ((msg: EventMsg) => void) | null = null;
    private approvalHandler: ApprovalHandler | null = null;
    private stableNotificationHandler: ((notification: ServerNotification) => void) | null = null;
    private serverRequestHandler: CodexServerRequestHandler | null = null;
    private connectionHandler: CodexConnectionHandler | null = null;
    private protocolTraceSink: CodexProtocolTraceSink | null = null;
    private connectionEvent: CodexConnectionEvent = {
        connection: 'disconnected',
        statusUnknown: true,
        error: null,
    };

    constructor(sandboxConfig?: SandboxConfig) {
        this.sandboxConfig = sandboxConfig;
    }

    get threadId(): string | null {
        return this.threads.selectedThreadIdValue;
    }

    get turnId(): string | null {
        return this.threads.selectedTurnId;
    }

    supportsGoalActions(): boolean {
        return isGoalActionsAvailable();
    }

    supportsTurnSteering(): boolean {
        return isTurnSteeringAvailable();
    }

    setEventHandler(handler: (msg: EventMsg) => void): void {
        this.eventHandler = handler;
    }

    setApprovalHandler(handler: ApprovalHandler): void {
        this.approvalHandler = handler;
    }

    setStableNotificationHandler(handler: ((notification: ServerNotification) => void) | null): void {
        this.stableNotificationHandler = handler;
    }

    setServerRequestHandler(handler: CodexServerRequestHandler | null): void {
        this.serverRequestHandler = handler;
    }

    setConnectionHandler(handler: CodexConnectionHandler | null): void {
        this.connectionHandler = handler;
        handler?.(this.connectionEvent);
    }

    setProtocolTraceSink(sink: CodexProtocolTraceSink | null): void {
        this.protocolTraceSink = sink;
    }

    private updateConnection(event: CodexConnectionEvent): void {
        this.connectionEvent = event;
        this.connectionHandler?.(event);
    }

    private emitStableNotification(method: string, params: unknown): void {
        this.stableNotificationHandler?.({ method, params } as ServerNotification);
    }

    private normalizeProtocolTurn(value: unknown): ProtocolTurn | null {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const turn = value as Record<string, unknown>;
        if (typeof turn.id !== 'string' || turn.id.length === 0) return null;
        const status = turn.status === 'completed'
            || turn.status === 'interrupted'
            || turn.status === 'failed'
            || turn.status === 'inProgress'
            ? turn.status
            : 'inProgress';
        return {
            ...turn,
            id: turn.id,
            items: Array.isArray(turn.items) ? turn.items : [],
            itemsView: turn.itemsView === 'notLoaded' || turn.itemsView === 'summary' || turn.itemsView === 'full'
                ? turn.itemsView
                : 'full',
            status,
            error: turn.error && typeof turn.error === 'object' ? turn.error : null,
            startedAt: typeof turn.startedAt === 'number' ? turn.startedAt : null,
            completedAt: typeof turn.completedAt === 'number' ? turn.completedAt : null,
            durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : null,
        } as ProtocolTurn;
    }

    private normalizeProtocolThread(value: unknown): ProtocolThread | null {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const thread = value as Record<string, unknown>;
        if (typeof thread.id !== 'string' || thread.id.length === 0) return null;
        const turns = Array.isArray(thread.turns)
            ? thread.turns.map((turn) => this.normalizeProtocolTurn(turn)).filter((turn): turn is ProtocolTurn => !!turn)
            : [];
        const status = this.normalizeThreadStatus(thread.status)
            ?? (turns.some((turn) => turn.status === 'inProgress') ? { type: 'active', activeFlags: [] } : { type: 'idle' });
        return {
            ...thread,
            id: thread.id,
            status,
            turns,
        } as ProtocolThread;
    }

    private normalizeThreadStatus(value: unknown): ProtocolThreadStatus | null {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const status = value as Record<string, unknown>;
        if (status.type === 'notLoaded' || status.type === 'idle' || status.type === 'systemError') {
            return { type: status.type };
        }
        if (status.type === 'active') {
            const activeFlags = Array.isArray(status.activeFlags)
                ? status.activeFlags.filter((flag): flag is 'waitingOnApproval' | 'waitingOnUserInput' => (
                    flag === 'waitingOnApproval' || flag === 'waitingOnUserInput'
                ))
                : [];
            return { type: 'active', activeFlags };
        }
        return null;
    }

    private registerThreadSnapshot(
        value: unknown,
        source: 'response' | 'snapshot' = 'response',
        emitNotification = true,
    ): ProtocolThread | null {
        const thread = this.normalizeProtocolThread(value);
        if (thread) {
            this.threads.registerThread(thread, source);
            if (emitNotification) this.emitStableNotification('thread/started', { thread });
        }
        return thread;
    }

    private scheduleThreadHydration(threadId: string): void {
        if (!this.threads.markHydrationRequested(threadId)) return;
        void this.request('thread/read', { threadId, includeTurns: true })
            .then((result) => {
                const thread = result && typeof result === 'object' && 'thread' in result
                    ? (result as { thread: unknown }).thread
                    : null;
                if (!this.registerThreadSnapshot(thread, 'snapshot')) {
                    this.threads.markHydrationFailed(threadId);
                }
            })
            .catch((error) => {
                this.threads.markHydrationFailed(threadId);
                logger.debug(`[CodexAppServer] Failed to hydrate unknown thread (${errorKind(error)})`);
            });
    }

    private trackStableNotification(method: string, params: any): string | null {
        const threadId = stringOrNull(params?.threadId) ?? stringOrNull(params?.thread?.id);
        if (!threadId) return null;

        if (method === 'thread/started') {
            if (!this.registerThreadSnapshot(params?.thread)) this.scheduleThreadHydration(threadId);
            return null;
        }

        const runtime = this.threads.ensureThread(threadId).runtime;
        if (runtime.placeholder) this.scheduleThreadHydration(threadId);

        if (method === 'turn/started' || method === 'turn/completed') {
            const turn = this.normalizeProtocolTurn(params?.turn);
            if (turn) this.threads.registerTurn(threadId, turn);
            return null;
        }

        if (method === 'thread/status/changed') {
            const activeTurnId = runtime.activeTurnId;
            const status = this.normalizeThreadStatus(params?.status);
            if (status) this.threads.updateThreadStatus(threadId, status);
            return status?.type !== 'active' ? activeTurnId : null;
        }
        return null;
    }

    private extractTurnId(params: any): string | null {
        const turnId = params?.turn?.id ?? params?.turnId ?? params?.turn_id ?? null;
        return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
    }

    private extractTurnStatus(params: any): string | null {
        const status = params?.turn?.status ?? params?.status ?? null;
        return typeof status === 'string' && status.length > 0 ? status : null;
    }

    private shouldHandleRawNotification(method: string): boolean {
        const isRawNotification = method === 'thread/started'
            || method === 'thread/goal/updated'
            || method === 'thread/goal/cleared'
            || method === 'turn/started'
            || method === 'turn/completed'
            || method === 'thread/status/changed'
            || method === 'thread/tokenUsage/updated'
            || method.startsWith('item/');

        if (!isRawNotification) {
            return false;
        }

        if (this.notificationProtocol === 'legacy') {
            return false;
        }

        if (this.notificationProtocol === 'unknown') {
            this.notificationProtocol = 'raw';
        }

        return true;
    }

    private emitRawTurnCompletion(
        threadId: string | null,
        turnId: string | null,
        status: string | null,
        error: unknown,
    ): void {
        const aborted = status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted';
        const completionKey = turnId ? formatScopedItemKey(threadId, turnId) : null;
        if (completionKey && this.completedTurnIds.has(completionKey)) {
            return;
        }
        if (completionKey) {
            this.completedTurnIds.add(completionKey);
        }

        if (aborted) {
            this.eventHandler?.({
                type: 'turn_aborted',
                ...(turnId ? { turn_id: turnId } : {}),
                ...(status ? { status } : {}),
                ...(error !== undefined && error !== null ? { error } : {}),
            });
            return;
        }

        this.eventHandler?.({
            type: 'task_complete',
            ...(turnId ? { turn_id: turnId } : {}),
            ...(status ? { status } : {}),
            ...(error !== undefined && error !== null ? { error } : {}),
        });
    }

    private trackRawFileChangeMetadata(method: string, params: any): void {
        const item = params?.item;
        const threadId = stringOrNull(params?.threadId);
        if (item?.type !== 'fileChange' || typeof item.id !== 'string' || !threadId) return;

        const itemKey = formatScopedItemKey(threadId, item.id);
        const changes = normalizeRawFileChangeList(item.changes);
        if (changes) this.rawFileChangesByItemId.set(itemKey, changes);
        if (method === 'item/completed'
            && (item.status === 'completed' || item.status === 'failed' || item.status === 'declined')) {
            this.rawFileChangesByItemId.delete(itemKey);
        }
    }

    private handleRawNotification(
        method: string,
        params: any,
        statusCompletionTurnId: string | null = null,
    ): boolean {
        this.trackRawFileChangeMetadata(method, params);
        if (!this.shouldHandleRawNotification(method)) {
            return false;
        }

        const notificationThreadId = stringOrNull(params?.threadId) ?? stringOrNull(params?.thread?.id);
        const selectedThreadId = this.threadId;
        if (selectedThreadId && notificationThreadId && notificationThreadId !== selectedThreadId) {
            // Stable notifications already updated the per-thread registry.
            // The legacy event handler belongs to the explicitly selected Happy
            // session, so projecting child events into it would make a child
            // completion appear to finish or overwrite the parent conversation.
            return true;
        }

        if (method === 'turn/started') {
            const turnId = this.extractTurnId(params);
            this.eventHandler?.({
                type: 'task_started',
                ...(turnId ? { turn_id: turnId } : {}),
            });
            return true;
        }

        if (method === 'turn/completed') {
            this.emitRawTurnCompletion(
                stringOrNull(params?.threadId),
                this.extractTurnId(params),
                this.extractTurnStatus(params),
                params?.turn?.error ?? params?.error,
            );
            return true;
        }

        if (method === 'thread/status/changed') {
            const statusType = params?.status?.type;
            if ((statusType === 'idle' || statusType === 'systemError') && statusCompletionTurnId) {
                this.emitRawTurnCompletion(
                    stringOrNull(params?.threadId),
                    statusCompletionTurnId,
                    statusType === 'systemError' ? 'failed' : 'completed',
                    null,
                );
            }
            return true;
        }

        if (method === 'thread/goal/updated') {
            const threadId = typeof params?.threadId === 'string'
                ? params.threadId
                : (typeof params?.goal?.threadId === 'string' ? params.goal.threadId : undefined);
            const turnId = typeof params?.turnId === 'string' ? params.turnId : null;
            this.eventHandler?.({
                type: 'thread_goal_updated',
                ...(threadId ? { thread_id: threadId, threadId } : {}),
                ...(turnId ? { turn_id: turnId, turnId } : {}),
                goal: params?.goal,
            });
            return true;
        }

        if (method === 'thread/goal/cleared') {
            const threadId = typeof params?.threadId === 'string' ? params.threadId : undefined;
            this.eventHandler?.({
                type: 'thread_goal_cleared',
                ...(threadId ? { thread_id: threadId, threadId } : {}),
            });
            return true;
        }

        if (method === 'thread/tokenUsage/updated') {
            const tokenUsage = params?.tokenUsage;
            if (tokenUsage && typeof tokenUsage === 'object') {
                this.eventHandler?.({
                    type: 'token_count',
                    ...tokenUsage,
                });
            }
            return true;
        }

        const item = params?.item;
        if (!item || typeof item !== 'object') {
            return method.startsWith('item/');
        }

        if (method === 'item/started' && item.type === 'commandExecution') {
            const itemId = typeof item.id === 'string' ? item.id : '';
            // Scoped the same way as the approval request for this item, so
            // the app can attach the permission card to the tool call.
            const callId = itemId ? formatScopedItemKey(stringOrNull(params?.threadId) ?? this.threadId, itemId) : '';
            this.eventHandler?.({
                type: 'exec_command_begin',
                call_id: callId,
                callId,
                command: item.command,
                cwd: item.cwd,
                description: item.command,
            });
            return true;
        }

        if (method === 'item/completed' && item.type === 'commandExecution') {
            const itemId = typeof item.id === 'string' ? item.id : '';
            const callId = itemId ? formatScopedItemKey(stringOrNull(params?.threadId) ?? this.threadId, itemId) : '';
            this.eventHandler?.({
                type: 'exec_command_end',
                call_id: callId,
                callId,
                output: item.aggregatedOutput ?? '',
                exit_code: item.exitCode ?? null,
                duration_ms: item.durationMs ?? null,
                status: item.status,
                cwd: item.cwd,
                command: item.command,
            });
            return true;
        }

        if (item.type === 'fileChange') {
            const itemId = typeof item.id === 'string' ? item.id : '';
            const threadId = stringOrNull(params?.threadId) ?? this.threadId;
            const itemKey = itemId ? formatScopedItemKey(threadId, itemId) : '';
            const changes = normalizeRawFileChangeList(item.changes);

            if (method === 'item/started') {
                this.eventHandler?.({
                    type: 'patch_apply_begin',
                    call_id: itemKey,
                    callId: itemKey,
                    changes: changes ?? {},
                });
                return true;
            }

            if (method === 'item/completed') {
                this.eventHandler?.({
                    type: 'patch_apply_end',
                    call_id: itemKey,
                    callId: itemKey,
                    status: item.status,
                });
                return true;
            }
        }

        if (item.type === 'collabAgentToolCall') {
            const callId = typeof item.id === 'string' ? item.id : '';
            const payload = {
                call_id: callId,
                callId,
                tool: item.tool,
                status: item.status,
                sender_thread_id: item.senderThreadId,
                senderThreadId: item.senderThreadId,
                receiver_thread_ids: item.receiverThreadIds,
                receiverThreadIds: item.receiverThreadIds,
                prompt: item.prompt,
                model: item.model,
                reasoning_effort: item.reasoningEffort,
                reasoningEffort: item.reasoningEffort,
                agents_states: item.agentsStates,
                agentsStates: item.agentsStates,
            };

            if (method === 'item/started') {
                this.eventHandler?.({
                    type: 'collab_agent_begin',
                    ...payload,
                });
                return true;
            }

            if (method === 'item/completed') {
                this.eventHandler?.({
                    type: 'collab_agent_end',
                    ...payload,
                });
                return true;
            }
        }

        if (item.type === 'subAgentActivity') {
            if (method === 'item/started' || method === 'item/completed') {
                const itemId = typeof item.id === 'string' ? item.id : '';
                const threadId = stringOrNull(params?.threadId);
                const itemKey = itemId ? formatScopedItemKey(threadId, itemId) : '';
                const signature = [
                    String(item.kind ?? ''),
                    String(item.agentThreadId ?? ''),
                    String(item.agentPath ?? ''),
                ].join('\0');
                const seenSignatures = itemKey
                    ? this.rawSubagentActivitySignaturesByItemId.get(itemKey)
                    : undefined;
                if (seenSignatures?.has(signature)) {
                    return true;
                }
                if (itemKey) {
                    const signatures = seenSignatures ?? new Set<string>();
                    signatures.add(signature);
                    this.rawSubagentActivitySignaturesByItemId.set(itemKey, signatures);
                }
                this.eventHandler?.({
                    type: 'subagent_activity',
                    item_id: item.id,
                    kind: item.kind,
                    agent_thread_id: item.agentThreadId,
                    agentThreadId: item.agentThreadId,
                    agent_path: item.agentPath,
                    agentPath: item.agentPath,
                });
            }
            return true;
        }

        if (method === 'item/completed' && item.type === 'agentMessage') {
            const text = typeof item.text === 'string' ? item.text : '';
            if (text.length > 0) {
                this.eventHandler?.({
                    type: 'agent_message',
                    message: text,
                    item_id: item.id,
                    phase: item.phase,
                });
            }

            return true;
        }

        return method.startsWith('item/');
    }

    // ─── Lifecycle ──────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this.connected) return;
        assertMinimumCodexCliVersion();
        this.updateConnection({ connection: 'connecting', statusUnknown: true, error: null });

        let command = 'codex';
        let args = ['app-server', '--listen', 'stdio://'];
        this.sandboxEnabled = false;

        if (this.sandboxConfig?.enabled && process.platform !== 'win32') {
            try {
                this.sandboxCleanup = await initializeSandbox(this.sandboxConfig, process.cwd());
                const wrapped = await wrapForMcpTransport('codex', ['app-server', '--listen', 'stdio://']);
                command = wrapped.command;
                args = wrapped.args;
                this.sandboxEnabled = true;
                logger.info(`[CodexAppServer] Sandbox enabled`);
            } catch (error) {
                logger.warn(`[CodexAppServer] Failed to initialize sandbox; continuing without (${errorKind(error)})`);
                this.sandboxCleanup = null;
            }
        }

        // Build env — same filtering as the old MCP client
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (typeof value === 'string') env[key] = value;
        }
        // Mute noisy rollout list logging
        const filter = 'codex_core::rollout::list=off';
        if (!env.RUST_LOG) {
            env.RUST_LOG = filter;
        } else if (!env.RUST_LOG.includes('codex_core::rollout::list=')) {
            env.RUST_LOG += `,${filter}`;
        }
        if (this.sandboxEnabled) {
            env.CODEX_SANDBOX = 'seatbelt';
        }

        logger.debug(`[CodexAppServer] Spawning app-server transport; sandbox=${this.sandboxEnabled}`);

        const epoch = ++this.processEpoch;
        this.intentionalTransportClose = false;
        // Use cross-spawn so npm-installed wrappers (codex.cmd / codex.ps1) resolve on Windows.
        // Native child_process.spawn fails with ENOENT for .cmd shims (issues #980, #1016).
        const proc = crossSpawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            windowsHide: true,
        });
        this.process = proc;

        proc.on('error', (err) => {
            logger.debug(`[CodexAppServer] Process error (${errorKind(err)})`);
            if (this.process === proc && this.processEpoch === epoch) {
                this.updateConnection({ connection: 'error', statusUnknown: true, error: errorKind(err) });
            }
        });

        proc.on('exit', (code, signal) => {
            logger.debug(`[CodexAppServer] Process exited: code=${code} signal=${signal}`);
            // Ignore stale process exits from prior generations during reconnect.
            if (this.process !== proc || this.processEpoch !== epoch) {
                logger.debug('[CodexAppServer] Ignoring stale process exit');
                return;
            }
            this.connected = false;
            this.process = null;
            this.updateConnection({ connection: 'disconnected', statusUnknown: true, error: null });
            this.readline?.close();
            this.readline = null;
            // Reject all pending requests
            for (const [id, req] of this.pending) {
                if (req.epoch !== epoch) continue;
                req.reject(new CodexRpcOutcomeUnknownError(
                    req.method,
                    `Codex process exited (code=${code}) while waiting for ${req.method}; outcome is unknown`,
                ));
                this.pending.delete(id);
            }
            const threadId = this.threadId;
            if (threadId && this.threads.hasPendingTurn(threadId)) {
                void this.recoverThreadAfterUnexpectedExit(threadId);
            }
        });

        // Pipe stderr for debug logging
        proc.stderr?.on('data', (chunk: Buffer) => {
            if (this.process !== proc || this.processEpoch !== epoch) return;
            if (chunk.length > 0) logger.debug(`[CodexAppServer] stderr suppressed; bytes=${chunk.length}`);
        });

        // Parse newline-delimited JSON from stdout
        this.readline = createInterface({ input: proc.stdout! });
        this.readline.on('line', (line) => {
            if (this.process !== proc || this.processEpoch !== epoch) return;
            this.handleLine(line, epoch);
        });
        this.readline.on('close', () => {
            if (this.intentionalTransportClose || this.process !== proc || this.processEpoch !== epoch) return;
            logger.debug('[CodexAppServer] Stdout transport closed unexpectedly');
            this.handleUnexpectedTransportClose(proc, epoch);
        });

        // Perform initialize handshake
        const initParams: InitializeParams = {
            clientInfo: {
                name: 'happy-codex',
                title: 'Happy Codex Client',
                version: packageJson.version,
            },
            capabilities: {
                experimentalApi: false,
            },
        };
        try {
            await this.request('initialize', initParams);
            this.notify('initialized');
            this.connected = true;
            this.updateConnection({
                connection: 'connected',
                statusUnknown: this.threadId !== null,
                error: null,
            });
            logger.debug('[CodexAppServer] Connected and initialized');
        } catch (error) {
            this.updateConnection({ connection: 'error', statusUnknown: true, error: errorKind(error) });
            throw error;
        }
    }

    private async disconnectInternal(opts?: { preserveThreadState?: boolean }): Promise<void> {
        if (!this.connected && !this.process) {
            if (!opts?.preserveThreadState) {
                this.threads.clear(new Error('Codex client disconnected'));
                this.threadDefaults.clear();
            }
            return;
        }

        const proc = this.process;
        const pid = proc?.pid;
        const epoch = this.processEpoch;
        logger.debug(`[CodexAppServer] Disconnecting; pid=${pid ?? 'none'}`);

        this.intentionalTransportClose = true;
        this.readline?.close();
        this.readline = null;

        try {
            proc?.stdin?.end();
            proc?.kill('SIGTERM');
        } catch { /* ignore */ }

        // Force kill after 2s (unref so timer doesn't block process exit)
        if (pid) {
            const killTimer = setTimeout(() => {
                try {
                    process.kill(pid, 0); // check alive
                    process.kill(pid, 'SIGKILL');
                } catch { /* already dead */ }
            }, 2000);
            killTimer.unref();
        }

        this.process = null;
        this.connected = false;
        this.updateConnection({ connection: 'disconnected', statusUnknown: true, error: null });
        this.notificationProtocol = 'unknown';
        this.completedTurnIds.clear();
        if (!opts?.preserveThreadState) {
            this.threads.clear(new Error('Codex client disconnected'));
            this.threadDefaults.clear();
        }

        // Fail in-flight requests from this process generation.
        for (const [id, req] of this.pending) {
            if (req.epoch !== epoch) continue;
            req.reject(new CodexRpcOutcomeUnknownError(
                req.method,
                `Codex process disconnected while waiting for ${req.method}; outcome is unknown`,
            ));
            this.pending.delete(id);
        }

        if (this.sandboxCleanup) {
            try { await this.sandboxCleanup(); } catch { /* ignore */ }
            this.sandboxCleanup = null;
        }
        this.sandboxEnabled = false;

        logger.debug('[CodexAppServer] Disconnected');
        this.intentionalTransportClose = false;
    }

    async disconnect(): Promise<void> {
        await this.disconnectInternal();
    }

    private buildThreadConfig(mcpServers?: Record<string, unknown>): Record<string, unknown> | null {
        return mcpServers ? { mcp_servers: mcpServers } : null;
    }

    private rememberThreadDefaults(threadId: string, opts: ThreadDefaults): void {
        this.threadDefaults.set(threadId, {
            model: opts.model,
            cwd: opts.cwd,
            approvalPolicy: opts.approvalPolicy,
            sandbox: opts.sandbox,
            mcpServers: opts.mcpServers,
        });
    }

    async listModels(opts?: { timeoutMs?: number; pageSize?: number }): Promise<Model[]> {
        const models: Model[] = [];
        const seenCursors = new Set<string>();
        const timeoutMs = opts?.timeoutMs ?? CodexAppServerClient.REQUEST_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;
        const maxPages = 100;
        let pageCount = 0;
        let cursor: string | null = null;

        do {
            pageCount += 1;
            if (pageCount > maxPages) {
                throw new Error(`model/list exceeded ${maxPages} pages`);
            }
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                throw new Error(`model/list timed out after ${timeoutMs}ms`);
            }
            const params: ModelListParams = {
                cursor,
                limit: opts?.pageSize ?? 100,
                includeHidden: false,
            };
            const result = await this.request('model/list', params, remainingMs) as ModelListResponse;
            models.push(...result.data);

            cursor = result.nextCursor;
            if (cursor && seenCursors.has(cursor)) {
                throw new Error(`model/list returned a repeated cursor: ${cursor}`);
            }
            if (cursor) {
                seenCursors.add(cursor);
            }
        } while (cursor);

        return models;
    }

    async listSkills(opts?: SkillsListParams): Promise<SkillsListResponse> {
        return await this.request('skills/list', {
            cwds: opts?.cwds ?? [process.cwd()],
            forceReload: opts?.forceReload ?? false,
        }) as SkillsListResponse;
    }

    async listMcpServerStatus(opts?: {
        threadId?: string | null;
        detail?: ListMcpServerStatusParams['detail'];
        timeoutMs?: number;
        pageSize?: number;
    }): Promise<ListMcpServerStatusResponse['data']> {
        const data: ListMcpServerStatusResponse['data'] = [];
        const seenCursors = new Set<string>();
        const timeoutMs = opts?.timeoutMs ?? CodexAppServerClient.REQUEST_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;
        let cursor: string | null = null;
        let pageCount = 0;
        do {
            pageCount += 1;
            if (pageCount > 100) throw new Error('mcpServerStatus/list exceeded 100 pages');
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) throw new Error(`mcpServerStatus/list timed out after ${timeoutMs}ms`);
            const response = await this.request('mcpServerStatus/list', {
                cursor,
                limit: opts?.pageSize ?? 100,
                detail: opts?.detail ?? 'toolsAndAuthOnly',
                threadId: opts?.threadId ?? this.threadId,
            } satisfies ListMcpServerStatusParams, remainingMs) as ListMcpServerStatusResponse;
            data.push(...response.data);
            cursor = response.nextCursor;
            if (cursor && seenCursors.has(cursor)) {
                throw new Error('mcpServerStatus/list returned a repeated cursor');
            }
            if (cursor) seenCursors.add(cursor);
        } while (cursor);
        return data;
    }

    // ─── Thread management ──────────────────────────────────────

    async startThread(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string }> {
        const params: NewConversationParams = {
            model: opts.model ?? null,
            modelProvider: null,
            profile: null,
            cwd: opts.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? null,
            config: this.buildThreadConfig(opts.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            compactPrompt: null,
            includeApplyPatchTool: null,
            experimentalRawEvents: false,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/start', params, undefined, (value) => {
            const response = value as NewConversationResponse;
            this.registerThreadSnapshot(response.thread);
            this.threads.selectThread(response.thread.id);
            this.rememberThreadDefaults(response.thread.id, opts);
        }) as NewConversationResponse;
        logger.debug('[CodexAppServer] Thread started');
        return { threadId: result.thread.id, model: result.model };
    }

    async resumeThread(opts?: {
        threadId?: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
        emitSnapshot?: boolean;
    }): Promise<{ threadId: string; model: string; thread: ProtocolThread }> {
        const threadId = opts?.threadId ?? this.threadId;
        if (!threadId) {
            throw new Error('No thread available to resume.');
        }

        const defaults = this.threadDefaults.get(threadId) ?? {};
        const params: ResumeConversationParams = {
            threadId,
            model: opts?.model ?? defaults.model ?? null,
            modelProvider: null,
            cwd: opts?.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy ?? null,
            sandbox: opts?.sandbox ?? defaults.sandbox ?? null,
            config: this.buildThreadConfig(opts?.mcpServers ?? defaults.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            persistExtendedHistory: true,
        };

        const nextDefaults = {
            model: opts?.model ?? defaults.model,
            cwd: opts?.cwd ?? defaults.cwd,
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts?.sandbox ?? defaults.sandbox,
            mcpServers: opts?.mcpServers ?? defaults.mcpServers,
        };
        let resumedSnapshot: ProtocolThread | null = null;
        const result = await this.request('thread/resume', params, undefined, (value) => {
            const response = value as ResumeConversationResponse;
            resumedSnapshot = this.registerThreadSnapshot(
                response.thread,
                'snapshot',
                opts?.emitSnapshot !== false,
            );
            this.threads.selectThread(response.thread.id);
            this.rememberThreadDefaults(response.thread.id, nextDefaults);
        }) as ResumeConversationResponse;
        const thread = resumedSnapshot ?? this.normalizeProtocolThread(result.thread);
        if (!thread) throw new Error('thread/resume returned an invalid thread snapshot');
        logger.debug('[CodexAppServer] Thread resumed');
        return { threadId: thread.id, model: result.model, thread };
    }

    async forkThread(opts: {
        threadId: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string; thread: Thread }> {
        const defaults = this.threadDefaults.get(opts.threadId) ?? {};
        const params: ForkConversationParams = {
            threadId: opts.threadId,
            model: opts.model ?? defaults.model ?? null,
            modelProvider: null,
            cwd: opts.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? defaults.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? defaults.sandbox ?? null,
            config: this.buildThreadConfig(opts.mcpServers ?? defaults.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            ephemeral: false,
            threadSource: null,
        };

        const nextDefaults = {
            model: opts.model ?? defaults.model,
            cwd: opts.cwd ?? defaults.cwd,
            approvalPolicy: opts.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts.sandbox ?? defaults.sandbox,
            mcpServers: opts.mcpServers ?? defaults.mcpServers,
        };
        const result = await this.request('thread/fork', params, undefined, (value) => {
            const response = value as ForkConversationResponse;
            this.registerThreadSnapshot(response.thread, 'snapshot');
            this.threads.selectThread(response.thread.id);
            this.rememberThreadDefaults(response.thread.id, nextDefaults);
        }) as ForkConversationResponse;
        logger.debug('[CodexAppServer] Thread forked');
        return { threadId: result.thread.id, model: result.model, thread: result.thread };
    }

    async readThread(opts: {
        threadId: string;
        includeTurns?: boolean;
        emitSnapshot?: boolean;
    }): Promise<{ thread: ProtocolThread }> {
        const params: ReadConversationParams = {
            threadId: opts.threadId,
            includeTurns: opts.includeTurns ?? true,
        };
        const result = await this.request('thread/read', params) as ReadConversationResponse;
        const thread = this.registerThreadSnapshot(result.thread, 'snapshot', opts.emitSnapshot !== false);
        if (!thread) throw new Error('thread/read returned an invalid thread snapshot');
        return { thread };
    }

    async rollbackThread(opts: {
        threadId: string;
        numTurns: number;
    }): Promise<RollbackConversationResponse> {
        const params: RollbackConversationParams = {
            threadId: opts.threadId,
            numTurns: opts.numTurns,
        };
        const result = await this.request('thread/rollback', params) as RollbackConversationResponse;
        this.registerThreadSnapshot(result.thread, 'snapshot');
        return result;
    }

    async injectItems(opts: {
        threadId: string;
        items: unknown[];
    }): Promise<InjectItemsResponse> {
        const params: InjectItemsParams = {
            threadId: opts.threadId,
            items: opts.items,
        };
        return await this.request('thread/inject_items', params) as InjectItemsResponse;
    }

    async setGoal(opts: {
        threadId: string;
        objective: string;
        status?: ThreadGoalSetParams['status'];
        tokenBudget?: number | null;
    }): Promise<ThreadGoalSetResponse> {
        const params: ThreadGoalSetParams = {
            threadId: opts.threadId,
            objective: opts.objective,
            ...(opts.status !== undefined ? { status: opts.status } : {}),
            ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
        };
        return await this.request('thread/goal/set', params) as ThreadGoalSetResponse;
    }

    async getGoal(opts: {
        threadId: string;
    }): Promise<ThreadGoalGetResponse> {
        const params: ThreadGoalGetParams = { threadId: opts.threadId };
        return await this.request('thread/goal/get', params) as ThreadGoalGetResponse;
    }

    async clearGoal(opts: {
        threadId: string;
    }): Promise<ThreadGoalClearResponse> {
        const params: ThreadGoalClearParams = {
            threadId: opts.threadId,
        };
        return await this.request('thread/goal/clear', params) as ThreadGoalClearResponse;
    }

    async compactThread(threadId: string): Promise<ThreadCompactStartResponse> {
        return await this.request('thread/compact/start', { threadId }) as ThreadCompactStartResponse;
    }

    async startReview(params: ReviewStartParams): Promise<ReviewStartResponse> {
        const result = await this.request('review/start', params) as ReviewStartResponse;
        const turn = this.normalizeProtocolTurn(result.turn);
        if (turn) {
            this.threads.registerTurn(result.reviewThreadId, turn);
            this.emitStableNotification('turn/started', {
                threadId: result.reviewThreadId,
                turn,
            });
        }
        const reviewRuntime = this.threads.ensureThread(result.reviewThreadId).runtime;
        if (reviewRuntime.placeholder) this.scheduleThreadHydration(result.reviewThreadId);
        return result;
    }

    async reconnectAndResumeThread(): Promise<boolean> {
        const threadId = this.threadId;
        if (!threadId) return false;
        return await this.restartAndResumeThread(threadId);
    }

    private async restartAndResumeThread(threadId: string): Promise<boolean> {
        if (this.recoveryPromise) return await this.recoveryPromise;

        const recovery = (async () => {
            await this.disconnectInternal({ preserveThreadState: true });
            await this.connect();
            await this.resumeThread({ threadId });
            return true;
        })();
        this.recoveryPromise = recovery;
        try {
            return await recovery;
        } catch (error) {
            logger.warn(`[CodexAppServer] Failed to resume thread after reconnect (${errorKind(error)})`);
            await this.disconnectInternal({ preserveThreadState: true });
            return false;
        } finally {
            if (this.recoveryPromise === recovery) this.recoveryPromise = null;
        }
    }

    private async recoverThreadAfterUnexpectedExit(threadId: string): Promise<void> {
        const resumed = await this.restartAndResumeThread(threadId);
        if (!resumed) {
            logger.warn('[CodexAppServer] Active turn remains unknown after app-server exit');
        }
    }

    private reconcileUnknownTurn(threadId: string, completion: Promise<unknown>): void {
        if (this.unknownTurnReconciliations.has(threadId)) return;

        let reconciliation!: Promise<void>;
        reconciliation = (async () => {
            while (this.threads.hasPendingTurn(threadId)) {
                const authoritativeRead = this.connected
                    ? this.readThread({ threadId, includeTurns: true }).then(() => undefined)
                    : this.restartAndResumeThread(threadId).then(() => undefined);
                await Promise.race([
                    authoritativeRead.catch((error) => {
                        logger.debug(`[CodexAppServer] Unknown turn reconciliation failed (${errorKind(error)})`);
                    }),
                    completion.then(() => undefined, () => undefined),
                ]);
                if (!this.threads.hasPendingTurn(threadId)) break;
                await Promise.race([
                    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
                    completion.then(() => undefined, () => undefined),
                ]);
            }
        })().finally(() => {
            if (this.unknownTurnReconciliations.get(threadId) === reconciliation) {
                this.unknownTurnReconciliations.delete(threadId);
            }
        });
        this.unknownTurnReconciliations.set(threadId, reconciliation);
    }

    // ─── Turn management ────────────────────────────────────────

    /** Default grace period after interrupt before forcing a restart (ms). */
    private static readonly ABORT_GRACE_MS = 3_000;

    private hasPendingTurnCompletion(threadId: string | null = this.threadId): boolean {
        return threadId !== null && this.threads.hasPendingTurn(threadId);
    }

    private async waitForTurnCompletion(threadId: string, timeoutMs: number): Promise<boolean> {
        if (!this.hasPendingTurnCompletion(threadId)) {
            return true;
        }

        const deadline = Date.now() + Math.max(0, timeoutMs);
        while (this.hasPendingTurnCompletion(threadId)) {
            if (Date.now() >= deadline) {
                return false;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return true;
    }

    /**
     * Request turn interruption and optionally force-restart the app-server if
     * the turn does not settle within a short grace period.
     */
    async abortTurnWithFallback(opts?: {
        gracePeriodMs?: number;
        forceRestartOnTimeout?: boolean;
    }): Promise<{ hadActiveTurn: boolean; aborted: boolean; forcedRestart: boolean; resumedThread: boolean }> {
        const threadId = this.threadId;
        const hadActiveTurn = this.hasPendingTurnCompletion(threadId);

        // No active turn pending in this client call-site.
        if (!threadId || !hadActiveTurn) {
            return { hadActiveTurn: false, aborted: false, forcedRestart: false, resumedThread: false };
        }

        const gracePeriodMs = opts?.gracePeriodMs ?? CodexAppServerClient.ABORT_GRACE_MS;
        // Best-effort interrupt request first, but do not block the fallback on
        // the interrupt RPC itself. Codex can stop emitting responses while a
        // tool/subagent/MCP call is wedged, and in that case the restart fallback
        // is the mechanism that actually makes Stop Execution reliable.
        void this.interruptTurn({ timeoutMs: Math.max(1, gracePeriodMs) });

        const settled = await this.waitForTurnCompletion(threadId, gracePeriodMs);
        if (settled) {
            return { hadActiveTurn: true, aborted: true, forcedRestart: false, resumedThread: false };
        }

        const shouldForceRestart = opts?.forceRestartOnTimeout ?? true;
        if (!shouldForceRestart) {
            return { hadActiveTurn: true, aborted: false, forcedRestart: false, resumedThread: false };
        }

        logger.warn(`[CodexAppServer] interrupt did not settle turn in ${gracePeriodMs}ms; force-restarting app-server`);
        const pendingTurnId = this.threads.getThread(threadId)?.activeTurnId ?? null;
        this.threads.settleForcedInterrupt(threadId, pendingTurnId);
        this.eventHandler?.({
            type: 'turn_aborted',
            reason: 'interrupted',
            ...(pendingTurnId ? { turn_id: pendingTurnId } : {}),
            forced_restart: true,
        });
        const resumedThread = await this.reconnectAndResumeThread();
        return { hadActiveTurn: true, aborted: true, forcedRestart: true, resumedThread };
    }

    /**
     * Send a user turn and wait for it to complete.
     * Returns when task_complete or turn_aborted is received.
     */
    async sendTurn(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        extraInputItems?: InputItem[];
        clientUserMessageId?: string;
    }): Promise<void> {
        const threadId = this.threadId;
        if (!threadId) {
            throw new Error('No active thread. Call startThread first.');
        }
        await this.startTurnOnThread(threadId, prompt, opts);
    }

    async startTurnOnThread(threadId: string, prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        extraInputItems?: InputItem[];
        clientUserMessageId?: string;
    }): Promise<{ turnId: string | null }> {

        const extraInputItems = opts?.extraInputItems ?? [];
        const input: InputItem[] = [];
        if (prompt.length > 0 || extraInputItems.length === 0) {
            input.push({ type: 'text', text: prompt });
        }
        input.push(...extraInputItems);

        // Build params — only include optional fields when set (server uses thread defaults otherwise)
        const params: Record<string, unknown> = {
            threadId,
            input,
        };
        if (opts?.clientUserMessageId) params.clientUserMessageId = opts.clientUserMessageId;
        if (opts?.cwd) params.cwd = opts.cwd;
        if (opts?.approvalPolicy) params.approvalPolicy = opts.approvalPolicy;
        if (opts?.model) params.model = opts.model;
        if (opts?.effort) params.effort = opts.effort;

        // Map sandbox mode to the camelCase policy format the server expects
        if (opts?.sandbox) {
            switch (opts.sandbox) {
                case 'workspace-write':
                    params.sandboxPolicy = { type: 'workspaceWrite' };
                    break;
                case 'danger-full-access':
                    params.sandboxPolicy = { type: 'dangerFullAccess' };
                    break;
                case 'read-only':
                    params.sandboxPolicy = { type: 'readOnly' };
                    break;
            }
        }

        // turn/start returns immediately; turn completes via events.
        // We don't await completion here — the caller's event handler
        // tracks task_complete / turn_aborted.
        const result = await this.request('turn/start', params) as { turn?: unknown };
        const turn = this.normalizeProtocolTurn(result?.turn);
        if (turn) {
            this.threads.registerTurn(threadId, turn);
            this.emitStableNotification('turn/started', { threadId, turn });
        }
        return { turnId: turn?.id ?? null };
    }

    /**
     * Send a user turn and wait for it to complete (task_complete or turn_aborted).
     * Returns { aborted: true } if the turn was aborted (user cancel, permission reject, etc.).
     */
    async sendTurnAndWait(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        extraInputItems?: InputItem[];
        clientUserMessageId?: string;
        /** @deprecated Kept for API compatibility. Turn completion has no wall-clock timeout. */
        turnTimeoutMs?: number;
    }): Promise<{ aborted: boolean }> {
        const threadId = this.threadId;
        if (!threadId) {
            throw new Error('No active thread. Call startThread first.');
        }

        // Wait for any in-flight interruptTurn() to complete before starting a new
        // turn. Otherwise the stale turn/interrupt RPC can reach Codex after our
        // turn/start and abort the wrong turn.
        const pendingInterrupts = [...this.pendingInterrupts.entries()]
            .filter(([key]) => key.startsWith(`${threadId}\0`))
            .map(([, pending]) => pending);
        if (pendingInterrupts.length > 0) {
            await Promise.all(pendingInterrupts);
            // Yield to the event loop so any stale turn_aborted/task_complete
            // notifications queued by the interrupted turn are processed first.
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        const wait = this.threads.beginTurn(threadId);

        try {
            await this.startTurnOnThread(threadId, prompt, opts);
        } catch (error) {
            if (error instanceof CodexRpcOutcomeUnknownError) {
                logger.warn('[CodexAppServer] turn/start outcome is unknown; reconciling from authoritative state');
                this.reconcileUnknownTurn(threadId, wait.promise);
            } else {
                const failure = error instanceof Error ? error : new Error(String(error));
                this.threads.failTurnStart(threadId, failure);
                await wait.promise;
                throw failure;
            }
        }

        const completion = await wait.promise;
        return { aborted: completion.aborted };
    }

    /** Add user input to the active turn without interrupting it. */
    async steerTurn(prompt: string, opts?: {
        extraInputItems?: InputItem[];
        clientUserMessageId?: string;
    }): Promise<void> {
        if (!this.supportsTurnSteering()) {
            throw new Error('The installed Codex version does not support turn steering');
        }
        const threadId = this.threadId;
        const turnId = this.turnId;
        if (!threadId || !turnId || !this.hasPendingTurnCompletion(threadId)) {
            throw new Error('No active Codex turn to steer');
        }

        await this.steerTurnOnThread(threadId, turnId, prompt, opts);
    }

    async steerTurnOnThread(
        threadId: string,
        expectedTurnId: string,
        prompt: string,
        opts?: {
            extraInputItems?: InputItem[];
            clientUserMessageId?: string;
        },
    ): Promise<void> {
        if (!this.supportsTurnSteering()) {
            throw new Error('The installed Codex version does not support turn steering');
        }

        const extraInputItems = opts?.extraInputItems ?? [];
        const input: InputItem[] = [];
        if (prompt.length > 0 || extraInputItems.length === 0) {
            input.push({ type: 'text', text: prompt });
        }
        input.push(...extraInputItems);

        await this.request('turn/steer', {
            threadId,
            expectedTurnId,
            input,
            ...(opts?.clientUserMessageId
                ? { clientUserMessageId: opts.clientUserMessageId }
                : {}),
        });
    }

    async interruptTurn(opts?: { timeoutMs?: number }): Promise<void> {
        const threadId = this.threadId;
        if (!threadId) return;
        const turnId = this.threads.getThread(threadId)?.activeTurnId ?? null;
        if (!turnId) {
            logger.debug('[CodexAppServer] interruptTurn: no active turnId, skipping');
            return;
        }
        await this.interruptTurnOnThread(threadId, turnId, opts);
    }

    async interruptTurnOnThread(
        threadId: string,
        turnId: string,
        opts?: { timeoutMs?: number },
    ): Promise<void> {
        const params: InterruptConversationParams = {
            threadId,
            turnId,
        };
        const interruptKey = `${threadId}\0${turnId}`;
        const existing = this.pendingInterrupts.get(interruptKey);
        if (existing) return await existing;

        let interrupt!: Promise<void>;
        const doInterrupt = async () => {
            try {
                await this.request('turn/interrupt', params, opts?.timeoutMs);
            } catch (err) {
                // Ignore if no turn is active
                logger.debug(`[CodexAppServer] interruptTurn error (may be expected; ${errorKind(err)})`);
            } finally {
                if (this.pendingInterrupts.get(interruptKey) === interrupt) {
                    this.pendingInterrupts.delete(interruptKey);
                }
            }
        };
        interrupt = doInterrupt();
        this.pendingInterrupts.set(interruptKey, interrupt);
        return await interrupt;
    }

    // ─── State queries ──────────────────────────────────────────

    hasActiveThread(): boolean {
        return this.threadId !== null;
    }

    clearThreadState(): void {
        const threadId = this.threadId;
        const turnId = this.turnId;
        logger.debug(
            `[CodexAppServer] Clearing selected thread state: activeTurn=${turnId ? 'yes' : 'no'}`,
        );
        if (threadId) {
            this.threads.settleForcedInterrupt(threadId, turnId);
            this.threads.forgetThread(threadId, new Error('Selected Codex thread cleared'));
            this.threadDefaults.delete(threadId);
        }
        this.completedTurnIds.clear();
        this.rawFileChangesByItemId.clear();
        this.rawSubagentActivitySignaturesByItemId.clear();
    }

    // ─── JSON-RPC transport ─────────────────────────────────────

    /** Default timeout for RPC requests (ms). */
    private static readonly REQUEST_TIMEOUT_MS = 30_000;

    private request(
        method: string,
        params?: unknown,
        timeoutMs?: number,
        onResult?: (result: unknown) => void,
    ): Promise<unknown> {
        const timeout = timeoutMs ?? CodexAppServerClient.REQUEST_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin?.writable) {
                reject(new Error(`Cannot send ${method}: stdin not writable`));
                return;
            }
            const id = this.nextId++;

            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CodexRpcOutcomeUnknownError(
                    method,
                    `${method} timed out after ${timeout}ms; outcome is unknown`,
                ));
            }, timeout);

            this.pending.set(id, {
                resolve: (result) => { clearTimeout(timer); resolve(result); },
                reject: (err) => { clearTimeout(timer); reject(err); },
                onResult,
                method,
                epoch: this.processEpoch,
            });

            const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
            const line = JSON.stringify(msg) + '\n';
            logger.debug(`[CodexAppServer] → ${method} (id=${id})`);
            this.recordProtocolTrace('outbound', msg);
            this.process.stdin.write(line);
        });
    }

    private notify(method: string, params?: unknown): void {
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcRequest = { jsonrpc: '2.0', method, params };
        this.recordProtocolTrace('outbound', msg);
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug(`[CodexAppServer] → ${method} (notification)`);
    }

    private respond(id: number, result: unknown): void {
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
        this.recordProtocolTrace('outbound', msg);
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug(`[CodexAppServer] → response (id=${id})`);
    }

    private handleLine(line: string, sourceEpoch: number = this.processEpoch): void {
        if (sourceEpoch !== this.processEpoch) {
            return;
        }
        if (!line.trim()) return;

        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            logger.debug(`[CodexAppServer] Non-JSON stdout suppressed; chars=${line.length}`);
            return;
        }
        this.recordProtocolTrace('inbound', msg);

        // Response to our request
        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
            const pending = this.pending.get(msg.id);
            if (pending) {
                if (pending.epoch !== sourceEpoch) {
                    logger.debug(`[CodexAppServer] Ignoring response from stale epoch for id=${msg.id}`);
                    return;
                }
                this.pending.delete(msg.id);
                if (msg.error) {
                    const code = typeof msg.error.code === 'number' || typeof msg.error.code === 'string'
                        ? msg.error.code
                        : 'unknown';
                    pending.reject(new Error(`${pending.method} failed (code=${code})`));
                } else {
                    try {
                        pending.onResult?.(msg.result);
                    } catch (error) {
                        pending.reject(error instanceof Error ? error : new Error(String(error)));
                        return;
                    }
                    pending.resolve(msg.result);
                }
            }
            return;
        }

        // Server → client request (approvals)
        if (msg.id != null && msg.method) {
            this.handleServerRequest(msg.id, msg.method, msg.params).catch((err) => {
                logger.debug(`[CodexAppServer] Error handling server request (${errorKind(err)})`);
            });
            return;
        }

        // Notification (no id)
        if (msg.method) {
            this.handleNotification(msg.method, msg.params);
            return;
        }

        const keys = msg && typeof msg === 'object' && !Array.isArray(msg)
            ? Object.keys(msg).sort().join(',')
            : typeof msg;
        logger.debug(`[CodexAppServer] Unhandled message shape; keys=${keys}`);
    }

    private recordProtocolTrace(direction: CodexProtocolTraceDirection, message: unknown): void {
        try {
            this.protocolTraceSink?.record(direction, message);
        } catch (error) {
            logger.debug(`[CodexAppServer] Protocol trace sink failed (${errorKind(error)})`);
        }
    }

    private handleUnexpectedTransportClose(proc: ChildProcess, epoch: number): void {
        if (this.process !== proc || this.processEpoch !== epoch) return;
        this.connected = false;
        this.process = null;
        this.readline = null;
        this.updateConnection({ connection: 'disconnected', statusUnknown: true, error: null });
        for (const [id, request] of this.pending) {
            if (request.epoch !== epoch) continue;
            request.reject(new CodexRpcOutcomeUnknownError(
                request.method,
                `Codex transport closed while waiting for ${request.method}; outcome is unknown`,
            ));
            this.pending.delete(id);
        }
        try {
            proc.kill('SIGTERM');
        } catch { /* process already unavailable */ }
        const threadId = this.threadId;
        if (threadId && this.threads.hasPendingTurn(threadId)) {
            void this.recoverThreadAfterUnexpectedExit(threadId);
        }
    }

    /**
     * Map our internal ReviewDecision to the wire format codex expects.
     * v2 methods (item/*) use: accept/acceptForSession/decline/cancel
     * Legacy methods (execCommandApproval/applyPatchApproval) use: approved/approved_for_session/denied/abort
     */
    private mapDecisionToWire(decision: ReviewDecision, legacy: boolean): string | Record<string, unknown> {
        if (typeof decision === 'string') {
            if (legacy) {
                // Legacy wire format — pass through as-is (approved/denied/abort)
                return decision;
            }
            // v2 wire format
            switch (decision) {
                case 'approved': return 'accept';
                case 'approved_for_session': return 'acceptForSession';
                case 'denied': return 'decline';
                case 'abort': return 'cancel';
                default: return 'decline';
            }
        }
        // Object variant: approved_execpolicy_amendment → pass through as-is
        if ('approved_execpolicy_amendment' in decision) {
            return decision;
        }
        return legacy ? 'denied' : 'decline';
    }

    private parseToolNameFromElicitationMessage(message: unknown): string | null {
        if (typeof message !== 'string') {
            return null;
        }
        const match = message.match(/tool "([^"]+)"/i);
        return match?.[1] ?? null;
    }

    private mapDecisionToMcpElicitationResponse(
        decision: ReviewDecision,
        params: any,
    ): McpServerElicitationRequestResponse {
        if (typeof decision === 'string') {
            switch (decision) {
                case 'approved':
                case 'approved_for_session':
                    return {
                        action: 'accept',
                        content: params?.mode === 'form' ? {} : null,
                        _meta: null,
                    };
                case 'abort':
                    return {
                        action: 'cancel',
                        content: null,
                        _meta: null,
                    };
                case 'denied':
                default:
                    return {
                        action: 'decline',
                        content: null,
                        _meta: null,
                    };
            }
        }

        return {
            action: 'decline',
            content: null,
            _meta: null,
        };
    }

    private async handleServerRequest(id: number, method: string, params: any): Promise<void> {
        if (this.serverRequestHandler && isStableServerRequestMethod(method)) {
            const result = await this.serverRequestHandler({
                requestId: String(id),
                method,
                params,
            });
            this.respond(id, result);
            return;
        }

        if (method === 'mcpServer/elicitation/request') {
            const threadId = stringOrNull(params?.threadId) ?? this.threadId;
            const turnId = stringOrNull(params?.turnId);
            const serverName = stringOrNull(params?.serverName) ?? 'mcp';
            const toolName = this.parseToolNameFromElicitationMessage(params?.message) ?? serverName;
            const itemId = `${serverName}:${id}`;
            const decision = await this.handleApproval({
                type: 'mcp',
                callId: formatScopedItemKey(threadId, itemId),
                itemId,
                threadId,
                turnId,
                approvalId: String(id),
                toolName,
                input: params?._meta?.tool_params ?? {},
                serverName,
                message: params?.message,
            });
            this.respond(id, this.mapDecisionToMcpElicitationResponse(decision, params));
            return;
        }

        // Command execution approval
        if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
            const legacy = method === 'execCommandApproval';
            const threadId = stringOrNull(params?.threadId) ?? stringOrNull(params?.conversationId) ?? this.threadId;
            const turnId = stringOrNull(params?.turnId);
            const itemId = stringOrNull(params?.itemId) ?? stringOrNull(params?.callId) ?? String(id);
            const approvalId = stringOrNull(params?.approvalId);
            // Legacy events pass through with raw call ids, so legacy
            // approvals must stay raw too; v2 uses the scoped item key that
            // exec_command_begin emitted for this item, so the app joins
            // permission ↔ tool call by exact id equality. Only a concurrent
            // second approval for the same item gets an approvalId suffix.
            const callId = legacy
                ? itemId
                : this.resolveApprovalCallId(formatScopedItemKey(threadId, itemId), approvalId ?? String(id));
            this.pendingApprovalCallIds.add(callId);
            try {
                const decision = await this.handleApproval({
                    type: 'exec',
                    callId,
                    itemId,
                    threadId,
                    turnId,
                    approvalId,
                    command: Array.isArray(params.command)
                        ? params.command
                        : params.command != null ? [params.command] : [],
                    cwd: params.cwd,
                    reason: params.reason,
                });
                this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) });
            } finally {
                this.pendingApprovalCallIds.delete(callId);
            }
            return;
        }

        // File change / patch approval
        if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
            const legacy = method === 'applyPatchApproval';
            const threadId = stringOrNull(params?.threadId) ?? stringOrNull(params?.conversationId) ?? this.threadId;
            const turnId = stringOrNull(params?.turnId);
            const itemId = stringOrNull(params?.itemId) ?? stringOrNull(params?.callId) ?? String(id);
            const itemKey = formatScopedItemKey(threadId, itemId);
            const callId = legacy ? itemId : this.resolveApprovalCallId(itemKey, String(id));
            this.pendingApprovalCallIds.add(callId);
            try {
                const decision = await this.handleApproval({
                    type: 'patch',
                    callId,
                    itemId,
                    threadId,
                    turnId,
                    fileChanges: params.fileChanges ?? (typeof itemId === 'string'
                        ? this.rawFileChangesByItemId.get(itemKey) ?? this.rawFileChangesByItemId.get(itemId)
                        : undefined),
                    reason: params.reason,
                });
                this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) });
            } finally {
                this.pendingApprovalCallIds.delete(callId);
            }
            return;
        }

        // Unknown server request — respond so server doesn't hang
        logger.debug(`[CodexAppServer] Unknown server request: ${method}`);
        this.respond(id, {});
    }

    // The bare scoped key keeps the app's permission ↔ tool-call join for the
    // common single-approval case; a SECOND approval arriving while the first
    // is still pending gets a disambiguating suffix instead of silently
    // overwriting the first one's pending entry (which would orphan its
    // promise and hang the codex request forever).
    private resolveApprovalCallId(baseCallId: string, disambiguator: string): string {
        return this.pendingApprovalCallIds.has(baseCallId)
            ? `${baseCallId}:${disambiguator}`
            : baseCallId;
    }

    private async handleApproval(params: Parameters<ApprovalHandler>[0]): Promise<ReviewDecision> {
        if (this.approvalHandler) {
            try {
                return await this.approvalHandler(params);
            } catch (err) {
                logger.debug(`[CodexAppServer] Approval handler error (${errorKind(err)})`);
                return 'denied';
            }
        }
        return 'denied'; // default: deny if no handler
    }

    private handleNotification(method: string, params: any): void {
        // codex/event notifications: either `codex/event` or `codex/event/<type>`
        if (method === 'codex/event' || method.startsWith('codex/event/')) {
            this.notificationProtocol = 'legacy';
            const msg = params?.msg;
            const legacyThreadId = stringOrNull(params?.threadId)
                ?? stringOrNull(params?.conversationId)
                ?? stringOrNull(msg?.threadId)
                ?? stringOrNull(msg?.thread_id)
                ?? stringOrNull(msg?.conversationId)
                ?? stringOrNull(msg?.conversation_id);
            if (msg && (!this.threadId || !legacyThreadId || legacyThreadId === this.threadId)) {
                this.eventHandler?.(msg);
            }
            return;
        }

        const statusCompletionTurnId = this.trackStableNotification(method, params);

        // thread/started is emitted by registerThreadSnapshot after the registry
        // has accepted the snapshot. Every other stable notification is tapped
        // here before the legacy selected-thread projection can filter it.
        if (method !== 'thread/started') {
            this.emitStableNotification(method, params);
        }

        if (this.handleRawNotification(method, params, statusCompletionTurnId)) {
            logger.debug(`[CodexAppServer] Raw notification: ${method}`);
            return;
        }

        // v2 lifecycle notifications
        if (method === 'thread/started' || method === 'turn/started' ||
            method === 'turn/completed' || method === 'thread/status/changed') {
            logger.debug(`[CodexAppServer] Lifecycle notification: ${method}`);
            return;
        }

        if (method === 'mcpServer/startupStatus/updated') {
            logger.debug('[CodexAppServer] MCP server startup status updated');
            return;
        }

        logger.debug(`[CodexAppServer] Notification: ${method}`);
    }
}
