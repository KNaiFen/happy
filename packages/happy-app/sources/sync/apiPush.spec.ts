import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    backoff: vi.fn(),
}));

vi.mock('@/utils/time', () => ({ backoff: mocks.backoff }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://happy.example' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'test-client' }));

import { unregisterPushToken } from './apiPush';
import { beginAccountOutboundLifecycle, endAccountOutboundLifecycle } from './accountOutboundFence';

const credentials = { token: 'account-token', secret: 'account-secret' };
const originalFetch = globalThis.fetch;

describe('push token unregister retries', () => {
    beforeEach(() => {
        mocks.backoff.mockReset();
        endAccountOutboundLifecycle();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        endAccountOutboundLifecycle();
    });

    it('makes only one best-effort request after local revocation', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response('{}', { status: 503 }),
        );
        globalThis.fetch = fetchMock;

        await expect(unregisterPushToken(credentials, 'push/token', {
            allowAfterRevocation: true,
        })).rejects.toThrow('Failed to unregister push token: 503');

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(mocks.backoff).not.toHaveBeenCalled();
    });

    it('keeps retry handling for an active account lifecycle', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify({ success: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        globalThis.fetch = fetchMock;
        mocks.backoff.mockImplementationOnce(async (request: () => Promise<void>) => request());
        beginAccountOutboundLifecycle(credentials.token);

        await unregisterPushToken(credentials, 'push-token');

        expect(mocks.backoff).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});
