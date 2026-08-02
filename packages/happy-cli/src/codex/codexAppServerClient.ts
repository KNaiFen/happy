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
import WebSocket from 'ws';
import { logger } from '@/ui/logger';
import {
    classifySyncV4DiagnosticError,
    recordSyncV4DiagnosticSafely,
    type SyncV4DiagnosticInput,
    type SyncV4DiagnosticSink,
    type SyncV4DiagnosticTransportSecurity,
} from '@slopus/happy-wire';
import { syncV4DiagnosticHash } from '@/api/syncV4Diagnostics';
import type {
    ReviewDecision,
    EventMsg,
} from './codexAppServerTypes';
import type { SandboxConfig } from '@/persistence';
import { initializeSandbox, wrapForMcpTransport } from '@/sandbox/manager';
import packageJson from '../../package.json';
import {
    assertMinimumCodexCliVersion,
    isCodexCliVersionAtLeast,
    readCodexCliVersion,
    type CodexCliVersion,
} from './codexCliVersion';
import { CodexThreadRegistry, type CodexTurnCompletion } from './codexThreadRegistry';
import type { CodexProtocolTraceDirection, CodexProtocolTraceSink } from './codexProtocolTrace';
import { redactCodexProtocolMethod } from './codexProtocolMethod';
import {
    codexWebSocketRawDataBuffer,
    connectCodexAppServerWebSocket,
    type CodexAppServerWebSocketEndpoint,
} from './codexAppServerWebSocket';
import type {
    ApprovalPolicy,
    ClientNotification,
    ClientRequest,
    InitializeParams,
    InputItem,
    JsonValue,
    ServerNotification,
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse,
    McpServerElicitationRequestResponse,
    Model,
    ModelListParams,
    ModelListResponse,
    ReasoningEffort,
    ReviewStartParams,
    ReviewStartResponse,
    SandboxMode,
    SandboxPolicy,
    SkillsListParams,
    SkillsListResponse,
    ThreadCompactStartResponse,
    ThreadForkParams,
    ThreadForkResponse,
    ThreadGoalClearParams,
    ThreadGoalClearResponse,
    ThreadGoalGetParams,
    ThreadGoalGetResponse,
    ThreadGoalSetParams,
    ThreadGoalSetResponse,
    ThreadInjectItemsParams,
    ThreadInjectItemsResponse,
    ThreadListParams,
    ThreadListResponse,
    ThreadReadParams,
    ThreadReadResponse,
    ThreadResumeParams,
    ThreadResumeResponse,
    ThreadRollbackParams,
    ThreadRollbackResponse,
    ThreadStartParams,
    ThreadStartResponse,
    Thread as ProtocolThread,
    ThreadStatus as ProtocolThreadStatus,
    TurnInterruptParams,
    Turn as ProtocolTurn,
    TurnStartParams,
    TurnStartResponse,
    TurnSteerParams,
    TurnStatus as ProtocolTurnStatus,
} from './protocol';

type StableClientMethod = ClientRequest['method'];
type StableClientRequestFor<M extends StableClientMethod> = Extract<ClientRequest, { method: M }>;
type StableClientRequestParams<M extends StableClientMethod> = StableClientRequestFor<M>['params'];

type CodexWireResponse = {
    id: number;
    result?: unknown;
    error?: { code: number | string; message?: string; data?: unknown };
};

export interface CodexAppServerClientOptions {
    webSocketEndpoint?: CodexAppServerWebSocketEndpoint;
}

class CodexRpcResponseError extends Error {
    constructor(
        readonly method: string,
        readonly code: number | string,
        readonly providerMessage: string | null,
    ) {
        super(`${method} failed (code=${code})`);
        this.name = 'CodexRpcResponseError';
    }
}

type PendingRequest = {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    onResult?: (result: unknown) => void;
    method: string;
    epoch: number;
    startedAt: number;
    requestHash: string;
};

type PendingCompaction = {
    epoch: number;
    itemId: string | null;
    completion: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
};

type LegacyPatchChanges = Record<string, Record<string, unknown>>;
type LegacyFileChangeMetadata = {
    turnId: string | null;
    changes: LegacyPatchChanges;
};

type ThreadDefaults = {
    model?: string;
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
    mcpServers?: Record<string, unknown>;
};

const MAX_COMPLETED_TURN_MARKERS = 50_000;
const MAX_ACTIVE_SERVER_REQUEST_IDS = 4_096;
const MAX_SETTLED_SERVER_REQUEST_GAPS = 4_096;
const MAX_RAW_FILE_CHANGE_ITEMS = 4_096;
const MAX_RAW_SUBAGENT_ACTIVITY_ITEMS = 4_096;
const MAX_RAW_SUBAGENT_SIGNATURES_PER_ITEM = 16;
const MAX_CODEX_RPC_METHOD_CHARS = 256;
const TERMINAL_TURN_STATUSES = new Set(['completed', 'interrupted', 'failed']);

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

export interface CodexManagedServerResponse {
    response: unknown;
    markResponseSupplied(): Promise<void>;
    markDelivered(): Promise<void>;
    markAbandoned(): Promise<void>;
}

export type CodexServerRequestHandler = (
    request: CodexServerRequest,
) => Promise<CodexManagedServerResponse | null>;

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
    return classifySyncV4DiagnosticError(error);
}

function providerDiagnosticErrorKind(
    error: unknown,
): ReturnType<typeof classifySyncV4DiagnosticError> {
    const classified = classifySyncV4DiagnosticError(error);
    return classified === 'unknown' ? 'provider' : classified;
}

function isStableServerRequestMethod(method: string): method is CodexServerRequest['method'] {
    return method === 'item/commandExecution/requestApproval'
        || method === 'item/fileChange/requestApproval'
        || method === 'item/permissions/requestApproval'
        || method === 'item/tool/requestUserInput'
        || method === 'mcpServer/elicitation/request';
}

function isPaginatedThreadReadError(error: unknown): boolean {
    return error instanceof CodexRpcResponseError
        && error.method === 'thread/read'
        && error.code === -32600
        && error.providerMessage === 'paginated threads do not support thread/read(includeTurns=true)';
}

function isUnmaterializedThreadResumeError(error: unknown, threadId: string): boolean {
    return error instanceof CodexRpcResponseError
        && error.method === 'thread/resume'
        && error.code === -32600
        && error.providerMessage === `no rollout found for thread id ${threadId}`;
}

// Codex item ids are per-thread counters, so items from collab subagent
// threads collide with the main thread's. Scoping with the thread id keeps
// them unique — but the SAME scoped id must be used both for the tool-call
// events and for the approval requests of an item: the app attaches a
// permission card to its tool call by exact id equality.
function formatScopedItemKey(threadId: string | null, itemId: string): string {
    return threadId ? `${threadId}:${itemId}` : itemId;
}

function addBoundedSetEntry<T>(set: Set<T>, value: T, limit: number): boolean {
    if (set.has(value)) return false;
    set.add(value);
    while (set.size > limit) {
        const oldest = set.values().next().value;
        if (oldest === undefined) break;
        set.delete(oldest);
    }
    return true;
}

function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
    }
}

function boundedOwnFieldCount(value: Record<string, unknown>, limit = 4_096): number {
    let count = 0;
    for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        count += 1;
        if (count >= limit) return limit;
    }
    return count;
}

function isGoalActionsAvailable(version: CodexCliVersion | null): boolean {
    return isCodexCliVersionAtLeast(version, { major: 0, minor: 140, patch: 0 });
}

function isTurnSteeringAvailable(version: CodexCliVersion | null): boolean {
    return isCodexCliVersionAtLeast(version, { major: 0, minor: 145, patch: 0 });
}

function sandboxPolicyForMode(mode: SandboxMode): SandboxPolicy {
    switch (mode) {
        case 'danger-full-access':
            return { type: 'dangerFullAccess' };
        case 'read-only':
            return { type: 'readOnly', networkAccess: false };
        case 'workspace-write':
            return {
                type: 'workspaceWrite',
                writableRoots: [],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
            };
    }
}

function toJsonValue(value: unknown, path: string): JsonValue | undefined {
    if (value === undefined) return undefined;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
        return value.map((entry, index) => {
            const normalized = toJsonValue(entry, `${path}[${index}]`);
            if (normalized === undefined) {
                throw new Error(`${path}[${index}] cannot be undefined`);
            }
            return normalized;
        });
    }
    if (typeof value === 'object') {
        const normalized: { [key: string]: JsonValue | undefined } = {};
        for (const [key, entry] of Object.entries(value)) {
            const jsonEntry = toJsonValue(entry, `${path}.${key}`);
            if (jsonEntry !== undefined) normalized[key] = jsonEntry;
        }
        return normalized;
    }
    throw new Error(`${path} contains a non-JSON ${typeof value} value`);
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
    private webSocket: WebSocket | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private processEpoch = 0;
    private connected = false;
    private intentionalTransportClose = false;
    private sandboxConfig?: SandboxConfig;
    private codexCliVersion: CodexCliVersion | null | undefined;
    private sandboxCleanup: (() => Promise<void>) | null = null;
    public sandboxEnabled = false;

    private readonly threads = new CodexThreadRegistry();
    private readonly threadDefaults = new Map<string, ThreadDefaults>();

    private readonly pendingInterrupts = new Map<string, Promise<void>>();
    private readonly pendingCompactions = new Map<string, PendingCompaction>();
    private readonly unknownTurnReconciliations = new Map<string, Promise<void>>();
    private recoveryPromise: Promise<Set<string>> | null = null;
    private readonly recoveredThreadEpochs = new Map<string, number>();
    private notificationProtocol: 'unknown' | 'legacy' | 'raw' = 'unknown';
    private readonly completedTurnIds = new Set<string>();
    private readonly rawFileChangesByItemId = new Map<string, LegacyFileChangeMetadata>();
    private readonly rawSubagentActivitySignaturesByItemId = new Map<string, Set<string>>();
    // Approval callIds currently awaiting an answer. One codex item can raise
    // several approval callbacks (approvalId exists to disambiguate them);
    // the bare scoped key is kept for the first so the app's permission ↔
    // tool-call join works, and only a concurrent second approval for the
    // same item gets a disambiguating suffix.
    private pendingApprovalCallIds = new Set<string>();
    private readonly activeServerRequestIds = new Set<number>();
    private readonly settledServerRequestIds = new Set<number>();
    private retiredServerRequestId = -1;

    // Handlers are installed by the Gateway coordinator or a focused protocol consumer.
    private eventHandler: ((msg: EventMsg) => void) | null = null;
    private approvalHandler: ApprovalHandler | null = null;
    private stableNotificationHandler: ((notification: ServerNotification) => void) | null = null;
    private serverRequestHandler: CodexServerRequestHandler | null = null;
    private connectionHandler: CodexConnectionHandler | null = null;
    private protocolTraceSink: CodexProtocolTraceSink | null = null;
    private diagnosticSink: SyncV4DiagnosticSink | null = null;
    private diagnosticSessionHash: string | undefined;
    private diagnosticTransportSecurity: SyncV4DiagnosticTransportSecurity | undefined;
    private connectionEvent: CodexConnectionEvent = {
        connection: 'disconnected',
        statusUnknown: true,
        error: null,
    };

    constructor(
        sandboxConfig?: SandboxConfig,
        codexCliVersion?: CodexCliVersion,
        private readonly options: CodexAppServerClientOptions = {},
    ) {
        this.sandboxConfig = sandboxConfig;
        this.codexCliVersion = codexCliVersion;
    }

    get threadId(): string | null {
        return this.threads.selectedThreadIdValue;
    }

    get turnId(): string | null {
        return this.threads.selectedTurnId;
    }

    supportsGoalActions(): boolean {
        return isGoalActionsAvailable(this.readCodexCliVersionOnce());
    }

    supportsTurnSteering(): boolean {
        return isTurnSteeringAvailable(this.readCodexCliVersionOnce());
    }

    private readCodexCliVersionOnce(): CodexCliVersion | null {
        if (this.codexCliVersion === undefined) {
            this.codexCliVersion = readCodexCliVersion();
        }
        return this.codexCliVersion;
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

    setDiagnosticSink(sink: SyncV4DiagnosticSink | null): void {
        this.diagnosticSink = sink;
    }

    setDiagnosticContext(context: {
        sessionHash?: string;
        transportSecurity?: SyncV4DiagnosticTransportSecurity;
    }): void {
        this.diagnosticSessionHash = context.sessionHash;
        this.diagnosticTransportSecurity = context.transportSecurity;
    }

    private updateConnection(event: CodexConnectionEvent): void {
        this.connectionEvent = event;
        this.connectionHandler?.(event);
    }

    private recordDiagnostic(
        input: Omit<SyncV4DiagnosticInput, 'component'>,
    ): void {
        recordSyncV4DiagnosticSafely(this.diagnosticSink, {
            component: 'cli.gateway',
            sessionHash: this.diagnosticSessionHash,
            softwareVersion: packageJson.version,
            codexVersion: this.codexCliVersion
                ? `${this.codexCliVersion.major}.${this.codexCliVersion.minor}.${this.codexCliVersion.patch}`
                : undefined,
            protocolVersion: 4,
            featureEnabled: true,
            transportSecurity: this.diagnosticTransportSecurity,
            ...input,
        });
    }

    private emitStableNotification(method: string, params: unknown): void {
        this.stableNotificationHandler?.({ method, params } as ServerNotification);
    }

    private trackPendingCompaction(method: string, params: any, sourceEpoch: number): void {
        if (method !== 'item/started' && method !== 'item/completed') return;

        const threadId = stringOrNull(params?.threadId);
        const itemId = stringOrNull(params?.item?.id);
        if (!threadId || !itemId || params?.item?.type !== 'contextCompaction') return;

        const pending = this.pendingCompactions.get(threadId);
        if (!pending || pending.epoch !== sourceEpoch) return;

        if (method === 'item/started') {
            if (pending.itemId === null) pending.itemId = itemId;
            return;
        }

        if (pending.itemId !== itemId) return;
        this.pendingCompactions.delete(threadId);
        pending.resolve();
    }

    private rejectPendingCompactions(
        epoch: number,
        reason: string,
    ): void {
        for (const [threadId, pending] of this.pendingCompactions) {
            if (pending.epoch !== epoch) continue;
            this.pendingCompactions.delete(threadId);
            pending.reject(new CodexRpcOutcomeUnknownError(
                'thread/compact/start',
                `${reason} while waiting for contextCompaction item completion; outcome is unknown`,
            ));
        }
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
        source: 'response' | 'snapshot' | 'notification' = 'response',
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
            if (!this.registerThreadSnapshot(params?.thread, 'notification')) {
                this.scheduleThreadHydration(threadId);
            }
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

    private validateTerminalTurnNotification(
        params: any,
        sourceEpoch: number,
    ): boolean {
        const threadId = stringOrNull(params?.threadId);
        const turnId = stringOrNull(params?.turn?.id);
        const status = stringOrNull(params?.turn?.status);
        if (threadId && turnId && status && TERMINAL_TURN_STATUSES.has(status)) {
            return true;
        }

        this.recordDiagnostic({
            level: 'warn',
            event: 'notification',
            phase: 'dropped',
            source: 'notification',
            state: 'failed',
            ...(threadId ? { threadHash: syncV4DiagnosticHash(threadId) } : {}),
            ...(turnId ? { turnHash: syncV4DiagnosticHash(turnId) } : {}),
            epoch: sourceEpoch,
            reason: 'validation',
            errorKind: 'protocol',
        });
        return false;
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
        if (completionKey && !addBoundedSetEntry(
            this.completedTurnIds,
            completionKey,
            MAX_COMPLETED_TURN_MARKERS,
        )) {
            return;
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
        if (method === 'turn/completed') {
            const threadId = stringOrNull(params?.threadId);
            const turnId = stringOrNull(params?.turn?.id);
            if (!threadId || !turnId) return;
            const itemPrefix = `${threadId}:`;
            for (const [itemKey, metadata] of this.rawFileChangesByItemId) {
                if (itemKey.startsWith(itemPrefix) && metadata.turnId === turnId) {
                    this.rawFileChangesByItemId.delete(itemKey);
                }
            }
            return;
        }

        const item = params?.item;
        const threadId = stringOrNull(params?.threadId);
        if (item?.type !== 'fileChange' || typeof item.id !== 'string' || !threadId) return;

        const itemKey = formatScopedItemKey(threadId, item.id);
        const changes = normalizeRawFileChangeList(item.changes);
        if (changes) {
            setBoundedMapEntry(
                this.rawFileChangesByItemId,
                itemKey,
                {
                    turnId: stringOrNull(params?.turnId),
                    changes,
                },
                MAX_RAW_FILE_CHANGE_ITEMS,
            );
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
                const signatureHash = syncV4DiagnosticHash(`subagent-activity:${signature}`);
                const seenSignatures = itemKey
                    ? this.rawSubagentActivitySignaturesByItemId.get(itemKey)
                    : undefined;
                if (seenSignatures?.has(signatureHash)) {
                    return true;
                }
                if (itemKey) {
                    const signatures = seenSignatures ?? new Set<string>();
                    addBoundedSetEntry(
                        signatures,
                        signatureHash,
                        MAX_RAW_SUBAGENT_SIGNATURES_PER_ITEM,
                    );
                    setBoundedMapEntry(
                        this.rawSubagentActivitySignaturesByItemId,
                        itemKey,
                        signatures,
                        MAX_RAW_SUBAGENT_ACTIVITY_ITEMS,
                    );
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
        if (this.options.webSocketEndpoint) {
            await this.connectExternalWebSocket(this.options.webSocketEndpoint);
            return;
        }
        await this.connectOwnedProcess();
    }

    private async connectOwnedProcess(): Promise<void> {
        if (this.connected) return;
        const appServerPath = process.env.HAPPY_CODEX_APP_SERVER_PATH?.trim();
        if (!appServerPath) {
            this.codexCliVersion = assertMinimumCodexCliVersion(
                this.codexCliVersion ?? readCodexCliVersion(),
            );
        }
        this.updateConnection({ connection: 'connecting', statusUnknown: true, error: null });

        let command = appServerPath ? process.execPath : 'codex';
        let args = appServerPath ? [appServerPath] : ['app-server', '--listen', 'stdio://'];
        this.sandboxEnabled = false;

        if (this.sandboxConfig?.enabled && process.platform !== 'win32' && !appServerPath) {
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

        logger.debug(
            `[CodexAppServer] Spawning app-server transport; sandbox=${this.sandboxEnabled}; override=${Boolean(appServerPath)}`,
        );

        const epoch = ++this.processEpoch;
        this.resetServerRequestTracking();
        this.intentionalTransportClose = false;
        this.recordDiagnostic({
            level: 'info',
            event: 'connection',
            phase: 'started',
            state: 'connecting',
            epoch,
            codexVersion: this.codexCliVersion
                ? `${this.codexCliVersion.major}.${this.codexCliVersion.minor}.${this.codexCliVersion.patch}`
                : undefined,
        });
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
                this.recordDiagnostic({
                    level: 'error',
                    event: 'connection',
                    phase: 'failed',
                    state: 'failed',
                    epoch,
                    errorKind: providerDiagnosticErrorKind(err),
                });
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
            this.recordDiagnostic({
                level: code === 0 ? 'info' : 'warn',
                event: 'connection',
                phase: 'exited',
                state: 'disconnected',
                epoch,
                count: this.pending.size,
                reason: 'processExit',
            });
            this.updateConnection({ connection: 'disconnected', statusUnknown: true, error: null });
            this.readline?.close();
            this.readline = null;
            // Reject all pending requests
            for (const [id, req] of this.pending) {
                if (req.epoch !== epoch) continue;
                this.recordDiagnostic({
                    level: 'warn',
                    event: 'rpc',
                    phase: 'failed',
                    state: 'outcomeUnknown',
                    rpcFamily: codexRpcFamily(req.method),
                    requestHash: req.requestHash,
                    epoch: req.epoch,
                    durationMs: elapsedDiagnosticMs(req.startedAt),
                    reason: 'processExit',
                    errorKind: 'provider',
                });
                req.reject(new CodexRpcOutcomeUnknownError(
                    req.method,
                    `Codex process exited (code=${code}) while waiting for ${req.method}; outcome is unknown`,
                ));
                this.pending.delete(id);
            }
            this.rejectPendingCompactions(epoch, `Codex process exited (code=${code})`);
            const activeThreadIds = this.threads.activeThreadIds();
            if (activeThreadIds.length > 0) {
                void this.recoverThreadsAfterUnexpectedExit(activeThreadIds, this.threadId);
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

        await this.initializeConnection(epoch);
    }

    private async connectExternalWebSocket(
        endpoint: CodexAppServerWebSocketEndpoint,
    ): Promise<void> {
        if (this.connected) return;
        this.codexCliVersion = assertMinimumCodexCliVersion(
            this.codexCliVersion ?? readCodexCliVersion(),
        );
        this.updateConnection({ connection: 'connecting', statusUnknown: true, error: null });

        const epoch = ++this.processEpoch;
        this.resetServerRequestTracking();
        this.intentionalTransportClose = false;
        this.recordDiagnostic({
            level: 'info',
            event: 'connection',
            phase: 'started',
            state: 'connecting',
            epoch,
            codexVersion: `${this.codexCliVersion.major}.${this.codexCliVersion.minor}.${this.codexCliVersion.patch}`,
        });

        const socket = connectCodexAppServerWebSocket(endpoint);
        this.webSocket = socket;
        socket.on('message', (data, isBinary) => {
            if (this.webSocket !== socket || this.processEpoch !== epoch) return;
            if (isBinary) {
                this.recordDiagnostic({
                    level: 'warn',
                    event: 'notification',
                    phase: 'dropped',
                    source: 'notification',
                    state: 'failed',
                    epoch,
                    errorKind: 'protocol',
                });
                socket.close(1003, 'Codex app-server RPC must use text frames');
                return;
            }
            this.handleLine(codexWebSocketRawDataBuffer(data).toString('utf8'), epoch);
        });
        socket.on('close', () => {
            if (this.intentionalTransportClose || this.webSocket !== socket || this.processEpoch !== epoch) {
                return;
            }
            this.handleUnexpectedWebSocketClose(socket, epoch);
        });
        socket.on('error', (error) => {
            if (this.webSocket !== socket || this.processEpoch !== epoch) return;
            logger.debug(`[CodexAppServer] WebSocket transport error (${errorKind(error)})`);
        });

        let opened = false;
        try {
            await waitForWebSocketOpen(socket);
            opened = true;
            await this.initializeConnection(epoch);
        } catch (error) {
            if (this.webSocket === socket && this.processEpoch === epoch) {
                this.webSocket = null;
                socket.terminate();
            }
            if (!opened) {
                this.recordDiagnostic({
                    level: 'error',
                    event: 'connection',
                    phase: 'failed',
                    state: 'failed',
                    epoch,
                    errorKind: providerDiagnosticErrorKind(error),
                });
                this.updateConnection({ connection: 'error', statusUnknown: true, error: errorKind(error) });
            }
            throw error;
        }
    }

    private async initializeConnection(epoch: number): Promise<void> {
        const initParams: InitializeParams = {
            clientInfo: {
                name: 'happy-codex',
                title: 'Happy Codex Client',
                version: packageJson.version,
            },
            capabilities: {
                experimentalApi: false,
                requestAttestation: false,
            },
        };
        try {
            await this.request('initialize', initParams);
            if (!this.notify({ method: 'initialized' })) {
                throw new Error('Codex transport closed before initialized was sent');
            }
            this.connected = true;
            this.updateConnection({
                connection: 'connected',
                statusUnknown: this.threadId !== null,
                error: null,
            });
            this.recordDiagnostic({
                level: 'info',
                event: 'connection',
                phase: 'completed',
                state: 'connected',
                epoch,
            });
            logger.debug('[CodexAppServer] Connected and initialized');
        } catch (error) {
            this.recordDiagnostic({
                level: 'error',
                event: 'connection',
                phase: 'failed',
                state: 'failed',
                epoch,
                errorKind: providerDiagnosticErrorKind(error),
            });
            this.updateConnection({ connection: 'error', statusUnknown: true, error: errorKind(error) });
            throw error;
        }
    }

    private async disconnectInternal(opts?: { preserveThreadState?: boolean }): Promise<void> {
        if (!this.connected && !this.process && !this.webSocket) {
            if (!opts?.preserveThreadState) {
                this.threads.clear(new Error('Codex client disconnected'));
                this.threadDefaults.clear();
                this.recoveredThreadEpochs.clear();
            }
            return;
        }

        const proc = this.process;
        const webSocket = this.webSocket;
        const pid = proc?.pid;
        const epoch = this.processEpoch;
        logger.debug(`[CodexAppServer] Disconnecting; transport=${webSocket ? 'websocket' : 'stdio'}; pid=${pid ?? 'none'}`);
        this.recordDiagnostic({
            level: 'info',
            event: 'connection',
            phase: 'started',
            state: 'stopping',
            epoch,
            reason: 'shutdown',
        });

        this.intentionalTransportClose = true;
        this.readline?.close();
        this.readline = null;
        this.webSocket = null;

        if (webSocket) {
            await closeCodexWebSocket(webSocket);
        }

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
            this.recoveredThreadEpochs.clear();
        }

        // Fail in-flight requests from this process generation.
        for (const [id, req] of this.pending) {
            if (req.epoch !== epoch) continue;
            this.recordDiagnostic({
                level: 'warn',
                event: 'rpc',
                phase: 'failed',
                state: 'outcomeUnknown',
                rpcFamily: codexRpcFamily(req.method),
                requestHash: req.requestHash,
                epoch: req.epoch,
                durationMs: elapsedDiagnosticMs(req.startedAt),
                reason: 'shutdown',
                errorKind: 'cancelled',
            });
            req.reject(new CodexRpcOutcomeUnknownError(
                req.method,
                `Codex transport disconnected while waiting for ${req.method}; outcome is unknown`,
            ));
            this.pending.delete(id);
        }
        this.rejectPendingCompactions(epoch, 'Codex transport disconnected');

        if (this.sandboxCleanup) {
            try { await this.sandboxCleanup(); } catch { /* ignore */ }
            this.sandboxCleanup = null;
        }
        this.sandboxEnabled = false;

        logger.debug('[CodexAppServer] Disconnected');
        this.recordDiagnostic({
            level: 'info',
            event: 'connection',
            phase: 'completed',
            state: 'disconnected',
            epoch,
            reason: 'shutdown',
        });
        this.intentionalTransportClose = false;
    }

    async disconnect(): Promise<void> {
        await this.disconnectInternal();
    }

    async reconnectExternalTransportPreservingThreads(): Promise<void> {
        if (!this.options.webSocketEndpoint) {
            throw new Error('External Codex transport is not configured');
        }
        await this.disconnectInternal({ preserveThreadState: true });
        await this.connect();
    }

    private buildThreadConfig(mcpServers?: Record<string, unknown>): ThreadStartParams['config'] {
        if (!mcpServers) return null;
        const normalized = toJsonValue(mcpServers, 'mcpServers');
        if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') {
            throw new Error('mcpServers must be a JSON object');
        }
        return { mcp_servers: normalized };
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

    async listThreads(opts: ThreadListParams): Promise<ThreadListResponse> {
        return await this.request('thread/list', opts) as ThreadListResponse;
    }

    async startThread(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string }> {
        const params: ThreadStartParams = {
            model: opts.model ?? null,
            modelProvider: null,
            cwd: opts.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? null,
            config: this.buildThreadConfig(opts.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
        };

        const result = await this.request('thread/start', params, undefined, (value) => {
            const response = value as ThreadStartResponse;
            this.registerThreadSnapshot(response.thread);
            this.threads.selectThread(response.thread.id);
            this.rememberThreadDefaults(response.thread.id, opts);
        }) as ThreadStartResponse;
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
        selectThread?: boolean;
        preserveConfiguration?: boolean;
    }): Promise<{ threadId: string; model: string; thread: ProtocolThread }> {
        const threadId = opts?.threadId ?? this.threadId;
        if (!threadId) {
            throw new Error('No thread available to resume.');
        }

        const defaults = this.threadDefaults.get(threadId) ?? {};
        const preserveConfiguration = opts?.preserveConfiguration === true;
        const params: ThreadResumeParams = preserveConfiguration
            ? {
                threadId,
                model: null,
                modelProvider: null,
                cwd: null,
                approvalPolicy: null,
                sandbox: null,
                config: null,
                baseInstructions: null,
                developerInstructions: null,
            }
            : {
                threadId,
                model: opts?.model ?? defaults.model ?? null,
                modelProvider: null,
                cwd: opts?.cwd ?? defaults.cwd ?? process.cwd(),
                approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy ?? null,
                sandbox: opts?.sandbox ?? defaults.sandbox ?? null,
                config: this.buildThreadConfig(opts?.mcpServers ?? defaults.mcpServers),
                baseInstructions: null,
                developerInstructions: null,
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
            const response = value as ThreadResumeResponse;
            resumedSnapshot = this.registerThreadSnapshot(
                response.thread,
                'snapshot',
                opts?.emitSnapshot !== false,
            );
            if (opts?.selectThread !== false) this.threads.selectThread(response.thread.id);
            if (!preserveConfiguration) this.rememberThreadDefaults(response.thread.id, nextDefaults);
        }) as ThreadResumeResponse;
        const thread = resumedSnapshot ?? this.normalizeProtocolThread(result.thread);
        if (!thread) throw new Error('thread/resume returned an invalid thread snapshot');
        logger.debug('[CodexAppServer] Thread resumed');
        return { threadId: thread.id, model: result.model, thread };
    }

    async subscribeThread(threadId: string): Promise<{
        threadId: string;
        model: string;
        thread: ProtocolThread;
    }> {
        return await this.resumeThread({
            threadId,
            emitSnapshot: false,
            selectThread: false,
            preserveConfiguration: true,
        });
    }

    async subscribeThreadIfMaterialized(threadId: string): Promise<{
        threadId: string;
        model: string;
        thread: ProtocolThread;
    } | null> {
        try {
            return await this.subscribeThread(threadId);
        } catch (error) {
            if (isUnmaterializedThreadResumeError(error, threadId)) return null;
            throw error;
        }
    }

    async forkThread(opts: {
        threadId: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string; thread: ProtocolThread }> {
        const defaults = this.threadDefaults.get(opts.threadId) ?? {};
        const params: ThreadForkParams = {
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
            const response = value as ThreadForkResponse;
            this.registerThreadSnapshot(response.thread, 'snapshot');
            this.threads.selectThread(response.thread.id);
            this.rememberThreadDefaults(response.thread.id, nextDefaults);
        }) as ThreadForkResponse;
        logger.debug('[CodexAppServer] Thread forked');
        return { threadId: result.thread.id, model: result.model, thread: result.thread };
    }

    async readThread(opts: {
        threadId: string;
        includeTurns?: boolean;
        emitSnapshot?: boolean;
    }): Promise<{ thread: ProtocolThread }> {
        const params: ThreadReadParams = {
            threadId: opts.threadId,
            includeTurns: opts.includeTurns ?? true,
        };
        const result = await this.request('thread/read', params) as ThreadReadResponse;
        const thread = this.registerThreadSnapshot(result.thread, 'snapshot', opts.emitSnapshot !== false);
        if (!thread) throw new Error('thread/read returned an invalid thread snapshot');
        return { thread };
    }

    async readThreadComplete(opts: {
        threadId: string;
        emitSnapshot?: boolean;
    }): Promise<{ thread: ProtocolThread }> {
        try {
            return await this.readThread({
                threadId: opts.threadId,
                includeTurns: true,
                emitSnapshot: opts.emitSnapshot,
            });
        } catch (error) {
            if (!isPaginatedThreadReadError(error)) throw error;
        }

        // Stable-v2 thread/resume materializes complete turns for paginated
        // histories when no experimental pagination fields are supplied.
        const result = await this.request('thread/resume', {
            threadId: opts.threadId,
        }) as ThreadResumeResponse;
        const thread = this.registerThreadSnapshot(
            result.thread,
            'snapshot',
            opts.emitSnapshot !== false,
        );
        if (!thread) throw new Error('thread/resume returned an invalid thread snapshot');
        return { thread };
    }

    async rollbackThread(opts: {
        threadId: string;
        numTurns: number;
    }): Promise<ThreadRollbackResponse> {
        const params: ThreadRollbackParams = {
            threadId: opts.threadId,
            numTurns: opts.numTurns,
        };
        const result = await this.request('thread/rollback', params) as ThreadRollbackResponse;
        this.registerThreadSnapshot(result.thread, 'snapshot');
        return result;
    }

    async injectItems(opts: {
        threadId: string;
        items: ThreadInjectItemsParams['items'];
    }): Promise<ThreadInjectItemsResponse> {
        const params: ThreadInjectItemsParams = {
            threadId: opts.threadId,
            items: opts.items,
        };
        return await this.request('thread/inject_items', params) as ThreadInjectItemsResponse;
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
        if (this.pendingCompactions.has(threadId)) {
            throw new Error(`A Codex compaction is already pending for thread ${threadId}`);
        }

        let resolveCompletion!: () => void;
        let rejectCompletion!: (error: Error) => void;
        const completion = new Promise<void>((resolve, reject) => {
            resolveCompletion = resolve;
            rejectCompletion = reject;
        });
        const pending: PendingCompaction = {
            epoch: this.processEpoch,
            itemId: null,
            completion,
            resolve: resolveCompletion,
            reject: rejectCompletion,
        };
        this.pendingCompactions.set(threadId, pending);

        try {
            const request = this.request('thread/compact/start', { threadId }) as Promise<ThreadCompactStartResponse>;
            const [response] = await Promise.all([request, pending.completion]);
            return response;
        } finally {
            if (this.pendingCompactions.get(threadId) === pending) {
                this.pendingCompactions.delete(threadId);
            }
        }
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
        const resumed = await this.restartAndResumeThreads([threadId], this.threadId);
        return resumed.has(threadId);
    }

    private async restartAndResumeThreads(
        threadIds: string[],
        selectedThreadId: string | null,
    ): Promise<Set<string>> {
        if (this.recoveryPromise) {
            const resumed = await this.recoveryPromise;
            const missing = threadIds.filter((threadId) => (
                this.recoveredThreadEpochs.get(threadId) !== this.processEpoch
            ));
            if (!this.connected || missing.length === 0) return resumed;
            const additional = await this.resumeThreadsConservatively(missing, selectedThreadId);
            return new Set([...resumed, ...additional]);
        }

        const recovery = (async () => {
            await this.disconnectInternal({ preserveThreadState: true });
            await this.connect();
            return await this.resumeThreadsConservatively(threadIds, selectedThreadId);
        })();
        this.recoveryPromise = recovery;
        try {
            return await recovery;
        } catch (error) {
            logger.warn(`[CodexAppServer] Failed to resume threads after reconnect (${errorKind(error)})`);
            await this.disconnectInternal({ preserveThreadState: true });
            return new Set();
        } finally {
            if (this.recoveryPromise === recovery) this.recoveryPromise = null;
        }
    }

    private async resumeThreadsConservatively(
        threadIds: string[],
        selectedThreadId: string | null,
    ): Promise<Set<string>> {
        const resumed = new Set<string>();
        try {
            for (const threadId of new Set(threadIds)) {
                if (this.recoveredThreadEpochs.get(threadId) === this.processEpoch) {
                    resumed.add(threadId);
                    continue;
                }
                try {
                    await this.resumeThread({
                        threadId,
                        approvalPolicy: 'on-request',
                        sandbox: 'read-only',
                        selectThread: false,
                    });
                    this.recoveredThreadEpochs.set(threadId, this.processEpoch);
                    resumed.add(threadId);
                } catch (error) {
                    logger.warn(`[CodexAppServer] Conservative thread recovery failed (${errorKind(error)})`);
                }
            }
        } finally {
            if (selectedThreadId && this.threads.getThread(selectedThreadId)) {
                this.threads.selectThread(selectedThreadId);
            }
        }
        return resumed;
    }

    private async recoverThreadsAfterUnexpectedExit(
        threadIds: string[],
        selectedThreadId: string | null,
    ): Promise<void> {
        const resumed = await this.restartAndResumeThreads(threadIds, selectedThreadId);
        if (resumed.size !== new Set(threadIds).size) {
            logger.warn('[CodexAppServer] One or more active turns remain unknown after app-server exit');
        }
        for (const threadId of threadIds) {
            if (!this.threads.hasPendingTurn(threadId)) continue;
            this.reconcileUnknownTurn(
                threadId,
                this.threads.pendingCompletion(threadId) ?? undefined,
            );
        }
    }

    private reconcileUnknownTurn(threadId: string, completion?: Promise<unknown>): void {
        if (this.unknownTurnReconciliations.has(threadId)) return;
        const completionSignal = completion ?? new Promise<never>(() => {});

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
                    completionSignal.then(() => undefined, () => undefined),
                ]);
                if (!this.threads.hasPendingTurn(threadId)) break;
                await Promise.race([
                    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
                    completionSignal.then(() => undefined, () => undefined),
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
     * Request turn interruption and optionally restart the app-server for
     * authoritative reconciliation if the turn does not settle quickly.
     */
    async abortTurnWithFallback(opts?: {
        gracePeriodMs?: number;
        forceRestartOnTimeout?: boolean;
    }): Promise<{
        hadActiveTurn: boolean;
        aborted: boolean;
        forcedRestart: boolean;
        resumedThread: boolean;
        statusUnknown: boolean;
    }> {
        const threadId = this.threadId;
        const hadActiveTurn = this.hasPendingTurnCompletion(threadId);

        // No active turn pending in this client call-site.
        if (!threadId || !hadActiveTurn) {
            return {
                hadActiveTurn: false,
                aborted: false,
                forcedRestart: false,
                resumedThread: false,
                statusUnknown: false,
            };
        }

        const pendingTurnId = this.threads.getThread(threadId)?.activeTurnId ?? null;
        const completion = this.threads.pendingCompletion(threadId);
        const gracePeriodMs = opts?.gracePeriodMs ?? CodexAppServerClient.ABORT_GRACE_MS;
        // Best-effort interrupt request first, but do not block the fallback on
        // the interrupt RPC itself. Codex can stop emitting responses while a
        // tool/subagent/MCP call is wedged. Restarting only restores the
        // coordination channel; it is not proof that the turn was interrupted.
        void this.interruptTurn({ timeoutMs: Math.max(1, gracePeriodMs) });

        const settled = await this.waitForTurnCompletion(threadId, gracePeriodMs);
        if (settled) {
            let authoritativeCompletion: CodexTurnCompletion | null = null;
            if (completion) {
                try {
                    authoritativeCompletion = await completion;
                } catch {
                    // A rejected wait is not an authoritative provider terminal state.
                }
            }
            const status = authoritativeCompletion?.status ?? (pendingTurnId
                ? this.threads.getThread(threadId)?.turns.get(pendingTurnId)?.status
                : null);
            const statusUnknown = status === null
                || status === undefined
                || status === 'inProgress';
            return {
                hadActiveTurn: true,
                aborted: !statusUnknown && status === 'interrupted',
                forcedRestart: false,
                resumedThread: false,
                statusUnknown,
            };
        }

        const shouldForceRestart = opts?.forceRestartOnTimeout ?? true;
        if (!shouldForceRestart) {
            return {
                hadActiveTurn: true,
                aborted: false,
                forcedRestart: false,
                resumedThread: false,
                statusUnknown: true,
            };
        }

        logger.warn(`[CodexAppServer] interrupt did not settle turn in ${gracePeriodMs}ms; restarting app-server for authoritative reconciliation`);
        const resumedThread = await this.reconnectAndResumeThread();
        const stillPending = this.threads.hasPendingTurn(threadId);
        let authoritativeCompletion: CodexTurnCompletion | null = null;
        if (completion && !stillPending) {
            try {
                authoritativeCompletion = await completion;
            } catch {
                // A rejected wait is not an authoritative provider terminal state.
            }
        }
        const reconciledTurnId = pendingTurnId ?? authoritativeCompletion?.turnId ?? null;
        const turn = reconciledTurnId
            ? this.threads.getThread(threadId)?.turns.get(reconciledTurnId)
            : null;
        const reconciledStatus = authoritativeCompletion?.status ?? turn?.status ?? null;
        const statusUnknown = !resumedThread
            || stillPending
            || reconciledStatus === null
            || reconciledStatus === 'inProgress';
        if (statusUnknown) {
            this.reconcileUnknownTurn(threadId, completion ?? undefined);
        }
        return {
            hadActiveTurn: true,
            aborted: !statusUnknown && reconciledStatus === 'interrupted',
            forcedRestart: true,
            resumedThread,
            statusUnknown,
        };
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
            input.push({ type: 'text', text: prompt, text_elements: [] });
        }
        input.push(...extraInputItems);

        // Build params — only include optional fields when set (server uses thread defaults otherwise)
        const params: TurnStartParams = {
            threadId,
            input,
        };
        if (opts?.clientUserMessageId) params.clientUserMessageId = opts.clientUserMessageId;
        if (opts?.cwd) params.cwd = opts.cwd;
        if (opts?.approvalPolicy) params.approvalPolicy = opts.approvalPolicy;
        if (opts?.model) params.model = opts.model;
        if (opts?.effort) params.effort = opts.effort;

        if (opts?.sandbox) {
            params.sandboxPolicy = sandboxPolicyForMode(opts.sandbox);
        }

        // turn/start returns immediately; turn completes via events.
        // We don't await completion here — the caller's event handler
        // tracks task_complete / turn_aborted.
        const result = await this.request('turn/start', params) as TurnStartResponse;
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
            input.push({ type: 'text', text: prompt, text_elements: [] });
        }
        input.push(...extraInputItems);

        const params: TurnSteerParams = {
            threadId,
            expectedTurnId,
            input,
            ...(opts?.clientUserMessageId
                ? { clientUserMessageId: opts.clientUserMessageId }
                : {}),
        };
        await this.request('turn/steer', params);
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
        opts?: { timeoutMs?: number; propagateErrors?: boolean },
    ): Promise<void> {
        const params: TurnInterruptParams = {
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
                logger.debug(`[CodexAppServer] interruptTurn error (may be expected; ${errorKind(err)})`);
                if (opts?.propagateErrors) throw err;
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
            this.threads.forgetThread(threadId, new Error('Selected Codex thread cleared'));
            this.threadDefaults.delete(threadId);
            this.recoveredThreadEpochs.delete(threadId);
        }
        this.completedTurnIds.clear();
        this.rawFileChangesByItemId.clear();
        this.rawSubagentActivitySignaturesByItemId.clear();
    }

    // ─── JSON-RPC transport ─────────────────────────────────────

    /** Default timeout for RPC requests (ms). */
    private static readonly REQUEST_TIMEOUT_MS = 30_000;

    private request<M extends StableClientMethod>(
        method: M,
        params: StableClientRequestParams<M>,
        timeoutMs?: number,
        onResult?: (result: unknown) => void,
    ): Promise<unknown> {
        const timeout = timeoutMs ?? CodexAppServerClient.REQUEST_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            if (!this.isTransportWritable()) {
                this.recordDiagnostic({
                    level: 'warn',
                    event: 'rpc',
                    phase: 'failed',
                    state: 'failed',
                    rpcFamily: codexRpcFamily(method),
                    epoch: this.processEpoch,
                    errorKind: 'provider',
                });
                reject(new Error(`Cannot send ${method}: Codex transport is not writable`));
                return;
            }
            const id = this.nextId++;
            const startedAt = Date.now();
            const requestHash = syncV4DiagnosticHash(`${this.processEpoch}:${id}`);
            this.recordDiagnostic({
                level: 'debug',
                event: 'rpc',
                phase: 'started',
                state: 'pending',
                rpcFamily: codexRpcFamily(method),
                requestHash,
                epoch: this.processEpoch,
            });

            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.recordDiagnostic({
                    level: 'warn',
                    event: 'rpc',
                    phase: 'failed',
                    state: 'outcomeUnknown',
                    rpcFamily: codexRpcFamily(method),
                    requestHash,
                    epoch: this.processEpoch,
                    durationMs: elapsedDiagnosticMs(startedAt),
                    reason: 'timeout',
                    errorKind: 'timeout',
                });
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
                startedAt,
                requestHash,
            });

            const msg = { id, method, params } as StableClientRequestFor<M>;
            const line = JSON.stringify(msg) + '\n';
            logger.debug(`[CodexAppServer] -> ${redactCodexProtocolMethod(method)}`, {
                requestHash,
            });
            this.recordProtocolTrace('outbound', msg);
            if (!this.writeTransportPayload(line, JSON.stringify(msg), this.processEpoch)) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(new CodexRpcOutcomeUnknownError(
                    method,
                    `Codex transport closed while sending ${method}; outcome is unknown`,
                ));
            }
        });
    }

    private notify(msg: ClientNotification): boolean {
        if (!this.isTransportWritable()) return false;
        this.recordProtocolTrace('outbound', msg);
        const payload = JSON.stringify(msg);
        const written = this.writeTransportPayload(`${payload}\n`, payload, this.processEpoch);
        logger.debug(`[CodexAppServer] -> ${redactCodexProtocolMethod(msg.method)} (notification)`);
        return written;
    }

    private async respond(
        id: number,
        result: unknown,
        sourceEpoch: number = this.processEpoch,
    ): Promise<boolean> {
        return await this.writeResponse({ id, result }, sourceEpoch);
    }

    private async respondError(
        id: number,
        code: number,
        message: string,
        sourceEpoch: number = this.processEpoch,
    ): Promise<boolean> {
        return await this.writeResponse({ id, error: { code, message } }, sourceEpoch);
    }

    private async writeResponse(
        msg: CodexWireResponse,
        sourceEpoch: number,
    ): Promise<boolean> {
        if (sourceEpoch !== this.processEpoch || !this.isTransportWritable()) return false;
        this.recordProtocolTrace('outbound', msg);
        return await new Promise<boolean>((resolve) => {
            const payload = JSON.stringify(msg);
            const accepted = this.writeTransportPayload(
                `${payload}\n`,
                payload,
                sourceEpoch,
                (written) => {
                    if (written) {
                        logger.debug('[CodexAppServer] → response', {
                            requestHash: syncV4DiagnosticHash(`${sourceEpoch}:${msg.id}`),
                        });
                    }
                    resolve(written);
                },
            );
            if (!accepted) resolve(false);
        });
    }

    private isTransportWritable(): boolean {
        return Boolean(this.process?.stdin?.writable)
            || this.webSocket?.readyState === WebSocket.OPEN;
    }

    private writeTransportPayload(
        stdioPayload: string,
        webSocketPayload: string,
        sourceEpoch: number,
        onWritten?: (written: boolean) => void,
    ): boolean {
        if (sourceEpoch !== this.processEpoch) return false;
        const socket = this.webSocket;
        if (socket?.readyState === WebSocket.OPEN) {
            try {
                socket.send(webSocketPayload, (error) => {
                    onWritten?.(!error);
                    if (error && this.webSocket === socket && this.processEpoch === sourceEpoch) {
                        socket.terminate();
                    }
                });
                return true;
            } catch {
                return false;
            }
        }
        const stdin = this.process?.stdin;
        if (!stdin?.writable) return false;
        if (!onWritten) {
            try {
                stdin.write(stdioPayload);
                return true;
            } catch {
                return false;
            }
        }
        let settled = false;
        const finish = (written: boolean) => {
            if (settled) return;
            settled = true;
            stdin.off('error', onError);
            stdin.off('close', onClose);
            onWritten(written);
        };
        const onError = () => finish(false);
        const onClose = () => finish(false);
        stdin.once('error', onError);
        stdin.once('close', onClose);
        try {
            stdin.write(stdioPayload, (error) => finish(!error));
            return true;
        } catch {
            finish(false);
            return false;
        }
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
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
            const messageKind = msg === null
                ? 'null'
                : Array.isArray(msg) ? 'array' : typeof msg;
            logger.debug('[CodexAppServer] Unhandled message shape', {
                messageKind,
                fieldCount: 0,
            });
            this.recordDiagnostic({
                level: 'warn',
                event: 'notification',
                phase: 'dropped',
                source: 'notification',
                state: 'failed',
                epoch: sourceEpoch,
                errorKind: 'protocol',
            });
            return;
        }

        // Response to our request
        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
            if (!Number.isSafeInteger(msg.id) || msg.id < 0) {
                this.recordDiagnostic({
                    level: 'warn',
                    event: 'rpc',
                    phase: 'dropped',
                    direction: 'inbound',
                    state: 'failed',
                    epoch: sourceEpoch,
                    errorKind: 'protocol',
                });
                return;
            }
            const pending = this.pending.get(msg.id);
            if (pending) {
                if (pending.epoch !== sourceEpoch) {
                    logger.debug('[CodexAppServer] Ignoring response from stale epoch', {
                        requestHash: syncV4DiagnosticHash(`${sourceEpoch}:${msg.id}`),
                    });
                    return;
                }
                this.pending.delete(msg.id);
                if (msg.error) {
                    this.recordDiagnostic({
                        level: 'warn',
                        event: 'rpc',
                        phase: 'failed',
                        state: 'failed',
                        rpcFamily: codexRpcFamily(pending.method),
                        requestHash: pending.requestHash,
                        epoch: pending.epoch,
                        durationMs: elapsedDiagnosticMs(pending.startedAt),
                        errorKind: 'provider',
                    });
                    const code = typeof msg.error.code === 'number' || typeof msg.error.code === 'string'
                        ? msg.error.code
                        : 'unknown';
                    pending.reject(new CodexRpcResponseError(
                        pending.method,
                        code,
                        stringOrNull(msg.error.message),
                    ));
                } else {
                    try {
                        pending.onResult?.(msg.result);
                    } catch (error) {
                        this.recordDiagnostic({
                            level: 'error',
                            event: 'rpc',
                            phase: 'failed',
                            state: 'failed',
                            rpcFamily: codexRpcFamily(pending.method),
                            requestHash: pending.requestHash,
                            epoch: pending.epoch,
                            durationMs: elapsedDiagnosticMs(pending.startedAt),
                            errorKind: 'protocol',
                        });
                        pending.reject(error instanceof Error ? error : new Error(String(error)));
                        return;
                    }
                    this.recordDiagnostic({
                        level: 'debug',
                        event: 'rpc',
                        phase: 'completed',
                        state: 'succeeded',
                        rpcFamily: codexRpcFamily(pending.method),
                        requestHash: pending.requestHash,
                        epoch: pending.epoch,
                        durationMs: elapsedDiagnosticMs(pending.startedAt),
                    });
                    pending.resolve(msg.result);
                }
            }
            return;
        }

        // Server → client request (approvals)
        if (msg.id != null) {
            if (!Number.isSafeInteger(msg.id) || msg.id < 0) {
                this.recordDiagnostic({
                    level: 'error',
                    event: 'request',
                    phase: 'dropped',
                    source: 'notification',
                    state: 'failed',
                    epoch: sourceEpoch,
                    errorKind: 'protocol',
                });
                return;
            }
            const requestId = msg.id as number;
            if (this.isDuplicateServerRequestId(requestId)) {
                logger.debug('[CodexAppServer] Ignoring duplicate server request', {
                    requestHash: syncV4DiagnosticHash(`${sourceEpoch}:${requestId}`),
                });
                this.recordDiagnostic({
                    level: 'warn',
                    event: 'request',
                    phase: 'replayed',
                    source: 'notification',
                    state: 'pending',
                    requestHash: syncV4DiagnosticHash(`${sourceEpoch}:${requestId}`),
                    epoch: sourceEpoch,
                });
                return;
            }
            if (this.activeServerRequestIds.size >= MAX_ACTIVE_SERVER_REQUEST_IDS) {
                this.recordDiagnostic({
                    level: 'error',
                    event: 'request',
                    phase: 'dropped',
                    source: 'notification',
                    state: 'failed',
                    requestHash: syncV4DiagnosticHash(`${sourceEpoch}:${requestId}`),
                    epoch: sourceEpoch,
                    count: this.activeServerRequestIds.size,
                    errorKind: 'protocol',
                });
                this.activeServerRequestIds.add(requestId);
                void this.respondError(
                    requestId,
                    -32000,
                    'Too many pending server requests',
                    sourceEpoch,
                ).finally(() => this.settleServerRequestId(requestId, sourceEpoch));
                return;
            }
            this.activeServerRequestIds.add(requestId);
            if (!isValidCodexRpcMethod(msg.method)) {
                this.recordDiagnostic({
                    level: 'error',
                    event: 'request',
                    phase: 'dropped',
                    source: 'notification',
                    state: 'failed',
                    requestHash: syncV4DiagnosticHash(`${sourceEpoch}:${requestId}`),
                    epoch: sourceEpoch,
                    errorKind: 'protocol',
                });
                void this.respondError(
                    requestId,
                    -32600,
                    'Invalid request',
                    sourceEpoch,
                ).finally(() => this.settleServerRequestId(requestId, sourceEpoch));
                return;
            }
            void this.handleServerRequest(requestId, msg.method, msg.params, sourceEpoch)
                .catch((err) => {
                    logger.debug(`[CodexAppServer] Error handling server request (${errorKind(err)})`);
                })
                .finally(() => this.settleServerRequestId(requestId, sourceEpoch));
            return;
        }

        // Notification (no id)
        if (msg.method !== undefined) {
            if (!isValidCodexRpcMethod(msg.method)) {
                this.recordDiagnostic({
                    level: 'warn',
                    event: 'notification',
                    phase: 'dropped',
                    source: 'notification',
                    state: 'failed',
                    epoch: sourceEpoch,
                    errorKind: 'protocol',
                });
                return;
            }
            this.handleNotification(msg.method, msg.params, sourceEpoch);
            return;
        }

        const messageKind = msg === null
            ? 'null'
            : Array.isArray(msg) ? 'array' : typeof msg;
        const fieldCount = msg && typeof msg === 'object' && !Array.isArray(msg)
            ? boundedOwnFieldCount(msg)
            : 0;
        logger.debug('[CodexAppServer] Unhandled message shape', {
            messageKind,
            fieldCount,
        });
    }

    private recordProtocolTrace(direction: CodexProtocolTraceDirection, message: unknown): void {
        try {
            this.protocolTraceSink?.record(direction, message);
        } catch (error) {
            logger.debug(`[CodexAppServer] Protocol trace sink failed (${errorKind(error)})`);
        }
    }

    private isDuplicateServerRequestId(requestId: number): boolean {
        return requestId <= this.retiredServerRequestId
            || this.activeServerRequestIds.has(requestId)
            || this.settledServerRequestIds.has(requestId);
    }

    private settleServerRequestId(requestId: number, sourceEpoch: number): void {
        if (sourceEpoch !== this.processEpoch) return;
        this.activeServerRequestIds.delete(requestId);
        if (requestId <= this.retiredServerRequestId) return;
        this.settledServerRequestIds.add(requestId);
        this.compactSettledServerRequestIds();
    }

    private compactSettledServerRequestIds(): void {
        while (this.settledServerRequestIds.delete(this.retiredServerRequestId + 1)) {
            this.retiredServerRequestId += 1;
        }
        if (this.settledServerRequestIds.size <= MAX_SETTLED_SERVER_REQUEST_GAPS) return;

        const ordered = [...this.settledServerRequestIds].sort((left, right) => left - right);
        const floor = ordered[ordered.length - MAX_SETTLED_SERVER_REQUEST_GAPS];
        if (floor === undefined) return;
        this.retiredServerRequestId = Math.max(this.retiredServerRequestId, floor);
        for (const settled of this.settledServerRequestIds) {
            if (settled <= this.retiredServerRequestId) {
                this.settledServerRequestIds.delete(settled);
            }
        }
        while (this.settledServerRequestIds.delete(this.retiredServerRequestId + 1)) {
            this.retiredServerRequestId += 1;
        }
    }

    private resetServerRequestTracking(): void {
        this.activeServerRequestIds.clear();
        this.settledServerRequestIds.clear();
        this.retiredServerRequestId = -1;
    }

    private handleUnexpectedTransportClose(proc: ChildProcess, epoch: number): void {
        if (this.process !== proc || this.processEpoch !== epoch) return;
        this.connected = false;
        this.process = null;
        this.readline = null;
        this.recordDiagnostic({
            level: 'warn',
            event: 'connection',
            phase: 'failed',
            state: 'disconnected',
            epoch,
            reason: 'processExit',
            errorKind: 'provider',
        });
        this.updateConnection({ connection: 'disconnected', statusUnknown: true, error: null });
        for (const [id, request] of this.pending) {
            if (request.epoch !== epoch) continue;
            this.recordDiagnostic({
                level: 'warn',
                event: 'rpc',
                phase: 'failed',
                state: 'outcomeUnknown',
                rpcFamily: codexRpcFamily(request.method),
                requestHash: request.requestHash,
                epoch: request.epoch,
                durationMs: elapsedDiagnosticMs(request.startedAt),
                reason: 'processExit',
                errorKind: 'provider',
            });
            request.reject(new CodexRpcOutcomeUnknownError(
                request.method,
                `Codex transport closed while waiting for ${request.method}; outcome is unknown`,
            ));
            this.pending.delete(id);
        }
        this.rejectPendingCompactions(epoch, 'Codex transport closed');
        try {
            proc.kill('SIGTERM');
        } catch { /* process already unavailable */ }
        const activeThreadIds = this.threads.activeThreadIds();
        if (activeThreadIds.length > 0) {
            void this.recoverThreadsAfterUnexpectedExit(activeThreadIds, this.threadId);
        }
    }

    private handleUnexpectedWebSocketClose(socket: WebSocket, epoch: number): void {
        if (this.webSocket !== socket || this.processEpoch !== epoch) return;
        this.connected = false;
        this.webSocket = null;
        this.recordDiagnostic({
            level: 'warn',
            event: 'connection',
            phase: 'failed',
            state: 'disconnected',
            epoch,
            reason: 'reconnect',
            errorKind: 'provider',
        });
        this.updateConnection({ connection: 'disconnected', statusUnknown: true, error: null });
        for (const [id, request] of this.pending) {
            if (request.epoch !== epoch) continue;
            this.recordDiagnostic({
                level: 'warn',
                event: 'rpc',
                phase: 'failed',
                state: 'outcomeUnknown',
                rpcFamily: codexRpcFamily(request.method),
                requestHash: request.requestHash,
                epoch: request.epoch,
                durationMs: elapsedDiagnosticMs(request.startedAt),
                reason: 'reconnect',
                errorKind: 'provider',
            });
            request.reject(new CodexRpcOutcomeUnknownError(
                request.method,
                `Codex WebSocket closed while waiting for ${request.method}; outcome is unknown`,
            ));
            this.pending.delete(id);
        }
        this.rejectPendingCompactions(epoch, 'Codex WebSocket transport closed');
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

    private async handleServerRequest(
        id: number,
        method: string,
        params: any,
        sourceEpoch: number,
    ): Promise<void> {
        if (this.serverRequestHandler && isStableServerRequestMethod(method)) {
            let managed: CodexManagedServerResponse | null;
            try {
                managed = await this.serverRequestHandler({
                    requestId: String(id),
                    method,
                    params,
                });
            } catch (error) {
                logger.debug(`[CodexAppServer] Managed server request failed before response (${errorKind(error)})`);
                await this.respondError(id, -32000, 'Server request handler failed', sourceEpoch);
                return;
            }
            // A passive Gateway subscriber may deliberately leave the request
            // unanswered while another attached TUI owns the first response.
            if (!managed) return;
            if (!await this.respond(id, managed.response, sourceEpoch)) {
                await managed.markAbandoned();
                return;
            }
            try {
                await managed.markResponseSupplied();
            } catch (error) {
                // The success response may already be visible to Codex. Never
                // answer the same JSON-RPC id twice; coordinate it as unknown.
                try {
                    await managed.markAbandoned();
                } catch (abandonError) {
                    logger.debug(`[CodexAppServer] Failed to persist unknown provider response (${errorKind(abandonError)})`);
                }
                throw error;
            }
            // stdin.write only confirms local handoff. The matching
            // serverRequest/resolved notification is the provider ACK and is
            // routed back to the owning request broker.
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
            await this.respond(id, this.mapDecisionToMcpElicitationResponse(decision, params), sourceEpoch);
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
                await this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) }, sourceEpoch);
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
                        ? this.rawFileChangesByItemId.get(itemKey)?.changes
                        : undefined),
                    reason: params.reason,
                });
                await this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) }, sourceEpoch);
            } finally {
                this.pendingApprovalCallIds.delete(callId);
            }
            return;
        }

        // Unknown server request — respond so server doesn't hang
        logger.debug('[CodexAppServer] Unknown server request', {
            method: redactCodexProtocolMethod(method),
        });
        this.recordDiagnostic({
            level: 'warn',
            event: 'request',
            phase: 'failed',
            state: 'failed',
            requestHash: syncV4DiagnosticHash(`${sourceEpoch}:${id}`),
            epoch: sourceEpoch,
            reason: 'unknownMethod',
            errorKind: 'protocol',
        });
        await this.respondError(id, -32601, 'Method not found', sourceEpoch);
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

    private handleNotification(
        method: string,
        params: any,
        sourceEpoch: number = this.processEpoch,
    ): void {
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

        if (
            method === 'turn/completed'
            && !this.validateTerminalTurnNotification(params, sourceEpoch)
        ) {
            return;
        }

        const statusCompletionTurnId = this.trackStableNotification(method, params);

        // thread/started is emitted by registerThreadSnapshot after the registry
        // has accepted the snapshot. Every other stable notification is tapped
        // here before the legacy selected-thread projection can filter it.
        if (method !== 'thread/started') {
            this.emitStableNotification(method, params);
        }
        // Hand canonical item state to the mapper before allowing the remote
        // command result to complete, so consumers never observe success ahead
        // of the contextCompaction item that proves it.
        this.trackPendingCompaction(method, params, sourceEpoch);

        if (this.handleRawNotification(method, params, statusCompletionTurnId)) {
            logger.debug('[CodexAppServer] Raw notification', {
                method: redactCodexProtocolMethod(method),
            });
            return;
        }

        // v2 lifecycle notifications
        if (method === 'thread/started' || method === 'turn/started' ||
            method === 'turn/completed' || method === 'thread/status/changed') {
            logger.debug(`[CodexAppServer] Lifecycle notification: ${redactCodexProtocolMethod(method)}`);
            return;
        }

        if (method === 'mcpServer/startupStatus/updated') {
            logger.debug('[CodexAppServer] MCP server startup status updated');
            return;
        }

        logger.debug('[CodexAppServer] Notification', {
            method: redactCodexProtocolMethod(method),
        });
    }
}

function codexRpcFamily(method: string): SyncV4DiagnosticInput['rpcFamily'] {
    if (method === 'initialize' || method === 'initialized') return 'initialize';
    if (method.includes('compact')) return 'compact';
    if (method.startsWith('review/')) return 'review';
    if (method.startsWith('thread/')) return 'thread';
    if (method.startsWith('turn/')) return 'turn';
    if (method.startsWith('item/')) return 'item';
    if (method.startsWith('mcp')) return 'mcp';
    if (method.startsWith('skills/')) return 'skills';
    if (method.startsWith('model/')) return 'model';
    if (method.includes('goal')) return 'goal';
    if (method.includes('collab') || method.includes('agent')) return 'collaboration';
    if (method.includes('request') || method.includes('approval')) return 'request';
    return 'unknown';
}

function elapsedDiagnosticMs(startedAt: number): number {
    return Math.max(0, Math.trunc(Date.now() - startedAt));
}

function isValidCodexRpcMethod(method: unknown): method is string {
    return typeof method === 'string'
        && method.length > 0
        && method.length <= MAX_CODEX_RPC_METHOD_CHARS;
}

async function waitForWebSocketOpen(socket: WebSocket, timeoutMs = 10_000): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off('open', onOpen);
            socket.off('error', onError);
            socket.off('close', onClose);
            if (error) reject(error);
            else resolve();
        };
        const onOpen = () => finish();
        const onError = (error: Error) => finish(error);
        const onClose = () => finish(new Error('Codex WebSocket closed before initialization'));
        const timer = setTimeout(
            () => finish(new Error(`Codex WebSocket did not open within ${timeoutMs}ms`)),
            timeoutMs,
        );
        socket.once('open', onOpen);
        socket.once('error', onError);
        socket.once('close', onClose);
    });
}

async function closeCodexWebSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) return;
    if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
        return;
    }
    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off('close', finish);
            socket.off('error', finish);
            resolve();
        };
        const timer = setTimeout(() => {
            socket.terminate();
            finish();
        }, 500);
        socket.once('close', finish);
        socket.once('error', finish);
        socket.close(1000, 'Happy bridge disconnected');
    });
}
