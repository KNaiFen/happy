import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    sessionRPC,
    machineRPC,
    request,
    getState,
    isCodexV4Eligible,
    publishCodexV4Command,
} = vi.hoisted(() => ({
    sessionRPC: vi.fn(),
    machineRPC: vi.fn(),
    request: vi.fn(),
    getState: vi.fn((): any => ({ sessions: {} })),
    isCodexV4Eligible: vi.fn(() => false),
    publishCodexV4Command: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { sessionRPC, machineRPC, request },
}));

vi.mock('./sync', () => ({
    sync: {
        refreshSessions: vi.fn(),
        isCodexV4Eligible,
        publishCodexV4Command,
    },
}));

vi.mock('./storage', () => ({
    storage: { getState },
}));

describe('Codex queued message ops', () => {
    beforeEach(() => {
        sessionRPC.mockReset();
        sessionRPC.mockResolvedValue({ ok: true });
        machineRPC.mockReset();
        request.mockReset();
        getState.mockReturnValue({ sessions: {} });
        isCodexV4Eligible.mockReset();
        isCodexV4Eligible.mockReturnValue(false);
        publishCodexV4Command.mockReset();
        publishCodexV4Command.mockResolvedValue({});
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

    it('rejects every write operation for a provider-created child before legacy RPC fallback', async () => {
        getState.mockReturnValue({
            sessions: {
                'session-child': {
                    metadata: {
                        path: '/workspace',
                        host: 'host',
                        flavor: 'codex',
                        codexReadOnly: true,
                    },
                },
            },
        });
        const {
            sessionAbort,
            sessionAllow,
            sessionArchive,
            sessionDelete,
            sessionGoalAction,
            sessionKill,
            sessionSteerCodexQueuedMessage,
            sessionUpdateCodexQueuedMessage,
            machineResumeSession,
        } = await import('./ops');

        await expect(sessionAbort('session-child')).rejects.toThrow('read-only');
        await expect(sessionAllow('session-child', 'request-1')).rejects.toThrow('read-only');
        await expect(sessionGoalAction('session-child', 'clear')).rejects.toThrow('read-only');
        await expect(sessionSteerCodexQueuedMessage('session-child', 'queued-1')).rejects.toThrow('read-only');
        await expect(sessionUpdateCodexQueuedMessage('session-child', 'queued-1', 'edited'))
            .rejects.toThrow('read-only');
        await expect(sessionKill('session-child')).resolves.toMatchObject({
            success: false,
            message: expect.stringContaining('read-only'),
        });
        await expect(sessionArchive('session-child')).resolves.toMatchObject({
            success: false,
            message: expect.stringContaining('read-only'),
        });
        await expect(sessionDelete('session-child')).resolves.toMatchObject({
            success: false,
            message: expect.stringContaining('read-only'),
        });
        await expect(machineResumeSession({
            machineId: 'machine-1',
            sessionId: 'session-child',
        })).resolves.toMatchObject({
            type: 'error',
            errorMessage: expect.stringContaining('read-only'),
        });
        expect(sessionRPC).not.toHaveBeenCalled();
        expect(machineRPC).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });

    it('resolves a repeated provider request id only on the metadata-owned thread', async () => {
        isCodexV4Eligible.mockReturnValue(true);
        getState.mockReturnValue({
            sessions: {
                'session-current': {
                    metadata: {
                        path: '/workspace',
                        host: 'host',
                        flavor: 'codex',
                        codexThreadId: 'thread-current',
                    },
                },
            },
            codexV4Sessions: {
                'session-current': {
                    entities: {
                        'codex.request': {
                            old: {
                                requestId: 'request-reused',
                                threadId: 'thread-old',
                                turnId: 'turn-old',
                                requestType: 'commandApproval',
                                status: 'pending',
                                options: {},
                            },
                            current: {
                                requestId: 'request-reused',
                                threadId: 'thread-current',
                                turnId: 'turn-current',
                                requestType: 'commandApproval',
                                status: 'pending',
                                options: {},
                            },
                        },
                    },
                },
            },
        });
        const { sessionAllow } = await import('./ops');

        await sessionAllow('session-current', 'request-reused');

        expect(publishCodexV4Command).toHaveBeenCalledWith('session-current', {
            command: 'request.resolve',
            threadId: 'thread-current',
            expectedTurnId: 'turn-current',
            payload: {
                requestId: 'request-reused',
                response: { decision: 'accept' },
            },
        });
        expect(sessionRPC).not.toHaveBeenCalled();
    });
});
