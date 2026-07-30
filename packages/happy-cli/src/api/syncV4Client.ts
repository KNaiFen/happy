/**
 * Codex Sync v4 transport coordinator.
 *
 * Send acknowledgements and receive cursors are deliberately independent.
 * Every network-visible operation is backed by SyncV4Journal first.
 */

import {
    CodexCommandResultEntityV4Schema,
    CodexEntityV4Schema,
    CodexRequestEntityV4Schema,
    MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH,
    MAX_SYNC_V4_MUTATIONS_PER_BATCH,
    MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE,
    SyncChangesResponseV4Schema,
    SyncMutationBatchResponseV4Schema,
    SyncMutationBatchV4Schema,
    SyncMutationV4Schema,
    SyncSnapshotRequiredV4Schema,
    SyncSnapshotResponseV4Schema,
    classifySyncV4DiagnosticError,
    recordSyncV4DiagnosticSafely,
    requireSyncV4TraceEcho,
    requireSyncV4TraceId,
    syncV4Utf8ByteLength,
    type CodexEntityV4,
    type CodexCommandEntityV4,
    type CodexCommandResultEntityV4,
    type CodexRequestEntityV4,
    type SyncAckV4,
    type SyncChangeV4,
    type SyncEntitySnapshotV4,
    type SyncMutationBatchResponseV4,
    type SyncMutationOperationV4,
    type SyncMutationV4,
    type SyncSnapshotResponseV4,
    type SyncV4DiagnosticInput,
    type SyncV4DiagnosticSink,
    type SyncV4DiagnosticTransportSecurity,
} from "@slopus/happy-wire";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import { AsyncLock } from "@/utils/lock";
import { InvalidateSync } from "@/utils/sync";
import axios from "axios";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SyncV4Crypto } from "./syncV4Crypto";
import { createSyncV4TraceId, syncV4DiagnosticHash } from "./syncV4Diagnostics";
import {
    SyncV4Journal,
    type SyncV4CodexNotification,
    type SyncV4CodexThreadRoute,
    type SyncV4CommandJournalStatus,
    type SyncV4MigrationJournalState,
    type SyncV4PendingCodexNotification,
    type SyncV4PendingProviderRequest,
    type SyncV4ProviderRequestJournalState,
} from "./syncV4Journal";

const CHANGES_PAGE_SIZE = 100;
const SNAPSHOT_PAGE_SIZE = MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const BACKGROUND_OUTBOUND_BATCH_BUDGET = 16;
const COMPACTION_CHECK_BATCH_INTERVAL = 16;

export interface SyncV4Transport {
    postMutations(
        sessionId: string,
        mutations: SyncMutationV4[],
        traceId?: string,
    ): Promise<SyncMutationBatchResponseV4>;
    getChanges(
        sessionId: string,
        afterSeq: number,
        limit: number,
        traceId?: string,
    ): Promise<ReturnType<typeof SyncChangesResponseV4Schema.parse>>;
    getSnapshot(
        sessionId: string,
        cursor: string | null,
        limit: number,
        traceId?: string,
    ): Promise<SyncSnapshotResponseV4>;
}

export class SyncV4SnapshotRequiredError extends Error {
    constructor(
        readonly minimumSeq: number,
        readonly highWatermark: number,
    ) {
        super("Sync v4 snapshot required");
    }
}

class SyncV4ProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SyncV4ProtocolError";
    }
}

function diagnosticErrorKind(
    error: unknown,
    fallback: ReturnType<typeof classifySyncV4DiagnosticError>,
): ReturnType<typeof classifySyncV4DiagnosticError> {
    const classified = classifySyncV4DiagnosticError(error);
    return classified === "unknown" ? fallback : classified;
}

export class AxiosSyncV4Transport implements SyncV4Transport {
    constructor(
        private readonly serverUrl: string,
        private readonly token: string,
        private readonly happyClient: string,
        private readonly machineId?: string,
    ) {}

    async postMutations(
        sessionId: string,
        mutations: SyncMutationV4[],
        traceId?: string,
    ): Promise<SyncMutationBatchResponseV4> {
        const body = SyncMutationBatchV4Schema.parse({ mutations });
        const response = await axios.post(
            `${this.serverUrl}/v4/sessions/${encodeURIComponent(sessionId)}/mutations`,
            body,
            { headers: this.headers(traceId), timeout: 60_000 },
        );
        validateAxiosTraceEcho(response, traceId);
        return SyncMutationBatchResponseV4Schema.parse(response.data);
    }

    async getChanges(
        sessionId: string,
        afterSeq: number,
        limit: number,
        traceId?: string,
    ): Promise<ReturnType<typeof SyncChangesResponseV4Schema.parse>> {
        try {
            const response = await axios.get(
                `${this.serverUrl}/v4/sessions/${encodeURIComponent(sessionId)}/changes`,
                {
                    params: { after_seq: afterSeq, limit },
                    headers: this.headers(traceId),
                    timeout: 60_000,
                },
            );
            validateAxiosTraceEcho(response, traceId);
            return SyncChangesResponseV4Schema.parse(response.data);
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 410) {
                validateAxiosTraceEcho(error.response, traceId);
                const required = SyncSnapshotRequiredV4Schema.parse(error.response.data);
                throw new SyncV4SnapshotRequiredError(required.minimumSeq, required.highWatermark);
            }
            throw error;
        }
    }

    async getSnapshot(
        sessionId: string,
        cursor: string | null,
        limit: number,
        traceId?: string,
    ): Promise<SyncSnapshotResponseV4> {
        const response = await axios.get(
            `${this.serverUrl}/v4/sessions/${encodeURIComponent(sessionId)}/snapshot`,
            {
                params: { ...(cursor ? { cursor } : {}), limit },
                headers: this.headers(traceId),
                timeout: 60_000,
            },
        );
        validateAxiosTraceEcho(response, traceId);
        return SyncSnapshotResponseV4Schema.parse(response.data);
    }

    private headers(traceId?: string): Record<string, string> {
        return {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "X-Happy-Client": this.happyClient,
            ...(this.machineId ? { "X-Happy-Machine-Id": this.machineId } : {}),
            ...(traceId ? { "X-Happy-Sync-Trace": requireSyncV4TraceId(traceId) } : {}),
        };
    }
}

export interface SyncV4AppliedEntity {
    entity: CodexEntityV4;
    source: "change" | "snapshot";
    op: SyncMutationOperationV4;
    revision: number;
    seq: number | null;
}

export interface SyncV4PublishEntity {
    entity: CodexEntityV4;
    op?: SyncMutationOperationV4;
}

interface SyncV4ClientOptions {
    sessionId: string;
    sessionKey: Uint8Array;
    onEntity: (event: SyncV4AppliedEntity) => Promise<void>;
    transport?: SyncV4Transport;
    token?: string;
    machineId?: string;
    serverUrl?: string;
    journalRoot?: string;
    pollIntervalMs?: number;
    diagnostics?: SyncV4DiagnosticSink;
    generateTraceId?: () => string;
    transportSecurity?: SyncV4DiagnosticTransportSecurity;
}

export class SyncV4Client {
    static async create(options: SyncV4ClientOptions): Promise<SyncV4Client> {
        const journal = await SyncV4Journal.open({
            rootDir: options.journalRoot ?? join(configuration.happyHomeDir, "sync-v4"),
            sessionId: options.sessionId,
        });
        try {
            const crypto = await SyncV4Crypto.create({ sessionId: options.sessionId, sessionKey: options.sessionKey });
            const diagnosticSessionId = (
                await crypto.opaqueEntityId("codex.runtime", "__happy_sync_v4_diagnostic_session__")
            ).slice(0, 16);
            const serverUrl = options.serverUrl ?? configuration.serverUrl;
            const transport = options.transport ?? new AxiosSyncV4Transport(
                serverUrl,
                requiredToken(options.token),
                `cli-coding-session/${configuration.currentCliVersion}`,
                options.machineId,
            );
            return new SyncV4Client(
                options.sessionId,
                journal,
                crypto,
                transport,
                options.onEntity,
                options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
                options.diagnostics ?? null,
                diagnosticSessionId,
                options.generateTraceId ?? createSyncV4TraceId,
                options.transportSecurity ?? syncV4TransportSecurity(serverUrl),
            );
        } catch (error) {
            await journal.close();
            throw error;
        }
    }

    private readonly publishLock = new AsyncLock();
    private readonly sendLock = new AsyncLock();
    private readonly receiveLock = new AsyncLock();
    private readonly sendSync: InvalidateSync;
    private readonly receiveSync: InvalidateSync;
    private pollTimer: NodeJS.Timeout | null = null;
    private started = false;
    private disposed = false;
    private lifecycleGeneration = 0;
    private journalClosePromise: Promise<void> | null = null;

    private constructor(
        readonly sessionId: string,
        private readonly journal: SyncV4Journal,
        private readonly crypto: SyncV4Crypto,
        private readonly transport: SyncV4Transport,
        private readonly onEntity: (event: SyncV4AppliedEntity) => Promise<void>,
        private readonly pollIntervalMs: number,
        private readonly diagnostics: SyncV4DiagnosticSink | null,
        private readonly diagnosticSessionId: string,
        private readonly generateTraceId: () => string,
        private readonly transportSecurity: SyncV4DiagnosticTransportSecurity,
    ) {
        this.sendSync = new InvalidateSync(() => this.flushOutboundForGeneration(
            this.lifecycleGeneration,
            BACKGROUND_OUTBOUND_BATCH_BUDGET,
        ));
        this.receiveSync = new InvalidateSync(() => this.pullChangesForGeneration(this.lifecycleGeneration));
    }

    get producerId(): string {
        return this.journal.producerId;
    }

    get receiveCursor(): number {
        return this.journal.snapshot().receiveCursor;
    }

    get diagnosticSessionHash(): string {
        return this.diagnosticSessionId;
    }

    async start(): Promise<void> {
        if (this.started) return;
        if (this.disposed) throw new Error("Sync v4 client has been stopped");
        const generation = this.lifecycleGeneration;
        this.started = true;
        this.recordDiagnostic({
            level: "info",
            event: "lifecycle",
            phase: "started",
            state: "starting",
            generation,
            cursor: this.receiveCursor,
            featureEnabled: true,
        });
        this.logJournalDiagnostics("start");
        try {
            await this.processPendingInbound(generation);
            await Promise.all([
                this.flushOutboundForGeneration(generation, BACKGROUND_OUTBOUND_BATCH_BUDGET),
                this.pullChangesForGeneration(generation),
            ]);
            this.assertCurrentGeneration(generation);
        } catch (error) {
            if (this.isCurrentGeneration(generation)) {
                this.started = false;
                this.lifecycleGeneration += 1;
            }
            this.recordDiagnostic({
                level: "error",
                event: "lifecycle",
                phase: "failed",
                state: "failed",
                generation,
                errorKind: classifySyncV4DiagnosticError(error),
            });
            throw error;
        }
        this.pollTimer = setInterval(() => this.receiveSync.invalidate(), this.pollIntervalMs);
        this.pollTimer.unref();
        this.recordDiagnostic({
            level: "info",
            event: "lifecycle",
            phase: "completed",
            state: "ready",
            generation,
            cursor: this.receiveCursor,
        });
    }

    stop(): void {
        if (this.disposed) return;
        const journalDiagnostics = this.journal.diagnostics();
        this.logJournalDiagnostics("stop");
        this.recordDiagnostic({
            level: "info",
            event: "lifecycle",
            phase: "started",
            state: "stopping",
            generation: this.lifecycleGeneration,
            cursor: this.receiveCursor,
            pending: journalDiagnostics.pendingOutboundDepth
                + journalDiagnostics.pendingInboundDepth,
            featureEnabled: true,
        });
        this.disposed = true;
        this.started = false;
        this.lifecycleGeneration += 1;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.sendSync.stop();
        this.receiveSync.stop();
        this.journalClosePromise = this.journal.close();
        this.recordDiagnostic({
            level: "info",
            event: "lifecycle",
            phase: "completed",
            state: "stopped",
            generation: this.lifecycleGeneration,
            cursor: this.receiveCursor,
            pending: journalDiagnostics.pendingOutboundDepth
                + journalDiagnostics.pendingInboundDepth,
            featureEnabled: true,
        });
    }

    async close(): Promise<void> {
        this.stop();
        await this.journalClosePromise;
    }

    invalidate(highWatermark?: number): void {
        if (!this.started) return;
        if (highWatermark === undefined || highWatermark > this.receiveCursor) this.receiveSync.invalidate();
    }

    async publishEntity(
        entity: CodexEntityV4,
        op: SyncMutationOperationV4 = "upsert",
    ): Promise<SyncMutationV4> {
        return (await this.publishEntities([{ entity, op }]))[0];
    }

    async publishEntities(entries: SyncV4PublishEntity[]): Promise<SyncMutationV4[]> {
        if (entries.length === 0) return [];
        const canonicalEntries = entries.map((entry) => ({
            ...entry,
            entity: CodexEntityV4Schema.parse(entry.entity),
        }));
        const generation = this.lifecycleGeneration;
        this.assertCurrentGeneration(generation);
        const mutations = await this.publishLock.inLock(async () => {
            this.assertCurrentGeneration(generation);
            const pendingRevisions = new Map<string, number>();
            const nextMutations: SyncMutationV4[] = [];
            for (const entry of canonicalEntries) {
                const entityId = await this.crypto.opaqueEntityId(entry.entity.entityType, entry.entity.providerId);
                this.assertCurrentGeneration(generation);
                const revision = (pendingRevisions.get(entityId) ?? this.journal.nextRevision(entityId) - 1) + 1;
                pendingRevisions.set(entityId, revision);
                const op = entry.op ?? "upsert";
                const aad = {
                    sessionId: this.sessionId,
                    entityId,
                    entityType: entry.entity.entityType,
                    revision,
                    op,
                };
                nextMutations.push(SyncMutationV4Schema.parse({
                    mutationId: randomUUID(),
                    producerId: this.producerId,
                    entityId,
                    entityType: entry.entity.entityType,
                    revision,
                    op,
                    ciphertext: await this.crypto.encryptEntity(aad, entry.entity),
                }));
                this.assertCurrentGeneration(generation);
            }
            await this.journal.appendOutbound(nextMutations);
            this.recordDiagnostic({
                level: "debug",
                event: "outbox",
                phase: "enqueued",
                direction: "outbound",
                count: nextMutations.length,
                depth: this.journal.snapshot().pendingOutbound.length,
                bytes: nextMutations.reduce(
                    (total, mutation) => total + syncV4Utf8ByteLength(mutation.ciphertext),
                    0,
                ),
            });
            return nextMutations;
        });
        if (this.started) this.sendSync.invalidate();
        return mutations;
    }

    async publishCommandTransition(
        command: CodexCommandEntityV4,
        result: CodexCommandResultEntityV4,
        status: SyncV4CommandJournalStatus,
    ): Promise<SyncMutationV4> {
        const canonicalResult = CodexCommandResultEntityV4Schema.parse(result);
        const generation = this.lifecycleGeneration;
        this.assertCurrentGeneration(generation);
        const mutation = await this.publishLock.inLock(async () => {
            this.assertCurrentGeneration(generation);
            const entityId = await this.crypto.opaqueEntityId(
                canonicalResult.entityType,
                canonicalResult.providerId,
            );
            this.assertCurrentGeneration(generation);
            const revision = this.journal.nextRevision(entityId);
            const aad = {
                sessionId: this.sessionId,
                entityId,
                entityType: canonicalResult.entityType,
                revision,
                op: "upsert" as const,
            };
            const next = SyncMutationV4Schema.parse({
                mutationId: randomUUID(),
                producerId: this.producerId,
                entityId,
                entityType: canonicalResult.entityType,
                revision,
                op: aad.op,
                ciphertext: await this.crypto.encryptEntity(aad, canonicalResult),
            });
            this.assertCurrentGeneration(generation);
            await this.journal.appendCommandTransition(command.commandId, status, next, command);
            this.recordDiagnostic({
                level: status === "failed" || status === "resultUnknown" || status === "notReplayed"
                    ? "warn"
                    : "debug",
                event: "request",
                phase: "changed",
                source: "command",
                commandHash: syncV4DiagnosticHash(command.commandId),
                state: status,
                revision,
            });
            return next;
        });
        if (this.started) this.sendSync.invalidate();
        return mutation;
    }

    async publishProviderRequestTransition(
        request: CodexRequestEntityV4,
        state: SyncV4ProviderRequestJournalState = request.status === "pending"
            ? "pending"
            : "resolved",
        response: CodexRequestEntityV4["response"] = request.response,
    ): Promise<SyncMutationV4> {
        const canonicalRequest = CodexRequestEntityV4Schema.parse(request);
        const generation = this.lifecycleGeneration;
        this.assertCurrentGeneration(generation);
        const mutation = await this.publishLock.inLock(async () => {
            this.assertCurrentGeneration(generation);
            const entityId = await this.crypto.opaqueEntityId(
                canonicalRequest.entityType,
                canonicalRequest.providerId,
            );
            this.assertCurrentGeneration(generation);
            const revision = this.journal.nextRevision(entityId);
            const aad = {
                sessionId: this.sessionId,
                entityId,
                entityType: canonicalRequest.entityType,
                revision,
                op: "upsert" as const,
            };
            const next = SyncMutationV4Schema.parse({
                mutationId: randomUUID(),
                producerId: this.producerId,
                entityId,
                entityType: canonicalRequest.entityType,
                revision,
                op: aad.op,
                ciphertext: await this.crypto.encryptEntity(aad, canonicalRequest),
            });
            this.assertCurrentGeneration(generation);
            await this.journal.appendProviderRequestTransition(
                canonicalRequest,
                state,
                next,
                response,
            );
            this.recordDiagnostic({
                level: state === "outcomeUnknown" ? "warn" : "debug",
                event: "request",
                phase: "changed",
                source: "notification",
                requestHash: syncV4DiagnosticHash(canonicalRequest.requestId),
                state,
                revision,
            });
            return next;
        });
        if (this.started) this.sendSync.invalidate();
        return mutation;
    }

    async persistProviderRequestTransition(
        request: CodexRequestEntityV4,
        state: Extract<
            SyncV4ProviderRequestJournalState,
            "responseReady" | "responseSupplied"
        >,
        response: CodexRequestEntityV4["response"],
    ): Promise<void> {
        const generation = this.lifecycleGeneration;
        this.assertCurrentGeneration(generation);
        await this.publishLock.inLock(async () => {
            this.assertCurrentGeneration(generation);
            await this.journal.appendProviderRequestTransition(
                request,
                state,
                undefined,
                response,
            );
            this.recordDiagnostic({
                level: "debug",
                event: "request",
                phase: "changed",
                source: "notification",
                requestHash: syncV4DiagnosticHash(request.requestId),
                state,
            });
        });
    }

    async flushOutboundOnce(): Promise<void> {
        const targetMutationIds = new Set(
            this.journal.snapshot().pendingOutbound.map((mutation) => mutation.mutationId),
        );
        await this.flushOutboundForGeneration(this.lifecycleGeneration, null, targetMutationIds);
    }

    private async flushOutboundForGeneration(
        generation: number,
        batchBudget: number | null,
        targetMutationIds?: ReadonlySet<string>,
    ): Promise<void> {
        await this.sendLock.inLock(async () => {
            const targets = targetMutationIds ?? new Set(
                this.journal.snapshot().pendingOutbound.map((mutation) => mutation.mutationId),
            );
            let processedBatches = 0;
            while (true) {
                if (!this.isCurrentGeneration(generation)) return;
                const pending = this.journal.snapshot().pendingOutbound
                    .filter((mutation) => targets.has(mutation.mutationId));
                if (pending.length === 0) break;
                if (batchBudget !== null && processedBatches >= batchBudget) break;
                const batch = takeMutationBatch(pending);
                const traceId = this.nextTraceId();
                const startedAt = Date.now();
                this.recordDiagnostic({
                    level: "debug",
                    event: "transport",
                    phase: "started",
                    direction: "outbound",
                    transportOperation: "mutations",
                    traceId,
                    count: batch.length,
                    bytes: batch.reduce(
                        (total, mutation) => total + syncV4Utf8ByteLength(mutation.ciphertext),
                        0,
                    ),
                    depth: pending.length,
                });
                let response: SyncMutationBatchResponseV4;
                try {
                    response = await this.transport.postMutations(this.sessionId, batch, traceId);
                } catch (error) {
                    this.recordDiagnostic({
                        level: "warn",
                        event: "transport",
                        phase: "failed",
                        direction: "outbound",
                        transportOperation: "mutations",
                        traceId,
                        count: batch.length,
                        durationMs: elapsedMs(startedAt),
                        errorKind: classifySyncV4DiagnosticError(error),
                    });
                    throw error;
                }
                if (!this.isCurrentGeneration(generation)) return;
                try {
                    validateAcknowledgements(batch, response.acknowledgements);
                } catch (error) {
                    this.recordDiagnostic({
                        level: "error",
                        event: "ack",
                        phase: "failed",
                        direction: "inbound",
                        transportOperation: "mutations",
                        traceId,
                        count: response.acknowledgements.length,
                        durationMs: elapsedMs(startedAt),
                        errorKind: "protocol",
                    });
                    throw error;
                }
                try {
                    await this.journal.appendAcknowledgements(response.acknowledgements);
                } catch (error) {
                    this.recordDiagnostic({
                        level: "error",
                        event: "journal",
                        phase: "failed",
                        direction: "inbound",
                        traceId,
                        count: response.acknowledgements.length,
                        errorKind: "storage",
                    });
                    throw error;
                }
                processedBatches += 1;
                const accepted = response.acknowledgements.filter((ack) => ack.status === "accepted").length;
                const duplicate = response.acknowledgements.filter((ack) => ack.status === "duplicate").length;
                const superseded = response.acknowledgements.filter((ack) => ack.status === "superseded").length;
                this.recordDiagnostic({
                    level: "debug",
                    event: "transport",
                    phase: "completed",
                    direction: "outbound",
                    transportOperation: "mutations",
                    traceId,
                    count: response.acknowledgements.length,
                    accepted,
                    duplicate,
                    superseded,
                    durationMs: elapsedMs(startedAt),
                    depth: this.journal.snapshot().pendingOutbound.length,
                });
                this.logJournalDiagnostics("ack", {
                    accepted,
                    duplicate,
                    superseded,
                });
                if (processedBatches % COMPACTION_CHECK_BATCH_INTERVAL === 0) {
                    await this.journal.compactIfNeeded();
                    await yieldToEventLoop();
                }
            }
            if (!this.isCurrentGeneration(generation)) return;
            await this.journal.compactIfNeeded();
            if (this.started && this.journal.snapshot().pendingOutbound.length > 0) {
                this.sendSync.invalidate();
            }
        });
    }

    async pullChangesOnce(): Promise<void> {
        await this.pullChangesForGeneration(this.lifecycleGeneration);
    }

    private async pullChangesForGeneration(generation: number): Promise<void> {
        await this.receiveLock.inLock(async () => {
            if (!this.isCurrentGeneration(generation)) return;
            await this.processPendingInbound(generation);
            let targetWatermark: number | null = null;
            let latestObservedWatermark = this.receiveCursor;
            let processedPages = 0;
            while (true) {
                if (!this.isCurrentGeneration(generation)) return;
                const cursor = this.receiveCursor;
                if (targetWatermark !== null && cursor >= targetWatermark) break;
                let response: ReturnType<typeof SyncChangesResponseV4Schema.parse>;
                const traceId = this.nextTraceId();
                const startedAt = Date.now();
                this.recordDiagnostic({
                    level: "debug",
                    event: "transport",
                    phase: "started",
                    direction: "inbound",
                    transportOperation: "changes",
                    traceId,
                    cursor,
                });
                try {
                    response = await this.transport.getChanges(
                        this.sessionId,
                        cursor,
                        CHANGES_PAGE_SIZE,
                        traceId,
                    );
                } catch (error) {
                    if (!this.isCurrentGeneration(generation)) return;
                    if (error instanceof SyncV4SnapshotRequiredError) {
                        this.recordDiagnostic({
                            level: "warn",
                            event: "snapshot",
                            phase: "required",
                            direction: "inbound",
                            transportOperation: "changes",
                            traceId,
                            cursor,
                            highWatermark: error.highWatermark,
                            seq: error.minimumSeq,
                            durationMs: elapsedMs(startedAt),
                        });
                        logger.debug("[Sync v4] Snapshot fallback", {
                            session: this.diagnosticSessionId,
                            minimumSeq: error.minimumSeq,
                            highWatermark: error.highWatermark,
                        });
                        await this.rebuildFromSnapshot(generation);
                        continue;
                    }
                    this.recordDiagnostic({
                        level: "warn",
                        event: "transport",
                        phase: "failed",
                        direction: "inbound",
                        transportOperation: "changes",
                        traceId,
                        cursor,
                        durationMs: elapsedMs(startedAt),
                        errorKind: classifySyncV4DiagnosticError(error),
                    });
                    throw error;
                }
                if (!this.isCurrentGeneration(generation)) return;
                const drainWatermark: number = targetWatermark ?? response.highWatermark;
                let changesInDrain: typeof response.changes;
                try {
                    if (response.highWatermark < cursor) {
                        throw new Error("Sync v4 server watermark moved backwards");
                    }
                    if (targetWatermark !== null && response.highWatermark < targetWatermark) {
                        throw new Error("Sync v4 server watermark moved backwards during a drain");
                    }
                    if (response.changes.length === 0) {
                        if (response.hasMore || cursor < drainWatermark) {
                            throw new Error("Sync v4 changes response has a sequence gap");
                        }
                        changesInDrain = [];
                    } else {
                        assertContiguousChanges(response.changes, cursor);
                        if (response.changes.at(-1)!.seq > response.highWatermark) {
                            throw new Error("Sync v4 changes exceed the response watermark");
                        }
                        changesInDrain = response.changes.filter(
                            (change) => change.seq <= drainWatermark,
                        );
                    }
                } catch (error) {
                    this.recordDiagnostic({
                        level: "error",
                        event: "changes",
                        phase: "failed",
                        direction: "inbound",
                        transportOperation: "changes",
                        traceId,
                        cursor,
                        highWatermark: response.highWatermark,
                        count: response.changes.length,
                        durationMs: elapsedMs(startedAt),
                        errorKind: "protocol",
                    });
                    throw error;
                }
                targetWatermark = drainWatermark;
                latestObservedWatermark = Math.max(latestObservedWatermark, response.highWatermark);
                this.recordDiagnostic({
                    level: "debug",
                    event: "transport",
                    phase: "completed",
                    direction: "inbound",
                    transportOperation: "changes",
                    traceId,
                    cursor,
                    highWatermark: response.highWatermark,
                    count: response.changes.length,
                    durationMs: elapsedMs(startedAt),
                });
                const projectionLag = drainWatermark - cursor;
                if (projectionLag > 0 || response.changes.length > 0) {
                    logger.debug("[Sync v4] Projection lag", {
                        session: this.diagnosticSessionId,
                        mutations: projectionLag,
                        pageSize: response.changes.length,
                    });
                }
                if (response.changes.length === 0) {
                    break;
                }
                if (changesInDrain.length === 0) break;
                try {
                    await this.journal.appendInbound(changesInDrain);
                } catch (error) {
                    this.recordDiagnostic({
                        level: "error",
                        event: "journal",
                        phase: "failed",
                        direction: "inbound",
                        transportOperation: "changes",
                        traceId,
                        cursor,
                        highWatermark: response.highWatermark,
                        count: changesInDrain.length,
                        errorKind: diagnosticErrorKind(error, "storage"),
                    });
                    throw error;
                }
                if (!this.isCurrentGeneration(generation)) return;
                await this.processPendingInbound(generation);
                processedPages += 1;
                this.logJournalDiagnostics("projection");
                if (processedPages % COMPACTION_CHECK_BATCH_INTERVAL === 0) {
                    await this.journal.compactIfNeeded();
                    await yieldToEventLoop();
                }
                if (this.receiveCursor >= drainWatermark) break;
            }
            if (!this.isCurrentGeneration(generation)) return;
            await this.journal.compactIfNeeded();
            if (this.started && latestObservedWatermark > this.receiveCursor) {
                this.receiveSync.invalidate();
            }
        });
    }

    getCommandStatus(commandId: string): SyncV4CommandJournalStatus | undefined {
        return this.journal.snapshot().commandStatuses.get(commandId);
    }

    getPendingCommands(): Array<{
        command: CodexCommandEntityV4;
        status: SyncV4CommandJournalStatus;
    }> {
        const snapshot = this.journal.snapshot();
        const pending: Array<{ command: CodexCommandEntityV4; status: SyncV4CommandJournalStatus }> = [];
        for (const [commandId, command] of snapshot.commands) {
            const status = snapshot.commandStatuses.get(commandId);
            if (status === "received" || status === "executing" || status === "resultUnknown") {
                pending.push({ command, status });
            }
        }
        return pending.sort((left, right) => (
            left.command.createdAt - right.command.createdAt
            || left.command.commandId.localeCompare(right.command.commandId)
        ));
    }

    getPendingProviderRequests(): SyncV4PendingProviderRequest[] {
        return [...this.journal.snapshot().pendingProviderRequests.values()]
            .sort((left, right) => (
                left.request.createdAt - right.request.createdAt
                || left.request.providerId.localeCompare(right.request.providerId)
            ));
    }

    async setCommandStatus(
        commandId: string,
        status: SyncV4CommandJournalStatus,
        command?: CodexCommandEntityV4,
    ): Promise<void> {
        this.assertCurrentGeneration(this.lifecycleGeneration);
        await this.journal.setCommandStatus(commandId, status, command);
        this.recordDiagnostic({
            level: status === "failed" || status === "resultUnknown" || status === "notReplayed"
                ? "warn"
                : "debug",
            event: "request",
            phase: "changed",
            source: "command",
            commandHash: syncV4DiagnosticHash(commandId),
            state: status,
        });
    }

    getMigrationState(threadId: string): SyncV4MigrationJournalState | undefined {
        return this.journal.getMigrationState(threadId);
    }

    async setMigrationState(threadId: string, state: SyncV4MigrationJournalState): Promise<void> {
        const generation = this.lifecycleGeneration;
        this.assertCurrentGeneration(generation);
        await this.journal.setMigrationState(threadId, state);
        this.assertCurrentGeneration(generation);
        this.recordDiagnostic({
            level: state === "error" ? "error" : "info",
            event: "migration",
            phase: "changed",
            source: "migration",
            threadHash: syncV4DiagnosticHash(threadId),
            state,
        });
    }

    getPendingCodexNotifications(): readonly SyncV4PendingCodexNotification[] {
        return this.journal.snapshot().pendingCodexNotifications;
    }

    getCodexThreadRoutes(): ReadonlyMap<string, SyncV4CodexThreadRoute> {
        return this.journal.snapshot().codexThreadRoutes;
    }

    async persistCodexOrphan(
        threadId: string,
        notification: SyncV4CodexNotification,
    ): Promise<SyncV4PendingCodexNotification> {
        const generation = this.lifecycleGeneration;
        this.assertCurrentGeneration(generation);
        const pending = await this.journal.appendCodexOrphan(threadId, notification);
        this.assertCurrentGeneration(generation);
        this.recordDiagnostic({
            level: "warn",
            event: "notification",
            phase: "enqueued",
            source: "notification",
            threadHash: syncV4DiagnosticHash(threadId),
            count: this.journal.snapshot().pendingCodexNotifications.length,
        });
        return pending;
    }

    async completeCodexOrphan(notificationId: string): Promise<void> {
        const generation = this.lifecycleGeneration;
        this.assertCurrentGeneration(generation);
        await this.journal.completeCodexOrphan(notificationId);
        this.assertCurrentGeneration(generation);
        this.recordDiagnostic({
            level: "debug",
            event: "notification",
            phase: "replayed",
            source: "recovery",
            mutationHash: syncV4DiagnosticHash(notificationId),
            count: this.journal.snapshot().pendingCodexNotifications.length,
        });
    }

    async persistCodexThreadRoute(route: SyncV4CodexThreadRoute): Promise<void> {
        const generation = this.lifecycleGeneration;
        this.assertCurrentGeneration(generation);
        await this.journal.setCodexThreadRoute(route);
        this.assertCurrentGeneration(generation);
    }

    private async processPendingInbound(generation: number): Promise<void> {
        if (!this.isCurrentGeneration(generation)) return;
        const snapshot = this.journal.snapshot();
        const initialCursor = snapshot.receiveCursor;
        let applied = 0;
        let expectedSeq = snapshot.receiveCursor + 1;
        for (const change of snapshot.pendingInbound) {
            if (!this.isCurrentGeneration(generation)) return;
            if (change.seq !== expectedSeq) {
                this.recordDiagnostic({
                    level: "error",
                    event: "changes",
                    phase: "failed",
                    direction: "inbound",
                    cursor: expectedSeq - 1,
                    seq: change.seq,
                    errorKind: "protocol",
                });
                throw new SyncV4ProtocolError("Sync v4 inbound journal has a sequence gap");
            }
            const currentRevision = this.journal.snapshot().entityRevisions.get(change.entityId) ?? 0;
            if (change.revision <= currentRevision) {
                try {
                    await this.journal.advanceReceiveCursor(change.seq);
                } catch (error) {
                    this.recordDiagnostic({
                        level: "error",
                        event: "cursor",
                        phase: "failed",
                        direction: "inbound",
                        seq: change.seq,
                        revision: change.revision,
                        errorKind: diagnosticErrorKind(error, "storage"),
                    });
                    throw error;
                }
                expectedSeq += 1;
                continue;
            }
            let entity: CodexEntityV4;
            try {
                entity = await this.crypto.decryptEntity(
                    toAad(this.sessionId, change),
                    change.ciphertext,
                );
            } catch (error) {
                this.recordDiagnostic({
                    level: "error",
                    event: "changes",
                    phase: "failed",
                    direction: "inbound",
                    seq: change.seq,
                    revision: change.revision,
                    errorKind: diagnosticErrorKind(error, "crypto"),
                });
                throw error;
            }
            if (!this.isCurrentGeneration(generation)) return;
            const projectionStartedAt = Date.now();
            try {
                await this.onEntity({
                    entity,
                    source: "change",
                    op: change.op,
                    revision: change.revision,
                    seq: change.seq,
                });
            } catch (error) {
                this.recordDiagnostic({
                    level: "error",
                    event: "projection",
                    phase: "failed",
                    source: "change",
                    seq: change.seq,
                    revision: change.revision,
                    durationMs: elapsedMs(projectionStartedAt),
                    errorKind: diagnosticErrorKind(error, "projection"),
                });
                throw error;
            }
            if (!this.isCurrentGeneration(generation)) return;
            try {
                await this.journal.completeInbound(change.entityId, change.revision, change.seq);
            } catch (error) {
                this.recordDiagnostic({
                    level: "error",
                    event: "cursor",
                    phase: "failed",
                    direction: "inbound",
                    seq: change.seq,
                    revision: change.revision,
                    errorKind: diagnosticErrorKind(error, "storage"),
                });
                throw error;
            }
            applied += 1;
            expectedSeq += 1;
        }
        const cursor = this.receiveCursor;
        if (cursor > initialCursor) {
            this.recordDiagnostic({
                level: "debug",
                event: "cursor",
                phase: "advanced",
                direction: "inbound",
                cursor,
                count: applied,
            });
        }
    }

    private async rebuildFromSnapshot(generation: number): Promise<void> {
        if (!this.isCurrentGeneration(generation)) return;
        const snapshotStartedAt = Date.now();
        this.recordDiagnostic({
            level: "info",
            event: "snapshot",
            phase: "started",
            direction: "inbound",
            cursor: this.receiveCursor,
        });
        let cursor: string | null = null;
        let highWatermark: number | null = null;
        const seenCursors = new Set<string>();
        const snapshotEntityIds = new Set<string>();
        const snapshotRevisions = new Map<string, number>();
        const appliedRevisions: Array<{ entityId: string; revision: number }> = [];
        let page = 0;
        let failureKind: ReturnType<typeof classifySyncV4DiagnosticError> = "unknown";
        try {
            do {
                const traceId = this.nextTraceId();
                const pageStartedAt = Date.now();
                this.recordDiagnostic({
                    level: "debug",
                    event: "transport",
                    phase: "started",
                    direction: "inbound",
                    transportOperation: "snapshot",
                    traceId,
                    page,
                });
                let snapshotPage: SyncSnapshotResponseV4;
                try {
                    failureKind = "network";
                    snapshotPage = await this.transport.getSnapshot(
                        this.sessionId,
                        cursor,
                        SNAPSHOT_PAGE_SIZE,
                        traceId,
                    );
                } catch (error) {
                    failureKind = classifySyncV4DiagnosticError(error);
                    this.recordDiagnostic({
                        level: "error",
                        event: "transport",
                        phase: "failed",
                        direction: "inbound",
                        transportOperation: "snapshot",
                        traceId,
                        page,
                        durationMs: elapsedMs(pageStartedAt),
                        errorKind: failureKind,
                    });
                    throw error;
                }
                if (!this.isCurrentGeneration(generation)) return;
                failureKind = "protocol";
                try {
                    if (highWatermark === null) highWatermark = snapshotPage.highWatermark;
                    if (snapshotPage.highWatermark !== highWatermark) {
                        throw new SyncV4ProtocolError(
                            "Sync v4 snapshot watermark changed during pagination",
                        );
                    }
                    for (const snapshotEntity of snapshotPage.entities) {
                        if (snapshotEntityIds.has(snapshotEntity.entityId)) {
                            throw new SyncV4ProtocolError(
                                "Sync v4 snapshot repeated an entity across pages",
                            );
                        }
                        if (snapshotEntity.updatedSeq > snapshotPage.highWatermark) {
                            throw new SyncV4ProtocolError(
                                "Sync v4 snapshot entity exceeds its high watermark",
                            );
                        }
                        snapshotEntityIds.add(snapshotEntity.entityId);
                    }
                    if (snapshotPage.nextCursor && seenCursors.has(snapshotPage.nextCursor)) {
                        throw new SyncV4ProtocolError("Sync v4 snapshot pagination stalled");
                    }
                } catch (error) {
                    this.recordDiagnostic({
                        level: "error",
                        event: "snapshot",
                        phase: "failed",
                        direction: "inbound",
                        transportOperation: "snapshot",
                        traceId,
                        page,
                        highWatermark: snapshotPage.highWatermark,
                        count: snapshotPage.entities.length,
                        durationMs: elapsedMs(pageStartedAt),
                        errorKind: "protocol",
                    });
                    throw error;
                }
                this.recordDiagnostic({
                    level: "debug",
                    event: "transport",
                    phase: "completed",
                    direction: "inbound",
                    transportOperation: "snapshot",
                    traceId,
                    page,
                    highWatermark: snapshotPage.highWatermark,
                    count: snapshotPage.entities.length,
                    durationMs: elapsedMs(pageStartedAt),
                });
                for (const snapshotEntity of snapshotPage.entities) {
                    const currentRevision = Math.max(
                        this.journal.snapshot().entityRevisions.get(snapshotEntity.entityId) ?? 0,
                        snapshotRevisions.get(snapshotEntity.entityId) ?? 0,
                    );
                    if (snapshotEntity.revision <= currentRevision) continue;
                    let entity: CodexEntityV4;
                    try {
                        failureKind = "crypto";
                        entity = await this.crypto.decryptEntity(
                            toAad(this.sessionId, snapshotEntity),
                            snapshotEntity.ciphertext,
                        );
                    } catch (error) {
                        this.recordDiagnostic({
                            level: "error",
                            event: "snapshot",
                            phase: "failed",
                            direction: "inbound",
                            transportOperation: "snapshot",
                            traceId,
                            page,
                            revision: snapshotEntity.revision,
                            errorKind: diagnosticErrorKind(error, "crypto"),
                        });
                        throw error;
                    }
                    if (!this.isCurrentGeneration(generation)) return;
                    const projectionStartedAt = Date.now();
                    try {
                        failureKind = "unknown";
                        await this.onEntity({
                            entity,
                            source: "snapshot",
                            op: snapshotEntity.op,
                            revision: snapshotEntity.revision,
                            seq: null,
                        });
                    } catch (error) {
                        this.recordDiagnostic({
                            level: "error",
                            event: "projection",
                            phase: "failed",
                            source: "snapshot",
                            revision: snapshotEntity.revision,
                            durationMs: elapsedMs(projectionStartedAt),
                            errorKind: diagnosticErrorKind(error, "projection"),
                        });
                        throw error;
                    }
                    if (!this.isCurrentGeneration(generation)) return;
                    snapshotRevisions.set(snapshotEntity.entityId, snapshotEntity.revision);
                    appliedRevisions.push({
                        entityId: snapshotEntity.entityId,
                        revision: snapshotEntity.revision,
                    });
                }
                cursor = snapshotPage.nextCursor;
                if (cursor) seenCursors.add(cursor);
                page += 1;
            } while (cursor);
            if (!this.isCurrentGeneration(generation)) return;
            try {
                failureKind = "storage";
                await this.journal.completeSnapshot(appliedRevisions, highWatermark ?? 0);
            } catch (error) {
                this.recordDiagnostic({
                    level: "error",
                    event: "cursor",
                    phase: "failed",
                    direction: "inbound",
                    highWatermark: highWatermark ?? 0,
                    count: appliedRevisions.length,
                    errorKind: diagnosticErrorKind(error, "storage"),
                });
                throw error;
            }
            this.recordDiagnostic({
                level: "info",
                event: "snapshot",
                phase: "completed",
                direction: "inbound",
                cursor: highWatermark ?? 0,
                highWatermark: highWatermark ?? 0,
                count: appliedRevisions.length,
                page,
                durationMs: elapsedMs(snapshotStartedAt),
            });
            this.logJournalDiagnostics("snapshot");
        } catch (error) {
            this.recordDiagnostic({
                level: "error",
                event: "snapshot",
                phase: "failed",
                direction: "inbound",
                count: appliedRevisions.length,
                page,
                durationMs: elapsedMs(snapshotStartedAt),
                errorKind: diagnosticErrorKind(error, failureKind),
            });
            throw error;
        }
    }

    private logJournalDiagnostics(event: "start" | "ack" | "projection" | "snapshot" | "stop", extra = {}): void {
        const journal = this.journal.diagnostics();
        this.recordDiagnostic({
            level: "debug",
            event: "journal",
            phase: event === "start"
                ? "restored"
                : event === "stop"
                    ? "completed"
                : event === "ack"
                    ? "acknowledged"
                    : event === "snapshot"
                        ? "completed"
                        : "applied",
            direction: "outbound",
            depth: journal.pendingOutboundDepth,
            ...(journal.pendingOutboundOldestAgeMs === null
                ? {}
                : { ageMs: Math.trunc(journal.pendingOutboundOldestAgeMs) }),
        });
        this.recordDiagnostic({
            level: "debug",
            event: "journal",
            phase: event === "start"
                ? "restored"
                : event === "stop"
                    ? "completed"
                : event === "snapshot"
                    ? "completed"
                    : "applied",
            direction: "inbound",
            depth: journal.pendingInboundDepth,
            ...(journal.pendingInboundOldestAgeMs === null
                ? {}
                : { ageMs: Math.trunc(journal.pendingInboundOldestAgeMs) }),
            cursor: this.receiveCursor,
        });
        logger.debug("[Sync v4] Journal", {
            session: this.diagnosticSessionId,
            event,
            ...journal,
            ...extra,
        });
    }

    private recordDiagnostic(
        input: Omit<SyncV4DiagnosticInput, "component" | "sessionHash">,
    ): void {
        recordSyncV4DiagnosticSafely(this.diagnostics, {
            component: "cli.sync",
            sessionHash: this.diagnosticSessionId,
            softwareVersion: configuration.currentCliVersion,
            protocolVersion: 4,
            featureEnabled: true,
            transportSecurity: this.transportSecurity,
            ...input,
        });
    }

    private nextTraceId(): string {
        return requireSyncV4TraceId(this.generateTraceId());
    }

    private isCurrentGeneration(generation: number): boolean {
        return !this.disposed && this.lifecycleGeneration === generation;
    }

    private assertCurrentGeneration(generation: number): void {
        if (!this.isCurrentGeneration(generation)) {
            throw new Error("Sync v4 client has been stopped");
        }
    }
}

function requiredToken(token: string | undefined): string {
    if (!token) throw new Error("Sync v4 token is required when no custom transport is provided");
    return token;
}

function syncV4TransportSecurity(serverUrl: string): SyncV4DiagnosticTransportSecurity {
    try {
        return new URL(serverUrl).protocol === "http:" ? "insecureHttp" : "https";
    } catch {
        return "https";
    }
}

function validateAxiosTraceEcho(
    response: { headers?: unknown },
    traceId?: string,
): void {
    requireSyncV4TraceEcho(traceId, axiosTraceHeader(response.headers));
}

function axiosTraceHeader(headers: unknown): string | undefined {
    try {
        if (!headers || typeof headers !== "object") return undefined;
        const get = (headers as { get?: unknown }).get;
        if (typeof get === "function") {
            const value = get.call(headers, "X-Happy-Sync-Trace");
            return typeof value === "string" ? value : undefined;
        }
        const record = headers as Record<string, unknown>;
        const value = record["x-happy-sync-trace"] ?? record["X-Happy-Sync-Trace"];
        if (typeof value === "string") return value;
        return Array.isArray(value) && value.length === 1 && typeof value[0] === "string"
            ? value[0]
            : undefined;
    } catch {
        return undefined;
    }
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function elapsedMs(startedAt: number): number {
    return Math.max(0, Math.trunc(Date.now() - startedAt));
}

function takeMutationBatch(pending: SyncMutationV4[]): SyncMutationV4[] {
    const batch: SyncMutationV4[] = [];
    let ciphertextBytes = 0;
    for (const mutation of pending) {
        const nextBytes = syncV4Utf8ByteLength(mutation.ciphertext);
        if (batch.length >= MAX_SYNC_V4_MUTATIONS_PER_BATCH) break;
        if (batch.length > 0 && ciphertextBytes + nextBytes > MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH) break;
        batch.push(mutation);
        ciphertextBytes += nextBytes;
    }
    return SyncMutationBatchV4Schema.parse({ mutations: batch }).mutations;
}

function validateAcknowledgements(mutations: SyncMutationV4[], acknowledgements: SyncAckV4[]): void {
    if (mutations.length !== acknowledgements.length) {
        throw new Error("Sync v4 mutation response omitted acknowledgements");
    }
    for (let index = 0; index < mutations.length; index += 1) {
        const mutation = mutations[index];
        const acknowledgement = acknowledgements[index];
        if (acknowledgement.mutationId !== mutation.mutationId || acknowledgement.revision !== mutation.revision) {
            throw new Error("Sync v4 mutation acknowledgement does not match request order");
        }
    }
}

function assertContiguousChanges(changes: SyncChangeV4[], afterSeq: number): void {
    let expectedSeq = afterSeq + 1;
    for (const change of changes) {
        if (change.seq !== expectedSeq) throw new Error(`Sync v4 changes have a gap before sequence ${change.seq}`);
        expectedSeq += 1;
    }
}

function toAad(
    sessionId: string,
    entity: Pick<SyncChangeV4 | SyncEntitySnapshotV4, "entityId" | "entityType" | "revision" | "op">,
) {
    return {
        sessionId,
        entityId: entity.entityId,
        entityType: entity.entityType,
        revision: entity.revision,
        op: entity.op,
    };
}
