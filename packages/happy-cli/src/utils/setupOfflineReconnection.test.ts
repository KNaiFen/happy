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

        const result = setupOfflineReconnection({
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
        expect(() => result.session.sendCodexMessage({ afterFailure: true })).not.toThrow();
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
        const targetOnUserMessage = vi.fn();
        const realSession = {
            close: vi.fn(async () => {}),
            onUserMessage: targetOnUserMessage,
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
            expect(targetOnUserMessage).toHaveBeenCalledOnce();
            await binding;
        });

        const result = setupOfflineReconnection({
            api: api as never,
            sessionTag: 'tag-1',
            metadata: {} as never,
            state: {} as never,
            response: null,
            onSessionSwap,
        });
        result.session.onUserMessage(vi.fn());
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

    it('uses metadata and agent state accumulated while offline when reconnecting', async () => {
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
        const result = setupOfflineReconnection({
            api: api as never,
            sessionTag: 'tag-1',
            metadata: {
                path: '/tmp/project',
                host: 'test-host',
                homeDir: '/tmp/home',
                happyHomeDir: '/tmp/home/.happy',
                happyLibDir: '/tmp/home/.happy/lib',
                happyToolsDir: '/tmp/home/.happy/tools',
            },
            state: {},
            response: null,
            onSessionSwap: async () => undefined,
        });

        result.session.updateMetadata((metadata) => ({
            ...metadata,
            name: 'offline title',
        }));
        result.session.updateAgentState((state) => ({
            ...state,
            controlledByUser: true,
        }));
        await onReconnected();

        expect(api.getOrCreateSession).toHaveBeenCalledWith({
            tag: 'tag-1',
            metadata: expect.objectContaining({ name: 'offline title' }),
            state: expect.objectContaining({ controlledByUser: true }),
        });
    });
});
