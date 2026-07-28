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
    chmod,
    mkdir,
    open,
    readFile,
    rename,
    stat,
    truncate,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const JOURNAL_VERSION = 1;
const DEFAULT_COMPACTION_BYTES = 8 * 1024 * 1024;

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
    "ready",
    "error",
]);
export type SyncV4MigrationJournalState = z.infer<typeof SyncV4MigrationJournalStateSchema>;

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
        state: z.enum(["pending", "completed"]),
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
    pendingProviderRequests: ReadonlyMap<string, CodexRequestEntityV4>;
    migrationStates: ReadonlyMap<string, SyncV4MigrationJournalState>;
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
        const loaded = await loadJournal(journalPath);
        return new SyncV4Journal(
            journalPath,
            options.rootDir,
            producerId,
            options.compactionBytes ?? DEFAULT_COMPACTION_BYTES,
            options.now ?? Date.now,
            loaded,
        );
    }

    private readonly lock = new AsyncLock();
    private receiveCursor = 0;
    private readonly pendingOutbound = new Map<string, SyncMutationV4>();
    private readonly pendingOutboundEnqueuedAt = new Map<string, number>();
    private readonly pendingInbound = new Map<number, SyncChangeV4>();
    private readonly entityRevisions = new Map<string, number>();
    private readonly commandStatuses = new Map<string, SyncV4CommandJournalStatus>();
    private readonly commands = new Map<string, CodexCommandEntityV4>();
    private readonly pendingProviderRequests = new Map<string, CodexRequestEntityV4>();
    private readonly migrationStates = new Map<string, SyncV4MigrationJournalState>();

    private constructor(
        private readonly journalPath: string,
        private readonly rootDir: string,
        readonly producerId: string,
        private readonly compactionBytes: number,
        private readonly now: () => number,
        records: JournalRecord[],
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
        };
    }

    nextRevision(entityId: string): number {
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
        state: "pending" | "completed",
        mutation: SyncMutationV4,
    ): Promise<void> {
        await this.appendRecords([{
            version: JOURNAL_VERSION,
            kind: "providerRequest",
            request,
            state,
            updatedAt: this.now(),
            mutation,
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

    async compactIfNeeded(): Promise<void> {
        let currentSize = 0;
        try {
            currentSize = (await stat(this.journalPath)).size;
        } catch (error) {
            if (!isNodeError(error, "ENOENT")) throw error;
        }
        if (currentSize >= this.compactionBytes) await this.compact();
    }

    async compact(): Promise<void> {
        await this.lock.inLock(async () => {
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
                records.push({
                    version: JOURNAL_VERSION,
                    kind: "command",
                    commandId,
                    status,
                    updatedAt: this.now(),
                    ...(this.commands.get(commandId) ? { command: this.commands.get(commandId) } : {}),
                });
            }
            for (const request of this.pendingProviderRequests.values()) {
                records.push({
                    version: JOURNAL_VERSION,
                    kind: "providerRequest",
                    request,
                    state: "pending",
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
            if (this.receiveCursor > 0) {
                records.push({ version: JOURNAL_VERSION, kind: "cursor", seq: this.receiveCursor });
            }
            const temporaryPath = `${this.journalPath}.${randomUUID()}.tmp`;
            const handle = await open(temporaryPath, "wx", 0o600);
            try {
                await handle.writeFile(serializeRecords(records), "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }
            await rename(temporaryPath, this.journalPath);
            await syncDirectory(this.rootDir);
        });
    }

    private async appendRecords(records: JournalRecord[]): Promise<void> {
        if (records.length === 0) return;
        await this.lock.inLock(async () => {
            const handle = await open(this.journalPath, "a", 0o600);
            try {
                await handle.writeFile(serializeRecords(records), "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }
            for (const record of records) this.applyRecord(record);
        });
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
                if (record.command) this.commands.set(record.commandId, record.command);
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
                if (record.command) this.commands.set(record.commandId, record.command);
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
                if (record.state === "pending") {
                    this.pendingProviderRequests.set(record.request.providerId, record.request);
                } else {
                    this.pendingProviderRequests.delete(record.request.providerId);
                }
                return;
            case "migration":
                this.migrationStates.set(record.threadId, record.state);
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
