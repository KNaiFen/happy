import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { backoff } = vi.hoisted(() => ({
    backoff: vi.fn(async <T>(callback: () => Promise<T>) => callback()),
}));

vi.mock('@/utils/time', () => ({ backoff }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://happy.example' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'test-client' }));

import { fetchArtifacts } from './apiArtifacts';
import { beginAccountOutboundLifecycle, endAccountOutboundLifecycle } from './accountOutboundFence';

const credentials = { token: 'token', secret: 'secret' };

function artifact(id: string, updateSeq: number) {
    return {
        id,
        header: 'header',
        headerVersion: 1,
        dataEncryptionKey: 'key',
        seq: 0,
        updateSeq,
        createdAt: 1,
        updatedAt: 1,
    };
}

function response(payload: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: vi.fn(async () => payload),
    } as unknown as Response;
}

describe('fetchArtifacts snapshot pagination', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        backoff.mockClear();
        beginAccountOutboundLifecycle(credentials.token);
    });

    afterEach(() => endAccountOutboundLifecycle());

    it('collects every page before returning a complete snapshot', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(response({
                artifacts: Array.from({ length: 100 }, (_, index) => artifact(`artifact-${index}`, index)),
                highWatermark: 210,
                nextCursor: 'cursor-2',
            }))
            .mockResolvedValueOnce(response({
                artifacts: Array.from({ length: 100 }, (_, index) => artifact(`artifact-${index + 100}`, index + 100)),
                highWatermark: 210,
                nextCursor: 'cursor-3',
            }))
            .mockResolvedValueOnce(response({
                artifacts: [artifact('artifact-200', 200)],
                highWatermark: 210,
                nextCursor: null,
            }));

        const snapshot = await fetchArtifacts(credentials);

        expect(snapshot.artifacts).toHaveLength(201);
        expect(snapshot.highWatermark).toBe(210);
        expect(fetchMock).toHaveBeenNthCalledWith(1,
            'https://happy.example/v1/artifacts?limit=100', expect.any(Object));
        expect(fetchMock).toHaveBeenNthCalledWith(2,
            'https://happy.example/v1/artifacts?limit=100&cursor=cursor-2', expect.any(Object));
        expect(fetchMock).toHaveBeenNthCalledWith(3,
            'https://happy.example/v1/artifacts?limit=100&cursor=cursor-3', expect.any(Object));
    });

    it('rejects malformed or watermark-changing pages without returning a partial snapshot', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(response({
                artifacts: [artifact('artifact-1', 1)],
                highWatermark: 10,
                nextCursor: 'cursor-2',
            }))
            .mockResolvedValueOnce(response({
                artifacts: [artifact('artifact-2', 2)],
                highWatermark: 11,
                nextCursor: null,
            }));

        await expect(fetchArtifacts(credentials)).rejects.toThrow('high watermark changed');
    });

    it('rejects a row newer than the snapshot watermark', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({
            artifacts: [artifact('artifact-future', 11)],
            highWatermark: 10,
            nextCursor: null,
        }));

        await expect(fetchArtifacts(credentials)).rejects.toThrow('exceeds its high watermark');
    });

    it('rejects empty cursors instead of treating a partial page as complete', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({
            artifacts: [artifact('artifact-1', 1)],
            highWatermark: 10,
            nextCursor: '',
        }));

        await expect(fetchArtifacts(credentials)).rejects.toThrow();
    });

    it('rejects duplicate artifact IDs across pages', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(response({
                artifacts: [artifact('artifact-1', 1)],
                highWatermark: 10,
                nextCursor: 'cursor-2',
            }))
            .mockResolvedValueOnce(response({
                artifacts: [artifact('artifact-1', 1)],
                highWatermark: 10,
                nextCursor: null,
            }));

        await expect(fetchArtifacts(credentials)).rejects.toThrow('duplicate artifact');
    });

    it('rejects repeated non-empty cursors', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(response({
                artifacts: [artifact('artifact-1', 1)],
                highWatermark: 10,
                nextCursor: 'cursor-repeat',
            }))
            .mockResolvedValueOnce(response({
                artifacts: [artifact('artifact-2', 2)],
                highWatermark: 10,
                nextCursor: 'cursor-repeat',
            }));

        await expect(fetchArtifacts(credentials)).rejects.toThrow('repeated cursor');
    });
});
