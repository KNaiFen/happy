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
    type CodexRelationEntityV4,
    type CodexRequestEntityV4,
    type CodexRuntimeEntityV4,
    type CodexThreadEntityV4,
    type CodexThreadStatusV4,
    type CodexTurnEntityV4,
} from '@slopus/happy-wire';
import type { SyncV4Client } from '@/api/syncV4Client';
import type { SyncV4ProviderRequestJournalState } from '@/api/syncV4Journal';
import { logger } from '@/ui/logger';
import { createHash, randomUUID } from 'node:crypto';
import type {
    ServerNotification,
    Thread,
    ThreadGoal,
    ThreadItem,
    Turn,
    UserInput,
} from './protocol';

type SyncPublisher = Pick<
    SyncV4Client,
    | 'publishEntity'
    | 'publishEntities'
    | 'publishProviderRequestTransition'
    | 'persistProviderRequestTransition'
>;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type ThreadTokenUsage = NonNullable<CodexThreadEntityV4['tokenUsage']>;
type TokenUsageBreakdown = ThreadTokenUsage['total'];

interface MapperOptions {
    codexCliVersion: string;
    protocolVersion?: string;
    initialSyncState?: CodexRuntimeEntityV4['syncState'];
    flushIntervalMs?: number;
    finalizedStreamMarkerLimit?: number;
    diagnosticId?: () => string;
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

interface DiagnosticContent {
    message: string;
    code?: string | null;
    details?: string | null;
    willRetry?: boolean | null;
    category?: 'unknownStableVariant';
    union?: 'ThreadItem' | 'UserInput';
    variant?: string;
}

interface BufferedNotification {
    notification: ServerNotification;
    deliveryId: string | null;
}

export interface CodexSyncV4MapperDiagnostics {
    rawReasoningUtf8Bytes: number;
    rawReasoningDeltaCount: number;
    authoritativeStreamMismatchCount: number;
    unknownNotificationMethods: Record<string, number>;
    unknownStableVariants: Record<string, number>;
    threadStatusTransitions: Record<string, number>;
    activeStreamCount: number;
    finalizedStreamCount: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 200;
const DEFAULT_FINALIZED_STREAM_MARKER_LIMIT = 50_000;
const MAX_INLINE_ITEM_ARGUMENT_BYTES = 32 * 1024;
const TEXT_ENCODER = new TextEncoder();

export class CodexSyncV4Mapper {
    private readonly threads = new Map<string, CodexThreadEntityV4>();
    private readonly runtimes = new Map<string, CodexRuntimeEntityV4>();
    private readonly turns = new Map<string, CodexTurnEntityV4>();
    private readonly items = new Map<string, CodexItemEntityV4>();
    private readonly requests = new Map<string, CodexRequestEntityV4>();
    private readonly relations = new Map<string, CodexRelationEntityV4>();
    private readonly streams = new Map<string, PartStream>();
    private readonly finalizedStreams = new Map<string, true>();
    private readonly migrationBarriers = new Map<string, BufferedNotification[]>();
    private readonly activeTurnByThread = new Map<string, string>();
    private readonly unknownNotificationMethods = new Map<string, number>();
    private readonly unknownStableVariants = new Map<string, number>();
    private readonly threadStatusTransitions = new Map<string, number>();
    private readonly liveGoalObserved = new Set<string>();
    private pipeline: Promise<void> = Promise.resolve();
    private lastError: unknown = null;
    private closed = false;
    private rawReasoningUtf8Bytes = 0;
    private rawReasoningDeltaCount = 0;
    private authoritativeStreamMismatchCount = 0;
    private connection: CodexRuntimeEntityV4['connection'] = 'connected';
    private connectionStatusUnknown = false;
    private connectionError: string | null = null;
    private syncState: CodexRuntimeEntityV4['syncState'];

    constructor(
        private readonly publisher: SyncPublisher,
        private readonly options: MapperOptions,
    ) {
        this.syncState = options.initialSyncState ?? 'ready';
    }

    handleNotification(
        notification: ServerNotification,
        deliveryId: string | null = null,
    ): Promise<void> {
        if (this.closed) return Promise.resolve();
        const threadId = notificationThreadId(notification);
        const barrier = threadId ? this.migrationBarriers.get(threadId) : undefined;
        if (barrier) {
            barrier.push({ notification, deliveryId });
            return Promise.resolve();
        }
        const projection = this.enqueue(() => this.applyNotification(notification, deliveryId));
        void projection.catch(() => undefined);
        return projection;
    }

    importThread(thread: Thread): void {
        if (this.closed) return;
        void this.enqueue(() => this.applyThreadSnapshot(thread)).catch(() => undefined);
    }

    importThreadState(thread: Thread): void {
        if (this.closed) return;
        void this.enqueue(() => this.applyThreadSnapshot(thread, false)).catch(() => undefined);
    }

    importGoal(threadId: string, goal: ThreadGoal | null): void {
        if (this.closed) return;
        void this.enqueue(() => this.applyThreadGoal(threadId, goal, true)).catch(() => undefined);
    }

    async setConnection(
        connection: CodexRuntimeEntityV4['connection'],
        opts?: { statusUnknown?: boolean; error?: string | null },
    ): Promise<void> {
        if (this.closed) return;
        await this.enqueue(async () => {
            const statusUnknown = opts?.statusUnknown ?? connection !== 'connected';
            const connectionError = opts?.error ?? (connection === 'connected' ? null : this.connectionError);
            const now = this.now();
            const updates: CodexRuntimeEntityV4[] = [];
            for (const current of this.runtimes.values()) {
                updates.push({
                    ...current,
                    connection,
                    statusUnknown,
                    lastError: connectionError ?? (connection === 'connected' ? null : current.lastError),
                    lastKnownAt: now,
                    updatedAt: now,
                });
            }
            if (updates.length > 0) {
                await this.publisher.publishEntities(updates.map((entity) => ({ entity })));
                for (const runtime of updates) this.runtimes.set(runtime.threadId, runtime);
            }
            this.connection = connection;
            this.connectionStatusUnknown = statusUnknown;
            this.connectionError = connectionError;
        });
    }

    async setSyncState(syncState: CodexRuntimeEntityV4['syncState']): Promise<void> {
        if (this.closed) return;
        await this.enqueue(async () => {
            const now = this.now();
            const updates = [...this.runtimes.values()]
                .map((current): CodexRuntimeEntityV4 => ({ ...current, syncState, updatedAt: now }));
            if (updates.length > 0) {
                await this.publisher.publishEntities(updates.map((entity) => ({ entity })));
                for (const runtime of updates) this.runtimes.set(runtime.threadId, runtime);
            }
            this.syncState = syncState;
        });
    }

    async prepareMigration(threadId: string): Promise<void> {
        if (this.closed) return;
        this.prepareSnapshotBarrier(threadId);
        await this.enqueue(async () => {
            await this.ensureThread(threadId, this.now());
        });
    }

    prepareSnapshotBarrier(threadId: string): void {
        if (this.closed) return;
        if (!this.migrationBarriers.has(threadId)) this.migrationBarriers.set(threadId, []);
    }

    isMigrationBarrierActive(threadId: string): boolean {
        return this.migrationBarriers.has(threadId);
    }

    async releaseMigrationBarrier(threadId: string): Promise<void> {
        if (this.closed) return;
        const buffered = this.migrationBarriers.get(threadId);
        if (!buffered) return;
        this.migrationBarriers.delete(threadId);
        await this.enqueue(async () => {
            for (const entry of buffered) {
                await this.applyNotification(entry.notification, entry.deliveryId);
            }
        });
    }

    async upsertRequest(
        request: CodexRequestEntityV4,
        state: Extract<
            SyncV4ProviderRequestJournalState,
            'pending' | 'resolved' | 'outcomeUnknown'
        > = request.status === 'pending' ? 'pending' : 'resolved',
    ): Promise<void> {
        await this.enqueue(async () => {
            await this.publisher.publishProviderRequestTransition(
                request,
                state,
                request.response,
            );
            this.requests.set(request.providerId, request);
            await this.publishRuntimeRequestCounts(request.threadId);
        });
    }

    async persistRequestState(
        request: CodexRequestEntityV4,
        state: Extract<
            SyncV4ProviderRequestJournalState,
            'responseReady' | 'responseSupplied'
        >,
        response: CodexRequestEntityV4['response'],
    ): Promise<void> {
        await this.enqueue(async () => {
            await this.publisher.persistProviderRequestTransition(
                request,
                state,
                response,
            );
        });
    }

    async upsertRelation(relation: CodexRelationEntityV4): Promise<void> {
        await this.enqueue(async () => {
            await this.publisher.publishEntity(relation);
            this.relations.set(relation.childThreadId, relation);
            await this.publishRuntimeRelationCount(relation.parentThreadId);
        });
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
        this.streams.clear();
        this.finalizedStreams.clear();
        this.migrationBarriers.clear();
    }

    diagnostics(): CodexSyncV4MapperDiagnostics {
        return {
            rawReasoningUtf8Bytes: this.rawReasoningUtf8Bytes,
            rawReasoningDeltaCount: this.rawReasoningDeltaCount,
            authoritativeStreamMismatchCount: this.authoritativeStreamMismatchCount,
            unknownNotificationMethods: Object.fromEntries(this.unknownNotificationMethods),
            unknownStableVariants: Object.fromEntries(this.unknownStableVariants),
            threadStatusTransitions: Object.fromEntries(this.threadStatusTransitions),
            activeStreamCount: this.streams.size,
            finalizedStreamCount: this.finalizedStreams.size,
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

    private async applyNotification(
        notification: ServerNotification,
        deliveryId: string | null,
    ): Promise<void> {
        switch (notification.method) {
            case 'thread/started':
                await this.applyThreadSnapshot(
                    notification.params.thread,
                    true,
                    deliveryId,
                    'metadata',
                );
                return;
            case 'thread/status/changed':
                await this.applyThreadStatus(notification.params.threadId, notification.params.status);
                return;
            case 'thread/name/updated':
                await this.applyThreadName(notification.params.threadId, notification.params.threadName ?? null);
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
            case 'thread/goal/updated':
                await this.applyThreadGoal(notification.params.threadId, notification.params.goal, false);
                return;
            case 'thread/goal/cleared':
                await this.applyThreadGoal(notification.params.threadId, null, false);
                return;
            case 'turn/started':
                await this.applyTurn(
                    notification.params.threadId,
                    notification.params.turn,
                    'started',
                    true,
                    deliveryId,
                );
                return;
            case 'turn/completed':
                await this.applyTurn(
                    notification.params.threadId,
                    notification.params.turn,
                    'completed',
                    true,
                    deliveryId,
                );
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
                    deliveryId,
                );
                return;
            case 'item/completed':
                await this.applyItem(
                    notification.params.threadId,
                    notification.params.turnId,
                    notification.params.item,
                    'completed',
                    notification.params.completedAtMs,
                    deliveryId,
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
                    await this.applyDiagnostic(
                        notification.params.threadId,
                        null,
                        'warning',
                        { message: notification.params.message },
                        deliveryId,
                    );
                }
                return;
            case 'guardianWarning':
                await this.applyDiagnostic(
                    notification.params.threadId,
                    null,
                    'warning',
                    { message: notification.params.message },
                    deliveryId,
                );
                return;
            case 'error':
                await this.applyDiagnostic(
                    notification.params.threadId,
                    notification.params.turnId,
                    'error',
                    {
                        message: notification.params.error.message,
                        code: codexErrorCode(notification.params.error.codexErrorInfo),
                        details: notification.params.error.additionalDetails,
                        willRetry: notification.params.willRetry,
                    },
                    deliveryId,
                );
                return;
            case 'thread/compacted':
                // Deprecated coverage signal. The contextCompaction item is canonical.
                return;
            case 'serverRequest/resolved':
                // The request broker owns the canonical request lifecycle.
                return;
            case 'model/rerouted':
                await this.applyModelReroute(notification.params.threadId, notification.params.toModel);
                return;
            case 'mcpServer/startupStatus/updated':
                if (notification.params.threadId) await this.applyMcpStartup(notification.params);
                return;
            case 'thread/archived':
            case 'thread/closed':
            case 'thread/deleted':
                await this.applyThreadStatus(notification.params.threadId, { type: 'notLoaded' });
                return;
            case 'thread/unarchived':
            case 'thread/environment/connected':
            case 'thread/environment/disconnected':
            case 'skills/changed':
            case 'hook/started':
            case 'hook/completed':
            case 'item/autoApprovalReview/started':
            case 'item/autoApprovalReview/completed':
            case 'item/commandExecution/terminalInteraction':
            case 'rawResponseItem/completed':
            case 'rawResponse/completed':
            case 'mcpServer/oauthLogin/completed':
            case 'model/verification':
            case 'turn/moderationMetadata':
            case 'model/safetyBuffering/updated':
            case 'thread/realtime/started':
            case 'thread/realtime/itemAdded':
            case 'thread/realtime/transcript/delta':
            case 'thread/realtime/transcript/done':
            case 'thread/realtime/outputAudio/delta':
            case 'thread/realtime/sdp':
            case 'thread/realtime/error':
            case 'thread/realtime/closed':
            case 'account/updated':
            case 'account/rateLimits/updated':
            case 'account/login/completed':
            case 'app/list/updated':
            case 'command/exec/outputDelta':
            case 'process/outputDelta':
            case 'process/exited':
            case 'externalAgentConfig/import/progress':
            case 'externalAgentConfig/import/completed':
            case 'fs/changed':
            case 'fuzzyFileSearch/sessionUpdated':
            case 'fuzzyFileSearch/sessionCompleted':
            case 'remoteControl/status/changed':
            case 'windows/worldWritableWarning':
            case 'windowsSandbox/setupCompleted':
            case 'deprecationNotice':
            case 'configWarning':
                return;
            default:
                const method = (notification as { method: string }).method;
                const count = (this.unknownNotificationMethods.get(method) ?? 0) + 1;
                this.unknownNotificationMethods.set(method, count);
                if (count === 1 || (count & (count - 1)) === 0) {
                    logger.debug('[Codex v4] Unknown notification method', { method, count });
                }
        }
    }

    private async applyThreadSnapshot(
        thread: Thread,
        includeTurns = true,
        diagnosticSeed: string | null = null,
        source: 'snapshot' | 'metadata' = 'snapshot',
    ): Promise<void> {
        const now = this.now();
        const previous = this.threads.get(thread.id);
        const raw = thread as unknown as Record<string, unknown>;
        const reportedStatus = normalizeThreadStatus(thread.status);
        const activeTurnId = this.activeTurnByThread.get(thread.id);
        const liveActiveTurn = source === 'metadata' && activeTurnId
            ? this.turns.get(turnKey(thread.id, activeTurnId))
            : null;
        const hasActiveTurn = thread.turns.some((turn) => turn.status === 'inProgress')
            || (liveActiveTurn?.status === 'inProgress');
        let status: CodexThreadStatusV4 = reportedStatus;
        if (source === 'metadata' && previous) {
            status = previous.status;
            if (hasActiveTurn && status.type !== 'active') {
                status = { type: 'active', activeFlags: [] };
            }
        } else if (
            hasActiveTurn
            && (reportedStatus.type === 'idle' || reportedStatus.type === 'active')
        ) {
            status = reportedStatus.type === 'active'
                ? reportedStatus
                : { type: 'active', activeFlags: [] };
        }
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
            goal: previous?.goal ?? null,
            tokenUsage: previous?.tokenUsage ?? null,
        };
        const runtime = this.runtimeFor(thread.id, status, now);
        await this.publisher.publishEntities([{ entity }, { entity: runtime }]);
        this.recordThreadStatus(thread.id, status, previous?.status);
        this.threads.set(thread.id, entity);
        this.runtimes.set(thread.id, runtime);

        if (includeTurns) {
            for (let turnIndex = 0; turnIndex < thread.turns.length; turnIndex += 1) {
                const turn = thread.turns[turnIndex];
                await this.applyTurn(
                    thread.id,
                    turn,
                    turn.status === 'inProgress' ? 'started' : 'snapshot',
                    false,
                    diagnosticSeed ? `${diagnosticSeed}\0turn\0${turnIndex}` : null,
                );
            }
        }
    }

    private async applyThreadStatus(threadId: string, status: CodexThreadStatusV4): Promise<void> {
        const now = this.now();
        const thread = await this.ensureThread(threadId, now);
        const nextThread = { ...thread, status: normalizeThreadStatus(status), updatedAt: now };
        const runtime = this.runtimeFor(threadId, nextThread.status, now);
        await this.publisher.publishEntities([{ entity: nextThread }, { entity: runtime }]);
        this.recordThreadStatus(threadId, nextThread.status, thread.status);
        this.threads.set(threadId, nextThread);
        this.runtimes.set(threadId, runtime);
        if (nextThread.status.type !== 'active') this.activeTurnByThread.delete(threadId);
    }

    private async applyThreadName(threadId: string, name: string | null): Promise<void> {
        const now = this.now();
        const thread = await this.ensureThread(threadId, now);
        const next = { ...thread, name, updatedAt: now };
        await this.publisher.publishEntity(next);
        this.threads.set(threadId, next);
    }

    private async applyModelReroute(threadId: string, model: string): Promise<void> {
        const now = this.now();
        const thread = await this.ensureThread(threadId, now);
        const next = { ...thread, model, updatedAt: now };
        await this.publisher.publishEntity(next);
        this.threads.set(threadId, next);
    }

    private async applyMcpStartup(
        params: Extract<ServerNotification, { method: 'mcpServer/startupStatus/updated' }>['params'],
    ): Promise<void> {
        if (!params.threadId) return;
        const now = this.now();
        const turnId = this.activeTurnByThread.get(params.threadId) ?? '__runtime_events__';
        await this.ensureTurn(
            params.threadId,
            turnId,
            now,
            turnId === '__runtime_events__' ? 'completed' : 'inProgress',
        );
        const itemId = `__mcp_startup__${params.name}`;
        const current = await this.ensureItem(params.threadId, turnId, itemId, 'mcpStartup', now);
        const terminal = params.status !== 'starting';
        const item: CodexItemEntityV4 = {
            ...current,
            status: params.status === 'ready' ? 'completed' : params.status,
            completedAt: terminal ? now : null,
            server: params.name,
            tool: 'startup',
            arguments: asJsonValue({ failureReason: params.failureReason }),
            updatedAt: now,
        };
        await this.publisher.publishEntity(item);
        this.items.set(item.providerId, item);
        const stream = this.ensureStream({
            threadId: params.threadId,
            turnId,
            itemId,
            kind: 'mcpProgress',
            index: 0,
            contentType: 'json',
        });
        const content = stringifyJson({
            name: params.name,
            status: params.status,
            error: params.error,
            failureReason: params.failureReason,
        });
        if (terminal) {
            await this.setStreamContent(stream, content, false);
            stream.finalized = true;
            await this.flushStream(stream);
        } else {
            await this.setStreamContent(stream, content, true);
        }
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
        await this.publisher.publishEntity(next);
        this.threads.set(threadId, next);
    }

    private async applyThreadGoal(
        threadId: string,
        goal: ThreadGoal | null,
        fromSnapshot: boolean,
    ): Promise<void> {
        if (fromSnapshot && this.liveGoalObserved.has(threadId)) return;
        const now = this.now();
        const thread = await this.ensureThread(threadId, now);
        const next: CodexThreadEntityV4 = {
            ...thread,
            goal: goal ? normalizeThreadGoal(goal, now) : null,
            updatedAt: now,
        };
        await this.publisher.publishEntity(next);
        this.threads.set(threadId, next);
        if (!fromSnapshot) this.liveGoalObserved.add(threadId);
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

        const turn = await this.ensureTurn(threadId, turnId, now);
        const nextTurn = { ...turn, usage: tokenUsage.last, updatedAt: now };
        await this.publisher.publishEntities([{ entity: nextThread }, { entity: nextTurn }]);
        this.threads.set(threadId, nextThread);
        this.turns.set(turnKey(threadId, turnId), nextTurn);
    }

    private async applyTurn(
        threadId: string,
        turn: Turn,
        phase: 'started' | 'completed' | 'snapshot',
        updateThreadStatus = true,
        diagnosticSeed: string | null = null,
    ): Promise<void> {
        const now = this.now();
        await this.ensureThread(threadId, now);
        const key = turnKey(threadId, turn.id);
        const previous = this.turns.get(key);
        const incomingStatus = normalizeTurnStatus(turn.status);
        const status = previous && previous.status !== 'inProgress' && incomingStatus === 'inProgress'
            ? previous.status
            : incomingStatus;
        const startedAt = toNullableEpochMs(turn.startedAt) ?? previous?.startedAt ?? (phase === 'started' ? now : null);
        const completedAt = previous?.completedAt
            ?? toNullableEpochMs(turn.completedAt)
            ?? (status !== 'inProgress' ? now : null);
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
        await this.publisher.publishEntity(entity);
        this.turns.set(key, entity);
        if (status === 'inProgress') this.activeTurnByThread.set(threadId, turn.id);
        else if (this.activeTurnByThread.get(threadId) === turn.id) this.activeTurnByThread.delete(threadId);

        const fallbackTime = startedAt ?? entity.createdAt;
        for (let itemIndex = 0; itemIndex < turn.items.length; itemIndex += 1) {
            const item = turn.items[itemIndex];
            await this.applyItem(
                threadId,
                turn.id,
                item,
                status === 'inProgress' ? 'started' : 'completed',
                status === 'inProgress' ? fallbackTime : completedAt ?? fallbackTime,
                diagnosticSeed ? `${diagnosticSeed}\0item\0${itemIndex}` : null,
            );
        }

        const thread = this.threads.get(threadId);
        if (thread && updateThreadStatus) {
            const threadStatus: CodexThreadStatusV4 = status === 'inProgress'
                ? { type: 'active', activeFlags: [] }
                : this.activeTurnByThread.has(threadId)
                    ? { type: 'active', activeFlags: [] }
                    : thread.status.type === 'systemError' ? thread.status : { type: 'idle' };
            const nextThread = { ...thread, status: threadStatus, updatedAt: now };
            const runtime = this.runtimeFor(threadId, threadStatus, now);
            await this.publisher.publishEntities([{ entity: nextThread }, { entity: runtime }]);
            this.recordThreadStatus(threadId, threadStatus, thread.status);
            this.threads.set(threadId, nextThread);
            this.runtimes.set(threadId, runtime);
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
        await this.publisher.publishEntity(nextTurn);
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
    }

    private async applyTurnDiff(threadId: string, turnId: string, diff: string): Promise<void> {
        const now = this.now();
        const turn = await this.ensureTurn(threadId, turnId, now);
        const nextTurn = { ...turn, diffRevision: turn.diffRevision + 1, updatedAt: now };
        await this.publisher.publishEntity(nextTurn);
        this.turns.set(turnKey(threadId, turnId), nextTurn);
        const itemId = '__turn_diff__';
        await this.ensureItem(threadId, turnId, itemId, 'turnDiff', now);
        const stream = this.ensureStream({ threadId, turnId, itemId, kind: 'patch', index: 0, contentType: 'text' });
        await this.setStreamContent(stream, diff, true);
    }

    private async applyItem(
        threadId: string,
        turnId: string,
        item: ThreadItem,
        phase: 'started' | 'completed',
        eventAt: number,
        diagnosticSeed: string | null = null,
    ): Promise<void> {
        const runtimeItem: unknown = item;
        if (!isKnownThreadItem(runtimeItem)) {
            await this.applyUnknownStableVariant(
                threadId,
                turnId,
                'ThreadItem',
                runtimeVariant(runtimeItem),
                diagnosticSeed,
            );
            return;
        }
        const stableItem = runtimeItem;
        const now = this.now();
        await this.ensureTurn(threadId, turnId, now);
        const key = itemKey(threadId, turnId, stableItem.id);
        const previous = this.items.get(key);
        const at = toEpochMs(eventAt, now);
        const raw = stableItem as unknown as Record<string, unknown>;
        const incomingStatus = stringOrNull(raw.status) ?? (phase === 'completed' ? 'completed' : 'inProgress');
        const wasCompleted = previous?.completedAt !== null && previous?.completedAt !== undefined;
        const completed = phase === 'completed' || wasCompleted;
        const entity: CodexItemEntityV4 = {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.item',
            providerId: key,
            createdAt: previous?.createdAt ?? at,
            updatedAt: now,
            threadId,
            turnId,
            itemId: stableItem.id,
            itemType: stableItem.type,
            status: wasCompleted && phase === 'started' ? previous.status : incomingStatus,
            parentItemId: stringOrNull(raw.parentItemId),
            clientId: stringOrNull(raw.clientId),
            phase: stringOrNull(raw.phase),
            startedAt: previous?.startedAt ?? (phase === 'started' ? at : null),
            completedAt: phase === 'completed' ? at : previous?.completedAt ?? null,
            command: stringOrNull(raw.command),
            cwd: stringOrNull(raw.cwd),
            processId: stringOrNull(raw.processId),
            exitCode: intOrNull(raw.exitCode),
            durationMs: nonnegativeIntOrNull(raw.durationMs),
            server: stringOrNull(raw.server),
            tool: itemTool(stableItem),
            arguments: itemArguments(stableItem),
        };
        await this.publisher.publishEntity(entity);
        this.items.set(key, entity);
        await this.captureItemContent(threadId, turnId, stableItem, diagnosticSeed);
        if (completed) await this.finalizeItemStreams(threadId, turnId, stableItem.id);
    }

    private async captureItemContent(
        threadId: string,
        turnId: string,
        item: ThreadItem,
        diagnosticSeed: string | null,
    ): Promise<void> {
        const base = { threadId, turnId, itemId: item.id };
        switch (item.type) {
            case 'userMessage':
                for (let index = 0; index < item.content.length; index += 1) {
                    const input: unknown = item.content[index];
                    if (!isKnownUserInput(input)) {
                        await this.applyUnknownStableVariant(
                            threadId,
                            turnId,
                            'UserInput',
                            runtimeVariant(input),
                            diagnosticSeed
                                ? `${diagnosticSeed}\0userInput\0${index}`
                                : null,
                        );
                        continue;
                    }
                    const projected = userInputPart(input);
                    await this.setStreamContent(
                        this.ensureStream({
                            ...base,
                            kind: 'userInput',
                            index,
                            contentType: projected.contentType,
                        }),
                        projected.content,
                        true,
                    );
                }
                return;
            case 'hookPrompt':
                if (item.fragments.length > 0) {
                    await this.setStreamContent(
                        this.ensureStream({ ...base, kind: 'userInput', index: 0, contentType: 'json' }),
                        stringifyJson(item.fragments),
                        true,
                    );
                }
                return;
            case 'agentMessage':
                if (item.text) {
                    await this.setStreamContent(
                        this.ensureStream({ ...base, kind: 'text', index: 0, contentType: 'text' }),
                        item.text,
                        true,
                    );
                }
                return;
            case 'plan':
                if (item.text) {
                    await this.setStreamContent(
                        this.ensureStream({ ...base, kind: 'plan', index: 0, contentType: 'text' }),
                        item.text,
                        true,
                    );
                }
                return;
            case 'reasoning':
                for (let index = 0; index < item.summary.length; index += 1) {
                    await this.setStreamContent(
                        this.ensureStream({ ...base, kind: 'reasoningSummary', index, contentType: 'text' }),
                        item.summary[index],
                        true,
                    );
                }
                return;
            case 'commandExecution':
                if (item.aggregatedOutput) {
                    await this.setStreamContent(
                        this.ensureStream({ ...base, kind: 'commandOutput', index: 0, contentType: 'text' }),
                        item.aggregatedOutput,
                        true,
                    );
                }
                return;
            case 'fileChange':
                if (item.changes.length > 0) {
                    await this.setStreamContent(
                        this.ensureStream({ ...base, kind: 'patch', index: 0, contentType: 'json' }),
                        stringifyJson(item.changes),
                        true,
                    );
                }
                return;
            case 'mcpToolCall':
                await this.setStreamContent(
                    this.ensureStream({ ...base, kind: 'mcpProgress', index: 0, contentType: 'json' }),
                    stringifyJson({
                        arguments: item.arguments,
                        appContext: item.appContext,
                        pluginId: item.pluginId,
                    }),
                    true,
                );
                if (item.result || item.error) {
                    await this.setStreamContent(
                        this.ensureStream({ ...base, kind: 'mcpProgress', index: 1, contentType: 'json' }),
                        stringifyJson({ result: item.result, error: item.error }),
                        true,
                    );
                }
                return;
            case 'dynamicToolCall':
                await this.setStreamContent(
                    this.ensureStream({ ...base, kind: 'mcpProgress', index: 0, contentType: 'json' }),
                    stringifyJson({ arguments: item.arguments }),
                    true,
                );
                if (item.contentItems) {
                    await this.setStreamContent(
                        this.ensureStream({ ...base, kind: 'mcpProgress', index: 1, contentType: 'json' }),
                        stringifyJson({ contentItems: item.contentItems, success: item.success }),
                        true,
                    );
                }
                return;
            case 'collabAgentToolCall':
                if (item.prompt) {
                    await this.setStreamContent(
                        this.ensureStream({ ...base, kind: 'text', index: 0, contentType: 'text' }),
                        item.prompt,
                        true,
                    );
                }
                return;
            case 'subAgentActivity':
            case 'webSearch':
            case 'imageView':
            case 'sleep':
            case 'imageGeneration':
                await this.setStreamContent(
                    this.ensureStream({ ...base, kind: 'mcpProgress', index: 0, contentType: 'json' }),
                    stringifyJson(itemContentPayload(item)),
                    true,
                );
                return;
            case 'enteredReviewMode':
            case 'exitedReviewMode':
                if (item.review) {
                    await this.setStreamContent(
                        this.ensureStream({ ...base, kind: 'text', index: 0, contentType: 'text' }),
                        item.review,
                        true,
                    );
                }
                return;
            case 'contextCompaction':
                return;
            default:
                assertNever(item);
        }
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
        content: DiagnosticContent,
        diagnosticSeed: string | null = null,
    ): Promise<void> {
        const now = this.now();
        const turnId = requestedTurnId ?? this.activeTurnByThread.get(threadId) ?? '__runtime_events__';
        const turn = await this.ensureTurn(threadId, turnId, now, requestedTurnId ? 'inProgress' : 'completed');
        const diagnosticId = diagnosticSeed
            ? createHash('sha256').update(diagnosticSeed).digest('hex').slice(0, 32)
            : this.options.diagnosticId?.() ?? randomUUID();
        const itemId = `__${kind}_${diagnosticId}__`;
        const item = await this.ensureItem(threadId, turnId, itemId, kind, now);
        const completed = {
            ...item,
            status: 'completed',
            completedAt: now,
            arguments: asBoundedJsonValue(content),
            updatedAt: now,
        };
        await this.publisher.publishEntity(completed);
        this.items.set(item.providerId, completed);
        const structured = kind === 'error' || content.category === 'unknownStableVariant';
        const stream = this.ensureStream({
            threadId,
            turnId,
            itemId,
            kind,
            index: 0,
            contentType: structured ? 'json' : 'text',
        });
        this.appendStream(stream, structured ? stringifyJson(content) : content.message);
        stream.finalized = true;
        await this.flushStream(stream);
        if (turn.status === 'completed') await this.publisher.publishEntity(turn);
    }

    private async applyUnknownStableVariant(
        threadId: string,
        turnId: string,
        union: 'ThreadItem' | 'UserInput',
        variant: string,
        diagnosticSeed: string | null,
    ): Promise<void> {
        const key = `${union}:${variant}`;
        const count = (this.unknownStableVariants.get(key) ?? 0) + 1;
        this.unknownStableVariants.set(key, count);
        if (count === 1 || (count & (count - 1)) === 0) {
            logger.debug('[Codex v4] Unknown stable variant', { union, variant, count });
        }
        await this.applyDiagnostic(threadId, turnId, 'warning', {
            message: `Unsupported Codex ${union} variant`,
            category: 'unknownStableVariant',
            union,
            variant,
        }, diagnosticSeed ? `${diagnosticSeed}\0${union}\0${variant}` : null);
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
            goal: null,
            tokenUsage: null,
        };
        const runtime = this.runtimeFor(threadId, thread.status, now, false);
        await this.publisher.publishEntities([{ entity: thread }, { entity: runtime }]);
        this.recordThreadStatus(threadId, thread.status);
        this.threads.set(threadId, thread);
        this.runtimes.set(threadId, runtime);
        return thread;
    }

    private recordThreadStatus(
        threadId: string,
        status: CodexThreadStatusV4,
        previous?: CodexThreadStatusV4,
    ): void {
        if (previous && sameThreadStatus(previous, status)) return;
        const count = (this.threadStatusTransitions.get(status.type) ?? 0) + 1;
        this.threadStatusTransitions.set(status.type, count);
        logger.debug('[Codex v4] Thread status', {
            thread: createHash('sha256').update(threadId).digest('hex').slice(0, 16),
            status: status.type,
            activeFlags: status.type === 'active' ? status.activeFlags : [],
            count,
        });
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
        await this.publisher.publishEntity(turn);
        this.turns.set(key, turn);
        if (status === 'inProgress') this.activeTurnByThread.set(threadId, turnId);
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
        await this.publisher.publishEntity(item);
        this.items.set(key, item);
        return item;
    }

    private runtimeFor(
        threadId: string,
        execution: CodexThreadStatusV4,
        now: number,
        authoritative = true,
    ): CodexRuntimeEntityV4 {
        const previous = this.runtimes.get(threadId);
        return {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.runtime',
            providerId: `${threadId}\0runtime`,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
            threadId,
            connection: this.connection,
            execution: normalizeThreadStatus(execution),
            statusUnknown: this.connection !== 'connected' || (!authoritative && this.connectionStatusUnknown),
            protocolVersion: this.options.protocolVersion ?? 'stable-v2',
            codexCliVersion: this.options.codexCliVersion,
            syncState: this.syncState,
            pendingApprovalCount: previous?.pendingApprovalCount ?? 0,
            pendingUserInputCount: previous?.pendingUserInputCount ?? 0,
            activeSubagentCount: previous?.activeSubagentCount ?? 0,
            lastError: execution.type === 'systemError'
                ? previous?.lastError ?? 'systemError'
                : this.connectionError,
            lastKnownAt: now,
        };
    }

    private async publishRuntimeRequestCounts(threadId: string): Promise<void> {
        const now = this.now();
        const thread = await this.ensureThread(threadId, now);
        const current = this.runtimes.get(threadId) ?? this.runtimeFor(threadId, thread.status, now);
        let pendingApprovalCount = 0;
        let pendingUserInputCount = 0;
        for (const request of this.requests.values()) {
            if (request.threadId !== threadId || request.status !== 'pending') continue;
            if (request.requestType === 'toolUserInput') pendingUserInputCount += 1;
            else pendingApprovalCount += 1;
        }
        const runtime: CodexRuntimeEntityV4 = {
            ...current,
            pendingApprovalCount,
            pendingUserInputCount,
            updatedAt: now,
            lastKnownAt: now,
        };
        await this.publisher.publishEntity(runtime);
        this.runtimes.set(threadId, runtime);
    }

    private async publishRuntimeRelationCount(threadId: string): Promise<void> {
        const now = this.now();
        const thread = await this.ensureThread(threadId, now);
        const current = this.runtimes.get(threadId) ?? this.runtimeFor(threadId, thread.status, now);
        let activeSubagentCount = 0;
        for (const relation of this.relations.values()) {
            if (
                relation.parentThreadId === threadId
                && (relation.status === 'starting' || relation.status === 'active')
            ) {
                activeSubagentCount += 1;
            }
        }
        const runtime = { ...current, activeSubagentCount, updatedAt: now, lastKnownAt: now };
        await this.publisher.publishEntity(runtime);
        this.runtimes.set(threadId, runtime);
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
        if (this.finalizedStreams.has(key)) {
            this.finalizedStreams.delete(key);
            this.finalizedStreams.set(key, true);
            return { ...input, key, chunks: [], finalized: true, timer: null };
        }
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
        const publications: Array<{
            chunk: StreamChunk;
            content: string;
            final: boolean;
            entity: CodexPartEntityV4;
        }> = [];
        for (let chunkIndex = 0; chunkIndex < stream.chunks.length; chunkIndex += 1) {
            const chunk = stream.chunks[chunkIndex];
            if (!chunk.content) continue;
            const final = chunk.frozen || stream.finalized;
            if (chunk.publishedContent === chunk.content && chunk.publishedFinal === final) continue;
            const providerId = `${stream.key}\0${chunkIndex}`;
            publications.push({
                chunk,
                content: chunk.content,
                final,
                entity: {
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
                },
            });
        }
        if (publications.length > 0) {
            await this.publisher.publishEntities(publications.map(({ entity }) => ({ entity })));
            for (const publication of publications) {
                publication.chunk.publishedContent = publication.content;
                publication.chunk.publishedFinal = publication.final;
            }
        }
        if (stream.finalized) {
            this.finalizedStreams.delete(stream.key);
            this.finalizedStreams.set(stream.key, true);
            const markerLimit = Math.max(
                0,
                Math.trunc(
                    this.options.finalizedStreamMarkerLimit
                    ?? DEFAULT_FINALIZED_STREAM_MARKER_LIMIT,
                ),
            );
            while (this.finalizedStreams.size > markerLimit) {
                const oldest = this.finalizedStreams.keys().next().value;
                if (typeof oldest !== 'string') break;
                this.finalizedStreams.delete(oldest);
            }
            this.streams.delete(stream.key);
            stream.chunks = [];
        }
    }

    private now(): number {
        return Math.max(0, Math.trunc(this.options.now?.() ?? Date.now()));
    }
}

function notificationThreadId(notification: ServerNotification): string | null {
    const params = notification.params as unknown as Record<string, unknown>;
    if (typeof params.threadId === 'string' && params.threadId.length > 0) return params.threadId;
    const thread = params.thread;
    return thread && typeof thread === 'object' && typeof (thread as { id?: unknown }).id === 'string'
        ? (thread as { id: string }).id
        : null;
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

function sameThreadStatus(left: CodexThreadStatusV4, right: CodexThreadStatusV4): boolean {
    if (left.type !== right.type) return false;
    if (left.type !== 'active' || right.type !== 'active') return true;
    return left.activeFlags.length === right.activeFlags.length
        && left.activeFlags.every((flag, index) => flag === right.activeFlags[index]);
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

function normalizeThreadGoal(goal: ThreadGoal, fallbackTimestamp: number): NonNullable<CodexThreadEntityV4['goal']> {
    return {
        objective: goal.objective,
        status: goal.status,
        tokenBudget: goal.tokenBudget === null ? null : nonnegativeInt(goal.tokenBudget),
        tokensUsed: nonnegativeInt(goal.tokensUsed),
        timeUsedSeconds: nonnegativeInt(goal.timeUsedSeconds),
        createdAt: toEpochMs(goal.createdAt, fallbackTimestamp),
        updatedAt: toEpochMs(goal.updatedAt, fallbackTimestamp),
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
    switch (item.type) {
        case 'mcpToolCall':
        case 'dynamicToolCall':
        case 'collabAgentToolCall':
            return item.tool;
        case 'userMessage':
        case 'hookPrompt':
        case 'agentMessage':
        case 'plan':
        case 'reasoning':
        case 'commandExecution':
        case 'fileChange':
        case 'subAgentActivity':
        case 'webSearch':
        case 'imageView':
        case 'sleep':
        case 'imageGeneration':
        case 'enteredReviewMode':
        case 'exitedReviewMode':
        case 'contextCompaction':
            return null;
        default:
            return assertNever(item);
    }
}

function itemArguments(item: ThreadItem): JsonValue {
    switch (item.type) {
        case 'userMessage':
            return asBoundedJsonValue({
                content: item.content.map((input) => (
                    isKnownUserInput(input)
                        ? userInputMetadata(input)
                        : { type: runtimeVariant(input) }
                )),
            });
        case 'hookPrompt':
            return asBoundedJsonValue({
                fragmentCount: item.fragments.length,
                hookRunIds: item.fragments.map((fragment) => fragment.hookRunId),
            });
        case 'agentMessage':
            return asBoundedJsonValue({ memoryCitation: item.memoryCitation });
        case 'plan':
            return null;
        case 'reasoning':
            return asBoundedJsonValue({
                summaryPartCount: item.summary.length,
            });
        case 'commandExecution':
            return asBoundedJsonValue({
                source: item.source,
                status: item.status,
                commandActions: item.commandActions,
            });
        case 'fileChange':
            return asBoundedJsonValue({
                status: item.status,
                changeCount: item.changes.length,
            });
        case 'mcpToolCall':
            return asBoundedJsonValue({
                status: item.status,
                appContext: item.appContext,
                pluginId: item.pluginId,
                durationMs: item.durationMs,
            });
        case 'dynamicToolCall':
            return asBoundedJsonValue({
                namespace: item.namespace,
                status: item.status,
                success: item.success,
                durationMs: item.durationMs,
            });
        case 'collabAgentToolCall':
            return asBoundedJsonValue({
                senderThreadId: item.senderThreadId,
                receiverThreadIds: item.receiverThreadIds,
                model: item.model,
                reasoningEffort: item.reasoningEffort,
                agentsStates: item.agentsStates,
            });
        case 'subAgentActivity':
            return asBoundedJsonValue({
                kind: item.kind,
                agentThreadId: item.agentThreadId,
                agentPath: item.agentPath,
            });
        case 'webSearch':
            return asBoundedJsonValue({
                query: item.query,
                action: item.action,
                resultCount: item.results?.length ?? 0,
            });
        case 'imageView':
            return asBoundedJsonValue({ path: item.path });
        case 'sleep':
            return asBoundedJsonValue({ durationMs: item.durationMs });
        case 'imageGeneration':
            return asBoundedJsonValue({
                status: item.status,
                revisedPrompt: item.revisedPrompt,
                resultUtf8Bytes: utf8ByteLength(item.result),
                savedPath: item.savedPath ?? null,
            });
        case 'enteredReviewMode':
        case 'exitedReviewMode':
        case 'contextCompaction':
            return null;
        default:
            return assertNever(item);
    }
}

function itemContentPayload(
    item: Extract<
        ThreadItem,
        | { type: 'subAgentActivity' }
        | { type: 'webSearch' }
        | { type: 'imageView' }
        | { type: 'sleep' }
        | { type: 'imageGeneration' }
    >,
): JsonValue {
    switch (item.type) {
        case 'subAgentActivity':
            return asJsonValue({
                kind: item.kind,
                agentThreadId: item.agentThreadId,
                agentPath: item.agentPath,
            });
        case 'webSearch':
            return asJsonValue({
                query: item.query,
                action: item.action,
                results: item.results,
            });
        case 'imageView':
            return asJsonValue({ path: item.path });
        case 'sleep':
            return asJsonValue({ durationMs: item.durationMs });
        case 'imageGeneration':
            return asJsonValue({
                status: item.status,
                revisedPrompt: item.revisedPrompt,
                result: item.result,
                savedPath: item.savedPath ?? null,
            });
        default:
            return assertNever(item);
    }
}

function userInputPart(input: UserInput): {
    content: string;
    contentType: CodexPartEntityV4['contentType'];
} {
    switch (input.type) {
        case 'text':
            return { content: input.text, contentType: 'text' };
        case 'image':
        case 'localImage':
        case 'audio':
        case 'localAudio':
        case 'skill':
        case 'mention':
            return { content: stringifyJson(input), contentType: 'json' };
        default:
            return assertNever(input);
    }
}

function userInputMetadata(input: UserInput): JsonValue {
    switch (input.type) {
        case 'text':
            return asJsonValue({ type: input.type, textElements: input.text_elements });
        case 'image':
        case 'localImage':
            return asJsonValue({ type: input.type, detail: input.detail ?? null });
        case 'audio':
        case 'localAudio':
            return asJsonValue({ type: input.type });
        case 'skill':
        case 'mention':
            return asJsonValue({ type: input.type, name: input.name });
        default:
            return assertNever(input);
    }
}

const KNOWN_THREAD_ITEM_TYPES = new Set([
    'userMessage',
    'hookPrompt',
    'agentMessage',
    'plan',
    'reasoning',
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'dynamicToolCall',
    'collabAgentToolCall',
    'subAgentActivity',
    'webSearch',
    'imageView',
    'sleep',
    'imageGeneration',
    'enteredReviewMode',
    'exitedReviewMode',
    'contextCompaction',
]);

const KNOWN_USER_INPUT_TYPES = new Set([
    'text',
    'image',
    'localImage',
    'audio',
    'localAudio',
    'skill',
    'mention',
]);

function isKnownThreadItem(value: unknown): value is ThreadItem {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.id === 'string'
        && typeof record.type === 'string'
        && KNOWN_THREAD_ITEM_TYPES.has(record.type);
}

function isKnownUserInput(value: unknown): value is UserInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const type = (value as Record<string, unknown>).type;
    return typeof type === 'string' && KNOWN_USER_INPUT_TYPES.has(type);
}

function runtimeVariant(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '<invalid>';
    const type = (value as Record<string, unknown>).type;
    return typeof type === 'string' && type.length > 0
        ? type.slice(0, 128)
        : '<missing>';
}

function asBoundedJsonValue(value: unknown): JsonValue {
    const normalized = asJsonValue(value);
    const encoded = JSON.stringify(normalized);
    const bytes = utf8ByteLength(encoded);
    if (bytes <= MAX_INLINE_ITEM_ARGUMENT_BYTES) return normalized;
    return {
        truncated: true,
        utf8Bytes: bytes,
        sha256: createHash('sha256').update(encoded).digest('hex'),
    };
}

function assertNever(value: never): never {
    throw new Error(`Unhandled Codex stable-v2 variant: ${runtimeVariant(value)}`);
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
    if (typeof value === 'string' && value.length > 0) return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return stringOrNull(record.type)
        ?? stringOrNull(record.code)
        ?? Object.keys(record)[0]
        ?? null;
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
