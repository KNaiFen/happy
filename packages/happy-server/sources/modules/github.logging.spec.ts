import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, anyHandlers, errorHandlers, logMock } = vi.hoisted(() => ({
    handlers: new Map<string, (event: any) => Promise<void>>(),
    anyHandlers: [] as Array<(event: any) => Promise<void>>,
    errorHandlers: [] as Array<(error: any) => void>,
    logMock: vi.fn(),
}));

vi.mock('@/utils/log', () => ({ log: logMock }));
vi.mock('octokit', () => ({ App: class {} }));
vi.mock('@octokit/webhooks', () => ({
    Webhooks: class {
        on(event: string | string[], handler: (value: any) => Promise<void>) {
            for (const name of Array.isArray(event) ? event : [event]) handlers.set(name, handler);
        }
        onAny(handler: (value: any) => Promise<void>) { anyHandlers.push(handler); }
        onError(handler: (value: any) => void) { errorHandlers.push(handler); }
    },
}));

import { getWebhooks, initGithub } from './github';

describe('GitHub webhook payload-free logging', () => {
    beforeEach(async () => {
        handlers.clear();
        anyHandlers.splice(0);
        errorHandlers.splice(0);
        logMock.mockReset();
        process.env.GITHUB_APP_ID = 'app';
        process.env.GITHUB_PRIVATE_KEY = 'private';
        process.env.GITHUB_CLIENT_ID = 'client';
        process.env.GITHUB_CLIENT_SECRET = 'secret';
        process.env.GITHUB_REDIRECT_URI = 'https://example.test/callback';
        process.env.GITHUB_WEBHOOK_SECRET = 'webhook';
        await initGithub();
        expect(getWebhooks()).not.toBeNull();
    });

    it('does not log hostile repository, actor, title, delivery, or error text', async () => {
        const sentinel = 'HOSTILE_SENTINEL_DO_NOT_LOG';
        await handlers.get('push')!({
            id: `${sentinel}-delivery`,
            name: 'push',
            payload: { repository: { full_name: `${sentinel}/repo` }, pusher: { name: sentinel } },
        });
        errorHandlers[0]({ event: { name: 'push' }, message: sentinel, request: { body: sentinel } });

        const serialized = JSON.stringify(logMock.mock.calls);
        expect(serialized).not.toContain(sentinel);
        expect(serialized).toContain('repositoryHash');
        expect(serialized).toContain('deliveryHash');
        expect(serialized).toContain('GitHub webhook handler failed');
    });
});
