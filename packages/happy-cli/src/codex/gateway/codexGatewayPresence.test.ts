import { describe, expect, it, vi } from 'vitest';
import { SessionPresenceConflictError } from '@/api/api';
import { CodexGatewayPresenceRegistry, type CodexGatewayPresenceApi } from './codexGatewayPresence';

function createHarness() {
    const api: CodexGatewayPresenceApi = {
        claimSessionPresence: vi.fn(async () => true),
        touchSessionPresence: vi.fn(async () => true),
        releaseSessionPresence: vi.fn(async () => true),
    };
    const onError = vi.fn();
    return {
        api,
        onError,
        presence: new CodexGatewayPresenceRegistry({ api, onError, requestTimeoutMs: 1_500 }),
    };
}

describe('CodexGatewayPresenceRegistry', () => {
    it('uses one opaque lease for claim, touch, and release', async () => {
        const harness = createHarness();
        const lease = await harness.presence.claim('session-1');

        expect(lease?.leaseId).toMatch(/^[0-9a-f-]{36}$/);
        expect(harness.api.claimSessionPresence).toHaveBeenCalledWith(
            'session-1',
            lease?.leaseId,
            1_500,
        );
        await harness.presence.touchAll();
        expect(harness.api.touchSessionPresence).toHaveBeenCalledWith(
            'session-1',
            lease?.leaseId,
            1_500,
        );
        await lease?.release();
        expect(harness.api.releaseSessionPresence).toHaveBeenCalledWith(
            'session-1',
            lease?.leaseId,
            1_500,
        );

        await harness.presence.touchAll();
        expect(harness.api.touchSessionPresence).toHaveBeenCalledTimes(1);
    });

    it('terminates only the superseded binding and never releases over its successor', async () => {
        const harness = createHarness();
        const lease = await harness.presence.claim('session-1');
        const terminated = vi.fn();
        lease?.onTerminated(terminated);
        vi.mocked(harness.api.touchSessionPresence).mockRejectedValueOnce(
            new SessionPresenceConflictError('presenceLeaseSuperseded'),
        );

        await harness.presence.touchAll();

        expect(terminated).toHaveBeenCalledWith('presenceLeaseSuperseded');
        await lease?.release();
        expect(harness.api.releaseSessionPresence).not.toHaveBeenCalled();
        await harness.presence.touchAll();
        expect(harness.api.touchSessionPresence).toHaveBeenCalledTimes(1);
    });

    it('reconciles a live binding with the same lease and closes it on a tombstone', async () => {
        const harness = createHarness();
        const lease = await harness.presence.claim('session-1');
        const terminated = vi.fn();
        lease?.onTerminated(terminated);

        await expect(harness.presence.reconcile('session-1')).resolves.toBe(true);
        expect(harness.api.claimSessionPresence).toHaveBeenLastCalledWith(
            'session-1',
            lease?.leaseId,
            1_500,
        );

        vi.mocked(harness.api.claimSessionPresence).mockRejectedValueOnce(
            new SessionPresenceConflictError('sessionArchived'),
        );
        await expect(harness.presence.reconcile('session-1')).resolves.toBe(false);
        expect(terminated).toHaveBeenCalledWith('sessionArchived');
    });

    it('retains a lease across a transient touch failure', async () => {
        const harness = createHarness();
        const lease = await harness.presence.claim('session-1');
        vi.mocked(harness.api.touchSessionPresence)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);

        await harness.presence.touchAll();
        await harness.presence.touchAll();
        await lease?.release();

        expect(harness.api.touchSessionPresence).toHaveBeenCalledTimes(2);
        expect(harness.api.releaseSessionPresence).toHaveBeenCalledOnce();
    });

    it('does not keep touching a lease when release cannot reach the relay', async () => {
        const harness = createHarness();
        const lease = await harness.presence.claim('session-1');
        vi.mocked(harness.api.releaseSessionPresence).mockResolvedValueOnce(false);

        await lease?.release();
        await harness.presence.touchAll();

        expect(harness.onError).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Session presence release is pending relay recovery',
        }));
        expect(harness.api.touchSessionPresence).not.toHaveBeenCalled();
    });

    it('does not wait for an asynchronous termination callback while a binding is closing', async () => {
        const harness = createHarness();
        const lease = await harness.presence.claim('session-1');
        let releaseCallback!: () => void;
        const terminated = vi.fn(async () => await new Promise<void>((resolve) => {
            releaseCallback = resolve;
        }));
        lease?.onTerminated(terminated);
        vi.mocked(harness.api.touchSessionPresence).mockRejectedValueOnce(
            new SessionPresenceConflictError('presenceLeaseSuperseded'),
        );

        await Promise.race([
            harness.presence.touchAll(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('termination deadlock')), 50)),
        ]);

        expect(terminated).toHaveBeenCalledWith('presenceLeaseSuperseded');
        releaseCallback();
    });
});
