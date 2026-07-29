import {
    appendFile,
    chmod,
    mkdir,
    readdir,
    rename,
    stat,
    unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface BoundedJsonlWriterOptions {
    maxFileBytes: number;
    maxSegments: number;
    maxRecordBytes: number;
    maxPendingBytes?: number;
}

export interface BoundedJsonlWriterStats {
    currentFileBytes: number;
    pendingBytes: number;
    droppedRecords: number;
    writeFailures: number;
}

interface PendingRecord {
    line: string;
    bytes: number;
}

/**
 * Best-effort, process-local JSONL writer. Writes remain ordered and each file
 * and the in-memory pending queue are bounded. Under sustained backpressure the
 * oldest queued records are discarded so recent failure context is retained.
 */
export class BoundedJsonlWriter {
    static async open(
        path: string,
        options: BoundedJsonlWriterOptions,
    ): Promise<BoundedJsonlWriter> {
        assertOptions(options);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await chmod(dirname(path), 0o700).catch(() => undefined);
        const current = await stat(path).catch((error: unknown) => {
            if (errorCode(error) === 'ENOENT') return null;
            throw error;
        });
        if (current && !current.isFile()) {
            throw new Error('Bounded JSONL path is not a file');
        }
        if (current) await chmod(path, 0o600);
        return new BoundedJsonlWriter(path, options, current?.size ?? 0);
    }

    private readonly pending: PendingRecord[] = [];
    private pendingBytes = 0;
    private activeBytes = 0;
    private drainPromise: Promise<void> | null = null;
    private failure: unknown = null;
    private droppedRecords = 0;
    private writeFailures = 0;
    private closed = false;

    private constructor(
        readonly path: string,
        private readonly options: BoundedJsonlWriterOptions,
        private currentFileBytes: number,
    ) {}

    appendJson(value: unknown): void {
        if (this.closed) return;
        let line: string;
        try {
            line = `${JSON.stringify(value)}\n`;
        } catch {
            this.writeFailures += 1;
            return;
        }
        const bytes = Buffer.byteLength(line, 'utf8');
        if (bytes > this.options.maxRecordBytes || bytes > this.options.maxFileBytes) {
            this.writeFailures += 1;
            return;
        }
        const maxPendingBytes = this.options.maxPendingBytes
            ?? Math.max(this.options.maxFileBytes, this.options.maxRecordBytes);
        while (
            this.pending.length > 0
            && this.activeBytes + this.pendingBytes + bytes > maxPendingBytes
        ) {
            const dropped = this.pending.shift()!;
            this.pendingBytes -= dropped.bytes;
            this.droppedRecords += 1;
        }
        if (this.activeBytes + this.pendingBytes + bytes > maxPendingBytes) {
            this.droppedRecords += 1;
            return;
        }
        this.pending.push({ line, bytes });
        this.pendingBytes += bytes;
        this.ensureDrain();
    }

    stats(): BoundedJsonlWriterStats {
        return {
            currentFileBytes: this.currentFileBytes,
            pendingBytes: this.activeBytes + this.pendingBytes,
            droppedRecords: this.droppedRecords,
            writeFailures: this.writeFailures,
        };
    }

    async flush(): Promise<void> {
        while (this.drainPromise) await this.drainPromise;
        if (this.failure) throw this.failure;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.flush();
    }

    private ensureDrain(): void {
        if (this.drainPromise || this.pending.length === 0) return;
        this.drainPromise = this.drain().finally(() => {
            this.drainPromise = null;
            this.ensureDrain();
        });
    }

    private async drain(): Promise<void> {
        while (this.pending.length > 0) {
            const record = this.pending.shift()!;
            this.pendingBytes -= record.bytes;
            this.activeBytes = record.bytes;
            try {
                if (
                    this.currentFileBytes > 0
                    && this.currentFileBytes + record.bytes > this.options.maxFileBytes
                ) {
                    await this.rotate();
                }
                await appendFile(this.path, record.line, { encoding: 'utf8', mode: 0o600 });
                this.currentFileBytes += record.bytes;
                await chmod(this.path, 0o600);
            } catch (error) {
                this.failure ??= error;
                this.writeFailures += 1;
            } finally {
                this.activeBytes = 0;
            }
        }
    }

    private async rotate(): Promise<void> {
        if (this.options.maxSegments === 1) {
            await unlinkIfPresent(this.path);
            this.currentFileBytes = 0;
            return;
        }
        for (let index = this.options.maxSegments - 1; index >= 1; index -= 1) {
            const source = index === 1 ? this.path : `${this.path}.${index - 1}`;
            const target = `${this.path}.${index}`;
            await unlinkIfPresent(target);
            await rename(source, target).catch((error: unknown) => {
                if (errorCode(error) !== 'ENOENT') throw error;
            });
        }
        this.currentFileBytes = 0;
    }
}

export async function removeStaleBoundedJsonlFiles(options: {
    directory: string;
    filenameSuffixes: readonly string[];
    retentionMs: number;
    now?: number;
}): Promise<number> {
    if (!Number.isSafeInteger(options.retentionMs) || options.retentionMs < 0) {
        throw new Error('Bounded JSONL retention must be a nonnegative integer');
    }
    const now = options.now ?? Date.now();
    const entries = await readdir(options.directory, { withFileTypes: true }).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return [];
        throw error;
    });
    let removed = 0;
    for (const entry of entries) {
        if (!entry.isFile() || !matchesSuffix(entry.name, options.filenameSuffixes)) continue;
        const path = join(options.directory, basename(entry.name));
        const file = await stat(path).catch(() => null);
        if (!file || now - file.mtimeMs <= options.retentionMs) continue;
        await unlink(path).catch((error: unknown) => {
            if (errorCode(error) !== 'ENOENT') throw error;
        });
        removed += 1;
    }
    return removed;
}

function assertOptions(options: BoundedJsonlWriterOptions): void {
    if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes <= 0) {
        throw new Error('Bounded JSONL maxFileBytes must be a positive integer');
    }
    if (!Number.isSafeInteger(options.maxSegments) || options.maxSegments <= 0) {
        throw new Error('Bounded JSONL maxSegments must be a positive integer');
    }
    if (!Number.isSafeInteger(options.maxRecordBytes) || options.maxRecordBytes <= 0) {
        throw new Error('Bounded JSONL maxRecordBytes must be a positive integer');
    }
    const maxPendingBytes = options.maxPendingBytes
        ?? Math.max(options.maxFileBytes, options.maxRecordBytes);
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < options.maxRecordBytes) {
        throw new Error('Bounded JSONL maxPendingBytes must be at least maxRecordBytes');
    }
}

function matchesSuffix(filename: string, suffixes: readonly string[]): boolean {
    return suffixes.some((suffix) => (
        filename.endsWith(suffix)
        || new RegExp(`${escapeRegExp(suffix)}\\.\\d+$`).test(filename)
    ));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function unlinkIfPresent(path: string): Promise<void> {
    await unlink(path).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
    });
}

function errorCode(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
}
