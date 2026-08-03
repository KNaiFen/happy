import { register, Counter, Gauge, Histogram } from 'prom-client';
import { db } from '@/storage/db';
import { forever } from '@/utils/forever';
import { delay } from '@/utils/delay';
import { shutdownSignal } from '@/utils/shutdown';
import { Socket } from 'socket.io';

// Global default labels — applied to ALL metrics at scrape time
register.setDefaultLabels({ app: 'happy-server' });

interface ClientLabels {
    client: string;
    client_type: string;
}

interface SyncV4ClientLabels {
    client_type: string;
}

const knownClientTypes = new Set([
    'cli',
    'cli-coding-session',
    'cli-daemon',
    'cli-control-plane',
    'ios',
    'android',
    'web',
    'desktop',
    'macos',
    'windows',
]);

function parseClientLabels(raw: unknown): ClientLabels {
    if (typeof raw !== 'string') return { client: 'unknown', client_type: 'unknown' };
    const separator = raw.indexOf('/');
    const type = (separator === -1 ? raw : raw.slice(0, separator)).toLowerCase();
    const boundedType = knownClientTypes.has(type) ? type : 'unknown';
    // Both labels intentionally use a fixed enum. A client-controlled version
    // string would otherwise create unbounded Prometheus series.
    return { client: boundedType, client_type: boundedType };
}

/**
 * Extract standard metric labels from a Socket.IO socket.
 * Spread into any metric .inc() / .observe() call.
 */
export function getMetricsLabelsFromSocket(socket: Socket): ClientLabels {
    return parseClientLabels(socket.data.happyClient);
}

/**
 * Extract standard metric labels from a Fastify request.
 * Spread into any metric .inc() / .observe() call.
 */
export function getMetricsLabelsFromRequest(request: { headers: Record<string, string | string[] | undefined> }): ClientLabels {
    return parseClientLabels(request.headers['x-happy-client']);
}

export function getSyncV4MetricsLabelsFromRequest(
    request: { headers: Record<string, string | string[] | undefined> },
): SyncV4ClientLabels {
    return { client_type: parseClientLabels(request.headers['x-happy-client']).client_type };
}

// Application metrics
export const websocketConnectionsGauge = new Gauge({
    name: 'websocket_connections_total',
    help: 'Number of active WebSocket connections',
    labelNames: ['type', 'client', 'client_type'] as const,
    registers: [register]
});

export const machineAliveEventsCounter = new Counter({
    name: 'machine_alive_events_total',
    help: 'Total number of machine-alive events',
    registers: [register]
});

export const sessionCacheCounter = new Counter({
    name: 'session_cache_operations_total',
    help: 'Total session cache operations',
    labelNames: ['operation', 'result'] as const,
    registers: [register]
});

export const databaseUpdatesSkippedCounter = new Counter({
    name: 'database_updates_skipped_total',
    help: 'Number of database updates skipped due to debouncing',
    labelNames: ['type'] as const,
    registers: [register]
});

export const websocketEventsCounter = new Counter({
    name: 'websocket_events_total',
    help: 'Total WebSocket events received by type',
    labelNames: ['event_type', 'client', 'client_type'] as const,
    registers: [register]
});

export const httpRequestsCounter = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status', 'client', 'client_type'] as const,
    registers: [register]
});

export const httpRequestDurationHistogram = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status', 'client', 'client_type'] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
    registers: [register]
});

export const syncV4MutationResultsCounter = new Counter({
    name: 'sync_v4_mutation_results_total',
    help: 'Total Codex Sync v4 mutation outcomes',
    labelNames: ['result', 'client_type'] as const,
    registers: [register]
});

export const syncV4ProjectionLagHistogram = new Histogram({
    name: 'sync_v4_projection_lag_mutations',
    help: 'Codex Sync v4 mutations between a receive cursor and the server watermark',
    labelNames: ['client_type'] as const,
    buckets: [0, 1, 5, 10, 50, 100, 500, 1_000, 10_000, 100_000],
    registers: [register]
});

export const syncV4SnapshotFallbackCounter = new Counter({
    name: 'sync_v4_snapshot_fallback_total',
    help: 'Total Codex Sync v4 snapshot fallbacks caused by journal recovery conditions',
    labelNames: ['reason', 'client_type'] as const,
    registers: [register]
});

export const syncV4OperationsCounter = new Counter({
    name: 'sync_v4_operations_total',
    help: 'Total Codex Sync v4 operations by bounded operation and outcome',
    labelNames: ['operation', 'outcome', 'client_type'] as const,
    registers: [register]
});

export const syncV4OperationDurationHistogram = new Histogram({
    name: 'sync_v4_operation_duration_seconds',
    help: 'Codex Sync v4 operation duration by bounded operation and outcome',
    labelNames: ['operation', 'outcome', 'client_type'] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
    registers: [register]
});

export const syncV4PageSizeHistogram = new Histogram({
    name: 'sync_v4_page_size',
    help: 'Codex Sync v4 mutation, changes, and snapshot page sizes',
    labelNames: ['operation', 'client_type'] as const,
    buckets: [0, 1, 5, 10, 25, 50, 75, 100],
    registers: [register]
});

export const syncV4PrunedRecordsCounter = new Counter({
    name: 'sync_v4_pruned_records_total',
    help: 'Total Codex Sync v4 journal records pruned',
    labelNames: ['client_type'] as const,
    registers: [register]
});

// Database count metrics
export const databaseRecordCountGauge = new Gauge({
    name: 'database_records_total',
    help: 'Total number of records in database tables',
    labelNames: ['table'] as const,
    registers: [register]
});

type EstimatedCountRow = {
    estimated_count: bigint | number | null;
};

async function getEstimatedRecordCount(tableName: string): Promise<number> {
    const rows = await db.$queryRaw<EstimatedCountRow[]>`
        SELECT GREATEST(reltuples, 0)::bigint AS estimated_count
        FROM pg_class
        WHERE oid = to_regclass(${tableName})
    `;
    const estimatedCount = rows[0]?.estimated_count ?? 0;
    return Number(estimatedCount);
}

// Database metrics updater
export async function updateDatabaseMetrics(): Promise<void> {
    // Use catalog estimates instead of exact COUNT(*). Exact counts are full
    // scans in Postgres and this updater runs once a minute.
    const [accountCount, sessionCount, messageCount, machineCount] = await Promise.all([
        getEstimatedRecordCount('"Account"'),
        getEstimatedRecordCount('"Session"'),
        getEstimatedRecordCount('"SessionMessage"'),
        getEstimatedRecordCount('"Machine"')
    ]);

    // Update metrics
    databaseRecordCountGauge.set({ table: 'accounts' }, accountCount);
    databaseRecordCountGauge.set({ table: 'sessions' }, sessionCount);
    databaseRecordCountGauge.set({ table: 'messages' }, messageCount);
    databaseRecordCountGauge.set({ table: 'machines' }, machineCount);
}

export function startDatabaseMetricsUpdater(): void {
    forever('database-metrics-updater', async () => {
        await updateDatabaseMetrics();
        
        // Wait 60 seconds before next update
        await delay(60 * 1000, shutdownSignal);
    });
}

// Redis stream lag — how far behind this pod's reader is from the stream head
export const redisStreamLagMsGauge = new Gauge({
    name: 'redis_stream_lag_ms',
    help: 'Milliseconds between this pod read cursor and stream HEAD',
    registers: [register]
});

// Export the register for combining metrics
export { register };
