import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CodexProtocolTraceRecorder,
    CodexProtocolTraceReplayer,
    readCodexProtocolTrace,
} from './codexProtocolTrace';

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
            method: 'provider/newNotification',
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
            method: 'provider/newNotification',
            offsetMs: 30,
        });
        expect(entries[0].ids.map((entry) => entry.kind)).toEqual(['clientMessage', 'thread']);
        expect(entries[1].ids.map((entry) => entry.kind)).toEqual(['turn']);

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
        recorder.record('inbound', { method: 'first/event', params: { threadId: 'thread-1' } });
        now += 10;
        recorder.record('inbound', { method: 'second/event', params: { threadId: 'thread-1' } });
        await recorder.close();

        const loaded = await readCodexProtocolTrace(path);
        expect(loaded.map((entry) => entry.method)).toEqual(['first/event', 'second/event']);
        const replayed: string[] = [];
        await new CodexProtocolTraceReplayer([...loaded].reverse()).replay((entry) => {
            replayed.push(entry.method!);
        });
        expect(replayed).toEqual(['first/event', 'second/event']);

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
        recorder.record('inbound', { method: 'first/event' });
        recorder.record('inbound', { method: 'second/event' });
        const controller = new AbortController();
        const replayed: string[] = [];

        await expect(new CodexProtocolTraceReplayer(recorder.snapshot()).replay((entry) => {
            replayed.push(entry.method!);
            controller.abort();
        }, { speed: 1_000, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(replayed).toEqual(['first/event']);
    });
});
