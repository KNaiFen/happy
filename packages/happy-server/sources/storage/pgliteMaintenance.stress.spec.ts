import { PGlite } from '@electric-sql/pglite';
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fastify from 'fastify';
import axios from 'axios';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../standalone';
import { acquireAccountRead, acquireAccountWrite } from '../app/account/accountWriteGate';
import { PGliteMaintenance } from './pgliteMaintenance';

const stress = process.env.HAPPY_PGLITE_MAINTENANCE_STRESS === '1' ? describe.sequential : describe.skip;
const MiB = 1024 ** 2;
const names = ['Account', 'Session', 'SessionEntityV4'];
type Sizes = { name: string; heap: number; toast: number; indexes: number; total: number }[];
const report: Record<string, unknown> = {};

async function saveReport() {
    const directory = process.env.HAPPY_MAINTENANCE_REPORT_DIR;
    if (!directory) throw new Error('Stress acceptance requires HAPPY_MAINTENANCE_REPORT_DIR');
    const memory = Number(await readFile('/sys/fs/cgroup/memory.max', 'utf8'));
    const [quota, period] = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(' ').map(Number);
    report.resources = { memoryBytes: memory, cpus: quota / period };
    expect(memory).toBeLessThanOrEqual(2 * 1024 ** 3);
    expect(quota / period).toBeLessThanOrEqual(2);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'maintenance.json'), JSON.stringify(report, null, 2) + '\n');
}

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'happy-maintenance-stress-'));
    const directory = join(root, 'pglite');
    await runMigrations({ pgliteDir: directory, migrationsDir: resolve('prisma/migrations') });
    const pg = new PGlite(directory);
    const client = new PrismaClient({ adapter: new PrismaPGlite(pg) as unknown as Prisma.PrismaClientOptions['adapter'] });
    return { pg, client, directory, async close() {
        await client.$disconnect();
        await pg.close();
        await rm(root, { recursive: true });
    } };
}

async function sizes(pg: PGlite): Promise<Sizes> {
    return (await pg.query<Sizes[number]>(`
        SELECT relname AS name, pg_relation_size(oid)::float8 AS heap,
            CASE WHEN reltoastrelid = 0 THEN 0 ELSE pg_total_relation_size(reltoastrelid) END::float8 AS toast,
            pg_indexes_size(oid)::float8 AS indexes, pg_total_relation_size(oid)::float8 AS total
        FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY relname
    `, [names])).rows;
}

async function content(pg: PGlite) {
    const hash = createHash('sha256');
    for (const name of names) {
        const rows = (await pg.query(`SELECT row_to_json(t) AS value FROM public."${name}" t ORDER BY id`)).rows;
        expect(rows).toHaveLength(32);
        hash.update(JSON.stringify(rows));
    }
    return hash.digest('hex');
}

stress('PGlite growth and constrained maintenance acceptance', () => {
    it('keeps 10,000 admission transactions from creating new Account row versions', async () => {
        const f = await fixture();
        try {
            const account = await f.client.account.create({ data: { publicKey: 'admission-stress' } });
            const version = () => f.pg.query('SELECT xmin::text, ctid::text, row_to_json(a) AS content FROM "Account" a');
            const before = (await version()).rows;
            for (let i = 0; i < 10_000; i++) {
                await f.client.$transaction(tx => i % 2 ? acquireAccountRead(tx, account.id) : acquireAccountWrite(tx, account.id), { isolationLevel: 'Serializable' });
            }
            expect((await version()).rows).toEqual(before);
            report.admissionTransactions = 10_000;
        } finally { await f.close(); await saveReport(); }
    }, 300_000);

    it('reuses heap, TOAST and indexes under fixed live data instead of linear growth', async () => {
        const measurements: { enabled: boolean; rounds: { relations: Sizes; wal: number }[]; maxMaintenanceMs: number }[] = [];
        report.growth = measurements;
        for (const enabled of [false, true]) {
            const f = await fixture();
            let now = Date.now();
            const maintenance = new PGliteMaintenance(f.pg, f.directory, enabled, () => now);
            const sample = { enabled, rounds: [] as { relations: Sizes; wal: number }[], maxMaintenanceMs: 0 };
            measurements.push(sample);
            const tick = async () => {
                now += 60_001;
                await maintenance.runOnce();
                const status = maintenance.status!;
                expect(status).not.toBeNull();
                sample.maxMaintenanceMs = Math.max(sample.maxMaintenanceMs, status.checkpoint.durationMs ?? 0,
                    ...status.tables.map(table => table.durationMs ?? 0));
                if (enabled) expect(status.reasons.filter(reason => ['slow', 'sql-failed', 'oversize'].includes(reason))).toEqual([]);
            };
            try {
                const payloads = Array.from({ length: 64 }, () => randomBytes(4096).toString('base64'));
                for (let i = 0; i < 32; i++) {
                    await f.client.account.create({ data: { id: `a${i}`, publicKey: `key${i}`, settings: payloads[i] } });
                    await f.client.session.create({ data: { id: `s${i}`, accountId: `a${i}`, tag: `tag${i}`, metadata: payloads[i] } });
                    await f.client.sessionEntityV4.create({ data: { id: `e${i}`, sessionId: `s${i}`, producerId: 'fixture', entityId: `entity${i}`, entityType: 'item', revision: 0, op: 'upsert', ciphertext: payloads[i], updatedSeq: 0 } });
                }
                for (let round = 0; round < 5; round++) {
                    for (let i = 0; i < 20_000; i++) {
                        const n = round * 20_000 + i;
                        const row = Math.floor(n / 3) % 32;
                        const payload = payloads[n % payloads.length];
                        // Each query commits independently, like ordinary short application transactions.
                        if (n % 3 === 0) await f.pg.query('UPDATE "Account" SET settings = $1, seq = seq + 1, "updatedAt" = now() WHERE id = $2', [payload, `a${row}`]);
                        else if (n % 3 === 1) await f.pg.query('UPDATE "Session" SET metadata = $1, seq = seq + 1, "updatedAt" = now() WHERE id = $2', [payload, `s${row}`]);
                        else await f.pg.query('UPDATE "SessionEntityV4" SET ciphertext = $1, revision = revision + 1, "updatedSeq" = "updatedSeq" + 1, "updatedAt" = now() WHERE id = $2', [payload, `e${row}`]);
                        if (i % 300 === 299) await tick();
                    }
                    const before = await content(f.pg);
                    for (let i = 0; i < 65; i++) await tick();
                    expect(await content(f.pg)).toBe(before);
                    sample.rounds.push({ relations: await sizes(f.pg), wal: maintenance.status!.walBytes });
                    await saveReport();
                }
            } finally { await maintenance.stop(); await f.close(); await saveReport(); }
        }
        const [disabled, enabled] = measurements;
        for (const table of names) {
            const value = (sample: typeof enabled, round: number) => sample.rounds[round].relations.find(row => row.name === table)!;
            expect(value(enabled, 4).toast).toBeGreaterThan(0);
            for (const round of [3, 4]) expect(value(enabled, round).total).toBeLessThanOrEqual(value(enabled, 2).total * 1.2 + MiB);
            expect(value(disabled, 4).total - value(disabled, 2).total).toBeGreaterThan(MiB);
            expect(value(disabled, 4).total).toBeGreaterThan(value(enabled, 4).total * 1.2 + MiB);
        }
        expect(enabled.maxMaintenanceMs).toBeLessThanOrEqual(2000);
    }, 1_800_000);

    it('keeps requests responsive at the table budget and reports larger relations', async () => {
        const f = await fixture();
        let now = Date.now();
        const maintenance = new PGliteMaintenance(f.pg, f.directory, true, () => now);
        const app = fastify();
        const latencies: number[][] = [[], []];
        const operations: { table: string; durationMs: number | null; problem: string | null }[] = [];
        report.boundaryOperations = operations;
        try {
            // EXTERNAL storage makes the boundary reflect real incompressible TOAST work.
            await f.pg.exec('CREATE TABLE public."MaintenanceBoundary" (id int PRIMARY KEY, payload text); ALTER TABLE public."MaintenanceBoundary" ALTER COLUMN payload SET STORAGE EXTERNAL');
            const payload = randomBytes(32 * 1024).toString('base64');
            const total = async () => (await f.pg.query<{ bytes: number }>(`SELECT pg_total_relation_size('public."MaintenanceBoundary"')::float8 AS bytes`)).rows[0].bytes;
            let inserted = 0;
            while (await total() < 248 * MiB) {
                await f.pg.query('INSERT INTO public."MaintenanceBoundary" SELECT n, $1 FROM generate_series($2::int, $3::int) n', [payload, inserted, inserted + 63]);
                inserted += 64;
            }
            const boundaryBytes = await total();
            expect(boundaryBytes).toBeLessThanOrEqual(256 * MiB);
            await f.pg.exec('DELETE FROM public."MaintenanceBoundary" WHERE id % 2 = 0');
            const account = await f.client.account.create({ data: { publicKey: 'latency-stress', settings: 'retained' } });
            app.get('/health', async () => { await f.pg.query('SELECT 1'); return { ok: true }; });
            app.get('/account', () => f.client.$transaction(async tx => {
                expect(await acquireAccountRead(tx, account.id)).toBe(true);
                return tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            }, { isolationLevel: 'Serializable' }));
            app.post('/account', () => f.client.$transaction(async tx => {
                expect(await acquireAccountWrite(tx, account.id)).toBe(true);
                return tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } }, select: { seq: true } });
            }, { isolationLevel: 'Serializable' }));
            await app.listen({ host: '127.0.0.1', port: 0 });
            const address = app.server.address() as { port: number };
            const request = async (phase: number, i: number) => {
                const start = performance.now();
                const response = await axios.request({ url: `http://127.0.0.1:${address.port}${i % 3 ? '/account' : '/health'}`, method: i % 3 === 2 ? 'POST' : 'GET', data: i % 3 === 2 ? {} : undefined, timeout: 5000, responseType: 'arraybuffer' });
                expect(response.status).toBe(200);
                latencies[phase].push(performance.now() - start);
            };
            for (let phase = 0; phase < 2; phase++) {
                const requests = (async () => { for (let i = 0; i < 600; i++) await request(phase, i); })();
                const ticks = phase === 0 ? Promise.resolve() : (async () => {
                    for (let i = 0; i < 65; i++) {
                        now += 60_001;
                        await maintenance.runOnce();
                        const status = maintenance.status!;
                        const completed = [...status.tables.map(table => ({ ...table, table: table.name })), { ...status.checkpoint, table: 'CHECKPOINT' }]
                            .filter(operation => operation.lastAttemptAt === now);
                        operations.push(...completed.map(({ table, durationMs, problem }) => ({ table, durationMs, problem })));
                        await saveReport();
                        for (const operation of completed) {
                            expect(operation.problem).toBeNull();
                            expect(operation.durationMs).toBeLessThanOrEqual(2000);
                        }
                    }
                })();
                await Promise.all([requests, ticks]);
            }
            const status = maintenance.status!;
            const boundary = status.tables.find(table => table.name === 'MaintenanceBoundary')!;
            expect(boundary.successes).toBeGreaterThan(0);
            expect(status.tables.every(table => table.successes > 0 && table.problem === null)).toBe(true);
            expect(status.checkpoint.successes).toBeGreaterThan(0);
            expect(status.checkpoint.problem).toBeNull();
            const p99 = latencies.map(values => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.99) - 1]);
            report.availability = { boundaryBytes, p99, requests: latencies.map(values => values.length), maxMaintenanceMs: Math.max(...operations.map(operation => operation.durationMs ?? 0)), firstBoundary: operations.find(operation => operation.table === 'MaintenanceBoundary') };
            expect(p99[1]).toBeLessThanOrEqual(p99[0] * 2 + 100);
            expect((await f.client.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(400);
            expect(boundary.durationMs).toBeLessThanOrEqual(2000);
            await f.pg.query('INSERT INTO public."MaintenanceBoundary" SELECT n, $1 FROM generate_series($2::int, $3::int) n', [payload, inserted, inserted + 4095]);
            expect(await total()).toBeGreaterThan(256 * MiB);
            now += 60_001;
            await maintenance.runOnce();
            expect(maintenance.status!.reasons).toContain('oversize');
            expect(maintenance.status!.tables.find(table => table.name === 'MaintenanceBoundary')!.successes).toBe(boundary.successes);
            const saved = JSON.parse(await readFile(maintenance.statusPath, 'utf8'));
            expect(saved.tables.find((table: { name: string }) => table.name === 'MaintenanceBoundary').oversize).toBe(true);
        } finally { await app.close(); await maintenance.stop(); await f.close(); await saveReport(); }
    }, 300_000);
});
