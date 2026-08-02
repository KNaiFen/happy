import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { AsyncLock } from '@/utils/lock';
import {
    canonicalCodexNotificationForJournal,
} from '../codexV4ThreadRouter';
import type { ServerNotification } from '../protocol';

const JOURNAL_VERSION = 1;
const DEFAULT_MAX_NOTIFICATION_BYTES = 4 * 1024 * 1024;
const DEFAULT_COMPACTION_BYTES = 8 * 1024 * 1024;
const INVALID_LOCK_GRACE_MS = 30_000;

const idSchema = z.string().min(1).max(512);
const timestampSchema = z.number().int().nonnegative();
const notificationSchema = z.object({
    method: z.string().min(1).max(256),
    params: z.json(),
}).strict();

const deferredEntrySchema = z.discriminatedUnion('kind', [
    z.object({
        id: z.string().uuid(),
        kind: z.literal('notification'),
        threadId: idSchema,
        receivedAt: timestampSchema,
        notification: notificationSchema,
    }).strict(),
    z.object({
        id: z.string().uuid(),
        kind: z.literal('snapshotRequired'),
        threadId: idSchema,
        receivedAt: timestampSchema,
    }).strict(),
]);
export type CodexGatewayDeferredEntry =
    | {
        id: string;
        kind: 'notification';
        threadId: string;
        receivedAt: number;
        notification: ServerNotification;
    }
    | {
        id: string;
        kind: 'snapshotRequired';
        threadId: string;
        receivedAt: number;
    };

const handoffSchema = z.object({
    commandId: idSchema,
    sourceThreadId: idSchema,
    targetThreadId: idSchema,
    generation: z.number().int().nonnegative(),
    state: z.enum(['providerAccepted', 'bound']),
    updatedAt: timestampSchema,
}).strict();
export type CodexGatewayCommandHandoff = z.infer<typeof handoffSchema>;

const bootstrapSchema = z.object({
    operationId: z.string().uuid(),
    action: z.enum(['start', 'resume']),
    requestedThreadId: idSchema.nullable(),
    resolvedThreadId: idSchema,
    cwd: z.string().min(1).max(8_192),
    model: z.string().min(1).max(512).nullable(),
    permissionMode: z.enum(['default', 'read-only', 'safe-yolo', 'yolo']),
    effortLevel: z.string().min(1).max(128).nullable(),
    parentSessionId: idSchema.nullable(),
    forkedFromMessageId: idSchema.nullable(),
    isSideChat: z.boolean(),
    happySessionId: idSchema.nullable(),
    dataEncryptionKey: z.string().min(1).max(128).nullable(),
    state: z.enum(['providerAccepted', 'bound']),
    updatedAt: timestampSchema,
}).strict();
export type CodexGatewayBootstrap = z.infer<typeof bootstrapSchema>;

const recordSchema = z.discriminatedUnion('kind', [
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal('deferred'),
        entry: deferredEntrySchema,
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal('deferredCompleted'),
        entryId: z.string().uuid(),
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal('handoff'),
        handoff: handoffSchema,
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal('handoffCompleted'),
        commandId: idSchema,
    }).strict(),
    z.object({
        version: z.literal(JOURNAL_VERSION),
        kind: z.literal('bootstrap'),
        bootstrap: bootstrapSchema,
    }).strict(),
]);
type JournalRecord =
    | { version: 1; kind: 'deferred'; entry: CodexGatewayDeferredEntry }
    | { version: 1; kind: 'deferredCompleted'; entryId: string }
    | { version: 1; kind: 'handoff'; handoff: CodexGatewayCommandHandoff }
    | { version: 1; kind: 'handoffCompleted'; commandId: string }
    | { version: 1; kind: 'bootstrap'; bootstrap: CodexGatewayBootstrap };

export interface CodexGatewayJournalOptions {
    path: string;
    now?: () => number;
    maxNotificationBytes?: number;
    compactionBytes?: number;
    pid?: number;
    isProcessAlive?: (pid: number) => boolean;
}

export class CodexGatewayJournalCorruptionError extends Error {
    constructor(line: number) {
        super(`Codex Gateway journal is corrupt at line ${line}`);
        this.name = 'CodexGatewayJournalCorruptionError';
    }
}

export class CodexGatewayJournalLeaseError extends Error {
    constructor() {
        super('Codex Gateway journal is already owned by a live worker');
        this.name = 'CodexGatewayJournalLeaseError';
    }
}

export class CodexGatewayJournal {
    private readonly writeLock = new AsyncLock();
    private readonly deferred = new Map<string, CodexGatewayDeferredEntry>();
    private readonly handoffs = new Map<string, CodexGatewayCommandHandoff>();
    private readonly bootstraps = new Map<string, CodexGatewayBootstrap>();
    private handle: Awaited<ReturnType<typeof open>> | null = null;
    private lockPath: string;
    private lockOwned = false;
    private closed = false;

    private constructor(private readonly options: CodexGatewayJournalOptions) {
        this.lockPath = `${options.path}.lock`;
    }

    static async open(options: CodexGatewayJournalOptions): Promise<CodexGatewayJournal> {
        const journal = new CodexGatewayJournal(options);
        await journal.initialize();
        return journal;
    }

    pendingEntries(threadId?: string): CodexGatewayDeferredEntry[] {
        return [...this.deferred.values()]
            .filter((entry) => threadId === undefined || entry.threadId === threadId);
    }

    pendingHandoffs(): CodexGatewayCommandHandoff[] {
        return [...this.handoffs.values()];
    }

    handoff(commandId: string): CodexGatewayCommandHandoff | null {
        return this.handoffs.get(commandId) ?? null;
    }

    bootstrap(operationId: string): CodexGatewayBootstrap | null {
        return this.bootstraps.get(operationId) ?? null;
    }

    pendingBootstraps(): CodexGatewayBootstrap[] {
        return [...this.bootstraps.values()];
    }

    async enqueueNotification(
        threadId: string,
        notification: ServerNotification,
    ): Promise<CodexGatewayDeferredEntry | null> {
        this.assertOpen();
        validateThreadId(threadId);
        const canonical = canonicalCodexNotificationForJournal(notification);
        if (!canonical) return null;
        const receivedAt = this.now();
        const notificationBytes = Buffer.byteLength(JSON.stringify(canonical), 'utf8');
        const entry: CodexGatewayDeferredEntry = notificationBytes <= this.maxNotificationBytes()
            ? {
                id: randomUUID(),
                kind: 'notification',
                threadId,
                receivedAt,
                notification: notificationSchema.parse(canonical) as unknown as ServerNotification,
            }
            : {
                id: randomUUID(),
                kind: 'snapshotRequired',
                threadId,
                receivedAt,
            };
        await this.append({ version: JOURNAL_VERSION, kind: 'deferred', entry });
        return entry;
    }

    async enqueueSnapshotRequired(threadId: string): Promise<CodexGatewayDeferredEntry> {
        this.assertOpen();
        validateThreadId(threadId);
        const entry: CodexGatewayDeferredEntry = {
            id: randomUUID(),
            kind: 'snapshotRequired',
            threadId,
            receivedAt: this.now(),
        };
        await this.append({ version: JOURNAL_VERSION, kind: 'deferred', entry });
        return entry;
    }

    async completeEntry(entryId: string): Promise<void> {
        this.assertOpen();
        if (!this.deferred.has(entryId)) return;
        await this.append({ version: JOURNAL_VERSION, kind: 'deferredCompleted', entryId });
    }

    async recordHandoff(handoff: CodexGatewayCommandHandoff): Promise<void> {
        this.assertOpen();
        const parsed = handoffSchema.parse(handoff);
        const current = this.handoffs.get(parsed.commandId);
        if (current) {
            if (
                current.sourceThreadId !== parsed.sourceThreadId
                || current.targetThreadId !== parsed.targetThreadId
                || current.generation !== parsed.generation
            ) {
                throw new Error('Codex Gateway command handoff identity changed');
            }
            if (current.state === 'bound' && parsed.state === 'providerAccepted') return;
        }
        await this.append({ version: JOURNAL_VERSION, kind: 'handoff', handoff: parsed });
    }

    async completeHandoff(commandId: string): Promise<void> {
        this.assertOpen();
        if (!this.handoffs.has(commandId)) return;
        await this.append({ version: JOURNAL_VERSION, kind: 'handoffCompleted', commandId });
    }

    async recordBootstrap(bootstrap: CodexGatewayBootstrap): Promise<void> {
        this.assertOpen();
        const parsed = bootstrapSchema.parse(bootstrap);
        const current = this.bootstraps.get(parsed.operationId);
        if (current) {
            if (
                current.action !== parsed.action
                || current.requestedThreadId !== parsed.requestedThreadId
                || current.resolvedThreadId !== parsed.resolvedThreadId
                || current.cwd !== parsed.cwd
                || current.model !== parsed.model
                || current.permissionMode !== parsed.permissionMode
                || current.effortLevel !== parsed.effortLevel
                || current.parentSessionId !== parsed.parentSessionId
                || current.forkedFromMessageId !== parsed.forkedFromMessageId
                || current.isSideChat !== parsed.isSideChat
                || current.happySessionId !== parsed.happySessionId
                || current.dataEncryptionKey !== parsed.dataEncryptionKey
            ) {
                throw new Error('Codex Gateway bootstrap identity changed');
            }
            if (current.state === 'bound' && parsed.state === 'providerAccepted') return;
        }
        await this.append({ version: JOURNAL_VERSION, kind: 'bootstrap', bootstrap: parsed });
    }

    async compact(): Promise<void> {
        this.assertOpen();
        await this.writeLock.inLock(async () => {
            const records: JournalRecord[] = [
                ...[...this.deferred.values()].map((entry): JournalRecord => ({
                    version: JOURNAL_VERSION,
                    kind: 'deferred',
                    entry,
                })),
                ...[...this.handoffs.values()].map((handoff): JournalRecord => ({
                    version: JOURNAL_VERSION,
                    kind: 'handoff',
                    handoff,
                })),
                ...[...this.bootstraps.values()].map((bootstrap): JournalRecord => ({
                    version: JOURNAL_VERSION,
                    kind: 'bootstrap',
                    bootstrap,
                })),
            ];
            await this.replaceRecords(records);
        });
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.writeLock.inLock(async () => {
            await this.handle?.close();
            this.handle = null;
            if (this.lockOwned) {
                await rm(this.lockPath, { force: true });
                this.lockOwned = false;
            }
        });
    }

    private async initialize(): Promise<void> {
        await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') await chmod(dirname(this.options.path), 0o700);
        await this.acquireLease();
        try {
            const records = await loadRecords(this.options.path);
            for (const record of records) this.apply(record);
            this.handle = await open(this.options.path, 'a', 0o600);
            if (process.platform !== 'win32') await chmod(this.options.path, 0o600);
        } catch (error) {
            await rm(this.lockPath, { force: true }).catch(() => undefined);
            this.lockOwned = false;
            throw error;
        }
    }

    private async acquireLease(): Promise<void> {
        const payload = `${JSON.stringify({
            pid: this.options.pid ?? process.pid,
            leaseId: randomUUID(),
            createdAt: this.now(),
        })}\n`;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const handle = await open(this.lockPath, 'wx', 0o600);
                try {
                    await handle.writeFile(payload, 'utf8');
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                this.lockOwned = true;
                return;
            } catch (error) {
                if (!isNodeError(error, 'EEXIST')) throw error;
                if (!await this.leaseIsStale()) throw new CodexGatewayJournalLeaseError();
                await rm(this.lockPath, { force: true });
            }
        }
        throw new CodexGatewayJournalLeaseError();
    }

    private async leaseIsStale(): Promise<boolean> {
        try {
            const parsed = z.object({
                pid: z.number().int().positive(),
                leaseId: z.string().uuid(),
                createdAt: timestampSchema,
            }).strict().parse(JSON.parse(await readFile(this.lockPath, 'utf8')));
            return !this.isProcessAlive(parsed.pid);
        } catch {
            try {
                return this.now() - (await stat(this.lockPath)).mtimeMs >= INVALID_LOCK_GRACE_MS;
            } catch (error) {
                return isNodeError(error, 'ENOENT');
            }
        }
    }

    private isProcessAlive(pid: number): boolean {
        if (this.options.isProcessAlive) return this.options.isProcessAlive(pid);
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    private async append(record: JournalRecord): Promise<void> {
        await this.writeLock.inLock(async () => {
            this.assertOpen();
            if (!this.handle) throw new Error('Codex Gateway journal is unavailable');
            await this.handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
            await this.handle.sync();
            this.apply(record);
            if ((await this.handle.stat()).size >= (this.options.compactionBytes ?? DEFAULT_COMPACTION_BYTES)) {
                await this.replaceRecords([
                    ...[...this.deferred.values()].map((entry): JournalRecord => ({
                        version: JOURNAL_VERSION,
                        kind: 'deferred',
                        entry,
                    })),
                    ...[...this.handoffs.values()].map((handoff): JournalRecord => ({
                        version: JOURNAL_VERSION,
                        kind: 'handoff',
                        handoff,
                    })),
                    ...[...this.bootstraps.values()].map((bootstrap): JournalRecord => ({
                        version: JOURNAL_VERSION,
                        kind: 'bootstrap',
                        bootstrap,
                    })),
                ]);
            }
        });
    }

    private async replaceRecords(records: JournalRecord[]): Promise<void> {
        const temporary = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await this.handle?.close();
        this.handle = null;
        try {
            await rename(temporary, this.options.path);
            if (process.platform !== 'win32') await chmod(this.options.path, 0o600);
            await syncDirectory(dirname(this.options.path));
        } catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined);
            this.handle = await open(this.options.path, 'a', 0o600).catch(() => null);
            throw error;
        }
        this.handle = await open(this.options.path, 'a', 0o600);
    }

    private apply(record: JournalRecord): void {
        switch (record.kind) {
            case 'deferred':
                this.deferred.set(record.entry.id, record.entry);
                return;
            case 'deferredCompleted':
                this.deferred.delete(record.entryId);
                return;
            case 'handoff':
                this.handoffs.set(record.handoff.commandId, record.handoff);
                return;
            case 'handoffCompleted':
                this.handoffs.delete(record.commandId);
                return;
            case 'bootstrap':
                this.bootstraps.set(record.bootstrap.operationId, record.bootstrap);
        }
    }

    private maxNotificationBytes(): number {
        return Math.max(1, Math.trunc(
            this.options.maxNotificationBytes ?? DEFAULT_MAX_NOTIFICATION_BYTES,
        ));
    }

    private now(): number {
        return Math.max(0, Math.trunc(this.options.now?.() ?? Date.now()));
    }

    private assertOpen(): void {
        if (this.closed) throw new Error('Codex Gateway journal is closed');
    }
}

async function loadRecords(path: string): Promise<JournalRecord[]> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (error) {
        if (isNodeError(error, 'ENOENT')) return [];
        throw error;
    }
    if (raw.length === 0) return [];
    const endsWithNewline = raw.endsWith('\n');
    const lines = raw.split('\n');
    if (endsWithNewline) lines.pop();
    const records: JournalRecord[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        try {
            records.push(
                recordSchema.parse(JSON.parse(lines[index])) as unknown as JournalRecord,
            );
        } catch {
            if (!endsWithNewline && index === lines.length - 1) {
                const prefix = lines.slice(0, index).map((line) => `${line}\n`).join('');
                await truncate(path, Buffer.byteLength(prefix, 'utf8'));
                return records;
            }
            throw new CodexGatewayJournalCorruptionError(index + 1);
        }
    }
    if (!endsWithNewline) {
        const handle = await open(path, 'a');
        try {
            await handle.writeFile('\n', 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
    return records;
}

function validateThreadId(threadId: string): void {
    idSchema.parse(threadId);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error && error.code === code;
}

async function syncDirectory(path: string): Promise<void> {
    if (process.platform === 'win32') return;
    try {
        const handle = await open(path, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (
            !isNodeError(error, 'EINVAL')
            && !isNodeError(error, 'EISDIR')
            && !isNodeError(error, 'EPERM')
        ) {
            throw error;
        }
    }
}
