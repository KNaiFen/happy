import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createPGliteMock, pg } = vi.hoisted(() => ({
    createPGliteMock: vi.fn(),
    pg: {
        exec: vi.fn(),
        query: vi.fn(),
        close: vi.fn(),
    },
}));

vi.mock('./storage/pgliteLoader', () => ({ createPGlite: createPGliteMock }));

import { runMigrations } from './standalone';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
        recursive: true,
        force: true,
    })));
});

describe('runMigrations payload-free failures', () => {
    it('does not expose migration names, paths, or database errors', async () => {
        const hostile = 'prompt-reasoning-tool-output-migration';
        const root = await mkdtemp(join(tmpdir(), 'happy-standalone-log-'));
        temporaryDirectories.push(root);
        const migrationsDir = join(root, hostile);
        const migrationDir = join(migrationsDir, hostile);
        await mkdir(migrationDir, { recursive: true });
        await writeFile(join(migrationDir, 'migration.sql'), 'SELECT 1;', 'utf8');

        createPGliteMock.mockReturnValue(pg);
        pg.exec.mockReset()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error(hostile));
        pg.query.mockReset().mockResolvedValueOnce({ rows: [] });
        pg.close.mockReset().mockResolvedValue(undefined);
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await expect(runMigrations({
            pgliteDir: join(root, hostile, 'database'),
            migrationsDir,
        })).rejects.toThrow('Database migration failed');

        const output = JSON.stringify(log.mock.calls);
        expect(output).not.toContain(hostile);
        expect(output).toContain('Migrating database');
        expect(output).toContain('Applying database migration');
    });
});
