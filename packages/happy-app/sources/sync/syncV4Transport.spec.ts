import type { SyncMutationV4 } from '@slopus/happy-wire';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: {
        request: mocks.request,
    },
}));

vi.mock('./syncV4Crypto', () => ({
    SyncV4Crypto: { create: vi.fn() },
}));

import {
    AppSyncV4HttpTransport,
    HttpAppSyncV4Transport,
} from './syncV4Transport';

const traceIds = {
    capabilities: '00000000000000000000000000000001',
    mutations: '00000000000000000000000000000002',
    changes: '00000000000000000000000000000003',
    snapshot: '00000000000000000000000000000004',
};

const mutation: SyncMutationV4 = {
    mutationId: '00000000-0000-4000-8000-000000000001',
    producerId: '00000000-0000-4000-8000-000000000002',
    entityId: 'opaque_entity_123',
    entityType: 'codex.command',
    revision: 1,
    op: 'upsert',
    ciphertext: 'encrypted',
};

describe('HttpAppSyncV4Transport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.request
            .mockResolvedValueOnce(jsonResponse({
                codex: {
                    enabled: true,
                    protocolVersion: 4,
                    minimumHappyCliVersion: '1.4.2',
                    minimumHappyAppVersion: '1.11.4',
                    minimumCodexCliVersion: '0.145.0',
                },
            }, traceIds.capabilities))
            .mockResolvedValueOnce(jsonResponse({
                acknowledgements: [{
                    mutationId: mutation.mutationId,
                    seq: 1,
                    revision: 1,
                    status: 'accepted',
                }],
            }, traceIds.mutations))
            .mockResolvedValueOnce(jsonResponse({
                changes: [],
                hasMore: false,
                highWatermark: 1,
            }, traceIds.changes))
            .mockResolvedValueOnce(jsonResponse({
                entities: [],
                highWatermark: 1,
                nextCursor: null,
            }, traceIds.snapshot));
    });

    it('sends the fixed trace header on every Sync v4 HTTP operation', async () => {
        const transport = new HttpAppSyncV4Transport();

        await transport.getCapabilities(traceIds.capabilities);
        await transport.postMutations('session-1', [mutation], traceIds.mutations);
        await transport.getChanges('session-1', 1, 100, traceIds.changes);
        await transport.getSnapshot('session-1', null, 100, traceIds.snapshot);

        expect(mocks.request.mock.calls.map(([, options]) => (
            new Headers(options?.headers).get('X-Happy-Sync-Trace')
        ))).toEqual([
            traceIds.capabilities,
            traceIds.mutations,
            traceIds.changes,
            traceIds.snapshot,
        ]);
    });

    it('rejects malformed trace IDs before issuing a request', async () => {
        const transport = new HttpAppSyncV4Transport();

        await expect(transport.getCapabilities('prompt-reasoning-secret'))
            .rejects.toThrow('128-bit lowercase hex');
        expect(mocks.request).not.toHaveBeenCalled();
    });

    it('rejects a missing or mismatched server trace echo as a protocol failure', async () => {
        mocks.request
            .mockReset()
            .mockResolvedValueOnce(jsonResponse({
                codex: {
                    enabled: true,
                    protocolVersion: 4,
                    minimumHappyCliVersion: '1.4.2',
                    minimumHappyAppVersion: '1.11.4',
                    minimumCodexCliVersion: '0.145.0',
                },
            }))
            .mockResolvedValueOnce(jsonResponse({
                codex: {
                    enabled: true,
                    protocolVersion: 4,
                    minimumHappyCliVersion: '1.4.2',
                    minimumHappyAppVersion: '1.11.4',
                    minimumCodexCliVersion: '0.145.0',
                },
            }, 'f'.repeat(32)));
        const transport = new HttpAppSyncV4Transport();

        await expect(transport.getCapabilities(traceIds.capabilities))
            .rejects.toMatchObject({ name: 'SyncV4ProtocolError' });
        await expect(transport.getCapabilities(traceIds.capabilities))
            .rejects.toMatchObject({ name: 'SyncV4ProtocolError' });
    });

    it('shares the production transport behavior with injected HTTP request adapters', async () => {
        const request = vi.fn(async () => jsonResponse({
            codex: {
                enabled: true,
                protocolVersion: 4,
                minimumHappyCliVersion: '1.4.2',
                minimumHappyAppVersion: '1.11.4',
                minimumCodexCliVersion: '0.145.0',
            },
        }, traceIds.capabilities));
        const transport = new AppSyncV4HttpTransport(request);

        await expect(transport.getCapabilities(traceIds.capabilities)).resolves.toMatchObject({
            codex: { enabled: true },
        });
        expect(request).toHaveBeenCalledWith('/v4/capabilities', expect.objectContaining({
            headers: { 'X-Happy-Sync-Trace': traceIds.capabilities },
        }));
    });
});

function jsonResponse(value: unknown, traceId?: string): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            ...(traceId ? { 'X-Happy-Sync-Trace': traceId } : {}),
        },
    });
}
