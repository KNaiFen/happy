/**
 * Codex Sync v4 transport coordinator.
 *
 * Send acknowledgements and receive cursors are deliberately independent.
 * Every network-visible operation is backed by SyncV4Journal first.
 */

import {
    MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH,
    MAX_SYNC_V4_MUTATIONS_PER_BATCH,
    SyncChangesResponseV4Schema,
    SyncMutationBatchResponseV4Schema,
    SyncMutationBatchV4Schema,
    SyncMutationV4Schema,
    SyncSnapshotRequiredV4Schema,
    SyncSnapshotResponseV4Schema,
    syncV4Utf8ByteLength,
    type CodexEntityV4,
    type CodexCommandEntityV4,
    type CodexCommandResultEntityV4,
    type SyncAckV4,
    type SyncChangeV4,
    type SyncEntitySnapshotV4,
    type SyncMutationBatchResponseV4,
    type SyncMutationOperationV4,
    type SyncMutationV4,
    type SyncSnapshotResponseV4,
} from "@slopus/happy-wire";
import { configuration } from "@/configuration";
import { AsyncLock } from "@/utils/lock";
import { InvalidateSync } from "@/utils/sync";
import axios from "axios";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SyncV4Crypto } from "./syncV4Crypto";
import {
    SyncV4Journal,
    type SyncV4CommandJournalStatus,
} from "./syncV4Journal";

const CHANGES_PAGE_SIZE = 100;
const SNAPSHOT_PAGE_SIZE = 500;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface SyncV4Transport {
    postMutations(sessionId: string, mutations: SyncMutationV4[]): Promise<SyncMutationBatchResponseV4>;
    getChanges(sessionId: string, afterSeq: number, limit: number): Promise<ReturnType<typeof SyncChangesResponseV4Schema.parse>>;
    getSnapshot(sessionId: string, cursor: string | null, limit: number): Promise<SyncSnapshotResponseV4>;
}

export class SyncV4SnapshotRequiredError extends Error {
    constructor(
        readonly minimumSeq: number,
        readonly highWatermark: number,
    ) {
        super("Sync v4 snapshot required");
    }
}

export class AxiosSyncV4Transport implements SyncV4Transport {
    constructor(
        private readonly serverUrl: string,
        private readonly token: string,
        private readonly happyClient: string,
    ) {}

    async postMutations(sessionId: string, mutations: SyncMutationV4[]): Promise<SyncMutationBatchResponseV4> {
        const body = SyncMutationBatchV4Schema.parse({ mutations });
        const response = await axios.post(
            `${this.serverUrl}/v4/sessions/${encodeURIComponent(sessionId)}/mutations`,
            body,
            { headers: this.headers(), timeout: 60_000 },
        );
        return SyncMutationBatchResponseV4Schema.parse(response.data);
    }

    async getChanges(
        sessionId: string,
        afterSeq: number,
        limit: number,
    ): Promise<ReturnType<typeof SyncChangesResponseV4Schema.parse>> {
        try {
            const response = await axios.get(
                `${this.serverUrl}/v4/sessions/${encodeURIComponent(sessionId)}/changes`,
                {
                    params: { after_seq: afterSeq, limit },
                    headers: this.headers(),
                    timeout: 60_000,
                },
            );
            return SyncChangesResponseV4Schema.parse(response.data);
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 410) {
                const required = SyncSnapshotRequiredV4Schema.parse(error.response.data);
                throw new SyncV4SnapshotRequiredError(required.minimumSeq, required.highWatermark);
            }
            throw error;
        }
    }

    async getSnapshot(sessionId: string, cursor: string | null, limit: number): Promise<SyncSnapshotResponseV4> {
        const response = await axios.get(
            `${this.serverUrl}/v4/sessions/${encodeURIComponent(sessionId)}/snapshot`,
            {
                params: { ...(cursor ? { cursor } : {}), limit },
                headers: this.headers(),
                timeout: 60_000,
            },
        );
        return SyncSnapshotResponseV4Schema.parse(response.data);
    }

    private headers(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "X-Happy-Client": this.happyClient,
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
    serverUrl?: string;
    journalRoot?: string;
    pollIntervalMs?: number;
}

export class SyncV4Client {
    static async create(options: SyncV4ClientOptions): Promise<SyncV4Client> {
        const journal = await SyncV4Journal.open({
            rootDir: options.journalRoot ?? join(configuration.happyHomeDir, "sync-v4"),
            sessionId: options.sessionId,
        });
        const crypto = await SyncV4Crypto.create({ sessionId: options.sessionId, sessionKey: options.sessionKey });
        const transport = options.transport ?? new AxiosSyncV4Transport(
            options.serverUrl ?? configuration.serverUrl,
            requiredToken(options.token),
            `cli-coding-session/${configuration.currentCliVersion}`,
        );
        return new SyncV4Client(
            options.sessionId,
            journal,
            crypto,
            transport,
            options.onEntity,
            options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        );
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

    private constructor(
        readonly sessionId: string,
        private readonly journal: SyncV4Journal,
        private readonly crypto: SyncV4Crypto,
        private readonly transport: SyncV4Transport,
        private readonly onEntity: (event: SyncV4AppliedEntity) => Promise<void>,
        private readonly pollIntervalMs: number,
    ) {
        this.sendSync = new InvalidateSync(() => this.flushOutboundForGeneration(this.lifecycleGeneration));
        this.receiveSync = new InvalidateSync(() => this.pullChangesForGeneration(this.lifecycleGeneration));
    }

    get producerId(): string {
        return this.journal.producerId;
    }

    get receiveCursor(): number {
        return this.journal.snapshot().receiveCursor;
    }

    async start(): Promise<void> {
        if (this.started) return;
        if (this.disposed) throw new Error("Sync v4 client has been stopped");
        const generation = this.lifecycleGeneration;
        this.started = true;
        try {
            await this.processPendingInbound(generation);
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
            throw error;
        }
        this.pollTimer = setInterval(() => this.receiveSync.invalidate(), this.pollIntervalMs);
        this.pollTimer.unref();
    }

    stop(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.started = false;
        this.lifecycleGeneration += 1;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.sendSync.stop();
        this.receiveSync.stop();
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
        const generation = this.lifecycleGeneration;
        this.assertCurrentGeneration(generation);
        const mutations = await this.publishLock.inLock(async () => {
            this.assertCurrentGeneration(generation);
            const pendingRevisions = new Map<string, number>();
            const nextMutations: SyncMutationV4[] = [];
            for (const entry of entries) {
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
        const generation = this.lifecycleGeneration;
        this.assertCurrentGeneration(generation);
        const mutation = await this.publishLock.inLock(async () => {
            this.assertCurrentGeneration(generation);
            const entityId = await this.crypto.opaqueEntityId(result.entityType, result.providerId);
            this.assertCurrentGeneration(generation);
            const revision = this.journal.nextRevision(entityId);
            const aad = {
                sessionId: this.sessionId,
                entityId,
                entityType: result.entityType,
                revision,
                op: "upsert" as const,
            };
            const next = SyncMutationV4Schema.parse({
                mutationId: randomUUID(),
                producerId: this.producerId,
                entityId,
                entityType: result.entityType,
                revision,
                op: aad.op,
                ciphertext: await this.crypto.encryptEntity(aad, result),
            });
            this.assertCurrentGeneration(generation);
            await this.journal.appendCommandTransition(command.commandId, status, next, command);
            return next;
        });
        if (this.started) this.sendSync.invalidate();
        return mutation;
    }

    async flushOutboundOnce(): Promise<void> {
        await this.flushOutboundForGeneration(this.lifecycleGeneration);
    }

    private async flushOutboundForGeneration(generation: number): Promise<void> {
        await this.sendLock.inLock(async () => {
            while (true) {
                if (!this.isCurrentGeneration(generation)) return;
                const pending = this.journal.snapshot().pendingOutbound;
                if (pending.length === 0) break;
                const batch = takeMutationBatch(pending);
                const response = await this.transport.postMutations(this.sessionId, batch);
                if (!this.isCurrentGeneration(generation)) return;
                validateAcknowledgements(batch, response.acknowledgements);
                await this.journal.appendAcknowledgements(response.acknowledgements);
            }
            if (!this.isCurrentGeneration(generation)) return;
            await this.journal.compactIfNeeded();
        });
    }

    async pullChangesOnce(): Promise<void> {
        await this.pullChangesForGeneration(this.lifecycleGeneration);
    }

    private async pullChangesForGeneration(generation: number): Promise<void> {
        await this.receiveLock.inLock(async () => {
            if (!this.isCurrentGeneration(generation)) return;
            await this.processPendingInbound(generation);
            while (true) {
                if (!this.isCurrentGeneration(generation)) return;
                const cursor = this.receiveCursor;
                let response: ReturnType<typeof SyncChangesResponseV4Schema.parse>;
                try {
                    response = await this.transport.getChanges(this.sessionId, cursor, CHANGES_PAGE_SIZE);
                } catch (error) {
                    if (!this.isCurrentGeneration(generation)) return;
                    if (error instanceof SyncV4SnapshotRequiredError) {
                        await this.rebuildFromSnapshot(generation);
                        continue;
                    }
                    throw error;
                }
                if (!this.isCurrentGeneration(generation)) return;
                if (response.highWatermark < cursor) {
                    throw new Error("Sync v4 server watermark moved backwards");
                }
                if (response.changes.length === 0) {
                    if (response.hasMore || cursor < response.highWatermark) {
                        throw new Error("Sync v4 changes response has a sequence gap");
                    }
                    break;
                }
                assertContiguousChanges(response.changes, cursor);
                await this.journal.appendInbound(response.changes);
                if (!this.isCurrentGeneration(generation)) return;
                await this.processPendingInbound(generation);
                if (!response.hasMore && this.receiveCursor >= response.highWatermark) break;
            }
            if (!this.isCurrentGeneration(generation)) return;
            await this.journal.compactIfNeeded();
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

    async setCommandStatus(
        commandId: string,
        status: SyncV4CommandJournalStatus,
        command?: CodexCommandEntityV4,
    ): Promise<void> {
        this.assertCurrentGeneration(this.lifecycleGeneration);
        await this.journal.setCommandStatus(commandId, status, command);
    }

    private async processPendingInbound(generation: number): Promise<void> {
        if (!this.isCurrentGeneration(generation)) return;
        const snapshot = this.journal.snapshot();
        let expectedSeq = snapshot.receiveCursor + 1;
        for (const change of snapshot.pendingInbound) {
            if (!this.isCurrentGeneration(generation)) return;
            if (change.seq !== expectedSeq) {
                throw new Error(`Sync v4 inbound journal has a gap before sequence ${change.seq}`);
            }
            const currentRevision = this.journal.snapshot().entityRevisions.get(change.entityId) ?? 0;
            if (change.revision <= currentRevision) {
                await this.journal.advanceReceiveCursor(change.seq);
                expectedSeq += 1;
                continue;
            }
            const entity = await this.crypto.decryptEntity(toAad(this.sessionId, change), change.ciphertext);
            if (!this.isCurrentGeneration(generation)) return;
            await this.onEntity({
                entity,
                source: "change",
                op: change.op,
                revision: change.revision,
                seq: change.seq,
            });
            if (!this.isCurrentGeneration(generation)) return;
            await this.journal.completeInbound(change.entityId, change.revision, change.seq);
            expectedSeq += 1;
        }
    }

    private async rebuildFromSnapshot(generation: number): Promise<void> {
        if (!this.isCurrentGeneration(generation)) return;
        let cursor: string | null = null;
        let highWatermark: number | null = null;
        const seenCursors = new Set<string>();
        const appliedRevisions: Array<{ entityId: string; revision: number }> = [];
        do {
            const page = await this.transport.getSnapshot(this.sessionId, cursor, SNAPSHOT_PAGE_SIZE);
            if (!this.isCurrentGeneration(generation)) return;
            if (highWatermark === null) highWatermark = page.highWatermark;
            if (page.highWatermark !== highWatermark) {
                throw new Error("Sync v4 snapshot watermark changed during pagination");
            }
            for (const snapshotEntity of page.entities) {
                const currentRevision = this.journal.snapshot().entityRevisions.get(snapshotEntity.entityId) ?? 0;
                if (snapshotEntity.revision <= currentRevision) continue;
                const entity = await this.crypto.decryptEntity(
                    toAad(this.sessionId, snapshotEntity),
                    snapshotEntity.ciphertext,
                );
                if (!this.isCurrentGeneration(generation)) return;
                await this.onEntity({
                    entity,
                    source: "snapshot",
                    op: snapshotEntity.op,
                    revision: snapshotEntity.revision,
                    seq: null,
                });
                if (!this.isCurrentGeneration(generation)) return;
                appliedRevisions.push({ entityId: snapshotEntity.entityId, revision: snapshotEntity.revision });
            }
            cursor = page.nextCursor;
            if (cursor && seenCursors.has(cursor)) throw new Error("Sync v4 snapshot pagination stalled");
            if (cursor) seenCursors.add(cursor);
        } while (cursor);
        if (!this.isCurrentGeneration(generation)) return;
        await this.journal.completeSnapshot(appliedRevisions, highWatermark ?? 0);
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
