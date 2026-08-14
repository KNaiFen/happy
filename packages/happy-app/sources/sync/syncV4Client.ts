/**
 * App-side Sync v4 coordinator for encrypted Codex entities and commands.
 * Persistent cache/outbox writes always precede receive-cursor or ACK removal.
 */

import {
    CodexEntityV4Schema,
    MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH,
    MAX_SYNC_V4_MUTATIONS_PER_BATCH,
    MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE,
    classifySyncV4DiagnosticError,
    isSyncV4VersionAtLeast,
    recordSyncV4DiagnosticSafely,
    requireSyncV4TraceId,
    SyncMutationBatchV4Schema,
    SyncMutationV4Schema,
    syncV4Utf8ByteLength,
    type CodexEntityV4,
    type SyncAckV4,
    type SyncChangesResponseV4,
    type SyncEntitySnapshotV4,
    type SyncMutationBatchResponseV4,
    type SyncMutationOperationV4,
    type SyncMutationV4,
    type SyncSnapshotResponseV4,
    type SyncV4Capabilities,
    type SyncV4Aad,
    type SyncV4DiagnosticInput,
    type SyncV4DiagnosticSink,
    type SyncV4DiagnosticTransportSecurity,
} from '@slopus/happy-wire';
import { AsyncLock } from '../utils/lock';
import { InvalidateSync } from '../utils/sync';
import { SyncV4Persistence } from './syncV4Persistence';
import {
    appSyncV4DiagnosticStatsAreDegraded,
    readAppSyncV4DiagnosticStatsSafely,
    type AppSyncV4DiagnosticStatsProvider,
} from './syncV4Diagnostics';

const CHANGES_PAGE_SIZE = 100;
const SNAPSHOT_PAGE_SIZE = MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const HEALTHY_EMPTY_POLL_DIAGNOSTIC_INTERVAL_MS = 30_000;
const PROJECTION_DIAGNOSTIC_INTERVAL_MS = 5_000;

export interface AppSyncV4Transport {
    getCapabilities(traceId?: string): Promise<SyncV4Capabilities>;
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
    ): Promise<SyncChangesResponseV4>;
    getSnapshot(
        sessionId: string,
        cursor: string | null,
        limit: number,
        traceId?: string,
    ): Promise<SyncSnapshotResponseV4>;
}

export interface AppSyncV4Crypto {
    opaqueEntityId(entityType: CodexEntityV4['entityType'], providerId: string): Promise<string>;
    encryptEntity(aad: SyncV4Aad, entity: CodexEntityV4): Promise<string>;
    decryptEntity(aad: SyncV4Aad, ciphertext: string): Promise<CodexEntityV4>;
    dispose?: () => void;
}

export class AppSyncV4SnapshotRequiredError extends Error {
    constructor(
        readonly minimumSeq: number,
        readonly highWatermark: number,
    ) {
        super('Sync v4 snapshot required');
    }
}

export class AppSyncV4SessionReadOnlyError extends Error {
    constructor() {
        super('Sync v4 session is read-only because its source machine was deleted');
        this.name = 'AppSyncV4SessionReadOnlyError';
    }
}

export class AppSyncV4MutationPersistedError extends Error {
    constructor() {
        super('Sync v4 mutation is durable but its local projection outcome is unknown');
        this.name = 'AppSyncV4MutationPersistedError';
    }
}

class AppSyncV4ProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AppSyncV4ProtocolError';
    }
}

function diagnosticErrorKind(
    error: unknown,
    fallback: ReturnType<typeof classifySyncV4DiagnosticError>,
): ReturnType<typeof classifySyncV4DiagnosticError> {
    const classified = classifySyncV4DiagnosticError(error);
    return classified === 'unknown' ? fallback : classified;
}

function samePendingOutbox(
    left: readonly SyncMutationV4[],
    right: readonly SyncMutationV4[],
): boolean {
    return left.length === right.length
        && left.every((mutation, index) => mutation.mutationId === right[index]?.mutationId);
}

export interface AppSyncV4AppliedEntity {
    entity: CodexEntityV4;
    source: 'cache' | 'change' | 'snapshot';
    op: SyncMutationOperationV4;
    revision: number;
    seq: number | null;
}

export interface AppSyncV4PublishEntity {
    entity: CodexEntityV4;
    op?: SyncMutationOperationV4;
}

interface AppSyncV4ClientOptions {
    sessionId: string;
    sessionKey: Uint8Array;
    appVersion: string;
    persistence: SyncV4Persistence;
    transport: AppSyncV4Transport;
    onEntity: (event: AppSyncV4AppliedEntity) => Promise<void>;
    onEntities?: (events: readonly AppSyncV4AppliedEntity[]) => Promise<void>;
    onSnapshotReset: () => Promise<void>;
    onSnapshotReplace?: (events: readonly AppSyncV4AppliedEntity[]) => Promise<void>;
    crypto?: AppSyncV4Crypto;
    generateMutationId?: () => string;
    generateTraceId?: () => string;
    pollIntervalMs?: number | null;
    diagnostics?: SyncV4DiagnosticSink;
    diagnosticStats?: AppSyncV4DiagnosticStatsProvider;
    transportSecurity?: SyncV4DiagnosticTransportSecurity;
    canSendOutbound?: () => boolean;
}

export class AppSyncV4Client {
    static async create(options: AppSyncV4ClientOptions): Promise<AppSyncV4Client> {
        const crypto = options.crypto ?? await createDefaultSyncV4Crypto(
            options.sessionId,
            options.sessionKey,
        );
        const diagnosticSessionHash = safeDiagnosticId(
            await crypto.opaqueEntityId(
                'codex.runtime',
                '__happy_sync_v4_diagnostic_session__',
            ),
        );
        return new AppSyncV4Client(
            options.sessionId,
            options.persistence,
            options.transport,
            options.appVersion,
            crypto,
            options.onEntity,
            options.onEntities ?? null,
            options.onSnapshotReset,
            options.onSnapshotReplace ?? null,
            options.generateMutationId ?? defaultRandomUUID,
            options.generateTraceId ?? defaultTraceId,
            options.pollIntervalMs === undefined ? DEFAULT_POLL_INTERVAL_MS : options.pollIntervalMs,
            options.diagnostics ?? null,
            options.diagnosticStats ?? null,
            diagnosticSessionHash,
            options.transportSecurity ?? 'https',
            options.canSendOutbound ?? (() => true),
        );
    }

    private readonly publishLock = new AsyncLock();
    private readonly sendLock = new AsyncLock();
    private readonly receiveLock = new AsyncLock();
    private readonly sendSync: InvalidateSync;
    private readonly receiveSync: InvalidateSync;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private started = false;
    private disposed = false;
    private diagnosticsSuppressed = false;
    private lifecycleGeneration = 0;
    private lastHealthyEmptyPollDiagnosticAt = 0;
    private suppressedHealthyEmptyPolls = 0;
    private lastProjectionDiagnosticAt = 0;
    private suppressedProjectionBatches = 0;
    private totalSuppressedHealthyEmptyPolls = 0;
    private totalSuppressedProjectionBatches = 0;

    private constructor(
        readonly sessionId: string,
        private readonly persistence: SyncV4Persistence,
        private readonly transport: AppSyncV4Transport,
        private readonly appVersion: string,
        private readonly crypto: AppSyncV4Crypto,
        private readonly onEntity: (event: AppSyncV4AppliedEntity) => Promise<void>,
        private readonly onEntities: ((events: readonly AppSyncV4AppliedEntity[]) => Promise<void>) | null,
        private readonly onSnapshotReset: () => Promise<void>,
        private readonly onSnapshotReplace: ((events: readonly AppSyncV4AppliedEntity[]) => Promise<void>) | null,
        private readonly generateMutationId: () => string,
        private readonly generateTraceId: () => string,
        private readonly pollIntervalMs: number | null,
        private readonly diagnostics: SyncV4DiagnosticSink | null,
        private readonly diagnosticStats: AppSyncV4DiagnosticStatsProvider | null,
        private readonly diagnosticSessionHash: string,
        private readonly transportSecurity: SyncV4DiagnosticTransportSecurity,
        private readonly canSendOutbound: () => boolean,
    ) {
        this.sendSync = new InvalidateSync(() => this.flushOutboundOnce());
        this.receiveSync = new InvalidateSync(() => this.pullInvalidatedChanges());
    }

    get receiveCursor(): number {
        return this.persistence.getReceiveCursor(this.sessionId);
    }

    get diagnosticSessionId(): string {
        return this.diagnosticSessionHash;
    }

    async start(): Promise<void> {
        if (this.started) return;
        if (this.disposed) throw new Error('Sync v4 client has been stopped');
        const generation = this.lifecycleGeneration;
        this.started = true;
        this.recordDiagnostic({
            level: 'info',
            event: 'lifecycle',
            phase: 'started',
            state: 'starting',
            generation,
            cursor: this.receiveCursor,
            featureEnabled: true,
        });
        try {
            await this.assertCompatibleForGeneration(generation);
            await this.hydrateForGeneration(generation);
            await Promise.all([
                this.flushOutboundForGeneration(generation),
                this.pullChangesForGeneration(generation),
            ]);
            this.assertCurrentGeneration(generation);
        } catch (error) {
            if (this.isCurrentGeneration(generation)) {
                this.started = false;
                this.lifecycleGeneration += 1;
            }
            this.recordDiagnostic({
                level: 'error',
                event: 'lifecycle',
                phase: 'failed',
                state: 'failed',
                generation,
                errorKind: classifySyncV4DiagnosticError(error),
            });
            throw error;
        }
        if (this.pollIntervalMs !== null) {
            this.pollTimer = setInterval(() => this.receiveSync.invalidate(), this.pollIntervalMs);
        }
        this.recordDiagnostic({
            level: 'info',
            event: 'lifecycle',
            phase: 'completed',
            state: 'ready',
            generation,
            cursor: this.receiveCursor,
        });
    }

    private async assertCompatibleForGeneration(generation: number): Promise<void> {
        const traceId = this.nextTraceId();
        const startedAt = Date.now();
        this.recordDiagnostic({
            level: 'debug',
            event: 'transport',
            phase: 'started',
            direction: 'inbound',
            transportOperation: 'capabilities',
            traceId,
        });
        let capabilities: SyncV4Capabilities;
        try {
            capabilities = await this.transport.getCapabilities(traceId);
        } catch (error) {
            this.recordDiagnostic({
                level: 'warn',
                event: 'transport',
                phase: 'failed',
                direction: 'inbound',
                transportOperation: 'capabilities',
                traceId,
                durationMs: elapsedMs(startedAt),
                errorKind: classifySyncV4DiagnosticError(error),
            });
            throw error;
        }
        this.assertCurrentGeneration(generation);
        const capability = capabilities.codex;
        if (!capability.enabled) {
            this.recordDiagnostic({
                level: 'warn',
                event: 'transport',
                phase: 'failed',
                direction: 'inbound',
                transportOperation: 'capabilities',
                traceId,
                state: 'stopped',
                featureEnabled: false,
                durationMs: elapsedMs(startedAt),
                errorKind: 'protocol',
            });
            throw new AppSyncV4ProtocolError('Codex Sync v4 is disabled by Happy Server');
        }
        if (!isSyncV4VersionAtLeast(this.appVersion, capability.minimumHappyAppVersion)) {
            this.recordDiagnostic({
                level: 'warn',
                event: 'transport',
                phase: 'failed',
                direction: 'inbound',
                transportOperation: 'capabilities',
                traceId,
                state: 'failed',
                durationMs: elapsedMs(startedAt),
                errorKind: 'protocol',
            });
            throw new AppSyncV4ProtocolError(
                `Happy App ${capability.minimumHappyAppVersion} or newer is required for Codex Sync v4; found ${this.appVersion}.`,
            );
        }
        this.recordDiagnostic({
            level: 'debug',
            event: 'transport',
            phase: 'completed',
            direction: 'inbound',
            transportOperation: 'capabilities',
            traceId,
            state: 'ready',
            featureEnabled: true,
            durationMs: elapsedMs(startedAt),
        });
    }

    stop(options?: { silent?: boolean }): void {
        if (this.disposed) return;
        const silent = options?.silent === true;
        this.diagnosticsSuppressed = silent;
        const diagnosticStats = silent ? null : readAppSyncV4DiagnosticStatsSafely(this.diagnosticStats);
        const diagnosticsDegraded = !silent && appSyncV4DiagnosticStatsAreDegraded(diagnosticStats);
        if (!silent) {
            this.flushSuppressedHealthyEmptyPollDiagnostics();
            this.flushSuppressedProjectionDiagnostics();
            this.recordDiagnostic({
                level: diagnosticsDegraded ? 'warn' : 'info',
                event: 'lifecycle',
                phase: 'started',
                state: 'stopping',
                generation: this.lifecycleGeneration,
                cursor: this.receiveCursor,
                depth: this.diagnosticOutboxDepth(),
                count: diagnosticStats?.count,
                dropped: diagnosticStats?.droppedRecords,
                invalid: diagnosticStats?.invalidRecords,
                writeFailures: diagnosticStats?.writeFailures,
                listenerFailures: diagnosticStats?.listenerFailures,
                suppressed: this.totalSuppressedHealthyEmptyPolls
                    + this.totalSuppressedProjectionBatches,
                featureEnabled: true,
            });
        }
        this.disposed = true;
        this.started = false;
        this.lifecycleGeneration += 1;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.sendSync.stop();
        this.receiveSync.stop();
        this.crypto.dispose?.();
        if (!silent) {
            this.recordDiagnostic({
                level: diagnosticsDegraded ? 'warn' : 'info',
                event: 'lifecycle',
                phase: diagnosticsDegraded ? 'failed' : 'completed',
                state: diagnosticsDegraded ? 'degraded' : 'stopped',
                generation: this.lifecycleGeneration,
                cursor: this.receiveCursor,
                depth: this.diagnosticOutboxDepth(),
                count: diagnosticStats?.count,
                dropped: diagnosticStats?.droppedRecords,
                invalid: diagnosticStats?.invalidRecords,
                writeFailures: diagnosticStats?.writeFailures,
                listenerFailures: diagnosticStats?.listenerFailures,
                suppressed: this.totalSuppressedHealthyEmptyPolls
                    + this.totalSuppressedProjectionBatches,
                featureEnabled: true,
            });
        }
    }

    invalidate(highWatermark?: number): void {
        if (!this.started) return;
        if (highWatermark === undefined || highWatermark > this.receiveCursor) this.receiveSync.invalidate();
    }

    private async pullInvalidatedChanges(): Promise<void> {
        try {
            await this.pullChangesOnce();
        } catch (error) {
            // On-demand wakes are one-shot; the next external signal owns retry.
            if (this.pollIntervalMs !== null) throw error;
        }
    }

    async hydrate(): Promise<void> {
        await this.hydrateForGeneration(this.lifecycleGeneration);
    }

    private async hydrateForGeneration(generation: number): Promise<void> {
        if (!this.isCurrentGeneration(generation)) return;
        let persistent: ReturnType<SyncV4Persistence['loadSession']>;
        try {
            persistent = this.persistence.loadSession(this.sessionId);
        } catch (error) {
            this.recordDiagnostic({
                level: 'error',
                event: 'journal',
                phase: 'failed',
                source: 'cache',
                errorKind: diagnosticErrorKind(error, 'storage'),
            });
            throw error;
        }
        this.recordDiagnostic({
            level: 'debug',
            event: 'journal',
            phase: 'restored',
            source: 'cache',
            cursor: persistent.receiveCursor,
            count: persistent.entities.length,
            depth: persistent.outbox.length,
        });
        const cachedRevisions = new Map(persistent.entities.map((entity) => [entity.entityId, entity.revision]));
        const hydrated: AppSyncV4AppliedEntity[] = [];
        try {
            for (const cached of persistent.entities) {
                const entity = await this.crypto.decryptEntity(toAad(this.sessionId, cached), cached.ciphertext);
                if (!this.isCurrentGeneration(generation)) return;
                hydrated.push({
                    entity,
                    source: 'cache',
                    op: cached.op,
                    revision: cached.revision,
                    seq: cached.updatedSeq,
                });
            }
        } catch (error) {
            if (!this.isCurrentGeneration(generation)) return;
            this.recordDiagnostic({
                level: 'warn',
                event: 'snapshot',
                phase: 'required',
                source: 'cache',
                reason: 'cacheCorrupt',
                errorKind: diagnosticErrorKind(error, 'crypto'),
            });
            await this.rebuildFromSnapshot(generation);
            return;
        }
        try {
            for (const mutation of persistent.outbox) {
                if ((cachedRevisions.get(mutation.entityId) ?? 0) >= mutation.revision) continue;
                const entity = await this.crypto.decryptEntity(toAad(this.sessionId, mutation), mutation.ciphertext);
                if (!this.isCurrentGeneration(generation)) return;
                hydrated.push({
                    entity,
                    source: 'cache',
                    op: mutation.op,
                    revision: mutation.revision,
                    seq: null,
                });
            }
        } catch (error) {
            this.recordDiagnostic({
                level: 'error',
                event: 'outbox',
                phase: 'failed',
                source: 'cache',
                count: persistent.outbox.length,
                errorKind: diagnosticErrorKind(error, 'crypto'),
            });
            throw error;
        }
        await this.deliverEntitiesForGeneration(hydrated, generation);
        if (!this.isCurrentGeneration(generation)) return;
        if (persistent.snapshotRequired) await this.rebuildFromSnapshot(generation);
    }

    async publishEntity(
        entity: CodexEntityV4,
        op: SyncMutationOperationV4 = 'upsert',
    ): Promise<SyncMutationV4> {
        return (await this.publishEntities([{ entity, op }]))[0];
    }

    async publishEntities(entries: AppSyncV4PublishEntity[]): Promise<SyncMutationV4[]> {
        if (entries.length === 0) return [];
        this.assertOutboundEnabled();
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
                const revision = (
                    pendingRevisions.get(entityId)
                    ?? this.persistence.nextRevision(this.sessionId, entityId) - 1
                ) + 1;
                pendingRevisions.set(entityId, revision);
                const op = entry.op ?? 'upsert';
                const aad = {
                    sessionId: this.sessionId,
                    entityId,
                    entityType: entry.entity.entityType,
                    revision,
                    op,
                };
                nextMutations.push(SyncMutationV4Schema.parse({
                    mutationId: this.generateMutationId(),
                    producerId: this.persistence.loadProducerId(),
                    entityId,
                    entityType: entry.entity.entityType,
                    revision,
                    op,
                    ciphertext: await this.crypto.encryptEntity(aad, entry.entity),
                }));
                this.assertCurrentGeneration(generation);
            }
            this.assertOutboundEnabled();
            this.persistence.enqueueMutations(this.sessionId, nextMutations);
            this.recordDiagnostic({
                level: 'debug',
                event: 'outbox',
                phase: 'enqueued',
                direction: 'outbound',
                count: nextMutations.length,
                depth: this.persistence.getPendingOutbox(this.sessionId).length,
                bytes: nextMutations.reduce(
                    (total, mutation) => total + syncV4Utf8ByteLength(mutation.ciphertext),
                    0,
                ),
            });
            return nextMutations;
        });
        try {
            await this.deliverEntitiesForGeneration(mutations.map((mutation, index) => ({
                entity: canonicalEntries[index].entity,
                source: 'cache' as const,
                op: mutation.op,
                revision: mutation.revision,
                seq: null,
            })), generation);
            this.assertCurrentGeneration(generation);
        } catch {
            if (this.started) this.sendSync.invalidate();
            throw new AppSyncV4MutationPersistedError();
        }
        if (this.started) this.sendSync.invalidate();
        return mutations;
    }

    async flushOutboundOnce(): Promise<void> {
        await this.flushOutboundForGeneration(this.lifecycleGeneration);
    }

    private async flushOutboundForGeneration(generation: number): Promise<void> {
        await this.sendLock.inLock(async () => {
            while (true) {
                if (!this.isCurrentGeneration(generation)) return;
                if (!this.isOutboundEnabled()) return;
                const pending = this.persistence.getPendingOutbox(this.sessionId);
                if (pending.length === 0) return;
                const batch = takeMutationBatch(pending);
                const traceId = this.nextTraceId();
                const startedAt = Date.now();
                this.recordDiagnostic({
                    level: 'debug',
                    event: 'transport',
                    phase: 'started',
                    direction: 'outbound',
                    transportOperation: 'mutations',
                    traceId,
                    count: batch.length,
                    depth: pending.length,
                    bytes: batch.reduce(
                        (total, mutation) => total + syncV4Utf8ByteLength(mutation.ciphertext),
                        0,
                    ),
                });
                let response: SyncMutationBatchResponseV4;
                try {
                    if (!this.isOutboundEnabled()) return;
                    response = await this.transport.postMutations(this.sessionId, batch, traceId);
                } catch (error) {
                    if (error instanceof AppSyncV4SessionReadOnlyError) {
                        this.recordDiagnostic({
                            level: 'warn',
                            event: 'transport',
                            phase: 'failed',
                            direction: 'outbound',
                            transportOperation: 'mutations',
                            traceId,
                            count: batch.length,
                            durationMs: elapsedMs(startedAt),
                            errorKind: 'conflict',
                            state: 'blocked',
                        });
                        return;
                    }
                    this.recordDiagnostic({
                        level: 'warn',
                        event: 'transport',
                        phase: 'failed',
                        direction: 'outbound',
                        transportOperation: 'mutations',
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
                        level: 'error',
                        event: 'ack',
                        phase: 'failed',
                        direction: 'inbound',
                        transportOperation: 'mutations',
                        traceId,
                        count: response.acknowledgements.length,
                        durationMs: elapsedMs(startedAt),
                        errorKind: 'protocol',
                    });
                    throw error;
                }
                try {
                    this.persistence.acknowledgeMutations(
                        this.sessionId,
                        response.acknowledgements,
                    );
                } catch (error) {
                    this.recordDiagnostic({
                        level: 'error',
                        event: 'outbox',
                        phase: 'failed',
                        direction: 'inbound',
                        traceId,
                        count: response.acknowledgements.length,
                        errorKind: 'storage',
                    });
                    throw error;
                }
                const accepted = response.acknowledgements.filter((ack) => ack.status === 'accepted').length;
                const duplicate = response.acknowledgements.filter((ack) => ack.status === 'duplicate').length;
                const superseded = response.acknowledgements.filter((ack) => ack.status === 'superseded').length;
                this.recordDiagnostic({
                    level: 'debug',
                    event: 'transport',
                    phase: 'completed',
                    direction: 'outbound',
                    transportOperation: 'mutations',
                    traceId,
                    count: response.acknowledgements.length,
                    accepted,
                    duplicate,
                    superseded,
                    durationMs: elapsedMs(startedAt),
                    depth: this.persistence.getPendingOutbox(this.sessionId).length,
                });
            }
        });
    }

    private isOutboundEnabled(): boolean {
        try {
            return this.canSendOutbound();
        } catch {
            return false;
        }
    }

    private assertOutboundEnabled(): void {
        if (!this.isOutboundEnabled()) {
            throw new AppSyncV4SessionReadOnlyError();
        }
    }

    async pullChangesOnce(): Promise<void> {
        await this.pullChangesForGeneration(this.lifecycleGeneration);
    }

    private async pullChangesForGeneration(generation: number): Promise<void> {
        await this.receiveLock.inLock(async () => {
            while (true) {
                if (!this.isCurrentGeneration(generation)) return;
                const cursor = this.receiveCursor;
                let response: SyncChangesResponseV4;
                const traceId = this.nextTraceId();
                const startedAt = Date.now();
                try {
                    response = await this.transport.getChanges(
                        this.sessionId,
                        cursor,
                        CHANGES_PAGE_SIZE,
                        traceId,
                    );
                } catch (error) {
                    if (!this.isCurrentGeneration(generation)) return;
                    if (error instanceof AppSyncV4SnapshotRequiredError) {
                        this.recordDiagnostic({
                            level: 'warn',
                            event: 'snapshot',
                            phase: 'required',
                            direction: 'inbound',
                            transportOperation: 'changes',
                            traceId,
                            cursor,
                            seq: error.minimumSeq,
                            highWatermark: error.highWatermark,
                            durationMs: elapsedMs(startedAt),
                        });
                        await this.rebuildFromSnapshot(generation);
                        continue;
                    }
                    this.recordDiagnostic({
                        level: 'warn',
                        event: 'transport',
                        phase: 'failed',
                        direction: 'inbound',
                        transportOperation: 'changes',
                        traceId,
                        cursor,
                        durationMs: elapsedMs(startedAt),
                        errorKind: classifySyncV4DiagnosticError(error),
                    });
                    throw error;
                }
                if (!this.isCurrentGeneration(generation)) return;
                try {
                    if (response.highWatermark < cursor) {
                        throw new Error('Sync v4 server watermark moved backwards');
                    }
                    if (response.changes.length === 0) {
                        if (response.hasMore || cursor < response.highWatermark) {
                            throw new Error('Sync v4 changes response has a sequence gap');
                        }
                    } else {
                        assertContiguousChanges(response.changes, cursor);
                        if (response.changes.at(-1)!.seq > response.highWatermark) {
                            throw new Error('Sync v4 changes exceed the response watermark');
                        }
                    }
                } catch (error) {
                    this.recordDiagnostic({
                        level: 'error',
                        event: 'changes',
                        phase: 'failed',
                        direction: 'inbound',
                        transportOperation: 'changes',
                        traceId,
                        cursor,
                        highWatermark: response.highWatermark,
                        count: response.changes.length,
                        durationMs: elapsedMs(startedAt),
                        errorKind: 'protocol',
                    });
                    throw error;
                }
                this.recordChangesSuccessDiagnostic(response, traceId, cursor, startedAt);
                if (response.changes.length === 0) {
                    return;
                }
                let classified: ReturnType<SyncV4Persistence['classifyChanges']>;
                try {
                    classified = this.persistence.classifyChanges(this.sessionId, response.changes);
                } catch (error) {
                    this.recordDiagnostic({
                        level: 'error',
                        event: 'changes',
                        phase: 'failed',
                        direction: 'inbound',
                        transportOperation: 'changes',
                        traceId,
                        cursor,
                        highWatermark: response.highWatermark,
                        count: response.changes.length,
                        errorKind: diagnosticErrorKind(error, 'storage'),
                    });
                    throw error;
                }
                const decrypted: Array<{ change: SyncChangesResponseV4['changes'][number]; entity: CodexEntityV4 }> = [];
                try {
                    for (const { kind, change } of classified) {
                        if (kind === 'superseded') continue;
                        decrypted.push({
                            change,
                            entity: await this.crypto.decryptEntity(toAad(this.sessionId, change), change.ciphertext),
                        });
                        if (!this.isCurrentGeneration(generation)) return;
                    }
                } catch (error) {
                    this.recordDiagnostic({
                        level: 'error',
                        event: 'changes',
                        phase: 'failed',
                        direction: 'inbound',
                        transportOperation: 'changes',
                        traceId,
                        cursor,
                        highWatermark: response.highWatermark,
                        count: response.changes.length,
                        errorKind: diagnosticErrorKind(error, 'crypto'),
                    });
                    throw error;
                }
                try {
                    this.persistence.stageChanges(this.sessionId, response.changes);
                } catch (error) {
                    this.recordDiagnostic({
                        level: 'error',
                        event: 'changes',
                        phase: 'failed',
                        direction: 'inbound',
                        transportOperation: 'changes',
                        traceId,
                        cursor,
                        highWatermark: response.highWatermark,
                        count: response.changes.length,
                        errorKind: 'storage',
                    });
                    throw error;
                }
                await this.deliverEntitiesForGeneration(decrypted.map(({ change, entity }) => ({
                    entity,
                    source: 'change' as const,
                    op: change.op,
                    revision: change.revision,
                    seq: change.seq,
                })), generation);
                if (!this.isCurrentGeneration(generation)) return;
                try {
                    this.persistence.advanceReceiveCursor(this.sessionId, response.changes.at(-1)!.seq);
                } catch (error) {
                    this.recordDiagnostic({
                        level: 'error',
                        event: 'cursor',
                        phase: 'failed',
                        direction: 'inbound',
                        traceId,
                        cursor,
                        highWatermark: response.highWatermark,
                        count: response.changes.length,
                        errorKind: 'storage',
                    });
                    throw error;
                }
                this.recordDiagnostic({
                    level: 'debug',
                    event: 'cursor',
                    phase: 'advanced',
                    direction: 'inbound',
                    cursor: this.receiveCursor,
                    highWatermark: response.highWatermark,
                    count: response.changes.length,
                });
                if (!response.hasMore && this.receiveCursor >= response.highWatermark) return;
            }
        });
    }

    private async rebuildFromSnapshot(generation: number): Promise<void> {
        if (!this.isCurrentGeneration(generation)) return;
        const snapshotStartedAt = Date.now();
        this.recordDiagnostic({
            level: 'info',
            event: 'snapshot',
            phase: 'started',
            direction: 'inbound',
            cursor: this.receiveCursor,
        });
        let failureKind: ReturnType<typeof classifySyncV4DiagnosticError> = 'storage';
        let snapshotGeneration: string;
        try {
            snapshotGeneration = this.persistence.beginSnapshot(this.sessionId);
        } catch (error) {
            this.recordDiagnostic({
                level: 'error',
                event: 'snapshot',
                phase: 'failed',
                direction: 'inbound',
                page: 0,
                durationMs: elapsedMs(snapshotStartedAt),
                errorKind: diagnosticErrorKind(error, 'storage'),
            });
            throw error;
        }
        let cursor: string | null = null;
        let highWatermark: number | null = null;
        const snapshotRevisions = new Map<string, number>();
        const snapshotEntityIds = new Set<string>();
        const seenCursors = new Set<string>();
        const replacement: AppSyncV4AppliedEntity[] = [];
        let pageNumber = 0;
        try {
            do {
                const traceId = this.nextTraceId();
                const pageStartedAt = Date.now();
                this.recordDiagnostic({
                    level: 'debug',
                    event: 'transport',
                    phase: 'started',
                    direction: 'inbound',
                    transportOperation: 'snapshot',
                    traceId,
                    page: pageNumber,
                });
                let page: SyncSnapshotResponseV4;
                try {
                    failureKind = 'network';
                    page = await this.transport.getSnapshot(
                        this.sessionId,
                        cursor,
                        SNAPSHOT_PAGE_SIZE,
                        traceId,
                    );
                } catch (error) {
                    this.recordDiagnostic({
                        level: 'error',
                        event: 'transport',
                        phase: 'failed',
                        direction: 'inbound',
                        transportOperation: 'snapshot',
                        traceId,
                        page: pageNumber,
                        durationMs: elapsedMs(pageStartedAt),
                        errorKind: classifySyncV4DiagnosticError(error),
                    });
                    throw error;
                }
                if (!this.isCurrentGeneration(generation)) return;
                failureKind = 'protocol';
                try {
                    if (highWatermark === null) highWatermark = page.highWatermark;
                    if (page.highWatermark !== highWatermark) {
                        throw new AppSyncV4ProtocolError(
                            'Sync v4 snapshot watermark changed during pagination',
                        );
                    }
                    for (const snapshot of page.entities) {
                        if (snapshotEntityIds.has(snapshot.entityId)) {
                            throw new AppSyncV4ProtocolError(
                                'Sync v4 snapshot repeated an entity across pages',
                            );
                        }
                        if (snapshot.updatedSeq > page.highWatermark) {
                            throw new AppSyncV4ProtocolError(
                                'Sync v4 snapshot entity exceeds its high watermark',
                            );
                        }
                        snapshotEntityIds.add(snapshot.entityId);
                    }
                    if (page.nextCursor && seenCursors.has(page.nextCursor)) {
                        throw new AppSyncV4ProtocolError('Sync v4 snapshot pagination stalled');
                    }
                } catch (error) {
                    this.recordDiagnostic({
                        level: 'error',
                        event: 'snapshot',
                        phase: 'failed',
                        direction: 'inbound',
                        transportOperation: 'snapshot',
                        traceId,
                        page: pageNumber,
                        highWatermark: page.highWatermark,
                        count: page.entities.length,
                        durationMs: elapsedMs(pageStartedAt),
                        errorKind: 'protocol',
                    });
                    throw error;
                }
                this.recordDiagnostic({
                    level: 'debug',
                    event: 'transport',
                    phase: 'completed',
                    direction: 'inbound',
                    transportOperation: 'snapshot',
                    traceId,
                    page: pageNumber,
                    highWatermark: page.highWatermark,
                    count: page.entities.length,
                    durationMs: elapsedMs(pageStartedAt),
                });
                const decrypted: Array<{ snapshot: SyncEntitySnapshotV4; entity: CodexEntityV4 }> = [];
                try {
                    failureKind = 'crypto';
                    for (const snapshot of page.entities) {
                        decrypted.push({
                            snapshot,
                            entity: await this.crypto.decryptEntity(
                                toAad(this.sessionId, snapshot),
                                snapshot.ciphertext,
                            ),
                        });
                        if (!this.isCurrentGeneration(generation)) return;
                    }
                } catch (error) {
                    this.recordDiagnostic({
                        level: 'error',
                        event: 'snapshot',
                        phase: 'failed',
                        direction: 'inbound',
                        transportOperation: 'snapshot',
                        traceId,
                        page: pageNumber,
                        highWatermark: page.highWatermark,
                        count: page.entities.length,
                        durationMs: elapsedMs(pageStartedAt),
                        errorKind: diagnosticErrorKind(error, 'crypto'),
                    });
                    throw error;
                }
                try {
                    failureKind = 'storage';
                    this.persistence.applySnapshotPage(
                        this.sessionId,
                        snapshotGeneration,
                        page.entities,
                    );
                } catch (error) {
                    this.recordDiagnostic({
                        level: 'error',
                        event: 'snapshot',
                        phase: 'failed',
                        direction: 'inbound',
                        transportOperation: 'snapshot',
                        traceId,
                        page: pageNumber,
                        highWatermark: page.highWatermark,
                        count: page.entities.length,
                        durationMs: elapsedMs(pageStartedAt),
                        errorKind: 'storage',
                    });
                    throw error;
                }
                for (const { snapshot } of decrypted) {
                    snapshotRevisions.set(
                        snapshot.entityId,
                        Math.max(snapshotRevisions.get(snapshot.entityId) ?? 0, snapshot.revision),
                    );
                }
                replacement.push(...decrypted.map(({ snapshot, entity }) => ({
                    entity,
                    source: 'snapshot' as const,
                    op: snapshot.op,
                    revision: snapshot.revision,
                    seq: snapshot.updatedSeq,
                })));
                cursor = page.nextCursor;
                if (cursor) seenCursors.add(cursor);
                pageNumber += 1;
            } while (cursor);
            if (!this.isCurrentGeneration(generation)) return;

            let pendingOutbox: SyncMutationV4[];
            try {
                failureKind = 'storage';
                pendingOutbox = this.persistence.getPendingOutbox(this.sessionId);
            } catch (error) {
                this.recordDiagnostic({
                    level: 'error',
                    event: 'outbox',
                    phase: 'failed',
                    source: 'cache',
                    errorKind: diagnosticErrorKind(error, 'storage'),
                });
                throw error;
            }
            let committed = false;
            let replacementCount = replacement.length;
            while (!committed) {
                const pendingReplacement: AppSyncV4AppliedEntity[] = [];
                try {
                    failureKind = 'crypto';
                    for (const mutation of pendingOutbox) {
                        if ((snapshotRevisions.get(mutation.entityId) ?? 0) >= mutation.revision) continue;
                        const entity = await this.crypto.decryptEntity(
                            toAad(this.sessionId, mutation),
                            mutation.ciphertext,
                        );
                        if (!this.isCurrentGeneration(generation)) return;
                        pendingReplacement.push({
                            entity,
                            source: 'cache',
                            op: mutation.op,
                            revision: mutation.revision,
                            seq: null,
                        });
                    }
                } catch (error) {
                    this.recordDiagnostic({
                        level: 'error',
                        event: 'outbox',
                        phase: 'failed',
                        source: 'cache',
                        count: pendingOutbox.length,
                        errorKind: diagnosticErrorKind(error, 'crypto'),
                    });
                    throw error;
                }

                // Revalidate at commit so a publish is either replayed by this replacement
                // or persists after it; snapshot network and decryption stay outside the lock.
                await this.publishLock.inLock(async () => {
                    if (!this.isCurrentGeneration(generation)) return;
                    let currentPendingOutbox: SyncMutationV4[];
                    try {
                        failureKind = 'storage';
                        currentPendingOutbox = this.persistence.getPendingOutbox(this.sessionId);
                    } catch (error) {
                        this.recordDiagnostic({
                            level: 'error',
                            event: 'outbox',
                            phase: 'failed',
                            source: 'cache',
                            errorKind: diagnosticErrorKind(error, 'storage'),
                        });
                        throw error;
                    }
                    if (!samePendingOutbox(pendingOutbox, currentPendingOutbox)) {
                        pendingOutbox = currentPendingOutbox;
                        return;
                    }

                    const committedReplacement = [...replacement, ...pendingReplacement];
                    replacementCount = committedReplacement.length;
                    failureKind = 'projection';
                    await this.replaceSnapshotForGeneration(committedReplacement, generation);
                    if (!this.isCurrentGeneration(generation)) return;
                    try {
                        failureKind = 'storage';
                        this.persistence.finishSnapshot(
                            this.sessionId,
                            snapshotGeneration,
                            highWatermark ?? 0,
                        );
                    } catch (error) {
                        this.recordDiagnostic({
                            level: 'error',
                            event: 'cursor',
                            phase: 'failed',
                            direction: 'inbound',
                            cursor: this.receiveCursor,
                            highWatermark: highWatermark ?? 0,
                            count: replacementCount,
                            errorKind: 'storage',
                        });
                        throw error;
                    }
                    committed = true;
                });
                if (!this.isCurrentGeneration(generation)) return;
            }
            this.recordDiagnostic({
                level: 'info',
                event: 'snapshot',
                phase: 'completed',
                direction: 'inbound',
                cursor: highWatermark ?? 0,
                highWatermark: highWatermark ?? 0,
                count: replacementCount,
                page: pageNumber,
                durationMs: elapsedMs(snapshotStartedAt),
            });
        } catch (error) {
            this.recordDiagnostic({
                level: 'error',
                event: 'snapshot',
                phase: 'failed',
                direction: 'inbound',
                count: replacement.length,
                page: pageNumber,
                durationMs: elapsedMs(snapshotStartedAt),
                errorKind: diagnosticErrorKind(error, failureKind),
            });
            throw error;
        }
    }

    private async deliverEntitiesForGeneration(
        events: readonly AppSyncV4AppliedEntity[],
        generation: number,
    ): Promise<void> {
        if (events.length === 0 || !this.isCurrentGeneration(generation)) return;
        const startedAt = Date.now();
        try {
            if (this.onEntities) {
                await this.onEntities(events);
            } else {
                for (const event of events) {
                    if (!this.isCurrentGeneration(generation)) return;
                    await this.onEntity(event);
                }
            }
        } catch (error) {
            this.recordProjectionDiagnostic({
                level: 'error',
                event: 'projection',
                phase: 'failed',
                count: events.length,
                durationMs: elapsedMs(startedAt),
                errorKind: diagnosticErrorKind(error, 'projection'),
                source: uniformProjectionSource(events),
            });
            throw error;
        }
        if (!this.isCurrentGeneration(generation)) return;
        this.recordProjectionSuccess(events, startedAt);
    }

    private async replaceSnapshotForGeneration(
        events: readonly AppSyncV4AppliedEntity[],
        generation: number,
    ): Promise<void> {
        if (!this.isCurrentGeneration(generation)) return;
        const startedAt = Date.now();
        if (this.onSnapshotReplace) {
            try {
                await this.onSnapshotReplace(events);
            } catch (error) {
                this.recordProjectionDiagnostic({
                    level: 'error',
                    event: 'projection',
                    phase: 'failed',
                    count: events.length,
                    durationMs: elapsedMs(startedAt),
                    errorKind: diagnosticErrorKind(error, 'projection'),
                    source: 'snapshot',
                });
                throw error;
            }
            if (!this.isCurrentGeneration(generation)) return;
            this.recordProjectionSuccess(events, startedAt);
            return;
        }
        try {
            await this.onSnapshotReset();
        } catch (error) {
            this.recordProjectionDiagnostic({
                level: 'error',
                event: 'projection',
                phase: 'failed',
                count: events.length,
                durationMs: elapsedMs(startedAt),
                errorKind: diagnosticErrorKind(error, 'projection'),
                source: 'snapshot',
            });
            throw error;
        }
        if (!this.isCurrentGeneration(generation)) return;
        await this.deliverEntitiesForGeneration(events, generation);
    }

    private isCurrentGeneration(generation: number): boolean {
        return !this.disposed && this.lifecycleGeneration === generation;
    }

    private assertCurrentGeneration(generation: number): void {
        if (!this.isCurrentGeneration(generation)) {
            throw new Error('Sync v4 client has been stopped');
        }
    }

    private recordDiagnostic(
        input: Omit<SyncV4DiagnosticInput, 'component' | 'sessionHash'>,
    ): void {
        if (this.diagnosticsSuppressed) return;
        recordSyncV4DiagnosticSafely(this.diagnostics, {
            component: 'app.sync',
            sessionHash: this.diagnosticSessionHash,
            softwareVersion: this.appVersion,
            protocolVersion: 4,
            featureEnabled: true,
            transportSecurity: this.transportSecurity,
            ...input,
        });
    }

    private recordChangesSuccessDiagnostic(
        response: SyncChangesResponseV4,
        traceId: string,
        cursor: number,
        startedAt: number,
    ): void {
        const now = Date.now();
        const hasChanges = response.changes.length > 0;
        if (
            !hasChanges
            && now - this.lastHealthyEmptyPollDiagnosticAt < HEALTHY_EMPTY_POLL_DIAGNOSTIC_INTERVAL_MS
        ) {
            this.suppressedHealthyEmptyPolls += 1;
            this.totalSuppressedHealthyEmptyPolls += 1;
            return;
        }
        this.recordDiagnostic({
            level: 'debug',
            event: 'transport',
            phase: 'completed',
            direction: 'inbound',
            transportOperation: 'changes',
            traceId,
            cursor,
            highWatermark: response.highWatermark,
            count: response.changes.length,
            durationMs: elapsedMs(startedAt),
            ...(this.suppressedHealthyEmptyPolls > 0
                ? { suppressed: this.suppressedHealthyEmptyPolls }
                : {}),
        });
        if (!hasChanges) this.lastHealthyEmptyPollDiagnosticAt = now;
        this.suppressedHealthyEmptyPolls = 0;
    }

    private recordProjectionSuccess(
        events: readonly AppSyncV4AppliedEntity[],
        startedAt: number,
    ): void {
        const now = Date.now();
        const mustRecord = (
            events.some((event) => event.source === 'snapshot')
            || now - this.lastProjectionDiagnosticAt >= PROJECTION_DIAGNOSTIC_INTERVAL_MS
        );
        if (!mustRecord) {
            this.suppressedProjectionBatches += 1;
            this.totalSuppressedProjectionBatches += 1;
            return;
        }
        this.recordProjectionDiagnostic({
            level: 'debug',
            event: 'projection',
            phase: 'applied',
            count: events.length,
            durationMs: elapsedMs(startedAt),
            ...(this.suppressedProjectionBatches > 0
                ? { suppressed: this.suppressedProjectionBatches }
                : {}),
            source: uniformProjectionSource(events),
        });
        this.lastProjectionDiagnosticAt = now;
        this.suppressedProjectionBatches = 0;
    }

    private flushSuppressedProjectionDiagnostics(): void {
        if (this.suppressedProjectionBatches === 0) return;
        this.recordProjectionDiagnostic({
            level: 'debug',
            event: 'projection',
            phase: 'applied',
            count: 0,
            suppressed: this.suppressedProjectionBatches,
        });
        this.suppressedProjectionBatches = 0;
    }

    private flushSuppressedHealthyEmptyPollDiagnostics(): void {
        if (this.suppressedHealthyEmptyPolls === 0) return;
        this.recordDiagnostic({
            level: 'debug',
            event: 'changes',
            phase: 'completed',
            source: 'poll',
            cursor: this.receiveCursor,
            count: 0,
            suppressed: this.suppressedHealthyEmptyPolls,
        });
        this.suppressedHealthyEmptyPolls = 0;
    }

    private recordProjectionDiagnostic(
        input: Omit<SyncV4DiagnosticInput, 'component' | 'sessionHash'>,
    ): void {
        recordSyncV4DiagnosticSafely(this.diagnostics, {
            component: 'app.projection',
            sessionHash: this.diagnosticSessionHash,
            softwareVersion: this.appVersion,
            protocolVersion: 4,
            featureEnabled: true,
            transportSecurity: this.transportSecurity,
            ...input,
        });
    }

    private diagnosticOutboxDepth(): number | undefined {
        try {
            return this.persistence.getPendingOutbox(this.sessionId).length;
        } catch {
            return undefined;
        }
    }

    private nextTraceId(): string {
        return requireSyncV4TraceId(this.generateTraceId());
    }
}

async function createDefaultSyncV4Crypto(
    sessionId: string,
    sessionKey: Uint8Array,
): Promise<AppSyncV4Crypto> {
    const { SyncV4Crypto } = await import('./syncV4Crypto');
    return SyncV4Crypto.create({ sessionId, sessionKey });
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
        throw new Error('Sync v4 mutation response omitted acknowledgements');
    }
    for (let index = 0; index < mutations.length; index += 1) {
        if (
            acknowledgements[index].mutationId !== mutations[index].mutationId
            || acknowledgements[index].revision !== mutations[index].revision
        ) {
            throw new Error('Sync v4 mutation acknowledgement does not match request order');
        }
    }
}

function assertContiguousChanges(changes: SyncChangesResponseV4['changes'], afterSeq: number): void {
    let expectedSeq = afterSeq + 1;
    for (const change of changes) {
        if (change.seq !== expectedSeq) throw new Error(`Sync v4 changes have a gap before sequence ${change.seq}`);
        expectedSeq += 1;
    }
}

function toAad(
    sessionId: string,
    entity: Pick<SyncChangesResponseV4['changes'][number] | SyncEntitySnapshotV4, 'entityId' | 'entityType' | 'revision' | 'op'>,
): SyncV4Aad {
    return {
        sessionId,
        entityId: entity.entityId,
        entityType: entity.entityType,
        revision: entity.revision,
        op: entity.op,
    };
}

function defaultRandomUUID(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    throw new Error('Sync v4 client requires a mutation UUID generator');
}

function defaultTraceId(): string {
    if (typeof globalThis.crypto?.getRandomValues !== 'function') {
        throw new Error('Sync v4 client requires a secure trace ID generator');
    }
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function safeDiagnosticId(value: string): string {
    if (/^[A-Za-z0-9_-]{12,64}$/.test(value)) return value.slice(0, 16);
    let left = 0x811c9dc5;
    let right = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        left = Math.imul(left ^ code, 0x01000193);
        right = Math.imul(right ^ code, 0x85ebca6b);
    }
    return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

function elapsedMs(startedAt: number): number {
    return Math.max(0, Math.trunc(Date.now() - startedAt));
}

function uniformProjectionSource(
    events: readonly AppSyncV4AppliedEntity[],
): AppSyncV4AppliedEntity['source'] | undefined {
    const source = events[0]?.source;
    return source && events.every((event) => event.source === source) ? source : undefined;
}
