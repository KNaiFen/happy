import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';

const fakeServerPath = fileURLToPath(new URL('../../scripts/fake-codex-app-server.cjs', import.meta.url));

interface RunningFake {
    child: ChildProcessWithoutNullStreams;
    messages: Array<Record<string, unknown>>;
    stderr: string[];
}

describe('fake Codex app-server', () => {
    it('runs a default thread and streaming turn over real JSONL stdio', async () => {
        const fake = await startFake({});
        try {
            send(fake, {
                id: 1,
                method: 'initialize',
                params: {
                    clientInfo: { name: 'happy-test', title: 'Happy Test', version: '0.0.0' },
                    capabilities: { experimentalApi: false, requestAttestation: false },
                },
            });
            await waitFor(() => response(fake, 1) !== null);
            send(fake, { id: 2, method: 'thread/start', params: { cwd: '/tmp/project', model: 'gpt-test' } });
            await waitFor(() => response(fake, 2) !== null);
            const threadId = (((response(fake, 2)?.result as Record<string, unknown>).thread as Record<string, unknown>).id as string);
            send(fake, {
                id: 3,
                method: 'turn/start',
                params: {
                    threadId,
                    clientUserMessageId: 'command-3',
                    input: [{ type: 'text', text: 'test', text_elements: [] }],
                },
            });
            await waitFor(() => fake.messages.some((message) => message.method === 'turn/completed'));

            send(fake, { id: 4, method: 'thread/compact/start', params: { threadId } });
            await waitFor(() => fake.messages.some((message) => (
                message.method === 'item/completed'
                && (message.params as Record<string, unknown>)?.threadId === threadId
                && ((message.params as Record<string, unknown>)?.item as Record<string, unknown>)?.type === 'contextCompaction'
            )));

            expect(response(fake, 1)?.result).toMatchObject({ userAgent: 'happy-fake-codex/0.145.0' });
            expect(response(fake, 3)?.result).toMatchObject({ turn: { status: 'inProgress' } });
            expect(fake.messages.filter((message) => (
                message.method === 'item/completed'
                && ((message.params as Record<string, unknown>)?.item as Record<string, unknown>)?.type === 'userMessage'
            ))).toEqual([
                expect.objectContaining({
                    params: expect.objectContaining({
                        item: expect.objectContaining({
                            clientId: 'command-3',
                            content: [{ type: 'text', text: 'test', text_elements: [] }],
                        }),
                    }),
                }),
            ]);
            expect(fake.messages.filter((message) => message.method === 'item/agentMessage/delta')).toHaveLength(1);
            expect(fake.messages.find((message) => (
                message.method === 'turn/completed'
            ))).toMatchObject({
                params: {
                    turn: {
                        items: [
                            { type: 'userMessage', clientId: 'command-3' },
                            { type: 'agentMessage', text: 'Fake Codex response' },
                        ],
                    },
                },
            });
            expect(response(fake, 4)?.result).toEqual({});
            expect(fake.messages.filter((message) => (
                message.method === 'item/started'
                && ((message.params as Record<string, unknown>)?.item as Record<string, unknown>)?.type === 'contextCompaction'
            ))).toHaveLength(1);
            expect(fake.messages.at(-1)).toMatchObject({
                method: 'item/completed',
                params: { threadId, item: { type: 'contextCompaction' } },
            });
            expect(fake.stderr).toEqual([]);
        } finally {
            fake.child.kill('SIGTERM');
            await waitForExit(fake.child);
        }
    });

    it('injects duplicates, delay-based reordering, and unknown methods', async () => {
        const fake = await startFake({
            defaultBehavior: false,
            rules: [{
                on: 'test/faults',
                actions: [
                    { type: 'notification', method: 'test/slow', delayMs: 25 },
                    { type: 'notification', method: 'test/duplicate', repeat: 2 },
                    { type: 'unknown', method: 'future/unknown', delayMs: 1 },
                    { type: 'response', result: { ok: true }, delayMs: 5 },
                ],
            }],
        });
        try {
            send(fake, { id: 9, method: 'test/faults', params: { secret: 'not logged' } });
            await waitFor(() => fake.messages.length === 5);

            expect(fake.messages.map((message) => message.method ?? `response:${message.id}`)).toEqual([
                'test/duplicate',
                'test/duplicate',
                'future/unknown',
                'response:9',
                'test/slow',
            ]);
            expect(fake.stderr).toEqual([]);
        } finally {
            fake.child.kill('SIGTERM');
            await waitForExit(fake.child);
        }
    });

    it('rejects legacy and incomplete request shapes in strict stable-v2 mode', async () => {
        const fake = await startFake({ strictStableV2: true });
        try {
            send(fake, {
                id: 1,
                method: 'initialize',
                params: {
                    clientInfo: { name: 'happy-test', title: 'Happy Test', version: '0.0.0' },
                    capabilities: { experimentalApi: false, requestAttestation: false },
                },
            });
            await waitFor(() => response(fake, 1) !== null);

            send(fake, {
                id: 20,
                method: 'initialize',
                params: {
                    clientInfo: { name: 'happy-test', title: 'Happy Test', version: '0.0.0' },
                    capabilities: { experimentalApi: true, requestAttestation: false },
                },
            });
            await waitFor(() => errorResponse(fake, 20) !== null);
            expect(errorResponse(fake, 20)?.error).toMatchObject({
                code: -32602,
                message: 'strict stable-v2 requires initialize.capabilities.experimentalApi=false',
            });

            send(fake, {
                id: 2,
                method: 'thread/start',
                params: { cwd: '/tmp/project', profile: null },
            });
            await waitFor(() => errorResponse(fake, 2) !== null);
            expect(errorResponse(fake, 2)?.error).toMatchObject({ code: -32602, message: 'unexpected field: profile' });

            send(fake, { id: 3, method: 'thread/start', params: { cwd: '/tmp/project' } });
            await waitFor(() => response(fake, 3) !== null);
            const threadId = (((response(fake, 3)?.result as Record<string, unknown>).thread as Record<string, unknown>).id as string);
            send(fake, {
                id: 4,
                method: 'turn/start',
                params: {
                    threadId,
                    input: [{ type: 'text', text: 'missing elements' }],
                    sandboxPolicy: { type: 'workspaceWrite' },
                },
            });
            await waitFor(() => errorResponse(fake, 4) !== null);
            expect(errorResponse(fake, 4)?.error).toMatchObject({ code: -32602 });
        } finally {
            fake.child.kill('SIGTERM');
            await waitForExit(fake.child);
        }
    });

    it('injects a transport disconnect and a configured process exit', async () => {
        const disconnected = await startFake({
            defaultBehavior: false,
            rules: [{ on: 'test/disconnect', actions: [{ type: 'disconnect' }] }],
        });
        send(disconnected, { id: 1, method: 'test/disconnect' });
        await waitForStreamEnd(disconnected.child.stdout);
        expect(disconnected.child.exitCode).toBeNull();
        disconnected.child.kill('SIGTERM');
        await waitForExit(disconnected.child);

        const exited = await startFake({
            defaultBehavior: false,
            rules: [{ on: 'test/exit', actions: [{ type: 'exit', code: 73 }] }],
        });
        send(exited, { id: 2, method: 'test/exit' });
        await expect(waitForExit(exited.child)).resolves.toBe(73);
    });
});

async function startFake(scenario: Record<string, unknown>): Promise<RunningFake> {
    const root = await mkdtemp(join(tmpdir(), 'happy-fake-codex-'));
    const scenarioPath = join(root, 'scenario.json');
    await writeFile(scenarioPath, JSON.stringify(scenario));
    const child = spawn(process.execPath, [fakeServerPath, '--scenario', scenarioPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const messages: Array<Record<string, unknown>> = [];
    const stderr: string[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => {
        messages.push(JSON.parse(line) as Record<string, unknown>);
    });
    createInterface({ input: child.stderr }).on('line', (line) => stderr.push(line));
    return { child, messages, stderr };
}

function send(fake: RunningFake, message: Record<string, unknown>): void {
    fake.child.stdin.write(`${JSON.stringify(message)}\n`);
}

function response(fake: RunningFake, id: number): Record<string, unknown> | null {
    return fake.messages.find((message) => message.id === id && message.result !== undefined) ?? null;
}

function errorResponse(fake: RunningFake, id: number): Record<string, unknown> | null {
    return fake.messages.find((message) => message.id === id && message.error !== undefined) ?? null;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms`);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return new Promise((resolve, reject) => {
        child.once('exit', (code) => resolve(code));
        child.once('error', reject);
    });
}

function waitForStreamEnd(stream: NodeJS.ReadableStream): Promise<void> {
    if ((stream as NodeJS.ReadableStream & { readableEnded?: boolean }).readableEnded) return Promise.resolve();
    return new Promise((resolve, reject) => {
        stream.once('end', resolve);
        stream.once('error', reject);
    });
}
