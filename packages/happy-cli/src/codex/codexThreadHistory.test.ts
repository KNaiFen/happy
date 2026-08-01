import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexThreadHistoryService, type CodexThreadHistoryClient } from './codexThreadHistory';

function thread(overrides: Record<string, unknown> = {}) {
    return {
        id: 'thread-1',
        sessionId: 'tree-1',
        forkedFromId: null,
        parentThreadId: null,
        preview: 'First prompt',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 10,
        updatedAt: 20,
        recencyAt: 25,
        status: { type: 'idle' },
        path: null,
        cwd: '/tmp/project',
        cliVersion: '0.145.0',
        source: 'cli',
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: 'Named thread',
        turns: [],
        ...overrides,
    } as any;
}

function fakeClient() {
    return {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        listThreads: vi.fn(),
        readThread: vi.fn(),
    } satisfies CodexThreadHistoryClient;
}

describe('CodexThreadHistoryService', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses the stable-v2 history filters and removes non-root results defensively', async () => {
        const client = fakeClient();
        client.listThreads.mockResolvedValue({
            data: [
                thread(),
                thread({ id: 'ephemeral', ephemeral: true }),
                thread({ id: 'child', parentThreadId: 'parent' }),
                thread({ id: 'subagent', source: { subAgent: 'review' } }),
                thread({ id: 'other-cwd', cwd: '/tmp/other' }),
            ],
            nextCursor: 'next-1',
            backwardsCursor: null,
        });
        const service = new CodexThreadHistoryService({ createClient: () => client });

        await expect(service.list({
            directory: '/tmp/project',
            cursor: 'cursor-1',
            searchTerm: ' named ',
        })).resolves.toEqual({
            type: 'success',
            threads: [{
                threadId: 'thread-1',
                title: 'Named thread',
                preview: 'First prompt',
                cwd: '/tmp/project',
                createdAt: 10_000,
                updatedAt: 20_000,
                recencyAt: 25_000,
                source: 'cli',
                status: 'idle',
            }],
            nextCursor: 'next-1',
        });
        expect(client.listThreads).toHaveBeenCalledWith({
            cursor: 'cursor-1',
            limit: 50,
            sortKey: 'recency_at',
            sortDirection: 'desc',
            sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
            archived: false,
            cwd: '/tmp/project',
            searchTerm: 'named',
        });
        await service.close();
    });

    it('reuses one app-server client and disconnects it after the idle window', async () => {
        vi.useFakeTimers();
        const client = fakeClient();
        client.listThreads.mockResolvedValue({ data: [], nextCursor: null, backwardsCursor: null });
        const service = new CodexThreadHistoryService({
            createClient: () => client,
            idleTimeoutMs: 1_000,
        });

        await service.list({ directory: '/tmp/project' });
        await service.list({ directory: '/tmp/project' });
        expect(client.connect).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(1_000);
        expect(client.disconnect).toHaveBeenCalledOnce();
    });

    it('bounds list summaries without truncating the provider history itself', async () => {
        const client = fakeClient();
        client.listThreads.mockResolvedValue({
            data: [thread({
                name: 'n'.repeat(5_000),
                preview: 'p'.repeat(20_000),
            })],
            nextCursor: null,
            backwardsCursor: null,
        });
        const service = new CodexThreadHistoryService({ createClient: () => client });

        const result = await service.list({ directory: '/tmp/project' });

        expect(result.threads[0]?.title).toHaveLength(4_096);
        expect(result.threads[0]?.preview).toHaveLength(16_384);
        await service.close();
    });

    it('re-reads and validates the selected root thread before opening', async () => {
        const client = fakeClient();
        client.readThread.mockResolvedValue({ thread: thread({ status: { type: 'active', activeFlags: [] } }) });
        const service = new CodexThreadHistoryService({ createClient: () => client });

        await expect(service.inspect('/tmp/project', 'thread-1')).resolves.toMatchObject({
            threadId: 'thread-1',
            status: 'active',
        });
        expect(client.readThread).toHaveBeenCalledWith({
            threadId: 'thread-1',
            includeTurns: false,
            emitSnapshot: false,
        });

        client.readThread.mockResolvedValueOnce({ thread: thread({ cwd: '/tmp/other' }) });
        await expect(service.inspect('/tmp/project', 'thread-1')).rejects.toThrow('different directory');
        await service.close();
    });
});
