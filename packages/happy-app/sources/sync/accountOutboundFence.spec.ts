import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBackoff } from '@/utils/time';
import {
    AccountOutboundCancelledError,
    beginAccountOutboundLifecycle,
    captureAccountOutboundPermit,
    endAccountOutboundLifecycle,
    fetchWithAccountOutboundPermit,
} from './accountOutboundFence';

describe('account outbound fence', () => {
    beforeEach(() => {
        endAccountOutboundLifecycle();
    });

    it('rejects an old permit after quarantine and does not enter the transport', async () => {
        beginAccountOutboundLifecycle('account-token');
        const permit = captureAccountOutboundPermit('account-token');
        const transport = vi.fn<typeof fetch>();
        endAccountOutboundLifecycle();
        beginAccountOutboundLifecycle('next-account-token');

        expect(() => fetchWithAccountOutboundPermit(
            permit,
            'https://happy.example/v1/account/profile',
            undefined,
            transport,
        )).toThrow(AccountOutboundCancelledError);
        expect(transport).not.toHaveBeenCalled();
    });

    it('does not retry a request after its account lifecycle is cancelled', async () => {
        beginAccountOutboundLifecycle('account-token');
        const permit = captureAccountOutboundPermit('account-token');
        const transport = vi.fn<typeof fetch>();
        const backoff = createBackoff({ minDelay: 0, maxDelay: 0 });
        endAccountOutboundLifecycle();

        await expect(backoff(() => fetchWithAccountOutboundPermit(
            permit,
            'https://happy.example/v1/account/profile',
            undefined,
            transport,
        ))).rejects.toBeInstanceOf(AccountOutboundCancelledError);
        expect(transport).not.toHaveBeenCalled();
    });

    it('does not grant an old account access through a new account lifecycle', () => {
        beginAccountOutboundLifecycle('new-account-token');

        expect(() => captureAccountOutboundPermit('old-account-token'))
            .toThrow(AccountOutboundCancelledError);
    });
});
