import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';

const mocks = vi.hoisted(() => ({
    startOfflineReconnection: vi.fn(),
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
    startOfflineReconnection: mocks.startOfflineReconnection,
}));

import { setupOfflineReconnection } from './setupOfflineReconnection';

describe('setupOfflineReconnection', () => {
    beforeEach(() => {
        mocks.startOfflineReconnection.mockReset();
    });

    it('retries when provider-specific session binding fails and closes the rejected client', async () => {
        let onReconnected!: () => Promise<ApiSessionClient>;
        mocks.startOfflineReconnection.mockImplementation((options) => {
            onReconnected = options.onReconnected;
            return {
                cancel: vi.fn(),
                getSession: () => null,
                isReconnected: () => false,
            };
        });
        const close = vi.fn(async () => {});
        const realSession = { close } as unknown as ApiSessionClient;
        const response = { id: 'session-1' };
        const api = {
            getOrCreateSession: vi.fn(async () => response),
            sessionSyncClient: vi.fn(() => realSession),
        };
        const bindingError = new Error('Codex v4 migration failed');

        setupOfflineReconnection({
            api: api as never,
            sessionTag: 'tag-1',
            metadata: {} as never,
            state: {} as never,
            response: null,
            onSessionSwap: async () => {
                throw bindingError;
            },
        });

        await expect(onReconnected()).rejects.toBe(bindingError);
        expect(close).toHaveBeenCalledOnce();
    });

    it('marks the replacement usable only after asynchronous binding completes', async () => {
        let onReconnected!: () => Promise<ApiSessionClient>;
        mocks.startOfflineReconnection.mockImplementation((options) => {
            onReconnected = options.onReconnected;
            return {
                cancel: vi.fn(),
                getSession: () => null,
                isReconnected: () => false,
            };
        });
        const realSession = {
            close: vi.fn(async () => {}),
        } as unknown as ApiSessionClient;
        const api = {
            getOrCreateSession: vi.fn(async () => ({ id: 'session-1' })),
            sessionSyncClient: vi.fn(() => realSession),
        };
        let release!: () => void;
        const binding = new Promise<void>((resolve) => {
            release = resolve;
        });
        const onSessionSwap = vi.fn(async () => {
            await binding;
        });

        setupOfflineReconnection({
            api: api as never,
            sessionTag: 'tag-1',
            metadata: {} as never,
            state: {} as never,
            response: null,
            onSessionSwap,
        });
        const reconnecting = onReconnected();
        let settled = false;
        void reconnecting.then(() => {
            settled = true;
        });
        await Promise.resolve();

        expect(settled).toBe(false);
        release();
        await expect(reconnecting).resolves.toBe(realSession);
        expect(realSession.close).not.toHaveBeenCalled();
    });
});
