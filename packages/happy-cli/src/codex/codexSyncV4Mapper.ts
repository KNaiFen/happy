/**
 * Projects Codex stable-v2 snapshots and notifications into canonical Sync v4
 * entities. Provider payloads stay encrypted; raw reasoning text is counted
 * for coverage only and is never published.
 */

import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    MAX_CODEX_SYNC_V4_PART_BYTES,
    type CodexEntityV4,
    type CodexItemEntityV4,
    type CodexPartEntityV4,
    type CodexPartKindV4,
    type CodexRuntimeEntityV4,
    type CodexThreadEntityV4,
    type CodexThreadStatusV4,
    type CodexTurnEntityV4,
} from '@slopus/happy-wire';
import type { SyncV4Client } from '@/api/syncV4Client';
import type {
    ServerNotification,
    Thread,
    ThreadItem,
    Turn,
} from './protocol';

type SyncPublisher = Pick<SyncV4Client, 'publishEntity' | 'publishEntities'>;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type ThreadTokenUsage = NonNullable<CodexThreadEntityV4['tokenUsage']>;
type TokenUsageBreakdown = ThreadTokenUsage['total'];

interface MapperOptions {
    codexCliVersion: string;
    protocolVersion?: string;
    initialSyncState?: CodexRuntimeEntityV4['syncState'];
    flushIntervalMs?: number;
    now?: () => number;
    onError?: (error: unknown) => void;
}

interface StreamChunk {
    content: string;
    byteLength: number;
    frozen: boolean;
    createdAt: number;
    publishedContent: string | null;
    publishedFinal: boolean | null;
}

interface PartStream {
    key: string;
    threadId: string;
    turnId: string;
    itemId: string;
    kind: CodexPartKindV4;
    index: number;
    contentType: CodexPartEntityV4['contentType'];
    chunks: StreamChunk[];
    finalized: boolean;
    timer: NodeJS.Timeout | null;
}

export interface CodexSyncV4MapperDiagnostics {
    rawReasoningUtf8Bytes: number;
    rawReasoningDeltaCount: number;
    authoritativeStreamMismatchCount: number;
    unknownNotificationMethods: Record<string, number>;
}

const DEFAULT_FLUSH_INTERVAL_MS = 200;
const TEXT_ENCODER = new TextEncoder();

export class CodexSyncV4Mapper {
    private readonly threads = new Map<string, CodexThreadEntityV4>();
    private readonly runtimes = new Map<string, CodexRuntimeEntityV4>();
    private readonly turns = new Map<string, CodexTurnEntityV4>();
    private readonly items = new Map<string, CodexItemEntityV4>();
    private readonly streams = new Map<string, PartStream>();
    private readonly activeTurnByThread = new Map<string, string>();
    private readonly diagnosticSequenceByTurn = new Map<string, number>();
    private readonly unknownNotificationMethods = new Map<string, number>();
    private pipeline: Promise<void> = Promise.resolve();
    private lastError: unknown = null;
    private closed = false;
    private rawReasoningUtf8Bytes = 0;
    private rawReasoningDeltaCount = 0;
    private authoritativeStreamMismatchCount = 0;

    constructor(
        private readonly publisher: SyncPublisher,
        private readonly options: MapperOptions,
    ) {}

    handleNotification(notification: ServerNotification): void {
        if (this.closed) return;
        void this.enqueue(() => this.applyNotification(notification)).catch(() => undefined);
    }

    importThread(thread: Thread): void {
        if (this.closed) return;
        void this.enqueue(() => this.applyThreadSnapshot(thread)).catch(() => undefined);
    }

    setConnection(
        connection: CodexRuntimeEntityV4['connection'],
        opts?: { statusUnknown?: boolean; error?: string | null },
    ): void {
        if (this.closed) return;
        void this.enqueue(async () => {
            const now = this.now();
            for (const [threadId, current] of this.runtimes) {
                const runtime: CodexRuntimeEntityV4 = {
                    ...current,
                    connection,
                    statusUnknown: opts?.statusUnknown ?? connection !== 'connected',
                    lastError: opts?.error ?? (connection === 'connected' ? null : current.lastError),
                    lastKnownAt: now,
                    updatedAt: now,
                };
                this.runtimes.set(threadId, runtime);
                await this.publisher.publishEntity(runtime);
            }
        }).catch(() => undefined);
    }

    setSyncState(syncState: CodexRuntimeEntityV4['syncState']): void {
        if (this.closed) return;
        void this.enqueue(async () => {
            const now = this.now();
            for (const [threadId, current] of this.runtimes) {
                const runtime = { ...current, syncState, updatedAt: now };
                this.runtimes.set(threadId, runtime);
                await this.publisher.publishEntity(runtime);
            }
        }).catch(() => undefined);
    }

    async flush(): Promise<void> {
        await this.enqueue(async () => {
            for (const stream of this.streams.values()) {
                await this.flushStream(stream);
            }
        });
        if (this.lastError) {
            const error = this.lastError;
            this.lastError = null;
            throw error;
        }
    }

    async close(): Promise<void> {
        if (this.closed) return;
        await this.flush();
        this.closed = true;
        for (const stream of this.streams.values()) {
            if (stream.timer) clearTimeout(stream.timer);
            stream.timer = null;
        }
    }

    diagnostics(): CodexSyncV4MapperDiagnostics {
        return {
            rawReasoningUtf8Bytes: this.rawReasoningUtf8Bytes,
            rawReasoningDeltaCount: this.rawReasoningDeltaCount,
            authoritativeStreamMismatchCount: this.authoritativeStreamMismatchCount,
            unknownNotificationMethods: Object.fromEntries(this.unknownNotificationMethods),
        };
    }

    private enqueue(task: () => Promise<void>): Promise<void> {
        const run = this.pipeline.then(task);
        this.pipeline = run.catch((error) => {
            this.lastError = error;
            this.options.onError?.(error);
        });
        return run;
    }

    private async applyNotification(notification: ServerNotification): Promise<void> {
        switch (notification.method) {
            case 'thread/started':
                await this.applyThreadSnapshot(notification.params.thread);
                return;
            case 'thread/status/changed':
                await this.applyThreadStatus(notification.params.threadId, notification.params.status);
                return;
            case 'thread/settings/updated':
                await this.applyThreadSettings(notification.params.threadId, notification.params.threadSettings);
                return;
            case 'thread/tokenUsage/updated':
                await this.applyTokenUsage(
                    notification.params.threadId,
                    notification.params.turnId,
                    notification.params.tokenUsage,
                );
                return;
            case 'turn/started':
                await this.applyTurn(notification.params.threadId, notification.params.turn, 'started');
                return;
            case 'turn/completed':
                await this.applyTurn(notification.params.threadId, notification.params.turn, 'completed');
                return;
            case 'turn/plan/updated':
                await this.applyTurnPlan(notification.params);
                return;
            case 'turn/diff/updated':
                await this.applyTurnDiff(notification.params.threadId, notification.params.turnId, notification.params.diff);
                return;
            case 'item/started':
                await this.applyItem(
                    notification.params.threadId,
                    notification.params.turnId,
                    notification.params.item,
                    'started',
                    notification.params.startedAtMs,
                );
                return;
            case 'item/completed':
                await this.applyItem(
                    notification.params.threadId,
                    notification.params.turnId,
                    notification.params.item,
                    'completed',
                    notification.params.completedAtMs,
                );
                return;
            case 'item/agentMessage/delta':
                await this.applyDelta(notification.params, 'agentMessage', 'text', 0, notification.params.delta);
                return;
            case 'item/plan/delta':
                await this.applyDelta(notification.params, 'plan', 'plan', 0, notification.params.delta);
                return;
            case 'item/reasoning/summaryPartAdded':
                await this.ensureDeltaTarget(notification.params, 'reasoning');
                this.ensureStream({
                    ...notification.params,
                    kind: 'reasoningSummary',
                    index: notification.params.summaryIndex,
                    contentType: 'text',
                });
                return;
            case 'item/reasoning/summaryTextDelta':
                await this.applyDelta(
                    notification.params,
                    'reasoning',
                    'reasoningSummary',
                    notification.params.summaryIndex,
                    notification.params.delta,
                );
                return;
            case 'item/reasoning/textDelta':
                this.rawReasoningDeltaCount += 1;
                this.rawReasoningUtf8Bytes += utf8ByteLength(notification.params.delta);
                return;
            case 'item/commandExecution/outputDelta':
                await this.applyDelta(notification.params, 'commandExecution', 'commandOutput', 0, notification.params.delta);
                return;
            case 'item/fileChange/outputDelta':
                await this.applyDelta(notification.params, 'fileChange', 'patch', 0, notification.params.delta);
                return;
            case 'item/fileChange/patchUpdated':
                await this.ensureDeltaTarget(notification.params, 'fileChange');
                await this.setStreamContent(
                    this.ensureStream({ ...notification.params, kind: 'patch', index: 0, contentType: 'json' }),
                    stringifyJson(notification.params.changes),
                    true,
                );
                return;
            case 'item/mcpToolCall/progress':
                await this.applyDelta(
                    notification.params,
                    'mcpToolCall',
                    'mcpProgress',
                    0,
                    `${notification.params.message}\n`,
                );
                return;
            case 'warning':
                if (notification.params.threadId) {
                    await this.applyDiagnostic(notification.params.threadId, null, 'warning', notification.params.message);
                }
                return;
            case 'error':
                await this.applyDiagnostic(
                    notification.params.threadId,
                    notification.params.turnId,
                    'error',
                    notification.params.error.message,
                );
                return;
            case 'thread/compacted':
                // Deprecated coverage signal. The contextCompaction item is canonical.
                return;
            case 'serverRequest/resolved':
            case 'mcpServer/startupStatus/updated':
            case 'thread/goal/updated':
            case 'thread/goal/cleared':
                return;
            default:
                this.unknownNotificationMethods.set(
                    notification.method,
                    (this.unknownNotificationMethods.get(notification.method) ?? 0) + 1,
                );
        }
    }

    private async applyThreadSnapshot(thread: Thread): Promise<void> {
        const now = this.now();
        const previous = this.threads.get(thread.id);
        const raw = thread as unknown as Record<string, unknown>;
        const status = normalizeThreadStatus(thread.status);
        const createdAt = toEpochMs(thread.createdAt, previous?.createdAt ?? now);
        const updatedAt = toEpochMs(thread.updatedAt, now);
        const entity: CodexThreadEntityV4 = {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.thread',
            providerId: thread.id,
            createdAt,
            updatedAt,
            threadId: thread.id,
            sessionTreeId: stringOrNull(raw.sessionId),
            forkedFromThreadId: stringOrNull(raw.forkedFromId),
            parentThreadId: stringOrNull(raw.parentThreadId),
            name: stringOrNull(raw.name),
            preview: typeof raw.preview === 'string' ? raw.preview : '',
            cwd: typeof raw.cwd === 'string' ? raw.cwd : previous?.cwd ?? '',
            cliVersion: typeof raw.cliVersion === 'string' ? raw.cliVersion : this.options.codexCliVersion,
            model: previous?.model ?? null,
            modelProvider: typeof raw.modelProvider === 'string' ? raw.modelProvider : previous?.modelProvider ?? 'openai',
            source: asJsonValue(raw.source),
            status,
            canAcceptDirectInput: typeof raw.canAcceptDirectInput === 'boolean' ? raw.canAcceptDirectInput : null,
            settings: previous?.settings ?? emptyThreadSettings(),
            tokenUsage: previous?.tokenUsage ?? null,
        };
        const runtime = this.runtimeFor(thread.id, status, now);
        this.threads.set(thread.id, entity);
        this.runtimes.set(thread.id, runtime);
        await this.publisher.publishEntities([{ entity }, { entity: runtime }]);

        for (const turn of thread.turns) {
            await this.applyTurn(thread.id, turn, turn.status === 'inProgress' ? 'started' : 'snapshot');
        }
    }

    private async applyThreadStatus(threadId: string, status: CodexThreadStatusV4): Promise<void> {
        const now = this.now();
        const thread = await this.ensureThread(threadId, now);
        const nextThread = { ...thread, status: normalizeThreadStatus(status), updatedAt: now };
        const runtime = this.runtimeFor(threadId, nextThread.status, now);
        this.threads.set(threadId, nextThread);
        this.runtimes.set(threadId, runtime);
        if (nextThread.status.type !== 'active') this.activeTurnByThread.delete(threadId);
        await this.publisher.publishEntities([{ entity: nextThread }, { entity: runtime }]);
    }

    private async applyThreadSettings(threadId: string, settings: Record<string, unknown>): Promise<void> {
        const now = this.now();
        const thread = await this.ensureThread(threadId, now);
        const next: CodexThreadEntityV4 = {
            ...thread,
            cwd: typeof settings.cwd === 'string' ? settings.cwd : thread.cwd,
            model: stringOrNull(settings.model) ?? thread.model,
            modelProvider: stringOrNull(settings.modelProvider) ?? thread.modelProvider,
            settings: {
                approvalPolicy: asJsonValue(settings.approvalPolicy),
                approvalsReviewer: asJsonValue(settings.approvalsReviewer),
                sandboxPolicy: asJsonValue(settings.sandboxPolicy),
                permissionProfile: asJsonValue(settings.activePermissionProfile),
                serviceTier: stringOrNull(settings.serviceTier),
                reasoningEffort: stringOrNull(settings.effort),
                reasoningSummary: stringOrNull(settings.summary),
                collaborationMode: asJsonValue(settings.collaborationMode),
                personality: stringOrNull(settings.personality),
            },
            updatedAt: now,
        };
        this.threads.set(threadId, next);
        await this.publisher.publishEntity(next);
    }

    private async applyTokenUsage(
        threadId: string,
        turnId: string,
        usage: ThreadTokenUsage,
    ): Promise<void> {
        const now = this.now();
        const thread = await this.ensureThread(threadId, now);
        const tokenUsage = normalizeThreadTokenUsage(usage);
        const nextThread = { ...thread, tokenUsage, updatedAt: now };
        this.threads.set(threadId, nextThread);

        const turn = await this.ensureTurn(threadId, turnId, now);
        const nextTurn = { ...turn, usage: tokenUsage.last, updatedAt: now };
        this.turns.set(turnKey(threadId, turnId), nextTurn);
        await this.publisher.publishEntities([{ entity: nextThread }, { entity: nextTurn }]);
    }

    private async applyTurn(
        threadId: string,
        turn: Turn,
        phase: 'started' | 'completed' | 'snapshot',
    ): Promise<void> {
        const now = this.now();
        await this.ensureThread(threadId, now);
        const key = turnKey(threadId, turn.id);
        const previous = this.turns.get(key);
        const status = normalizeTurnStatus(turn.status);
        const startedAt = toNullableEpochMs(turn.startedAt) ?? previous?.startedAt ?? (phase === 'started' ? now : null);
        const completedAt = toNullableEpochMs(turn.completedAt) ?? (status !== 'inProgress' ? now : null);
        const entity: CodexTurnEntityV4 = {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.turn',
            providerId: key,
            createdAt: previous?.createdAt ?? startedAt ?? now,
            updatedAt: now,
            threadId,
            turnId: turn.id,
            status,
            startedAt,
            completedAt,
            durationMs: nonnegativeIntOrNull(turn.durationMs),
            error: turn.error ? {
                message: turn.error.message,
                code: codexErrorCode(turn.error.codexErrorInfo),
                details: turn.error.additionalDetails,
            } : null,
            usage: previous?.usage ?? null,
            planRevision: previous?.planRevision ?? 0,
            diffRevision: previous?.diffRevision ?? 0,
        };
        this.turns.set(key, entity);
        if (status === 'inProgress') this.activeTurnByThread.set(threadId, turn.id);
        else if (this.activeTurnByThread.get(threadId) === turn.id) this.activeTurnByThread.delete(threadId);
        await this.publisher.publishEntity(entity);

        const fallbackTime = startedAt ?? entity.createdAt;
        for (const item of turn.items) {
            await this.applyItem(
                threadId,
                turn.id,
                item,
                status === 'inProgress' ? 'started' : 'completed',
                status === 'inProgress' ? fallbackTime : completedAt ?? fallbackTime,
            );
        }

        const thread = this.threads.get(threadId);
        if (thread) {
            const threadStatus: CodexThreadStatusV4 = status === 'inProgress'
                ? { type: 'active', activeFlags: [] }
                : thread.status.type === 'systemError' ? thread.status : { type: 'idle' };
            const nextThread = { ...thread, status: threadStatus, updatedAt: now };
            const runtime = this.runtimeFor(threadId, threadStatus, now);
            this.threads.set(threadId, nextThread);
            this.runtimes.set(threadId, runtime);
            await this.publisher.publishEntities([{ entity: nextThread }, { entity: runtime }]);
        }
    }

    private async applyTurnPlan(params: {
        threadId: string;
        turnId: string;
        explanation: string | null;
        plan: Array<unknown>;
    }): Promise<void> {
        const now = this.now();
        const turn = await this.ensureTurn(params.threadId, params.turnId, now);
        const nextTurn = { ...turn, planRevision: turn.planRevision + 1, updatedAt: now };
        this.turns.set(turnKey(params.threadId, params.turnId), nextTurn);
        const itemId = '__turn_plan__';
        await this.ensureItem(params.threadId, params.turnId, itemId, 'plan', now);
        const stream = this.ensureStream({
            threadId: params.threadId,
            turnId: params.turnId,
            itemId,
            kind: 'plan',
            index: 0,
            contentType: 'json',
        });
        await this.setStreamContent(stream, stringifyJson({ explanation: params.explanation, plan: params.plan }), true);
        await this.publisher.publishEntity(nextTurn);
    }

    private async applyTurnDiff(threadId: string, turnId: string, diff: string): Promise<void> {
        const now = this.now();
        const turn = await this.ensureTurn(threadId, turnId, now);
        const nextTurn = { ...turn, diffRevision: turn.diffRevision + 1, updatedAt: now };
        this.turns.set(turnKey(threadId, turnId), nextTurn);
        const itemId = '__turn_diff__';
        await this.ensureItem(threadId, turnId, itemId, 'turnDiff', now);
        const stream = this.ensureStream({ threadId, turnId, itemId, kind: 'patch', index: 0, contentType: 'text' });
        await this.setStreamContent(stream, diff, true);
        await this.publisher.publishEntity(nextTurn);
    }

    private async applyItem(
        threadId: string,
        turnId: string,
        item: ThreadItem,
        phase: 'started' | 'completed',
        eventAt: number,
    ): Promise<void> {
        const now = this.now();
        await this.ensureTurn(threadId, turnId, now);
        const key = itemKey(threadId, turnId, item.id);
        const previous = this.items.get(key);
        const at = toEpochMs(eventAt, now);
        const raw = item as unknown as Record<string, unknown>;
        const entity: CodexItemEntityV4 = {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.item',
            providerId: key,
            createdAt: previous?.createdAt ?? at,
            updatedAt: now,
            threadId,
            turnId,
            itemId: item.id,
            itemType: item.type,
            status: stringOrNull(raw.status) ?? (phase === 'completed' ? 'completed' : 'inProgress'),
            parentItemId: stringOrNull(raw.parentItemId),
            clientId: stringOrNull(raw.clientId),
            phase: stringOrNull(raw.phase),
            startedAt: previous?.startedAt ?? (phase === 'started' ? at : null),
            completedAt: phase === 'completed' ? at : null,
            command: stringOrNull(raw.command),
            cwd: stringOrNull(raw.cwd),
            processId: stringOrNull(raw.processId),
            exitCode: intOrNull(raw.exitCode),
            durationMs: nonnegativeIntOrNull(raw.durationMs),
            server: stringOrNull(raw.server),
            tool: itemTool(item),
            arguments: itemArguments(item),
        };
        this.items.set(key, entity);
        await this.publisher.publishEntity(entity);
        await this.captureItemContent(threadId, turnId, item, phase === 'completed');
        if (phase === 'completed') await this.finalizeItemStreams(threadId, turnId, item.id);
    }

    private async captureItemContent(
        threadId: string,
        turnId: string,
        item: ThreadItem,
        final: boolean,
    ): Promise<void> {
        const base = { threadId, turnId, itemId: item.id };
        if (item.type === 'userMessage') {
            const text = item.content
                .map((entry) => ('text' in entry && typeof entry.text === 'string' ? entry.text : ''))
                .filter(Boolean)
                .join('\n');
            if (text) await this.setStreamContent(this.ensureStream({ ...base, kind: 'userInput', index: 0, contentType: 'text' }), text, true);
        } else if (item.type === 'agentMessage' && item.text) {
            await this.setStreamContent(this.ensureStream({ ...base, kind: 'text', index: 0, contentType: 'text' }), item.text, true);
        } else if (item.type === 'plan' && item.text) {
            await this.setStreamContent(this.ensureStream({ ...base, kind: 'plan', index: 0, contentType: 'text' }), item.text, true);
        } else if (item.type === 'reasoning') {
            for (let index = 0; index < item.summary.length; index += 1) {
                await this.setStreamContent(
                    this.ensureStream({ ...base, kind: 'reasoningSummary', index, contentType: 'text' }),
                    item.summary[index],
                    true,
                );
            }
            // item.content is raw reasoning and intentionally remains local.
        } else if (item.type === 'commandExecution' && item.aggregatedOutput) {
            await this.setStreamContent(
                this.ensureStream({ ...base, kind: 'commandOutput', index: 0, contentType: 'text' }),
                item.aggregatedOutput,
                true,
            );
        } else if (item.type === 'fileChange' && item.changes.length > 0) {
            await this.setStreamContent(
                this.ensureStream({ ...base, kind: 'patch', index: 0, contentType: 'json' }),
                stringifyJson(item.changes),
                true,
            );
        } else if (item.type === 'mcpToolCall' && (item.result || item.error)) {
            await this.setStreamContent(
                this.ensureStream({ ...base, kind: 'mcpProgress', index: 1, contentType: 'json' }),
                stringifyJson({ result: item.result, error: item.error }),
                true,
            );
        } else if (item.type === 'dynamicToolCall' && item.contentItems) {
            await this.setStreamContent(
                this.ensureStream({ ...base, kind: 'mcpProgress', index: 1, contentType: 'json' }),
                stringifyJson({ contentItems: item.contentItems, success: item.success }),
                true,
            );
        } else if (item.type === 'collabAgentToolCall' && item.prompt) {
            await this.setStreamContent(
                this.ensureStream({ ...base, kind: 'text', index: 0, contentType: 'text' }),
                item.prompt,
                true,
            );
        } else if ((item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') && item.review) {
            await this.setStreamContent(
                this.ensureStream({ ...base, kind: 'text', index: 0, contentType: 'text' }),
                item.review,
                true,
            );
        }

        if (final) await this.finalizeItemStreams(threadId, turnId, item.id);
    }

    private async applyDelta(
        params: { threadId: string; turnId: string; itemId: string },
        itemType: string,
        kind: CodexPartKindV4,
        index: number,
        delta: string,
    ): Promise<void> {
        await this.ensureDeltaTarget(params, itemType);
        const stream = this.ensureStream({ ...params, kind, index, contentType: 'text' });
        this.appendStream(stream, delta);
    }

    private async ensureDeltaTarget(
        params: { threadId: string; turnId: string; itemId: string },
        itemType: string,
    ): Promise<void> {
        const now = this.now();
        await this.ensureTurn(params.threadId, params.turnId, now);
        await this.ensureItem(params.threadId, params.turnId, params.itemId, itemType, now);
    }

    private async applyDiagnostic(
        threadId: string,
        requestedTurnId: string | null,
        kind: 'warning' | 'error',
        content: string,
    ): Promise<void> {
        const now = this.now();
        const turnId = requestedTurnId ?? this.activeTurnByThread.get(threadId) ?? '__runtime_events__';
        const turn = await this.ensureTurn(threadId, turnId, now, requestedTurnId ? 'inProgress' : 'completed');
        const sequenceKey = turnKey(threadId, turnId);
        const sequence = (this.diagnosticSequenceByTurn.get(sequenceKey) ?? 0) + 1;
        this.diagnosticSequenceByTurn.set(sequenceKey, sequence);
        const itemId = `__${kind}_${sequence}__`;
        const item = await this.ensureItem(threadId, turnId, itemId, kind, now);
        const completed = { ...item, status: 'completed', completedAt: now, updatedAt: now };
        this.items.set(item.providerId, completed);
        await this.publisher.publishEntity(completed);
        const stream = this.ensureStream({ threadId, turnId, itemId, kind, index: 0, contentType: 'text' });
        this.appendStream(stream, content);
        stream.finalized = true;
        await this.flushStream(stream);
        if (turn.status === 'completed') await this.publisher.publishEntity(turn);
    }

    private async ensureThread(threadId: string, now: number): Promise<CodexThreadEntityV4> {
        const existing = this.threads.get(threadId);
        if (existing) return existing;
        const thread: CodexThreadEntityV4 = {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.thread',
            providerId: threadId,
            createdAt: now,
            updatedAt: now,
            threadId,
            sessionTreeId: null,
            forkedFromThreadId: null,
            parentThreadId: null,
            name: null,
            preview: '',
            cwd: '',
            cliVersion: this.options.codexCliVersion,
            model: null,
            modelProvider: 'openai',
            source: null,
            status: { type: 'notLoaded' },
            canAcceptDirectInput: null,
            settings: emptyThreadSettings(),
            tokenUsage: null,
        };
        const runtime = this.runtimeFor(threadId, thread.status, now);
        this.threads.set(threadId, thread);
        this.runtimes.set(threadId, runtime);
        await this.publisher.publishEntities([{ entity: thread }, { entity: runtime }]);
        return thread;
    }

    private async ensureTurn(
        threadId: string,
        turnId: string,
        now: number,
        status: CodexTurnEntityV4['status'] = 'inProgress',
    ): Promise<CodexTurnEntityV4> {
        const key = turnKey(threadId, turnId);
        const existing = this.turns.get(key);
        if (existing) return existing;
        await this.ensureThread(threadId, now);
        const turn: CodexTurnEntityV4 = {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.turn',
            providerId: key,
            createdAt: now,
            updatedAt: now,
            threadId,
            turnId,
            status,
            startedAt: status === 'inProgress' ? now : null,
            completedAt: status === 'inProgress' ? null : now,
            durationMs: null,
            error: null,
            usage: null,
            planRevision: 0,
            diffRevision: 0,
        };
        this.turns.set(key, turn);
        if (status === 'inProgress') this.activeTurnByThread.set(threadId, turnId);
        await this.publisher.publishEntity(turn);
        return turn;
    }

    private async ensureItem(
        threadId: string,
        turnId: string,
        itemId: string,
        itemType: string,
        now: number,
    ): Promise<CodexItemEntityV4> {
        const key = itemKey(threadId, turnId, itemId);
        const existing = this.items.get(key);
        if (existing) return existing;
        const item: CodexItemEntityV4 = {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.item',
            providerId: key,
            createdAt: now,
            updatedAt: now,
            threadId,
            turnId,
            itemId,
            itemType,
            status: 'inProgress',
            parentItemId: null,
            clientId: null,
            phase: null,
            startedAt: now,
            completedAt: null,
            command: null,
            cwd: null,
            processId: null,
            exitCode: null,
            durationMs: null,
            server: null,
            tool: null,
            arguments: null,
        };
        this.items.set(key, item);
        await this.publisher.publishEntity(item);
        return item;
    }

    private runtimeFor(
        threadId: string,
        execution: CodexThreadStatusV4,
        now: number,
    ): CodexRuntimeEntityV4 {
        const previous = this.runtimes.get(threadId);
        return {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.runtime',
            providerId: `${threadId}\0runtime`,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
            threadId,
            connection: previous?.connection ?? 'connected',
            execution: normalizeThreadStatus(execution),
            statusUnknown: false,
            protocolVersion: this.options.protocolVersion ?? 'stable-v2',
            codexCliVersion: this.options.codexCliVersion,
            syncState: previous?.syncState ?? this.options.initialSyncState ?? 'ready',
            pendingApprovalCount: previous?.pendingApprovalCount ?? 0,
            pendingUserInputCount: previous?.pendingUserInputCount ?? 0,
            activeSubagentCount: previous?.activeSubagentCount ?? 0,
            lastError: execution.type === 'systemError' ? previous?.lastError ?? 'systemError' : null,
            lastKnownAt: now,
        };
    }

    private ensureStream(input: {
        threadId: string;
        turnId: string;
        itemId: string;
        kind: CodexPartKindV4;
        index: number;
        contentType: CodexPartEntityV4['contentType'];
    }): PartStream {
        const key = streamKey(input.threadId, input.turnId, input.itemId, input.kind, input.index);
        const existing = this.streams.get(key);
        if (existing) return existing;
        const stream: PartStream = { ...input, key, chunks: [], finalized: false, timer: null };
        this.streams.set(key, stream);
        return stream;
    }

    private appendStream(stream: PartStream, delta: string): void {
        if (!delta || stream.finalized) return;
        for (const character of delta) {
            const characterBytes = utf8ByteLength(character);
            let chunk = stream.chunks.at(-1);
            if (!chunk || chunk.frozen) {
                chunk = newChunk(this.now());
                stream.chunks.push(chunk);
            }
            if (chunk.byteLength + characterBytes > MAX_CODEX_SYNC_V4_PART_BYTES) {
                chunk.frozen = true;
                chunk = newChunk(this.now());
                stream.chunks.push(chunk);
            }
            chunk.content += character;
            chunk.byteLength += characterBytes;
            if (chunk.byteLength === MAX_CODEX_SYNC_V4_PART_BYTES) chunk.frozen = true;
        }
        this.scheduleFlush(stream);
    }

    private async setStreamContent(stream: PartStream, content: string, flushNow: boolean): Promise<void> {
        if (stream.finalized) return;
        const current = stream.chunks.map((chunk) => chunk.content).join('');
        if (current !== content) {
            if (content.startsWith(current)) {
                this.appendStream(stream, content.slice(current.length));
            } else if (!stream.chunks.some((chunk) => chunk.frozen && chunk.publishedContent !== null)) {
                stream.chunks = [];
                this.appendStream(stream, content);
            } else {
                this.authoritativeStreamMismatchCount += 1;
            }
        }
        if (flushNow) await this.flushStream(stream);
    }

    private scheduleFlush(stream: PartStream): void {
        if (stream.timer || this.closed) return;
        stream.timer = setTimeout(() => {
            stream.timer = null;
            void this.enqueue(() => this.flushStream(stream)).catch(() => undefined);
        }, this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
        stream.timer.unref();
    }

    private async finalizeItemStreams(threadId: string, turnId: string, itemId: string): Promise<void> {
        for (const stream of this.streams.values()) {
            if (stream.threadId !== threadId || stream.turnId !== turnId || stream.itemId !== itemId) continue;
            stream.finalized = true;
            await this.flushStream(stream);
        }
    }

    private async flushStream(stream: PartStream): Promise<void> {
        if (stream.timer) clearTimeout(stream.timer);
        stream.timer = null;
        const now = this.now();
        const entities: CodexEntityV4[] = [];
        for (let chunkIndex = 0; chunkIndex < stream.chunks.length; chunkIndex += 1) {
            const chunk = stream.chunks[chunkIndex];
            if (!chunk.content) continue;
            const final = chunk.frozen || stream.finalized;
            if (chunk.publishedContent === chunk.content && chunk.publishedFinal === final) continue;
            const providerId = `${stream.key}\0${chunkIndex}`;
            entities.push({
                schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
                entityType: 'codex.part',
                providerId,
                createdAt: chunk.createdAt,
                updatedAt: now,
                threadId: stream.threadId,
                turnId: stream.turnId,
                itemId: stream.itemId,
                partId: stream.key,
                kind: stream.kind,
                index: stream.index,
                chunkIndex,
                content: chunk.content,
                contentType: stream.contentType,
                final,
            });
            chunk.publishedContent = chunk.content;
            chunk.publishedFinal = final;
        }
        if (entities.length > 0) {
            await this.publisher.publishEntities(entities.map((entity) => ({ entity })));
        }
    }

    private now(): number {
        return Math.max(0, Math.trunc(this.options.now?.() ?? Date.now()));
    }
}

function normalizeThreadStatus(status: CodexThreadStatusV4): CodexThreadStatusV4 {
    if (status.type !== 'active') return { type: status.type };
    return {
        type: 'active',
        activeFlags: status.activeFlags.filter((flag) => (
            flag === 'waitingOnApproval' || flag === 'waitingOnUserInput'
        )),
    };
}

function normalizeTurnStatus(status: Turn['status']): CodexTurnEntityV4['status'] {
    return status === 'completed' || status === 'interrupted' || status === 'failed'
        ? status
        : 'inProgress';
}

function normalizeThreadTokenUsage(usage: ThreadTokenUsage): ThreadTokenUsage {
    return {
        total: normalizeTokenUsageBreakdown(usage.total),
        last: normalizeTokenUsageBreakdown(usage.last),
        modelContextWindow: positiveIntOrNull(usage.modelContextWindow),
    };
}

function normalizeTokenUsageBreakdown(usage: TokenUsageBreakdown): TokenUsageBreakdown {
    return {
        totalTokens: nonnegativeInt(usage.totalTokens),
        inputTokens: nonnegativeInt(usage.inputTokens),
        cachedInputTokens: nonnegativeInt(usage.cachedInputTokens),
        cacheWriteInputTokens: nonnegativeInt(usage.cacheWriteInputTokens),
        outputTokens: nonnegativeInt(usage.outputTokens),
        reasoningOutputTokens: nonnegativeInt(usage.reasoningOutputTokens),
    };
}

function emptyThreadSettings(): CodexThreadEntityV4['settings'] {
    return {
        approvalPolicy: null,
        approvalsReviewer: null,
        sandboxPolicy: null,
        permissionProfile: null,
        serviceTier: null,
        reasoningEffort: null,
        reasoningSummary: null,
        collaborationMode: null,
        personality: null,
    };
}

function itemTool(item: ThreadItem): string | null {
    if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return item.tool;
    if (item.type === 'collabAgentToolCall') return item.tool;
    return null;
}

function itemArguments(item: ThreadItem): JsonValue {
    if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return asJsonValue(item.arguments);
    if (item.type === 'collabAgentToolCall') {
        return asJsonValue({
            senderThreadId: item.senderThreadId,
            receiverThreadIds: item.receiverThreadIds,
            model: item.model,
            reasoningEffort: item.reasoningEffort,
            agentsStates: item.agentsStates,
        });
    }
    if (item.type === 'subAgentActivity') {
        return asJsonValue({ kind: item.kind, agentThreadId: item.agentThreadId, agentPath: item.agentPath });
    }
    return null;
}

function asJsonValue(value: unknown): JsonValue {
    if (value === undefined) return null;
    try {
        const encoded = JSON.stringify(value);
        return encoded === undefined ? null : JSON.parse(encoded) as JsonValue;
    } catch {
        return null;
    }
}

function stringifyJson(value: unknown): string {
    return JSON.stringify(asJsonValue(value));
}

function codexErrorCode(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return stringOrNull(record.type) ?? stringOrNull(record.code);
}

function newChunk(createdAt: number): StreamChunk {
    return {
        content: '',
        byteLength: 0,
        frozen: false,
        createdAt,
        publishedContent: null,
        publishedFinal: null,
    };
}

function utf8ByteLength(value: string): number {
    return TEXT_ENCODER.encode(value).byteLength;
}

function toEpochMs(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
    const normalized = value < 1_000_000_000_000 ? value * 1_000 : value;
    return Math.max(0, Math.trunc(normalized));
}

function toNullableEpochMs(value: unknown): number | null {
    return value === null || value === undefined ? null : toEpochMs(value, 0);
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function intOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function nonnegativeInt(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function nonnegativeIntOrNull(value: unknown): number | null {
    return value === null || value === undefined ? null : nonnegativeInt(value);
}

function positiveIntOrNull(value: unknown): number | null {
    const normalized = nonnegativeIntOrNull(value);
    return normalized !== null && normalized > 0 ? normalized : null;
}

function turnKey(threadId: string, turnId: string): string {
    return `${threadId}\0${turnId}`;
}

function itemKey(threadId: string, turnId: string, itemId: string): string {
    return `${turnKey(threadId, turnId)}\0${itemId}`;
}

function streamKey(
    threadId: string,
    turnId: string,
    itemId: string,
    kind: CodexPartKindV4,
    index: number,
): string {
    return `${itemKey(threadId, turnId, itemId)}\0${kind}\0${index}`;
}
