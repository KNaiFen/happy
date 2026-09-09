import type { PGlite } from '@electric-sql/pglite';
import { rename, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { error, log, warn } from '@/utils/log';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_RELATION_BYTES = 256 * 1024 * 1024;
const SLOW_OPERATION_MS = 2_000;
const HOT_TABLES = new Set(['Account', 'Session']);

type Relation = {
    name: string;
    bytes: number;
    liveRows: number;
    deadRows: number;
};

type MaintenanceResult = {
    lastAttemptAt: number | null;
    lastSuccessAt: number | null;
    durationMs: number | null;
    successes: number;
    failures: number;
    backedOff: boolean;
    nextAttemptAt: number;
    problem: 'failed' | 'slow' | null;
};

export type PGliteMaintenanceStatus = {
    version: 1;
    processId: number;
    startedAt: number;
    sampledAt: number;
    enabled: boolean;
    severity: 'healthy' | 'warning' | 'critical';
    reasons: string[];
    sweepCompletedAt: number | null;
    relationBytes: number;
    walBytes: number;
    availableBytes: number;
    availableRatio: number;
    growth: { since: number; relationBytes: number; walBytes: number; previousRelationBytes: number; previousWalBytes: number } | null;
    checkpoint: MaintenanceResult & { walBeforeBytes: number | null; walAfterBytes: number | null };
    tables: (Relation & MaintenanceResult & { oversize: boolean })[];
};

function emptyResult(): MaintenanceResult {
    return { lastAttemptAt: null, lastSuccessAt: null, durationMs: null, successes: 0,
        failures: 0, backedOff: false, nextAttemptAt: 0, problem: null };
}

/** Owns scheduling only; all SQL uses the existing PGlite connection queue. */
export class PGliteMaintenance {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pending: Promise<void> | null = null;
    private stopped = false;
    private readonly startedAt: number;
    private readonly results = new Map<string, MaintenanceResult>();
    private readonly checkpoint = { ...emptyResult(), walBeforeBytes: null as number | null, walAfterBytes: null as number | null };
    private sweepCompletedAt: number | null = null;
    private baseline: { at: number; relationBytes: number; walBytes: number } | null = null;
    private growth: PGliteMaintenanceStatus['growth'] = null;
    private lastReport = 0;
    private lastReasons = '';
    private failedSample = false;
    private failedWrite = false;
    readonly statusPath: string;
    status: PGliteMaintenanceStatus | null = null;

    constructor(
        private readonly pg: Pick<PGlite, 'query' | 'exec'>,
        private readonly pgliteDir: string,
        private readonly enabled = true,
        private readonly now: () => number = Date.now,
    ) {
        this.startedAt = now();
        this.statusPath = join(dirname(resolve(pgliteDir)), 'pglite-maintenance.json');
    }

    start(): void {
        if (this.stopped || this.timer || this.pending) return;
        this.schedule();
    }

    private schedule(): void {
        if (this.stopped) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.runOnce().finally(() => this.schedule());
        }, MINUTE);
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        await this.pending;
    }

    runOnce(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        if (this.pending) return this.pending;
        this.pending = this.tick().then(() => { this.failedSample = false; }).catch(() => {
            if (!this.failedSample || this.now() - this.lastReport >= HOUR) {
                error({ module: 'pglite-maintenance', operation: 'sample' }, 'Database maintenance sampling failed');
                this.lastReport = this.now();
            }
            this.failedSample = true;
        }).finally(() => { this.pending = null; });
        return this.pending;
    }

    private async relations(): Promise<Relation[]> {
        const result = await this.pg.query<Relation>(`
            SELECT c.relname AS name, pg_total_relation_size(c.oid)::float8 AS bytes,
                GREATEST(c.reltuples, 0)::float8 AS "liveRows",
                COALESCE(s.n_dead_tup, 0)::float8 AS "deadRows"
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relpersistence = 'p'
            ORDER BY c.relname
        `);
        return result.rows;
    }

    private async walBytes(): Promise<number> {
        const result = await this.pg.query<{ bytes: number }>('SELECT COALESCE(sum(size), 0)::float8 AS bytes FROM pg_ls_waldir()');
        return result.rows[0].bytes;
    }

    private async execute(sql: string, result: MaintenanceResult): Promise<void> {
        result.lastAttemptAt = this.now();
        const start = performance.now();
        try {
            await this.pg.exec(sql);
            result.durationMs = performance.now() - start;
            result.lastSuccessAt = this.now();
            result.successes++;
            result.failures = 0;
            result.problem = result.durationMs > SLOW_OPERATION_MS ? 'slow' : null;
            result.backedOff = result.problem === 'slow';
        } catch {
            result.durationMs = performance.now() - start;
            result.failures++;
            result.problem = 'failed';
            result.backedOff ||= result.failures >= 3;
        }
        result.nextAttemptAt = this.now() + (result.backedOff ? HOUR : MINUTE);
    }

    private async tick(): Promise<void> {
        const before = await this.relations();
        for (const name of this.results.keys()) {
            if (!before.some(table => table.name === name)) this.results.delete(name);
        }
        for (const table of before) {
            if (!this.results.has(table.name)) this.results.set(table.name, emptyResult());
        }
        const now = this.now();
        if (this.enabled && !this.stopped) {
            if (now >= Math.max(this.checkpoint.nextAttemptAt, (this.checkpoint.lastAttemptAt ?? this.startedAt) + HOUR)) {
                this.checkpoint.walBeforeBytes = await this.walBytes();
                await this.execute('CHECKPOINT', this.checkpoint);
                this.checkpoint.walAfterBytes = await this.walBytes();
            } else {
                const candidates = before.filter(table => table.bytes <= MAX_RELATION_BYTES
                    && this.results.get(table.name)!.nextAttemptAt <= now);
                const hot = candidates.filter(table => HOT_TABLES.has(table.name)
                    && now - (this.results.get(table.name)!.lastAttemptAt ?? 0) >= 10 * MINUTE);
                const selected = (hot.length ? hot : candidates).sort((a, b) =>
                    (this.results.get(a.name)!.lastAttemptAt ?? 0) - (this.results.get(b.name)!.lastAttemptAt ?? 0))[0];
                if (selected) {
                    const identifier = '"' + selected.name.replace(/"/g, '""') + '"';
                    await this.execute(`VACUUM (ANALYZE, TRUNCATE FALSE, PARALLEL 0) public.${identifier}`, this.results.get(selected.name)!);
                }
            }
        }
        const tables = (await this.relations()).map(table => ({ ...table, ...this.results.get(table.name)!, oversize: table.bytes > MAX_RELATION_BYTES }));
        const sampledAt = this.now();
        if (tables.length && tables.every(table => (table.lastSuccessAt ?? 0) > (this.sweepCompletedAt ?? this.startedAt))) {
            this.sweepCompletedAt = sampledAt;
        }
        const relationBytes = tables.reduce((sum, table) => sum + table.bytes, 0);
        const walBytes = await this.walBytes();
        const disk = await statfs(this.pgliteDir);
        const availableBytes = disk.bavail * disk.bsize;
        const availableRatio = disk.bavail / disk.blocks;
        if (this.baseline && sampledAt - this.baseline.at >= HOUR) {
            this.growth = { since: this.baseline.at, relationBytes: relationBytes - this.baseline.relationBytes, walBytes: walBytes - this.baseline.walBytes,
                previousRelationBytes: this.baseline.relationBytes, previousWalBytes: this.baseline.walBytes };
            this.baseline = { at: sampledAt, relationBytes, walBytes };
        } else if (!this.baseline) {
            this.baseline = { at: sampledAt, relationBytes, walBytes };
        }
        const reasons: string[] = [];
        const diskCritical = availableBytes < 2 * 1024 ** 3 || availableRatio < 0.1;
        if (diskCritical) reasons.push('disk-critical');
        else if (availableBytes < 5 * 1024 ** 3 || availableRatio < 0.2) reasons.push('disk-low');
        if (!this.enabled) reasons.push('disabled');
        if (tables.some(table => table.oversize)) reasons.push('oversize');
        if (tables.some(table => table.problem === 'slow') || this.checkpoint.problem === 'slow') reasons.push('slow');
        if (tables.some(table => table.problem === 'failed') || this.checkpoint.problem === 'failed') reasons.push('sql-failed');
        if (this.enabled && tables.some(table => sampledAt - (table.lastSuccessAt ?? this.startedAt) > (HOT_TABLES.has(table.name) ? 30 * MINUTE : 2 * HOUR))) reasons.push('maintenance-overdue');
        if (this.enabled && sampledAt - (this.checkpoint.lastSuccessAt ?? this.startedAt) > 2 * HOUR) reasons.push('checkpoint-overdue');
        if (this.growth && (this.growth.relationBytes > Math.max(MAX_RELATION_BYTES, this.growth.previousRelationBytes * 0.25)
            || this.growth.walBytes > Math.max(MAX_RELATION_BYTES, this.growth.previousWalBytes * 0.25))) reasons.push('growth');
        this.status = { version: 1, processId: process.pid, startedAt: this.startedAt, sampledAt, enabled: this.enabled,
            severity: diskCritical ? 'critical' : reasons.length ? 'warning' : 'healthy', reasons,
            sweepCompletedAt: this.sweepCompletedAt, relationBytes, walBytes, availableBytes, availableRatio,
            growth: this.growth, checkpoint: { ...this.checkpoint }, tables };
        try {
            await writeFile(this.statusPath + '.tmp', JSON.stringify(this.status) + '\n', { mode: 0o600 });
            await rename(this.statusPath + '.tmp', this.statusPath);
            this.failedWrite = false;
        } catch {
            if (!this.failedWrite || sampledAt - this.lastReport >= HOUR) {
                error({ module: 'pglite-maintenance', operation: 'status.write' }, 'Database maintenance status write failed');
                this.lastReport = sampledAt;
            }
            this.failedWrite = true;
        }
        const reasonKey = reasons.join(',');
        if (reasonKey !== this.lastReasons || sampledAt - this.lastReport >= HOUR) {
            const report = diskCritical ? error : reasons.length ? warn : log;
            report({ module: 'pglite-maintenance', reasons, relationBytes, walBytes, availableBytes,
                tables: tables.length, sweepCompletedAt: this.sweepCompletedAt }, 'Database maintenance status');
            this.lastReasons = reasonKey;
            this.lastReport = sampledAt;
        }
    }
}
