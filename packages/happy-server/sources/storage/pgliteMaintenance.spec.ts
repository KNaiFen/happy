import { PGlite } from '@electric-sql/pglite';
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../standalone';
import { acquireAccountRead, acquireAccountWrite } from '../app/account/accountWriteGate';
import { PGliteMaintenance, type PGliteMaintenanceStatus } from './pgliteMaintenance';

const directories: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'happy-maintenance-'));
    directories.push(root);
    const directory = join(root, 'pglite');
    await runMigrations({ pgliteDir: directory, migrationsDir: resolve('prisma/migrations') });
    const pg = new PGlite(directory);
    const client = new PrismaClient({ adapter: new PrismaPGlite(pg) as unknown as Prisma.PrismaClientOptions['adapter'] });
    const account = await client.account.create({ data: { publicKey: crypto.randomUUID() } });
    return { pg, client, directory, account };
}

describe('PGlite maintenance and account admission', () => {
    it('locks without updating rows, preserves encrypted data across maintenance and reopen', async () => {
        const { pg, client, directory, account } = await fixture();
        let now = Date.now();
        const maintenance = new PGliteMaintenance(pg, directory, true, () => now);
        const rowVersion = () => pg.query('SELECT xmin::text, ctid::text, "updatedAt" FROM "Account"');
        const before = (await rowVersion()).rows;
        const session = await client.session.create({ data: { accountId: account.id, tag: 'maintenance', metadata: 'encrypted', dataEncryptionKey: new Uint8Array([0, 255, 128]) } });
        try {
            for (let i = 0; i < 20; i++) {
                await client.$transaction(async tx => {
                    expect(await acquireAccountRead(tx, account.id)).toBe(true);
                    expect(await acquireAccountWrite(tx, account.id)).toBe(true);
                    expect(await acquireAccountRead(tx, 'absent')).toBe(false);
                }, { isolationLevel: 'Serializable' });
            }
            expect((await rowVersion()).rows).toEqual(before);
            for (let i = 0; i < 65; i++) {
                now += 60_001;
                await maintenance.runOnce();
            }
            const status: PGliteMaintenanceStatus = JSON.parse(await readFile(maintenance.statusPath, 'utf8'));
            expect(status.tables.every(table => table.successes > 0)).toBe(true);
            expect(status.tables.find(table => table.name === 'Account')!.successes).toBeGreaterThan(3);
            expect(status.sweepCompletedAt).not.toBeNull();
            expect(status.checkpoint.successes).toBe(1);
            expect(status.relationBytes).toBeGreaterThan(0);
            expect(status.growth).not.toBeNull();
            expect((await rowVersion()).rows).toEqual(before);
            await client.account.update({ where: { id: account.id }, data: { deletionRequestedAt: new Date() } });
            await expect(client.$transaction(tx => acquireAccountRead(tx, account.id))).resolves.toBe(false);
        } finally {
            await maintenance.stop();
            await client.$disconnect();
            await pg.close();
        }
        const reopened = new PGlite(directory);
        const reopenedClient = new PrismaClient({ adapter: new PrismaPGlite(reopened) as unknown as Prisma.PrismaClientOptions['adapter'] });
        const restarted = new PGliteMaintenance(reopened, directory);
        try {
            const saved = await reopenedClient.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(saved.metadata).toBe('encrypted');
            expect(Array.from(saved.dataEncryptionKey!)).toEqual([0, 255, 128]);
            expect(restarted.status).toBeNull();
            await restarted.runOnce();
            expect(restarted.status!.checkpoint.successes).toBe(0);
            expect(restarted.status!.tables.filter(table => table.successes > 0)).toHaveLength(1);
        } finally {
            await restarted.stop();
            await reopenedClient.$disconnect();
            await reopened.close();
        }
    }, 30_000);

    it('waits for the existing transaction and in-flight maintenance before stopping', async () => {
        const { pg, client, directory, account } = await fixture();
        const maintenance = new PGliteMaintenance(pg, directory);
        let release!: () => void;
        let entered!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        let sqlEntered!: () => void;
        const sqlReady = new Promise<void>(resolve => { sqlEntered = resolve; });
        const originalQuery = pg.query.bind(pg);
        vi.spyOn(pg, 'query').mockImplementation((...args: Parameters<typeof pg.query>) => {
            sqlEntered();
            return originalQuery(...args);
        });
        try {
            const transaction = client.$transaction(async tx => {
                await acquireAccountWrite(tx, account.id);
                entered();
                await held;
                await tx.account.update({ where: { id: account.id }, data: { settings: 'preserved' } });
            });
            await ready;
            const tick = maintenance.runOnce();
            expect(maintenance.runOnce()).toBe(tick);
            await sqlReady;
            let stopped = false;
            const stop = maintenance.stop().then(() => { stopped = true; });
            await Promise.resolve();
            expect(stopped).toBe(false);
            release();
            await Promise.all([transaction, tick, stop]);
            expect(stopped).toBe(true);
            expect((await client.account.findUniqueOrThrow({ where: { id: account.id } })).settings).toBe('preserved');
            expect(maintenance.status!.tables.every(table => table.successes === 0)).toBe(true);
        } finally {
            release();
            await maintenance.stop();
            await client.$disconnect();
            await pg.close();
        }
    }, 30_000);

    it('reports failed SQL, backs off only the failing table, and recovers', async () => {
        const { pg, client, directory } = await fixture();
        let now = Date.now();
        const maintenance = new PGliteMaintenance(pg, directory, true, () => now);
        const exec = pg.exec.bind(pg);
        const failing = vi.spyOn(pg, 'exec').mockImplementation((sql, options) => {
            if (sql.includes('public."Account"')) return Promise.reject(new Error('injected'));
            return exec(sql, options);
        });
        try {
            for (let i = 0; i < 30; i++) { now += 60_001; await maintenance.runOnce(); }
            const table = maintenance.status!.tables.find(table => table.name === 'Account')!;
            expect(table.failures).toBe(3);
            expect(table.lastSuccessAt).toBeNull();
            expect(table.nextAttemptAt).toBeGreaterThan(now);
            expect(maintenance.status!.reasons).toContain('sql-failed');
            expect(maintenance.status!.tables.some(item => item.successes > 0)).toBe(true);
            failing.mockRestore();
            now += 60 * 60_000;
            await maintenance.runOnce();
            now += 60_001;
            await maintenance.runOnce();
            expect(maintenance.status!.tables.find(item => item.name === 'Account')!.problem).toBeNull();
        } finally {
            await maintenance.stop();
            await client.$disconnect();
            await pg.close();
        }
    }, 30_000);

    it('reports disabled maintenance and survives an unwritable status destination', async () => {
        const { pg, client, directory } = await fixture();
        const maintenance = new PGliteMaintenance(pg, directory, false);
        try {
            await mkdir(maintenance.statusPath);
            await expect(maintenance.runOnce()).resolves.toBeUndefined();
            expect(maintenance.status!.reasons).toContain('disabled');
            expect(maintenance.status!.tables.every(table => table.successes === 0)).toBe(true);
            await rm(maintenance.statusPath, { recursive: true });
            await maintenance.runOnce();
            const saved = JSON.parse(await readFile(maintenance.statusPath, 'utf8'));
            expect(saved.enabled).toBe(false);
        } finally {
            await maintenance.stop();
            await client.$disconnect();
            await pg.close();
        }
    }, 30_000);

    it('backs off slow operations without cancelling SQL and waits for actual completion on stop', async () => {
        const { pg, client, directory } = await fixture();
        let now = Date.now();
        const maintenance = new PGliteMaintenance(pg, directory, true, () => now);
        let release!: () => void;
        let entered!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const hold = new Promise<void>(resolve => { release = resolve; });
        const exec = pg.exec.bind(pg);
        vi.spyOn(pg, 'exec').mockImplementation(async (sql, options) => {
            entered();
            await hold;
            return exec(sql, options);
        });
        try {
            const tick = maintenance.runOnce();
            await ready;
            const start = performance.now();
            vi.spyOn(performance, 'now').mockReturnValue(start + 2001);
            let stopped = false;
            const stopping = maintenance.stop().then(() => { stopped = true; });
            await Promise.resolve();
            expect(stopped).toBe(false);
            release();
            await Promise.all([tick, stopping]);
            const result = maintenance.status!.tables.find(table => table.lastAttemptAt !== null)!;
            expect(result.problem).toBe('slow');
            expect(result.successes).toBe(1);
            expect(result.nextAttemptAt).toBe(now + 60 * 60_000);
            expect(maintenance.status!.reasons).toContain('slow');
        } finally {
            release();
            await maintenance.stop();
            await client.$disconnect();
            await pg.close();
        }
    }, 30_000);

    it('retains hourly backoff through a failure until a normal successful operation', async () => {
        const { pg, client, directory } = await fixture();
        let now = Date.now();
        const maintenance = new PGliteMaintenance(pg, directory, true, () => now);
        const exec = pg.exec.bind(pg);
        let mode: 'slow' | 'failed' | 'normal' = 'slow';
        vi.spyOn(pg, 'exec').mockImplementation(async (sql, options) => {
            if (sql.includes('public."Account"')) {
                if (mode === 'failed') throw new Error('injected');
                if (mode === 'slow') vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2001);
            }
            return exec(sql, options);
        });
        const accountResult = () => maintenance.status!.tables.find(table => table.name === 'Account')!;
        try {
            await maintenance.runOnce();
            expect(accountResult().problem).toBe('slow');
            vi.mocked(performance.now).mockRestore();
            mode = 'failed';
            now += 60 * 60_000;
            await maintenance.runOnce(); // Hourly checkpoint has its own tick.
            for (let i = 0; i < 3 && accountResult().problem !== 'failed'; i++) {
                now += 60_001;
                await maintenance.runOnce();
            }
            expect(accountResult().problem).toBe('failed');
            expect(accountResult().failures).toBe(1);
            expect(accountResult().nextAttemptAt).toBe(now + 60 * 60_000);
            mode = 'normal';
            now += 60 * 60_000;
            await maintenance.runOnce();
            for (let i = 0; i < 3 && accountResult().problem !== null; i++) {
                now += 60_001;
                await maintenance.runOnce();
            }
            expect(accountResult().problem).toBeNull();
            expect(accountResult().backedOff).toBe(false);
            expect(accountResult().failures).toBe(0);
        } finally {
            await maintenance.stop();
            await client.$disconnect();
            await pg.close();
        }
    }, 30_000);

    it('queues two real Prisma transactions on the same PGlite owner', async () => {
        const { pg, client, account } = await fixture();
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const ready = new Promise<void>(resolve => { entered = resolve; });
        let firstCommitted = false;
        try {
            const first = client.$transaction(async tx => {
                expect(await acquireAccountWrite(tx, account.id)).toBe(true);
                entered();
                await held;
                await tx.account.update({ where: { id: account.id }, data: { deletionRequestedAt: new Date() } });
            }, { isolationLevel: 'Serializable' }).then(() => { firstCommitted = true; });
            await ready;
            const second = client.$transaction(async tx => {
                const admitted = await acquireAccountRead(tx, account.id);
                expect(firstCommitted).toBe(true);
                return admitted;
            }, { isolationLevel: 'Serializable' });
            release();
            await expect(second).resolves.toBe(false);
            await first;
        } finally {
            release();
            await client.$disconnect();
            await pg.close();
        }
    }, 30_000);
});
