import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    BoundedJsonlWriter,
    removeStaleBoundedJsonlFiles,
} from './boundedJsonlWriter';

const injectedChmodFailure = vi.hoisted(() => ({
    path: null as string | null,
    remaining: 0,
}));

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
        ...actual,
        chmod: vi.fn(async (
            path: Parameters<typeof actual.chmod>[0],
            mode: Parameters<typeof actual.chmod>[1],
        ) => {
            if (String(path) === injectedChmodFailure.path && injectedChmodFailure.remaining > 0) {
                injectedChmodFailure.remaining -= 1;
                throw Object.assign(new Error('injected chmod failure'), { code: 'EACCES' });
            }
            return actual.chmod(path, mode);
        }),
    };
});

describe('BoundedJsonlWriter', () => {
    it('orders records, rotates at the byte limit, and restricts file permissions', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-bounded-jsonl-'));
        const path = join(root, 'diagnostic.sync-v4.jsonl');
        const writer = await BoundedJsonlWriter.open(path, {
            maxFileBytes: 100,
            maxSegments: 3,
            maxRecordBytes: 80,
        });
        for (let index = 0; index < 12; index += 1) {
            writer.appendJson({ index, value: 'bounded' });
        }
        await writer.close();

        const files = await Promise.all(
            [path, `${path}.1`, `${path}.2`].map(async (candidate) => ({
                candidate,
                content: await readFile(candidate, 'utf8').catch(() => ''),
            })),
        );
        const records = files
            .slice()
            .reverse()
            .flatMap(({ content }) => content.trim().split('\n').filter(Boolean))
            .map((line) => JSON.parse(line) as { index: number });
        expect(records.length).toBeGreaterThan(0);
        expect(records.map((record) => record.index)).toEqual(
            [...records].map((record) => record.index).sort((left, right) => left - right),
        );
        expect(records.at(-1)?.index).toBe(11);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        for (const file of files) {
            if (!file.content) continue;
            expect(Buffer.byteLength(file.content)).toBeLessThanOrEqual(100);
        }
    });

    it('drops oversized and non-serializable records without writing their contents', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-bounded-jsonl-'));
        const path = join(root, 'diagnostic.sync-v4.jsonl');
        const writer = await BoundedJsonlWriter.open(path, {
            maxFileBytes: 100,
            maxSegments: 2,
            maxRecordBytes: 40,
        });
        writer.appendJson({ secret: 'x'.repeat(100) });
        const circular: { self?: unknown } = {};
        circular.self = circular;
        writer.appendJson(circular);
        await writer.close();

        expect(writer.stats().writeFailures).toBe(2);
        await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('keeps byte accounting correct when append succeeds and chmod fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-bounded-jsonl-'));
        const path = join(root, 'diagnostic.sync-v4.jsonl');
        const firstLine = `${JSON.stringify({ index: 0 })}\n`;
        const writer = await BoundedJsonlWriter.open(path, {
            maxFileBytes: Buffer.byteLength(firstLine),
            maxSegments: 2,
            maxRecordBytes: Buffer.byteLength(firstLine),
        });
        injectedChmodFailure.path = path;
        injectedChmodFailure.remaining = 1;

        writer.appendJson({ index: 0 });
        await expect(writer.flush()).rejects.toThrow('injected chmod failure');
        expect(writer.stats().currentFileBytes).toBe(Buffer.byteLength(firstLine));

        writer.appendJson({ index: 1 });
        await expect(writer.close()).rejects.toThrow('injected chmod failure');
        expect(await readFile(`${path}.1`, 'utf8')).toBe(firstLine);
        expect(await readFile(path, 'utf8')).toBe(`${JSON.stringify({ index: 1 })}\n`);
        expect((await stat(path)).size).toBeLessThanOrEqual(Buffer.byteLength(firstLine));
    });

    it('keeps the active file bounded when only one segment is configured', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-bounded-jsonl-'));
        const path = join(root, 'diagnostic.sync-v4.jsonl');
        const lineBytes = Buffer.byteLength(`${JSON.stringify({ index: 0 })}\n`);
        const writer = await BoundedJsonlWriter.open(path, {
            maxFileBytes: lineBytes,
            maxSegments: 1,
            maxRecordBytes: lineBytes,
        });

        writer.appendJson({ index: 0 });
        await writer.flush();
        writer.appendJson({ index: 1 });
        await writer.close();

        expect(await readFile(path, 'utf8')).toBe(`${JSON.stringify({ index: 1 })}\n`);
        expect((await stat(path)).size).toBeLessThanOrEqual(lineBytes);
    });

    it('bounds the pending queue and retains the newest queued diagnostics', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-bounded-jsonl-'));
        const path = join(root, 'diagnostic.sync-v4.jsonl');
        const writer = await BoundedJsonlWriter.open(path, {
            maxFileBytes: 1_024,
            maxSegments: 2,
            maxRecordBytes: 128,
            maxPendingBytes: 128,
        });

        for (let index = 0; index < 20; index += 1) {
            writer.appendJson({ index, value: 'bounded-pending-record' });
        }
        await writer.close();

        const records = (await readFile(path, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { index: number });
        expect(writer.stats()).toMatchObject({
            pendingBytes: 0,
            writeFailures: 0,
        });
        expect(writer.stats().droppedRecords).toBeGreaterThan(0);
        expect(records.at(-1)?.index).toBe(19);
        expect(records.map((record) => record.index)).toEqual(
            [...records].map((record) => record.index).sort((left, right) => left - right),
        );
    });

    it('removes only stale diagnostic files with an allowlisted suffix', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-bounded-jsonl-'));
        const stale = join(root, 'old.sync-v4.jsonl');
        const staleSegment = `${stale}.1`;
        const recent = join(root, 'recent.codex-rpc.jsonl');
        const unrelated = join(root, 'unrelated.log');
        await Promise.all([
            writeFile(stale, '{}\n'),
            writeFile(staleSegment, '{}\n'),
            writeFile(recent, '{}\n'),
            writeFile(unrelated, '{}\n'),
        ]);
        const old = new Date(1_000);
        await Promise.all([utimes(stale, old, old), utimes(staleSegment, old, old)]);

        const removed = await removeStaleBoundedJsonlFiles({
            directory: root,
            filenameSuffixes: ['.sync-v4.jsonl', '.codex-rpc.jsonl'],
            retentionMs: 1_000,
            now: 10_000,
        });

        expect(removed).toBe(2);
        await expect(readFile(stale, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(staleSegment, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(recent, 'utf8')).resolves.toBe('{}\n');
        await expect(readFile(unrelated, 'utf8')).resolves.toBe('{}\n');
    });
});
