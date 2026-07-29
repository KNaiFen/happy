import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CodexProtocolTraceRecorder,
    CodexProtocolTraceReplayer,
    readCodexProtocolTrace,
} from './codexProtocolTrace';
import { syncV4DiagnosticHash } from '@/api/syncV4Diagnostics';
import { redactCodexProtocolMethod } from './codexProtocolMethod';

describe('Codex protocol trace', () => {
    it('records only methods, hashed ids, timing, and value-free payload shapes', () => {
        let now = 1_000;
        const recorder = new CodexProtocolTraceRecorder({
            now: () => now,
            hashSecret: new Uint8Array(32).fill(7),
        });
        recorder.record('outbound', {
            jsonrpc: '2.0',
            id: 17,
            method: 'turn/start',
            params: {
                threadId: 'thread-provider-secret',
                clientUserMessageId: 'client-message-secret',
                input: [{ type: 'text', text: 'plaintext prompt must not be recorded' }],
                arguments: { privateParameterName: 'private tool value' },
            },
        });
        now += 25;
        recorder.record('inbound', {
            jsonrpc: '2.0',
            id: 17,
            result: {
                turn: { id: 'turn-provider-secret', status: 'inProgress', items: [] },
            },
        });
        now += 5;
        recorder.record('inbound', {
            jsonrpc: '2.0',
            method: 'item/agentMessage/delta',
            params: { itemId: 'item-provider-secret', output: 'private output' },
        });

        const entries = recorder.snapshot();
        expect(entries).toHaveLength(3);
        expect(entries[0]).toMatchObject({
            direction: 'outbound',
            kind: 'request',
            method: 'turn/start',
            offsetMs: 0,
        });
        expect(entries[1]).toMatchObject({
            direction: 'inbound',
            kind: 'response',
            method: 'turn/start',
            offsetMs: 25,
            rpcIdHash: entries[0].rpcIdHash,
        });
        expect(entries[2]).toMatchObject({
            kind: 'notification',
            method: 'item/agentMessage/delta',
            offsetMs: 30,
        });
        expect(entries[0].ids.map((entry) => entry.kind)).toEqual(['clientMessage', 'thread']);
        expect(entries[1].ids.map((entry) => entry.kind)).toEqual(['turn']);
        expect(entries[0].ids.find((entry) => entry.kind === 'thread')?.hash)
            .toBe(syncV4DiagnosticHash('thread-provider-secret'));
        expect(entries[1].ids[0].hash).toBe(syncV4DiagnosticHash('turn-provider-secret'));

        const serialized = JSON.stringify(entries);
        for (const secret of [
            'thread-provider-secret',
            'client-message-secret',
            'turn-provider-secret',
            'item-provider-secret',
            'plaintext prompt must not be recorded',
            'privateParameterName',
            'private tool value',
            'private output',
            'threadId',
            'input',
            'arguments',
        ]) {
            expect(serialized).not.toContain(secret);
        }
    });

    it('persists private JSONL and replays entries in deterministic sequence order', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-trace-'));
        const path = join(root, 'trace.jsonl');
        let now = 5_000;
        const recorder = await CodexProtocolTraceRecorder.open(path, {
            now: () => now,
            hashSecret: new Uint8Array(32).fill(9),
        });
        recorder.record('inbound', { method: 'thread/started', params: { threadId: 'thread-1' } });
        now += 10;
        recorder.record('inbound', { method: 'turn/started', params: { threadId: 'thread-1' } });
        await recorder.close();

        const loaded = await readCodexProtocolTrace(path);
        expect(loaded.map((entry) => entry.method)).toEqual(['thread/started', 'turn/started']);
        const replayed: string[] = [];
        await new CodexProtocolTraceReplayer([...loaded].reverse()).replay((entry) => {
            replayed.push(entry.method!);
        });
        expect(replayed).toEqual(['thread/started', 'turn/started']);

        await writeFile(path, '{"incomplete":', { flag: 'a' });
        await expect(readCodexProtocolTrace(path)).resolves.toHaveLength(2);
    });

    it('supports cancellation during timing replay', async () => {
        const recorder = new CodexProtocolTraceRecorder({
            now: (() => {
                let value = 0;
                return () => value += 100;
            })(),
            hashSecret: new Uint8Array(32).fill(4),
        });
        recorder.record('inbound', { method: 'thread/started' });
        recorder.record('inbound', { method: 'turn/started' });
        const controller = new AbortController();
        const replayed: string[] = [];

        await expect(new CodexProtocolTraceReplayer(recorder.snapshot()).replay((entry) => {
            replayed.push(entry.method!);
            controller.abort();
        }, { speed: 1_000, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(replayed).toEqual(['thread/started']);
    });

    it('bounds the default in-memory ring at 4,096 ordered entries', () => {
        const recorder = new CodexProtocolTraceRecorder({
            hashSecret: new Uint8Array(32).fill(5),
        });
        for (let index = 0; index < 4_097; index += 1) {
            recorder.record('inbound', { method: 'turn/started', params: { index } });
        }

        const entries = recorder.snapshot();
        expect(entries).toHaveLength(4_096);
        expect(entries[0].sequence).toBe(1);
        expect(entries.at(-1)?.sequence).toBe(4_096);
    });

    it('bounds pending RPC correlation at 4,096 fixed-length hashed keys', () => {
        const recorder = new CodexProtocolTraceRecorder({
            hashSecret: new Uint8Array(32).fill(6),
            maxMemoryEntries: 5_000,
        });
        for (let index = 0; index < 4_097; index += 1) {
            recorder.record('outbound', {
                id: `rpc-provider-secret-${index}`,
                method: 'turn/start',
                params: {},
            });
        }
        recorder.record('inbound', { id: 'rpc-provider-secret-0', result: {} });
        recorder.record('inbound', { id: 'rpc-provider-secret-1', result: {} });

        const entries = recorder.snapshot();
        expect(entries.at(-2)).toMatchObject({ kind: 'response', method: null });
        expect(entries.at(-1)).toMatchObject({ kind: 'response', method: 'turn/start' });
        expect(JSON.stringify(entries)).not.toContain('rpc-provider-secret');
    });

    it('hashes unknown methods and applies shape and id traversal budgets', () => {
        const secretMethod = `provider/private-${'x'.repeat(20_000)}`;
        const recorder = new CodexProtocolTraceRecorder({
            hashSecret: new Uint8Array(32).fill(8),
        });
        recorder.record('inbound', {
            id: `private-rpc-${'y'.repeat(20_000)}`,
            method: secretMethod,
            params: {
                entries: Array.from({ length: 10_000 }, (_, index) => ({
                    itemId: `private-item-${index}`,
                    output: 'private-output',
                })),
            },
        });

        const entry = recorder.snapshot()[0];
        expect(entry.method).toBe(redactCodexProtocolMethod(secretMethod));
        expect(entry.method).toMatch(/^unknown:[0-9a-f]{24}$/);
        expect(entry.ids.length).toBeLessThanOrEqual(128);
        const serialized = JSON.stringify(entry);
        expect(serialized).not.toContain('provider/private');
        expect(serialized).not.toContain('private-rpc');
        expect(serialized).not.toContain('private-item');
        expect(serialized).not.toContain('private-output');
    });

    it('stops enumerating object fields after the traversal budget is exhausted', () => {
        const keys = Array.from({ length: 20_000 }, (_, index) => `field${index}`);
        let descriptorReads = 0;
        const oversized = new Proxy<Record<string, number>>({}, {
            ownKeys: () => keys,
            getOwnPropertyDescriptor: () => {
                descriptorReads += 1;
                return { configurable: true, enumerable: true };
            },
            get: () => 1,
        });
        const recorder = new CodexProtocolTraceRecorder({
            hashSecret: new Uint8Array(32).fill(10),
        });

        recorder.record('inbound', {
            method: 'turn/started',
            params: oversized,
        });

        expect(recorder.snapshot()).toHaveLength(1);
        expect(descriptorReads).toBeGreaterThan(0);
        expect(descriptorReads).toBeLessThan(5_000);
    });

    it('fails open on hostile messages and exposes bounded recorder statistics', () => {
        const recorder = new CodexProtocolTraceRecorder({
            hashSecret: new Uint8Array(32).fill(2),
        });
        const hostile = new Proxy({}, {
            get: () => {
                throw new Error('prompt-reasoning-tool-output-secret');
            },
        });

        expect(() => recorder.record('inbound', hostile)).not.toThrow();
        expect(recorder.stats()).toMatchObject({
            memoryEntries: 0,
            pendingRequests: 0,
            invalidRecords: 1,
            droppedRecords: 0,
            writeFailures: 0,
        });
    });

    it('reads bounded rotated segments in sequence and ignores a truncated tail', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-trace-'));
        const path = join(root, 'trace.jsonl');
        const recorder = await CodexProtocolTraceRecorder.open(path, {
            hashSecret: new Uint8Array(32).fill(3),
            maxFileBytes: 600,
            maxFileSegments: 3,
        });
        for (let index = 0; index < 24; index += 1) {
            recorder.record('inbound', {
                method: 'item/agentMessage/delta',
                params: { threadId: `thread-${index}`, delta: 'private-output' },
            });
        }
        await recorder.close();

        const segmentNames = (await readdir(root)).filter((entry) => entry.startsWith('trace.jsonl'));
        expect(segmentNames.length).toBeLessThanOrEqual(3);
        for (const segmentName of segmentNames) {
            expect((await stat(join(root, segmentName))).size).toBeLessThanOrEqual(600);
        }
        const beforeTruncation = await readCodexProtocolTrace(path);
        expect(beforeTruncation.length).toBeGreaterThan(0);
        expect(beforeTruncation.map((entry) => entry.sequence)).toEqual(
            [...beforeTruncation].map((entry) => entry.sequence).sort((left, right) => left - right),
        );

        await writeFile(path, '{"incomplete":', { flag: 'a' });
        await expect(readCodexProtocolTrace(path)).resolves.toHaveLength(beforeTruncation.length);
    });
});
