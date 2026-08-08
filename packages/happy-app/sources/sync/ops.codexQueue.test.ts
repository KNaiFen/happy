import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    CodexCommandEntityV4,
    CodexRuntimeEntityV4,
    CodexThreadEntityV4,
    CodexTurnEntityV4,
} from '@slopus/happy-wire';
import { createCodexV4Projection } from './codexV4Projection';

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

function queuedState(queueEntryId: string) {
    const projection = createCodexV4Projection('thread-1');
    projection.entities['codex.command']['queue-command'] = {
        schemaVersion: 1,
        entityType: 'codex.command',
        providerId: 'queue-command',
        createdAt: 10,
        updatedAt: 10,
        commandId: 'queue-command',
        threadId: 'thread-1',
        expectedTurnId: 'turn-active',
        command: 'turn.queue',
        payload: { text: 'original', displayText: 'original' },
        clientUserMessageId: 'queue-command',
        replacesCommandId: null,
        queueEntryId,
        queuedAt: 10,
        bindingGeneration: 7,
    } as CodexCommandEntityV4;
    projection.entities['codex.turn']['turn-active'] = {
        schemaVersion: 1,
        entityType: 'codex.turn',
        providerId: 'turn-active',
        createdAt: 5,
        updatedAt: 10,
        threadId: 'thread-1',
        turnId: 'turn-active',
        status: 'inProgress',
        startedAt: 5,
        completedAt: null,
        durationMs: null,
        error: null,
        usage: null,
        planRevision: 0,
        diffRevision: 0,
    } as CodexTurnEntityV4;
    projection.thread = { threadId: 'thread-1' } as CodexThreadEntityV4;
    projection.runtime = {
        gateway: { generation: 11 },
        execution: { type: 'active' },
    } as unknown as CodexRuntimeEntityV4;
    return {
        sessions: {
            'session-1': {
                metadata: {
                        flavor: 'codex',
                        codexSyncVersion: 4,
                        codexThreadId: 'thread-1',
                        codexCapabilities: { queueSteering: true },
                },
            },
        },
        codexV4Sessions: { 'session-1': projection },
    };
}

describe('Codex queued message ops', () => {
    beforeEach(() => {
        sessionRPC.mockReset();
        sessionRPC.mockResolvedValue({ ok: true });
        machineRPC.mockReset();
        request.mockReset();
        request.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        getState.mockReturnValue({
            sessions: {
                'session-1': {
                    metadata: {
                        flavor: 'codex',
                        codexSyncVersion: 4,
                    },
                },
            },
        });
        isCodexV4Eligible.mockReset();
        isCodexV4Eligible.mockReturnValue(false);
        publishCodexV4Command.mockReset();
        publishCodexV4Command.mockResolvedValue({});
    });

    it('updates a queued V4 command while preserving its FIFO identity', async () => {
        getState.mockReturnValue(queuedState('queued-1'));
        const { sessionUpdateCodexQueuedMessage } = await import('./ops');

        await sessionUpdateCodexQueuedMessage('session-1', 'queued-1', 'edited text');

        expect(publishCodexV4Command).toHaveBeenCalledWith('session-1', {
            command: 'turn.queue',
            threadId: 'thread-1',
            expectedTurnId: 'turn-active',
            payload: { text: 'edited text', displayText: 'edited text' },
            replacesCommandId: 'queue-command',
            queueEntryId: 'queued-1',
            queuedAt: 10,
            bindingGeneration: 7,
        }, undefined, 'edited text');
        expect(sessionRPC).not.toHaveBeenCalled();
    });

    it('steers a queued V4 command into the active turn', async () => {
        getState.mockReturnValue(queuedState('queued-2'));
        const { sessionSteerCodexQueuedMessage } = await import('./ops');

        await sessionSteerCodexQueuedMessage('session-1', 'queued-2');

        expect(publishCodexV4Command).toHaveBeenCalledWith('session-1', {
            command: 'turn.steer',
            threadId: 'thread-1',
            expectedTurnId: 'turn-active',
            payload: { text: 'original', displayText: 'original' },
            replacesCommandId: 'queue-command',
            queueEntryId: 'queued-2',
            queuedAt: 10,
            bindingGeneration: 7,
        }, undefined, 'original');
        expect(sessionRPC).not.toHaveBeenCalled();
    });

    it('cancels a queued V4 command without drafting an empty provider message', async () => {
        getState.mockReturnValue(queuedState('queued-3'));
        const { sessionCancelCodexQueuedMessage } = await import('./ops');

        await sessionCancelCodexQueuedMessage('session-1', 'queued-3');

        expect(publishCodexV4Command).toHaveBeenCalledWith('session-1', {
            command: 'turn.queue.cancel',
            threadId: 'thread-1',
            expectedTurnId: 'turn-active',
            payload: {},
            replacesCommandId: 'queue-command',
            queueEntryId: 'queued-3',
            queuedAt: 10,
            bindingGeneration: 7,
        });
        expect(sessionRPC).not.toHaveBeenCalled();
    });

    it('attaches the current Gateway generation to interrupt and goal commands', async () => {
        getState.mockReturnValue(queuedState('queued-direct-controls'));
        const { sessionAbort, sessionGoalAction } = await import('./ops');

        await sessionAbort('session-1');
        await sessionGoalAction('session-1', 'clear');
        await sessionGoalAction('session-1', 'edit', 'finish the task');

        expect(publishCodexV4Command).toHaveBeenNthCalledWith(1, 'session-1', {
            command: 'turn.interrupt',
            threadId: 'thread-1',
            expectedTurnId: 'turn-active',
            payload: { expectedTurnId: 'turn-active' },
            bindingGeneration: 11,
        });
        expect(publishCodexV4Command).toHaveBeenNthCalledWith(2, 'session-1', {
            command: 'goal.clear',
            threadId: 'thread-1',
            payload: {},
            bindingGeneration: 11,
        });
        expect(publishCodexV4Command).toHaveBeenNthCalledWith(3, 'session-1', {
            command: 'goal.set',
            threadId: 'thread-1',
            payload: { objective: 'finish the task' },
            bindingGeneration: 11,
        });
    });

    it('rejects every mutating operation for a provider-created child', async () => {
        getState.mockReturnValue({
            sessions: {
                'session-child': {
                    metadata: {
                        path: '/workspace',
                        host: 'host',
                        flavor: 'codex',
                        codexSyncVersion: 4,
                        codexReadOnly: true,
                    },
                },
            },
        });
        const {
            sessionAbort,
            sessionAllow,
            sessionArchive,
            sessionCancelCodexQueuedMessage,
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
        await expect(sessionCancelCodexQueuedMessage('session-child', 'queued-1')).rejects.toThrow('read-only');
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
            directory: '/workspace',
            threadId: 'thread-child',
        })).resolves.toMatchObject({
            type: 'error',
            error: 'operationFailed',
        });
        expect(sessionRPC).not.toHaveBeenCalled();
        expect(machineRPC).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });

    it('rejects unsupported sessions without sending legacy archive traffic', async () => {
        getState.mockReturnValue({
            sessions: {
                'session-unknown': {
                    metadata: { flavor: 'unknown' },
                },
                'session-codex-without-v4': {
                    metadata: { flavor: 'codex' },
                },
            },
        });
        const { sessionArchive } = await import('./ops');

        await expect(sessionArchive('session-unknown')).resolves.toMatchObject({ success: false });
        await expect(sessionArchive('session-codex-without-v4')).resolves.toMatchObject({ success: false });
        expect(request).not.toHaveBeenCalled();
    });

    it('stops a Codex Gateway through the authenticated machine RPC', async () => {
        getState.mockReturnValue({
            sessions: {
                'session-gateway': {
                    metadata: {
                        path: '/workspace',
                        host: 'host',
                        flavor: 'codex',
                        codexSyncVersion: 4,
                        machineId: 'machine-1',
                        codexGatewayBinding: {
                            gatewayId: 'gateway-1',
                            generation: 2,
                            origin: 'app',
                            role: 'current',
                            terminal: 'unattached',
                            changedAt: 10,
                        },
                    },
                },
            },
        });
        machineRPC.mockResolvedValueOnce({ message: 'Session stopped' });
        const { sessionKill } = await import('./ops');

        await expect(sessionKill('session-gateway', { timeoutMs: 5_000 })).resolves.toEqual({
            success: true,
            message: 'Session stopped',
            outcome: 'stopped',
        });

        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'stop-session',
            {
                sessionId: 'session-gateway',
                expectedGatewayId: 'gateway-1',
                bindingGeneration: 2,
            },
            { timeoutMs: 5_000 },
        );
        expect(sessionRPC).not.toHaveBeenCalled();
    });

    it.each(['missing', 'unverified'] as const)(
        'preserves the structured %s Gateway stop outcome',
        async (outcome) => {
            getState.mockReturnValue({
                sessions: {
                    'session-gateway': {
                        metadata: {
                            path: '/workspace',
                            host: 'host',
                            flavor: 'codex',
                            codexSyncVersion: 4,
                            machineId: 'machine-1',
                            codexGatewayBinding: {
                                gatewayId: 'gateway-1',
                                generation: 2,
                                origin: 'app',
                                role: 'current',
                                terminal: 'unattached',
                                changedAt: 10,
                            },
                        },
                    },
                },
            });
            machineRPC.mockResolvedValueOnce({ message: outcome, outcome });
            const { sessionKill } = await import('./ops');

            await expect(sessionKill('session-gateway')).resolves.toEqual({
                success: false,
                message: outcome,
                outcome,
            });
        },
    );

    it('resolves a repeated provider request id only on the metadata-owned thread', async () => {
        isCodexV4Eligible.mockReturnValue(true);
        getState.mockReturnValue({
            sessions: {
                'session-current': {
                    metadata: {
                        path: '/workspace',
                        host: 'host',
                        flavor: 'codex',
                        codexSyncVersion: 4,
                        codexThreadId: 'thread-current',
                    },
                },
            },
            codexV4Sessions: {
                'session-current': {
                    runtime: { gateway: { generation: 13 } },
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
            bindingGeneration: 13,
        });
        expect(sessionRPC).not.toHaveBeenCalled();
    });
});
