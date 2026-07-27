/**
 * App-side Sync v4 coordinator for encrypted Codex entities and commands.
 * Persistent cache/outbox writes always precede receive-cursor or ACK removal.
 */

import {
    MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH,
    MAX_SYNC_V4_MUTATIONS_PER_BATCH,
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
    type SyncV4Aad,
} from '@slopus/happy-wire';
import { AsyncLock } from '@/utils/lock';
import { InvalidateSync } from '@/utils/sync';
import { SyncV4Crypto } from './syncV4Crypto';
import { SyncV4Persistence } from './syncV4Persistence';

const CHANGES_PAGE_SIZE = 100;
const SNAPSHOT_PAGE_SIZE = 500;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface AppSyncV4Transport {
    postMutations(sessionId: string, mutations: SyncMutationV4[]): Promise<SyncMutationBatchResponseV4>;
    getChanges(sessionId: string, afterSeq: number, limit: number): Promise<SyncChangesResponseV4>;
    getSnapshot(sessionId: string, cursor: string | null, limit: number): Promise<SyncSnapshotResponseV4>;
}

export interface AppSyncV4Crypto {
    opaqueEntityId(entityType: CodexEntityV4['entityType'], providerId: string): Promise<string>;
    encryptEntity(aad: SyncV4Aad, entity: CodexEntityV4): Promise<string>;
    decryptEntity(aad: SyncV4Aad, ciphertext: string): Promise<CodexEntityV4>;
}

export class AppSyncV4SnapshotRequiredError extends Error {
    constructor(
        readonly minimumSeq: number,
        readonly highWatermark: number,
    ) {
        super('Sync v4 snapshot required');
    }
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
    persistence: SyncV4Persistence;
    transport: AppSyncV4Transport;
    onEntity: (event: AppSyncV4AppliedEntity) => Promise<void>;
    crypto?: AppSyncV4Crypto;
    generateMutationId?: () => string;
    pollIntervalMs?: number;
}

export class AppSyncV4Client {
    static async create(options: AppSyncV4ClientOptions): Promise<AppSyncV4Client> {
        const crypto = options.crypto ?? await SyncV4Crypto.create({
            sessionId: options.sessionId,
            sessionKey: options.sessionKey,
        });
        return new AppSyncV4Client(
            options.sessionId,
            options.persistence,
            options.transport,
            crypto,
            options.onEntity,
            options.generateMutationId ?? defaultRandomUUID,
            options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        );
    }

    private readonly publishLock = new AsyncLock();
    private readonly sendLock = new AsyncLock();
    private readonly receiveLock = new AsyncLock();
    private readonly sendSync: InvalidateSync;
    private readonly receiveSync: InvalidateSync;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private started = false;

    private constructor(
        readonly sessionId: string,
        private readonly persistence: SyncV4Persistence,
        private readonly transport: AppSyncV4Transport,
        private readonly crypto: AppSyncV4Crypto,
        private readonly onEntity: (event: AppSyncV4AppliedEntity) => Promise<void>,
        private readonly generateMutationId: () => string,
        private readonly pollIntervalMs: number,
    ) {
        this.sendSync = new InvalidateSync(() => this.flushOutboundOnce());
        this.receiveSync = new InvalidateSync(() => this.pullChangesOnce());
    }

    get receiveCursor(): number {
        return this.persistence.getReceiveCursor(this.sessionId);
    }

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        try {
            await this.hydrate();
            await Promise.all([this.flushOutboundOnce(), this.pullChangesOnce()]);
        } catch (error) {
            this.started = false;
            throw error;
        }
        this.pollTimer = setInterval(() => this.receiveSync.invalidate(), this.pollIntervalMs);
    }

    stop(): void {
        this.started = false;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.sendSync.stop();
        this.receiveSync.stop();
    }

    invalidate(highWatermark?: number): void {
        if (!this.started) return;
        if (highWatermark === undefined || highWatermark > this.receiveCursor) this.receiveSync.invalidate();
    }

    async hydrate(): Promise<void> {
        const persistent = this.persistence.loadSession(this.sessionId);
        for (const cached of persistent.entities) {
            const entity = await this.crypto.decryptEntity(toAad(this.sessionId, cached), cached.ciphertext);
            await this.onEntity({
                entity,
                source: 'cache',
                op: cached.op,
                revision: cached.revision,
                seq: cached.updatedSeq,
            });
        }
        if (persistent.snapshotRequired) await this.rebuildFromSnapshot();
    }

    async publishEntity(
        entity: CodexEntityV4,
        op: SyncMutationOperationV4 = 'upsert',
    ): Promise<SyncMutationV4> {
        return (await this.publishEntities([{ entity, op }]))[0];
    }

    async publishEntities(entries: AppSyncV4PublishEntity[]): Promise<SyncMutationV4[]> {
        if (entries.length === 0) return [];
        const mutations = await this.publishLock.inLock(async () => {
            const pendingRevisions = new Map<string, number>();
            const nextMutations: SyncMutationV4[] = [];
            for (const entry of entries) {
                const entityId = await this.crypto.opaqueEntityId(entry.entity.entityType, entry.entity.providerId);
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
            }
            this.persistence.enqueueMutations(this.sessionId, nextMutations);
            return nextMutations;
        });
        if (this.started) this.sendSync.invalidate();
        return mutations;
    }

    async flushOutboundOnce(): Promise<void> {
        await this.sendLock.inLock(async () => {
            while (true) {
                const pending = this.persistence.getPendingOutbox(this.sessionId);
                if (pending.length === 0) return;
                const batch = takeMutationBatch(pending);
                const response = await this.transport.postMutations(this.sessionId, batch);
                validateAcknowledgements(batch, response.acknowledgements);
                this.persistence.acknowledgeMutations(this.sessionId, response.acknowledgements);
            }
        });
    }

    async pullChangesOnce(): Promise<void> {
        await this.receiveLock.inLock(async () => {
            while (true) {
                const cursor = this.receiveCursor;
                let response: SyncChangesResponseV4;
                try {
                    response = await this.transport.getChanges(this.sessionId, cursor, CHANGES_PAGE_SIZE);
                } catch (error) {
                    if (error instanceof AppSyncV4SnapshotRequiredError) {
                        await this.rebuildFromSnapshot();
                        continue;
                    }
                    throw error;
                }
                if (response.highWatermark < cursor) throw new Error('Sync v4 server watermark moved backwards');
                if (response.changes.length === 0) {
                    if (response.hasMore || cursor < response.highWatermark) {
                        throw new Error('Sync v4 changes response has a sequence gap');
                    }
                    return;
                }
                assertContiguousChanges(response.changes, cursor);
                const decrypted: Array<{ change: SyncChangesResponseV4['changes'][number]; entity: CodexEntityV4 }> = [];
                for (const change of response.changes) {
                    decrypted.push({
                        change,
                        entity: await this.crypto.decryptEntity(toAad(this.sessionId, change), change.ciphertext),
                    });
                }
                this.persistence.stageChanges(this.sessionId, response.changes);
                for (const { change, entity } of decrypted) {
                    await this.onEntity({
                        entity,
                        source: 'change',
                        op: change.op,
                        revision: change.revision,
                        seq: change.seq,
                    });
                }
                this.persistence.advanceReceiveCursor(this.sessionId, response.changes.at(-1)!.seq);
                if (!response.hasMore && this.receiveCursor >= response.highWatermark) return;
            }
        });
    }

    private async rebuildFromSnapshot(): Promise<void> {
        this.persistence.beginSnapshot(this.sessionId);
        let cursor: string | null = null;
        let highWatermark: number | null = null;
        const seenCursors = new Set<string>();
        do {
            const page = await this.transport.getSnapshot(this.sessionId, cursor, SNAPSHOT_PAGE_SIZE);
            if (highWatermark === null) highWatermark = page.highWatermark;
            if (page.highWatermark !== highWatermark) {
                throw new Error('Sync v4 snapshot watermark changed during pagination');
            }
            const decrypted: Array<{ snapshot: SyncEntitySnapshotV4; entity: CodexEntityV4 }> = [];
            for (const snapshot of page.entities) {
                decrypted.push({
                    snapshot,
                    entity: await this.crypto.decryptEntity(toAad(this.sessionId, snapshot), snapshot.ciphertext),
                });
            }
            this.persistence.applySnapshotPage(this.sessionId, page.entities);
            for (const { snapshot, entity } of decrypted) {
                await this.onEntity({
                    entity,
                    source: 'snapshot',
                    op: snapshot.op,
                    revision: snapshot.revision,
                    seq: snapshot.updatedSeq,
                });
            }
            cursor = page.nextCursor;
            if (cursor && seenCursors.has(cursor)) throw new Error('Sync v4 snapshot pagination stalled');
            if (cursor) seenCursors.add(cursor);
        } while (cursor);
        this.persistence.finishSnapshot(this.sessionId, highWatermark ?? 0);
    }
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
