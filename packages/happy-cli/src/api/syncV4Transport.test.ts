import { beforeEach, describe, expect, it, vi } from 'vitest';

const axiosMock = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
    isAxiosError: vi.fn(() => false),
}));

vi.mock('axios', () => ({
    default: axiosMock,
}));

import { AxiosSyncV4Transport } from './syncV4Client';

const mutation = {
    mutationId: 'mutation-1',
    producerId: 'producer-1',
    entityId: 'opaque-entity-1',
    entityType: 'codex.item' as const,
    revision: 1,
    op: 'upsert' as const,
    ciphertext: 'encrypted-content',
};

describe('AxiosSyncV4Transport diagnostics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        axiosMock.post.mockResolvedValue({
            data: {
                acknowledgements: [{
                    mutationId: mutation.mutationId,
                    seq: 1,
                    revision: mutation.revision,
                    status: 'accepted',
                }],
            },
            headers: { 'x-happy-sync-trace': '1'.repeat(32) },
        });
        axiosMock.get
            .mockResolvedValueOnce({
                data: { changes: [], highWatermark: 1, hasMore: false },
                headers: { 'x-happy-sync-trace': '2'.repeat(32) },
            })
            .mockResolvedValueOnce({
                data: { entities: [], highWatermark: 1, nextCursor: null },
                headers: { 'x-happy-sync-trace': '3'.repeat(32) },
            });
    });

    it('sends a validated trace ID on mutation, changes, and snapshot requests', async () => {
        const transport = new AxiosSyncV4Transport(
            'http://relay.example.test',
            'bearer-secret',
            'cli-coding-session/1.4.5',
        );
        const traceIds = [
            '1'.repeat(32),
            '2'.repeat(32),
            '3'.repeat(32),
        ];

        await transport.postMutations('session-1', [mutation], traceIds[0]);
        await transport.getChanges('session-1', 0, 100, traceIds[1]);
        await transport.getSnapshot('session-1', null, 100, traceIds[2]);

        expect(axiosMock.post.mock.calls[0][2].headers['X-Happy-Sync-Trace']).toBe(traceIds[0]);
        expect(axiosMock.get.mock.calls[0][1].headers['X-Happy-Sync-Trace']).toBe(traceIds[1]);
        expect(axiosMock.get.mock.calls[1][1].headers['X-Happy-Sync-Trace']).toBe(traceIds[2]);
    });

    it('rejects malformed trace IDs before issuing a request', async () => {
        const transport = new AxiosSyncV4Transport(
            'http://relay.example.test',
            'bearer-secret',
            'cli-coding-session/1.4.5',
        );

        await expect(transport.getChanges('session-1', 0, 100, 'prompt-secret'))
            .rejects.toThrow('128-bit lowercase hex');
        expect(axiosMock.get).not.toHaveBeenCalled();
    });

    it('rejects a missing or mismatched server trace echo', async () => {
        axiosMock.get
            .mockReset()
            .mockResolvedValueOnce({
                data: { changes: [], highWatermark: 0, hasMore: false },
                headers: {},
            })
            .mockResolvedValueOnce({
                data: { changes: [], highWatermark: 0, hasMore: false },
                headers: { 'x-happy-sync-trace': 'f'.repeat(32) },
            });
        const transport = new AxiosSyncV4Transport(
            'http://relay.example.test',
            'bearer-secret',
            'cli-coding-session/1.4.5',
        );

        await expect(transport.getChanges('session-1', 0, 100, 'a'.repeat(32)))
            .rejects.toMatchObject({ name: 'SyncV4ProtocolError' });
        await expect(transport.getChanges('session-1', 0, 100, 'a'.repeat(32)))
            .rejects.toMatchObject({ name: 'SyncV4ProtocolError' });
    });
});
