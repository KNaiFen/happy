import {
    createSyncV4DiagnosticRecord,
    MAX_SYNC_V4_DIAGNOSTIC_RECORD_BYTES,
    type SyncV4DiagnosticInput,
    type SyncV4DiagnosticSink,
} from '@slopus/happy-wire';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import {
    BoundedJsonlWriter,
    removeStaleBoundedJsonlFiles,
    type BoundedJsonlWriterStats,
} from '@/utils/boundedJsonlWriter';

export const SYNC_V4_DIAGNOSTIC_FILE_BYTES = 8 * 1024 * 1024;
export const SYNC_V4_DIAGNOSTIC_FILE_SEGMENTS = 4;
export const SYNC_V4_DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface CliSyncV4DiagnosticStats extends BoundedJsonlWriterStats {
    invalidRecords: number;
}

export function cliSyncV4DiagnosticStatsAreDegraded(
    stats: CliSyncV4DiagnosticStats | undefined,
): boolean {
    return Boolean(stats && (
        stats.droppedRecords > 0
        || stats.invalidRecords > 0
        || stats.writeFailures > 0
    ));
}

export class CliSyncV4DiagnosticLog implements SyncV4DiagnosticSink {
    static async open(path: string): Promise<CliSyncV4DiagnosticLog> {
        await removeStaleBoundedJsonlFiles({
            directory: dirname(path),
            filenameSuffixes: ['.sync-v4.jsonl', '.codex-rpc.jsonl'],
            retentionMs: SYNC_V4_DIAGNOSTIC_RETENTION_MS,
        });
        const writer = await BoundedJsonlWriter.open(path, {
            maxFileBytes: SYNC_V4_DIAGNOSTIC_FILE_BYTES,
            maxSegments: SYNC_V4_DIAGNOSTIC_FILE_SEGMENTS,
            maxRecordBytes: MAX_SYNC_V4_DIAGNOSTIC_RECORD_BYTES + 1,
        });
        return new CliSyncV4DiagnosticLog(writer);
    }

    private invalidRecords = 0;

    private constructor(private readonly writer: BoundedJsonlWriter) {}

    record(input: SyncV4DiagnosticInput): void {
        try {
            this.writer.appendJson(createSyncV4DiagnosticRecord(input));
        } catch {
            this.invalidRecords += 1;
        }
    }

    stats(): CliSyncV4DiagnosticStats {
        return {
            ...this.writer.stats(),
            invalidRecords: this.invalidRecords,
        };
    }

    async flush(): Promise<void> {
        await this.writer.flush();
    }

    async close(): Promise<void> {
        await this.writer.close();
    }
}

export function syncV4DiagnosticHash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function createSyncV4TraceId(): string {
    return randomBytes(16).toString('hex');
}

export function deriveSyncV4DiagnosticPath(logPath: string): string {
    return logPath.endsWith('.log')
        ? `${logPath.slice(0, -4)}.sync-v4.jsonl`
        : `${logPath}.sync-v4.jsonl`;
}

export function deriveCodexProtocolTracePath(logPath: string): string {
    return logPath.endsWith('.log')
        ? `${logPath.slice(0, -4)}.codex-rpc.jsonl`
        : `${logPath}.codex-rpc.jsonl`;
}
