import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CliSyncV4DiagnosticLog,
    cliSyncV4DiagnosticStatsAreDegraded,
    createSyncV4TraceId,
    deriveCodexProtocolTracePath,
    deriveSyncV4DiagnosticPath,
    syncV4DiagnosticHash,
} from './syncV4Diagnostics';

describe('CLI Sync v4 diagnostics', () => {
    it('persists valid payload-free events and rejects arbitrary fields', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-sync-v4-diagnostics-'));
        const path = join(root, 'session.sync-v4.jsonl');
        const diagnostics = await CliSyncV4DiagnosticLog.open(path);
        const secret = 'prompt-and-reasoning-secret';
        diagnostics.record({
            level: 'info',
            component: 'cli.sync',
            event: 'snapshot',
            phase: 'completed',
            sessionHash: syncV4DiagnosticHash('session'),
            count: 3,
            highWatermark: 9,
        });
        diagnostics.record({
            level: 'error',
            component: 'cli.gateway',
            event: 'rpc',
            phase: 'failed',
            message: secret,
        } as never);
        await diagnostics.close();

        const content = await readFile(path, 'utf8');
        expect(content).toContain('"event":"snapshot"');
        expect(content).not.toContain(secret);
        expect(diagnostics.stats().invalidRecords).toBe(1);
    });

    it('creates stable opaque hashes, random trace IDs, and sibling log paths', () => {
        expect(syncV4DiagnosticHash('same')).toBe(syncV4DiagnosticHash('same'));
        expect(syncV4DiagnosticHash('same')).not.toContain('same');
        expect(createSyncV4TraceId()).toMatch(/^[0-9a-f]{32}$/);
        expect(createSyncV4TraceId()).not.toBe(createSyncV4TraceId());
        expect(deriveSyncV4DiagnosticPath('/tmp/session.log')).toBe('/tmp/session.sync-v4.jsonl');
        expect(deriveCodexProtocolTracePath('/tmp/session.log')).toBe('/tmp/session.codex-rpc.jsonl');
    });

    it('marks actual diagnostic loss or failure as degraded', () => {
        const healthy = {
            currentFileBytes: 12,
            pendingBytes: 4,
            droppedRecords: 0,
            invalidRecords: 0,
            writeFailures: 0,
        };

        expect(cliSyncV4DiagnosticStatsAreDegraded(undefined)).toBe(false);
        expect(cliSyncV4DiagnosticStatsAreDegraded(healthy)).toBe(false);
        expect(cliSyncV4DiagnosticStatsAreDegraded({ ...healthy, droppedRecords: 1 })).toBe(true);
        expect(cliSyncV4DiagnosticStatsAreDegraded({ ...healthy, invalidRecords: 1 })).toBe(true);
        expect(cliSyncV4DiagnosticStatsAreDegraded({ ...healthy, writeFailures: 1 })).toBe(true);
    });
});
