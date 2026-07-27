import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sessionRPC } = vi.hoisted(() => ({ sessionRPC: vi.fn() }));

vi.mock('./apiSocket', () => ({
    apiSocket: { sessionRPC },
}));

vi.mock('./sync', () => ({
    sync: { refreshSessions: vi.fn() },
}));

vi.mock('./storage', () => ({
    storage: { getState: vi.fn(() => ({ sessions: {} })) },
}));

describe('Codex queued message ops', () => {
    beforeEach(() => {
        sessionRPC.mockReset();
        sessionRPC.mockResolvedValue({ ok: true });
    });

    it('updates a specific CLI-owned queue item', async () => {
        const { sessionUpdateCodexQueuedMessage } = await import('./ops');

        await sessionUpdateCodexQueuedMessage('session-1', 'queued-1', 'edited text');

        expect(sessionRPC).toHaveBeenCalledWith(
            'session-1',
            'codex-update-queued-message',
            { id: 'queued-1', text: 'edited text' },
        );
    });

    it('steers a specific CLI-owned queue item', async () => {
        const { sessionSteerCodexQueuedMessage } = await import('./ops');

        await sessionSteerCodexQueuedMessage('session-1', 'queued-2');

        expect(sessionRPC).toHaveBeenCalledWith(
            'session-1',
            'codex-steer-queued-message',
            { id: 'queued-2' },
        );
    });
});
