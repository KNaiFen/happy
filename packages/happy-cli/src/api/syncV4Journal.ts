/**
 * Durable append-only state for Codex Sync v4.
 *
 * The journal is authoritative for outbound FIFO ordering, inbound replay,
 * receive cursors, entity revisions, non-idempotent command state, and
 * provider requests that cannot survive an app-server process restart.
 */

import {
    CodexCommandEntityV4Schema,
    CodexRequestEntityV4Schema,
    SyncAckV4Schema,
    SyncChangeV4Schema,
    SyncMutationV4Schema,
    type CodexCommandEntityV4,
    type CodexRequestEntityV4,
    type SyncAckV4,
    type SyncChangeV4,
    type SyncMutationV4,
} from "@slopus/happy-wire";
import { AsyncLock } from "@/utils/lock";
import { createHash, randomUUID } from "node:crypto";
import {
    closeSync,
    constants,
    fsyncSync,
    openSync,
    readFileSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import {
    chmod,
    mkdir,
    open,
    readFile,
    rename,
    stat,
    truncate,
    unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const JOURNAL_VERSION = 1;
const DEFAULT_COMPACTION_BYTES = 8 * 1024 * 1024;
const INVALID_LEASE_GRACE_MS = 30_000;
const activeJournalLeases = new Map<string, string>();

export const SyncV4CommandJournalStatusSchema = z.enum([
    "received",
    "executing",
    "succeeded",
    "failed",
    "resultUnknown",
    "notReplayed",
]);
export type SyncV4CommandJournalStatus = z.infer<typeof SyncV4CommandJournalStatusSchema>;

export const SyncV4MigrationJournalStateSchema = z.enum([
    "pending",
    "importing",
    "activating",
    "ready",
    "error",
]);
export type SyncV4MigrationJournalState = z.infer<typeof SyncV4MigrationJournalStateSchema>;

export const SyncV4ProviderRequestJournalStateSchema = z.enum([
    "pending",
    "responseReady",
    "responseSupplied",
    "resolved",
    "outcomeUnknown",
]);
export type SyncV4ProviderRequestJournalState = z.infer<
    typeof SyncV4ProviderRequestJournalStateSchema
>;

export const SyncV4CodexThreadRouteKindSchema = z.enum([
    "root",
    "userFork",
    "providerChild",
    "detachedReview",
]);
export type SyncV4CodexThreadRouteKind = z.infer<typeof SyncV4CodexThreadRouteKindSchema>;

const syncV4CodexNotificationSchema = z.object({
    method: z.string().min(1).max(256),
    params: z.json(),
}).strict();
export type SyncV4CodexNotification = z.infer<typeof syncV4CodexNotificationSchema>;

export const SyncV4CodexThreadRouteSchema = z.object({
    threadId: z.string().min(1).max(512),
    kind: SyncV4CodexThreadRouteKindSchema,
    parentThreadId: z.string().min(1).max(512).nullable(),
    parentTurnId: z.string().min(1).max(512).nullable(),
    delegationItemId: z.string().min(1).max(512).nullable(),
    depth: z.number().int().nonnegative().max(1_000),
    status: z.enum([
        "starting",
        "active",
        "completed",
        "failed",
        "interrupted",
    ]).optional(),
    activeTurnId: z.string().min(1).max(512).nullable().optional(),
    coordinatedCommandId: z.string().min(1).max(512).optional(),
}).strict();
export type SyncV4CodexThreadRoute = z.infer<typeof SyncV4CodexThreadRouteSchema>;

// Read journals written by the first Sync v4 implementation. Compaction
// rewrites this legacy terminal state as no provider-request record.
const syncV4ProviderRequestRecordStateSchema = z.union([
    SyncV4ProviderRequestJournalStateSchema,
    z.literal("completed"),
]);

const journalRecordSchema = z.discriminatedUnion("kind", [
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal("outbound"),
        mutation: SyncMutationV4Schema,
        enqueuedAt: z.number().int().nonnegative().optional(),
    }).strict(),
    z.object({ version: z.literal(JOURNAL_VERSION), kind: z.literal("ack"), acknowledgement: SyncAckV4Schema }).strict(),
    z.object({ version: z.literal(JOURNAL_VERSION), kind: z.literal("inbound"), change: SyncChangeV4Schema }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal("cursor"),
        seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal("revision"),
        entityId: z.string().min(1).max(200),
        revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal("command"),
        commandId: z.string().min(1).max(512),
        status: SyncV4CommandJournalStatusSchema,
        updatedAt: z.number().int().nonnegative(),
        command: CodexCommandEntityV4Schema.optional(),
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal("inboundComplete"),
        entityId: z.string().min(1).max(200),
        revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal("snapshotComplete"),
        revisions: z.array(z.object({
            entityId: z.string().min(1).max(200),
            revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        }).strict()),
        seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal("commandTransition"),
        commandId: z.string().min(1).max(512),
        status: SyncV4CommandJournalStatusSchema,
        updatedAt: z.number().int().nonnegative(),
        mutation: SyncMutationV4Schema,
        command: CodexCommandEntityV4Schema.optional(),
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal("providerRequest"),
        request: CodexRequestEntityV4Schema,
        state: syncV4ProviderRequestRecordStateSchema,
        response: z.json().nullable().optional(),
        updatedAt: z.number().int().nonnegative(),
        mutation: SyncMutationV4Schema.optional(),
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal("migration"),
        threadId: z.string().min(1).max(512),
        state: SyncV4MigrationJournalStateSchema,
        updatedAt: z.number().int().nonnegative(),
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal("codexOrphanEnqueued"),
        notificationId: z.string().uuid(),
        threadId: z.string().min(1).max(512),
        notification: syncV4CodexNotificationSchema,
        receivedAt: z.number().int().nonnegative(),
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal("codexOrphanCompleted"),
        notificationId: z.string().uuid(),
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal("codexThreadRoute"),
        route: SyncV4CodexThreadRouteSchema,
        updatedAt: z.number().int().nonnegative(),
    }).strict(),
]);
type JournalRecord = z.infer<typeof journalRecordSchema>;

interface SyncV4JournalOptions {
    rootDir: string;
    sessionId: string;
    compactionBytes?: number;
    now?: () => number;
}

export interface SyncV4JournalSnapshot {
    producerId: string;
    receiveCursor: number;
    pendingOutbound: SyncMutationV4[];
    pendingInbound: SyncChangeV4[];
    entityRevisions: ReadonlyMap<string, number>;
    commandStatuses: ReadonlyMap<string, SyncV4CommandJournalStatus>;
    commands: ReadonlyMap<string, CodexCommandEntityV4>;
    pendingProviderRequests: ReadonlyMap<string, SyncV4PendingProviderRequest>;
    migrationStates: ReadonlyMap<string, SyncV4MigrationJournalState>;
    pendingCodexNotifications: readonly SyncV4PendingCodexNotification[];
    codexThreadRoutes: ReadonlyMap<string, SyncV4CodexThreadRoute>;
}

export interface SyncV4PendingProviderRequest {
    request: CodexRequestEntityV4;
    state: Extract<
        SyncV4ProviderRequestJournalState,
        "pending" | "responseReady" | "responseSupplied"
    >;
    response: CodexRequestEntityV4["response"];
}

export interface SyncV4PendingCodexNotification {
    notificationId: string;
    threadId: string;
    notification: SyncV4CodexNotification;
    receivedAt: number;
}

export interface SyncV4JournalDiagnostics {
    pendingOutboundDepth: number;
    pendingOutboundOldestAgeMs: number | null;
    pendingInboundDepth: number;
    pendingInboundOldestAgeMs: number | null;
}

export class SyncV4JournalCorruptionError extends Error {
    constructor(readonly line: number) {
        super(`Sync v4 journal is corrupt at line ${line}`);
    }
}

export class SyncV4JournalLeaseError extends Error {
    constructor() {
        super("Sync v4 journal already has an active writer");
    }
}

export class SyncV4JournalDurabilityError extends Error {
    constructor(options?: ErrorOptions) {
        super("Sync v4 journal durability is uncertain; reopen before writing again", options);
    }
}

interface SyncV4JournalLease {
    fd: number;
    lockPath: string;
    payload: string;
}

/**
 * Opens one session journal and repairs only an incomplete final JSONL record.
 */
export class SyncV4Journal {
    static async open(options: SyncV4JournalOptions): Promise<SyncV4Journal> {
        await mkdir(options.rootDir, { recursive: true, mode: 0o700 });
        await chmod(options.rootDir, 0o700);
        const producerId = await loadOrCreateProducerId(options.rootDir);
        const journalName = `${createHash("sha256").update(options.sessionId).digest("hex")}.jsonl`;
        const journalPath = join(options.rootDir, journalName);
        const lease = acquireJournalLease(`${journalPath}.lock`, options.now ?? Date.now);
        try {
            const loaded = await loadJournal(journalPath);
            return new SyncV4Journal(
                journalPath,
                options.rootDir,
                producerId,
                options.compactionBytes ?? DEFAULT_COMPACTION_BYTES,
                options.now ?? Date.now,
                loaded,
                lease,
            );
        } catch (error) {
            releaseJournalLease(lease);
            throw error;
        }
    }

    private readonly lock = new AsyncLock();
    private receiveCursor = 0;
    private readonly pendingOutbound = new Map<string, SyncMutationV4>();
    private readonly pendingOutboundEnqueuedAt = new Map<string, number>();
    private readonly pendingInbound = new Map<number, SyncChangeV4>();
    private readonly entityRevisions = new Map<string, number>();
    private readonly commandStatuses = new Map<string, SyncV4CommandJournalStatus>();
    private readonly commandUpdatedAt = new Map<string, number>();
    private readonly commands = new Map<string, CodexCommandEntityV4>();
    private readonly pendingProviderRequests = new Map<string, SyncV4PendingProviderRequest>();
    private readonly migrationStates = new Map<string, SyncV4MigrationJournalState>();
    private readonly pendingCodexNotifications = new Map<string, SyncV4PendingCodexNotification>();
    private readonly codexThreadRoutes = new Map<string, SyncV4CodexThreadRoute>();
    private poisonedCause: unknown = null;
    private closed = false;
    private closePromise: Promise<void> | null = null;

    private constructor(
        private readonly journalPath: string,
        private readonly rootDir: string,
        readonly producerId: string,
        private readonly compactionBytes: number,
        private readonly now: () => number,
        records: JournalRecord[],
        private readonly lease: SyncV4JournalLease,
    ) {
        for (const record of records) this.applyRecord(record);
    }

    snapshot(): SyncV4JournalSnapshot {
        return {
            producerId: this.producerId,
            receiveCursor: this.receiveCursor,
            pendingOutbound: [...this.pendingOutbound.values()],
            pendingInbound: [...this.pendingInbound.values()].sort((left, right) => left.seq - right.seq),
            entityRevisions: new Map(this.entityRevisions),
            commandStatuses: new Map(this.commandStatuses),
            commands: new Map(this.commands),
            pendingProviderRequests: new Map(this.pendingProviderRequests),
            migrationStates: new Map(this.migrationStates),
            pendingCodexNotifications: [...this.pendingCodexNotifications.values()],
            codexThreadRoutes: new Map(this.codexThreadRoutes),
        };
    }

    async close(): Promise<void> {
        if (this.closePromise) return await this.closePromise;
        this.closed = true;
        this.closePromise = this.lock.inLock(() => {
            releaseJournalLease(this.lease);
        });
        return await this.closePromise;
    }

    nextRevision(entityId: string): number {
        this.assertWritable();
        return (this.entityRevisions.get(entityId) ?? 0) + 1;
    }

    diagnostics(now: number = this.now()): SyncV4JournalDiagnostics {
        const outboundOldestAt = minimum(this.pendingOutboundEnqueuedAt.values());
        const inboundOldestAt = minimum([...this.pendingInbound.values()].map((change) => change.createdAt));
        return {
            pendingOutboundDepth: this.pendingOutbound.size,
            pendingOutboundOldestAgeMs: outboundOldestAt === null ? null : Math.max(0, now - outboundOldestAt),
            pendingInboundDepth: this.pendingInbound.size,
            pendingInboundOldestAgeMs: inboundOldestAt === null ? null : Math.max(0, now - inboundOldestAt),
        };
    }

    async appendOutbound(mutations: SyncMutationV4[]): Promise<void> {
        if (mutations.length === 0) return;
        const enqueuedAt = this.now();
        await this.appendRecords(mutations.map((mutation) => ({
            version: JOURNAL_VERSION,
            kind: "outbound",
            mutation,
            enqueuedAt,
        })));
    }

    async appendAcknowledgements(acknowledgements: SyncAckV4[]): Promise<void> {
        await this.appendRecords(acknowledgements.map((acknowledgement) => ({
            version: JOURNAL_VERSION,
            kind: "ack",
            acknowledgement,
        })));
    }

    async appendInbound(changes: SyncChangeV4[]): Promise<void> {
        await this.appendRecords(changes.map((change) => ({
            version: JOURNAL_VERSION,
            kind: "inbound",
            change,
        })));
    }

    async advanceReceiveCursor(seq: number): Promise<void> {
        if (!Number.isSafeInteger(seq) || seq < this.receiveCursor) {
            throw new Error("Sync v4 receive cursor must advance monotonically");
        }
        if (seq === this.receiveCursor) return;
        await this.appendRecords([{ version: JOURNAL_VERSION, kind: "cursor", seq }]);
    }

    async recordEntityRevisions(revisions: Array<{ entityId: string; revision: number }>): Promise<void> {
        await this.appendRecords(revisions.map(({ entityId, revision }) => ({
            version: JOURNAL_VERSION,
            kind: "revision",
            entityId,
            revision,
        })));
    }

    async completeInbound(entityId: string, revision: number, seq: number): Promise<void> {
        if (!Number.isSafeInteger(seq) || seq < this.receiveCursor) {
            throw new Error("Sync v4 receive cursor must advance monotonically");
        }
        await this.appendRecords([{
            version: JOURNAL_VERSION,
            kind: "inboundComplete",
            entityId,
            revision,
            seq,
        }]);
    }

    async completeSnapshot(
        revisions: Array<{ entityId: string; revision: number }>,
        seq: number,
    ): Promise<void> {
        if (!Number.isSafeInteger(seq) || seq < this.receiveCursor) {
            throw new Error("Sync v4 receive cursor must advance monotonically");
        }
        await this.appendRecords([{
            version: JOURNAL_VERSION,
            kind: "snapshotComplete",
            revisions,
            seq,
        }]);
    }

    async setCommandStatus(
        commandId: string,
        status: SyncV4CommandJournalStatus,
        command?: CodexCommandEntityV4,
    ): Promise<void> {
        await this.appendRecords([{
            version: JOURNAL_VERSION,
            kind: "command",
            commandId,
            status,
            updatedAt: this.now(),
            ...(command ? { command } : {}),
        }]);
    }

    async appendCommandTransition(
        commandId: string,
        status: SyncV4CommandJournalStatus,
        mutation: SyncMutationV4,
        command?: CodexCommandEntityV4,
    ): Promise<void> {
        await this.appendRecords([{
            version: JOURNAL_VERSION,
            kind: "commandTransition",
            commandId,
            status,
            updatedAt: this.now(),
            mutation,
            ...(command ? { command } : {}),
        }]);
    }

    async appendProviderRequestTransition(
        request: CodexRequestEntityV4,
        state: SyncV4ProviderRequestJournalState,
        mutation?: SyncMutationV4,
        response?: CodexRequestEntityV4["response"],
    ): Promise<void> {
        await this.appendRecords([{
            version: JOURNAL_VERSION,
            kind: "providerRequest",
            request,
            state,
            updatedAt: this.now(),
            ...(response === undefined ? {} : { response }),
            ...(mutation ? { mutation } : {}),
        }]);
    }

    getMigrationState(threadId: string): SyncV4MigrationJournalState | undefined {
        return this.migrationStates.get(threadId);
    }

    async setMigrationState(threadId: string, state: SyncV4MigrationJournalState): Promise<void> {
        await this.appendRecords([{
            version: JOURNAL_VERSION,
            kind: "migration",
            threadId,
            state,
            updatedAt: this.now(),
        }]);
    }

    async appendCodexOrphan(
        threadId: string,
        notification: SyncV4CodexNotification,
    ): Promise<SyncV4PendingCodexNotification> {
        const pending = {
            notificationId: randomUUID(),
            threadId,
            notification: syncV4CodexNotificationSchema.parse(notification),
            receivedAt: this.now(),
        };
        await this.appendRecords([{
            version: JOURNAL_VERSION,
            kind: "codexOrphanEnqueued",
            ...pending,
        }]);
        return pending;
    }

    async completeCodexOrphan(notificationId: string): Promise<void> {
        await this.appendRecords([{
            version: JOURNAL_VERSION,
            kind: "codexOrphanCompleted",
            notificationId,
        }]);
    }

    async setCodexThreadRoute(route: SyncV4CodexThreadRoute): Promise<void> {
        await this.appendRecords([{
            version: JOURNAL_VERSION,
            kind: "codexThreadRoute",
            route: SyncV4CodexThreadRouteSchema.parse(route),
            updatedAt: this.now(),
        }]);
    }

    async compactIfNeeded(): Promise<void> {
        this.assertWritable();
        await this.lock.inLock(async () => {
            this.assertWritable();
            let currentSize = 0;
            try {
                currentSize = (await stat(this.journalPath)).size;
            } catch (error) {
                if (!isNodeError(error, "ENOENT")) throw error;
            }
            const records = this.compactedRecords();
            const compactedSize = Buffer.byteLength(serializeRecords(records), "utf8");
            if (Math.max(0, currentSize - compactedSize) < this.compactionBytes) return;
            await this.replaceJournal(records);
        });
    }

    async compact(): Promise<void> {
        this.assertWritable();
        await this.lock.inLock(async () => {
            this.assertWritable();
            await this.replaceJournal(this.compactedRecords());
        });
    }

    private async appendRecords(records: JournalRecord[]): Promise<void> {
        if (records.length === 0) return;
        this.assertWritable();
        await this.lock.inLock(async () => {
            this.assertWritable();
            let handle: Awaited<ReturnType<typeof open>> | null = null;
            try {
                handle = await open(this.journalPath, "a", 0o600);
                await handle.writeFile(serializeRecords(records), "utf8");
                await handle.sync();
                await handle.close();
                handle = null;
            } catch (cause) {
                if (handle) await handle.close().catch(() => undefined);
                this.poisonedCause = cause;
                throw new SyncV4JournalDurabilityError({ cause });
            }
            for (const record of records) this.applyRecord(record);
        });
    }

    private compactedRecords(): JournalRecord[] {
        const records: JournalRecord[] = [];
        for (const mutation of this.pendingOutbound.values()) {
            const enqueuedAt = this.pendingOutboundEnqueuedAt.get(mutation.mutationId);
            records.push({
                version: JOURNAL_VERSION,
                kind: "outbound",
                mutation,
                ...(enqueuedAt === undefined ? {} : { enqueuedAt }),
            });
        }
        for (const change of [...this.pendingInbound.values()].sort((left, right) => left.seq - right.seq)) {
            records.push({ version: JOURNAL_VERSION, kind: "inbound", change });
        }
        for (const [entityId, revision] of this.entityRevisions) {
            records.push({ version: JOURNAL_VERSION, kind: "revision", entityId, revision });
        }
        for (const [commandId, status] of this.commandStatuses) {
            const command = this.commands.get(commandId);
            records.push({
                version: JOURNAL_VERSION,
                kind: "command",
                commandId,
                status,
                updatedAt: this.commandUpdatedAt.get(commandId) ?? this.now(),
                ...(command && isPendingCommandStatus(status) ? { command } : {}),
            });
        }
        for (const pending of this.pendingProviderRequests.values()) {
            records.push({
                version: JOURNAL_VERSION,
                kind: "providerRequest",
                request: pending.request,
                state: pending.state,
                response: pending.response,
                updatedAt: this.now(),
            });
        }
        for (const [threadId, state] of this.migrationStates) {
            records.push({
                version: JOURNAL_VERSION,
                kind: "migration",
                threadId,
                state,
                updatedAt: this.now(),
            });
        }
        for (const pending of this.pendingCodexNotifications.values()) {
            records.push({
                version: JOURNAL_VERSION,
                kind: "codexOrphanEnqueued",
                ...pending,
            });
        }
        for (const route of this.codexThreadRoutes.values()) {
            records.push({
                version: JOURNAL_VERSION,
                kind: "codexThreadRoute",
                route,
                updatedAt: this.now(),
            });
        }
        if (this.receiveCursor > 0) {
            records.push({ version: JOURNAL_VERSION, kind: "cursor", seq: this.receiveCursor });
        }
        return records;
    }

    private async replaceJournal(records: JournalRecord[]): Promise<void> {
        const temporaryPath = `${this.journalPath}.${randomUUID()}.tmp`;
        let handle: Awaited<ReturnType<typeof open>> | null = null;
        try {
            handle = await open(temporaryPath, "wx", 0o600);
            await handle.writeFile(serializeRecords(records), "utf8");
            await handle.sync();
            await handle.close();
            handle = null;
            await rename(temporaryPath, this.journalPath);
            await syncDirectory(this.rootDir);
        } catch (cause) {
            if (handle) await handle.close().catch(() => undefined);
            await unlink(temporaryPath).catch(() => undefined);
            this.poisonedCause = cause;
            throw new SyncV4JournalDurabilityError({ cause });
        }
    }

    private assertWritable(): void {
        if (this.poisonedCause) {
            throw new SyncV4JournalDurabilityError({ cause: this.poisonedCause });
        }
        if (this.closed) throw new Error("Sync v4 journal has been closed");
    }

    private applyRecord(record: JournalRecord): void {
        switch (record.kind) {
            case "outbound":
                this.pendingOutbound.set(record.mutation.mutationId, record.mutation);
                if (record.enqueuedAt !== undefined) {
                    this.pendingOutboundEnqueuedAt.set(
                        record.mutation.mutationId,
                        Math.min(
                            this.pendingOutboundEnqueuedAt.get(record.mutation.mutationId) ?? record.enqueuedAt,
                            record.enqueuedAt,
                        ),
                    );
                }
                this.applyRevision(record.mutation.entityId, record.mutation.revision);
                return;
            case "ack":
                this.pendingOutbound.delete(record.acknowledgement.mutationId);
                this.pendingOutboundEnqueuedAt.delete(record.acknowledgement.mutationId);
                return;
            case "inbound":
                if (record.change.seq > this.receiveCursor) this.pendingInbound.set(record.change.seq, record.change);
                return;
            case "cursor":
                this.receiveCursor = Math.max(this.receiveCursor, record.seq);
                for (const seq of this.pendingInbound.keys()) {
                    if (seq <= this.receiveCursor) this.pendingInbound.delete(seq);
                }
                return;
            case "revision":
                this.applyRevision(record.entityId, record.revision);
                return;
            case "command":
                this.commandStatuses.set(record.commandId, record.status);
                this.commandUpdatedAt.set(record.commandId, record.updatedAt);
                if (isPendingCommandStatus(record.status) && record.command) {
                    this.commands.set(record.commandId, record.command);
                } else if (!isPendingCommandStatus(record.status)) {
                    this.commands.delete(record.commandId);
                }
                return;
            case "inboundComplete":
                this.applyRevision(record.entityId, record.revision);
                this.applyCursor(record.seq);
                return;
            case "snapshotComplete":
                for (const revision of record.revisions) this.applyRevision(revision.entityId, revision.revision);
                this.applyCursor(record.seq);
                return;
            case "commandTransition":
                this.pendingOutbound.set(record.mutation.mutationId, record.mutation);
                this.pendingOutboundEnqueuedAt.set(
                    record.mutation.mutationId,
                    Math.min(
                        this.pendingOutboundEnqueuedAt.get(record.mutation.mutationId) ?? record.updatedAt,
                        record.updatedAt,
                    ),
                );
                this.applyRevision(record.mutation.entityId, record.mutation.revision);
                this.commandStatuses.set(record.commandId, record.status);
                this.commandUpdatedAt.set(record.commandId, record.updatedAt);
                if (isPendingCommandStatus(record.status) && record.command) {
                    this.commands.set(record.commandId, record.command);
                } else if (!isPendingCommandStatus(record.status)) {
                    this.commands.delete(record.commandId);
                }
                return;
            case "providerRequest":
                if (record.mutation) {
                    this.pendingOutbound.set(record.mutation.mutationId, record.mutation);
                    this.pendingOutboundEnqueuedAt.set(
                        record.mutation.mutationId,
                        Math.min(
                            this.pendingOutboundEnqueuedAt.get(record.mutation.mutationId) ?? record.updatedAt,
                            record.updatedAt,
                        ),
                    );
                    this.applyRevision(record.mutation.entityId, record.mutation.revision);
                }
                if (
                    record.state === "pending"
                    || record.state === "responseReady"
                    || record.state === "responseSupplied"
                ) {
                    this.pendingProviderRequests.set(record.request.providerId, {
                        request: record.request,
                        state: record.state,
                        response: record.response ?? null,
                    });
                } else {
                    this.pendingProviderRequests.delete(record.request.providerId);
                }
                return;
            case "migration":
                this.migrationStates.set(record.threadId, record.state);
                return;
            case "codexOrphanEnqueued":
                this.pendingCodexNotifications.set(record.notificationId, {
                    notificationId: record.notificationId,
                    threadId: record.threadId,
                    notification: record.notification,
                    receivedAt: record.receivedAt,
                });
                return;
            case "codexOrphanCompleted":
                this.pendingCodexNotifications.delete(record.notificationId);
                return;
            case "codexThreadRoute":
                this.codexThreadRoutes.set(record.route.threadId, record.route);
        }
    }

    private applyRevision(entityId: string, revision: number): void {
        this.entityRevisions.set(
            entityId,
            Math.max(this.entityRevisions.get(entityId) ?? 0, revision),
        );
    }

    private applyCursor(seq: number): void {
        this.receiveCursor = Math.max(this.receiveCursor, seq);
        for (const pendingSeq of this.pendingInbound.keys()) {
            if (pendingSeq <= this.receiveCursor) this.pendingInbound.delete(pendingSeq);
        }
    }
}

function isPendingCommandStatus(status: SyncV4CommandJournalStatus): boolean {
    return status === "received" || status === "executing" || status === "resultUnknown";
}

function acquireJournalLease(lockPath: string, now: () => number): SyncV4JournalLease {
    if (activeJournalLeases.has(lockPath)) throw new SyncV4JournalLeaseError();
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const payload = `${JSON.stringify({
            pid: process.pid,
            leaseId: randomUUID(),
            createdAt: now(),
        })}\n`;
        let fd: number | null = null;
        try {
            fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
            writeFileSync(fd, payload, "utf8");
            fsyncSync(fd);
            activeJournalLeases.set(lockPath, payload);
            return { fd, lockPath, payload };
        } catch (error) {
            if (fd !== null) {
                try {
                    closeSync(fd);
                } catch {}
                try {
                    unlinkSync(lockPath);
                } catch {}
            }
            if (!isNodeError(error, "EEXIST")) throw error;
            if (!journalLeaseIsStale(lockPath, now())) throw new SyncV4JournalLeaseError();
            try {
                unlinkSync(lockPath);
            } catch (unlinkError) {
                if (!isNodeError(unlinkError, "ENOENT")) throw new SyncV4JournalLeaseError();
            }
        }
    }
    throw new SyncV4JournalLeaseError();
}

function releaseJournalLease(lease: SyncV4JournalLease): void {
    try {
        closeSync(lease.fd);
    } catch {}
    try {
        if (readFileSync(lease.lockPath, "utf8") === lease.payload) unlinkSync(lease.lockPath);
    } catch {}
    if (activeJournalLeases.get(lease.lockPath) === lease.payload) {
        activeJournalLeases.delete(lease.lockPath);
    }
}

function journalLeaseIsStale(lockPath: string, now: number): boolean {
    let raw: string;
    try {
        raw = readFileSync(lockPath, "utf8");
    } catch (error) {
        return isNodeError(error, "ENOENT");
    }
    try {
        const parsed = z.object({
            pid: z.number().int().positive(),
            leaseId: z.string().uuid(),
            createdAt: z.number().int().nonnegative(),
        }).strict().parse(JSON.parse(raw));
        try {
            process.kill(parsed.pid, 0);
            return false;
        } catch (error) {
            return isNodeError(error, "ESRCH");
        }
    } catch {
        try {
            return now - statSync(lockPath).mtimeMs >= INVALID_LEASE_GRACE_MS;
        } catch (error) {
            return isNodeError(error, "ENOENT");
        }
    }
}

function minimum(values: Iterable<number>): number | null {
    let result: number | null = null;
    for (const value of values) result = result === null ? value : Math.min(result, value);
    return result;
}

async function loadOrCreateProducerId(rootDir: string): Promise<string> {
    const producerPath = join(rootDir, "producer-id");
    try {
        const producerId = (await readFile(producerPath, "utf8")).trim();
        if (z.string().uuid().safeParse(producerId).success) return producerId;
        throw new Error("Sync v4 producer ID is invalid");
    } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
    }

    const producerId = randomUUID();
    try {
        const handle = await open(producerPath, "wx", 0o600);
        try {
            await handle.writeFile(`${producerId}\n`, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
        await syncDirectory(rootDir);
        return producerId;
    } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const existing = (await readFile(producerPath, "utf8")).trim();
        return z.string().uuid().parse(existing);
    }
}

async function loadJournal(journalPath: string): Promise<JournalRecord[]> {
    let raw: string;
    try {
        raw = await readFile(journalPath, "utf8");
    } catch (error) {
        if (isNodeError(error, "ENOENT")) return [];
        throw error;
    }
    if (raw.length === 0) return [];

    const endsWithNewline = raw.endsWith("\n");
    const lines = raw.split("\n");
    if (endsWithNewline) lines.pop();
    const records: JournalRecord[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        try {
            records.push(journalRecordSchema.parse(JSON.parse(line)));
        } catch {
            const isTruncatedTail = !endsWithNewline && index === lines.length - 1;
            if (!isTruncatedTail) throw new SyncV4JournalCorruptionError(index + 1);
            const validPrefix = lines.slice(0, index).map((entry) => `${entry}\n`).join("");
            await truncate(journalPath, Buffer.byteLength(validPrefix, "utf8"));
            return records;
        }
    }
    if (!endsWithNewline) {
        const handle = await open(journalPath, "a");
        try {
            await handle.writeFile("\n", "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
    return records;
}

function serializeRecords(records: JournalRecord[]): string {
    return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

async function syncDirectory(directory: string): Promise<void> {
    try {
        const handle = await open(directory, "r");
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (!isNodeError(error, "EINVAL") && !isNodeError(error, "EISDIR") && !isNodeError(error, "EPERM")) {
            throw error;
        }
    }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === code;
}
