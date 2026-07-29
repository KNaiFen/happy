import {
    createSyncV4DiagnosticRecord,
    SyncV4DiagnosticRecordSchema,
    type SyncV4DiagnosticInput,
    type SyncV4DiagnosticRecord,
    type SyncV4DiagnosticSink,
} from '@slopus/happy-wire';
import { z } from 'zod';

export const MAX_APP_SYNC_V4_DIAGNOSTIC_RECORDS = 2_000;

export interface SyncV4DiagnosticStorage {
    getString(key: string): string | undefined;
    getNumber(key: string): number | undefined;
    set(key: string, value: string | number): void;
    delete(key: string): void;
    getAllKeys(): string[];
}

export interface AppSyncV4DiagnosticStats {
    count: number;
    droppedRecords: number;
    invalidRecords: number;
    writeFailures: number;
    listenerFailures: number;
}

export type AppSyncV4DiagnosticStatsProvider = () => AppSyncV4DiagnosticStats;

export function readAppSyncV4DiagnosticStatsSafely(
    provider: AppSyncV4DiagnosticStatsProvider | null | undefined,
): AppSyncV4DiagnosticStats | null {
    if (!provider) return null;
    try {
        const stats = provider();
        const result: AppSyncV4DiagnosticStats = {
            count: stats.count,
            droppedRecords: stats.droppedRecords,
            invalidRecords: stats.invalidRecords,
            writeFailures: stats.writeFailures,
            listenerFailures: stats.listenerFailures,
        };
        return Object.values(result).every(isDiagnosticCounter) ? result : null;
    } catch {
        return null;
    }
}

export function appSyncV4DiagnosticStatsAreDegraded(
    stats: AppSyncV4DiagnosticStats | null,
): boolean {
    return Boolean(stats && (
        stats.droppedRecords > 0
        || stats.invalidRecords > 0
        || stats.writeFailures > 0
        || stats.listenerFailures > 0
    ));
}

const storedRecordSchema = z.object({
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    record: SyncV4DiagnosticRecordSchema,
}).strict();

/**
 * Crash-tolerant MMKV-shaped ring. The logical N-record window uses N+1
 * physical slots, so writing the next slot cannot overwrite the committed
 * window before the head commit succeeds.
 */
export class AppSyncV4DiagnosticStore implements SyncV4DiagnosticSink {
    private droppedRecords = 0;
    private invalidRecords = 0;
    private writeFailures = 0;
    private listenerFailures = 0;
    private readonly listeners = new Set<() => void>();
    private head = 0;
    private count = 0;

    constructor(
        private readonly storage: SyncV4DiagnosticStorage,
        private readonly capacity: number = MAX_APP_SYNC_V4_DIAGNOSTIC_RECORDS,
        private readonly now: () => number = Date.now,
    ) {
        if (
            !Number.isSafeInteger(capacity)
            || capacity <= 0
            || capacity > MAX_APP_SYNC_V4_DIAGNOSTIC_RECORDS
        ) {
            throw new Error(
                `Sync v4 diagnostic capacity must be between 1 and ${MAX_APP_SYNC_V4_DIAGNOSTIC_RECORDS}`,
            );
        }
        try {
            const recovered = this.recoverState();
            this.head = recovered.head;
            this.count = recovered.count;
            this.droppedRecords = Math.max(0, recovered.head - recovered.count);
        } catch {
            this.writeFailures += 1;
        }
    }

    record(input: SyncV4DiagnosticInput): void {
        let record: SyncV4DiagnosticRecord;
        try {
            record = createSyncV4DiagnosticRecord(input, this.now);
        } catch {
            this.invalidRecords += 1;
            return;
        }

        let sequence = this.head + 1;
        try {
            if (!Number.isSafeInteger(sequence)) {
                this.clearStoredRecords();
                this.head = 0;
                this.count = 0;
                sequence = 1;
            }
            const nextCount = Math.min(this.capacity, this.count + 1);
            const evictsCommittedRecord = this.count === this.capacity;
            this.writeRecord(sequence, record);
            this.head = sequence;
            this.count = nextCount;
            if (evictsCommittedRecord) this.droppedRecords += 1;
        } catch {
            this.writeFailures += 1;
            return;
        }
        this.notifyListeners();
    }

    records(): SyncV4DiagnosticRecord[] {
        const minimum = Math.max(1, this.head - this.count + 1);
        const records: SyncV4DiagnosticRecord[] = [];
        try {
            for (let sequence = minimum; sequence <= this.head; sequence += 1) {
                const raw = this.storage.getString(this.recordKey(sequence));
                if (!raw) continue;
                try {
                    const stored = storedRecordSchema.parse(JSON.parse(raw));
                    if (stored.sequence !== sequence) continue;
                    records.push(stored.record);
                } catch {
                    continue;
                }
            }
        } catch {
            this.writeFailures += 1;
            return [];
        }
        return records;
    }

    clear(): void {
        try {
            this.clearStoredRecords();
        } catch {
            this.writeFailures += 1;
            return;
        }
        this.head = 0;
        this.count = 0;
        this.droppedRecords = 0;
        this.invalidRecords = 0;
        this.writeFailures = 0;
        this.listenerFailures = 0;
        this.notifyListeners();
    }

    stats(): AppSyncV4DiagnosticStats {
        return {
            count: this.count,
            droppedRecords: this.droppedRecords,
            invalidRecords: this.invalidRecords,
            writeFailures: this.writeFailures,
            listenerFailures: this.listenerFailures,
        };
    }

    exportJsonl(): string {
        const records = this.records();
        const stats = this.stats();
        const degraded = appSyncV4DiagnosticStatsAreDegraded(stats);
        const summary = createSyncV4DiagnosticRecord({
            level: degraded ? 'warn' : 'info',
            component: 'app.registry',
            event: 'lifecycle',
            phase: 'served',
            state: degraded ? 'degraded' : 'ready',
            count: stats.count,
            dropped: stats.droppedRecords,
            invalid: stats.invalidRecords,
            writeFailures: stats.writeFailures,
            listenerFailures: stats.listenerFailures,
        }, this.now);
        return [...records, summary]
            .sort((left, right) => left.timestamp - right.timestamp)
            .map((record) => JSON.stringify(record))
            .join('\n');
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private writeRecord(
        sequence: number,
        record: SyncV4DiagnosticRecord,
    ): void {
        this.storage.set(
            this.recordKey(sequence),
            JSON.stringify({ sequence, record }),
        );
        this.storage.set(HEAD_KEY, sequence);
    }

    private recordKey(sequence: number): string {
        return `${RECORD_PREFIX}${sequence % (this.capacity + 1)}`;
    }

    private recoverState(): { head: number; count: number } {
        for (const key of this.storage.getAllKeys()) {
            if (!key.startsWith(RECORD_PREFIX)) continue;
            const raw = this.storage.getString(key);
            if (!raw) continue;
            try {
                storedRecordSchema.parse(JSON.parse(raw));
            } catch {
                this.invalidRecords += 1;
            }
        }
        const storedHead = this.storage.getNumber(HEAD_KEY);
        const head = Number.isSafeInteger(storedHead) && storedHead! >= 0
            ? storedHead!
            : 0;
        const count = Math.min(this.capacity, head);
        return { head, count };
    }

    private clearStoredRecords(): void {
        for (const key of this.storage.getAllKeys()) {
            if (key.startsWith(RECORD_PREFIX)) this.storage.delete(key);
        }
        this.storage.delete(HEAD_KEY);
        this.storage.delete(COUNT_KEY);
    }

    private notifyListeners(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                this.listenerFailures += 1;
            }
        }
    }
}

const HEAD_KEY = 'sync-v4-diagnostics:head';
const COUNT_KEY = 'sync-v4-diagnostics:count';
const RECORD_PREFIX = 'sync-v4-diagnostics:record:';

function isDiagnosticCounter(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}
