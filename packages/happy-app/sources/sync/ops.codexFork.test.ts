import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    machineRPC,
    refreshSessions,
    getState,
    generateOperationId,
    getIndependentSessionDataKey,
} = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    refreshSessions: vi.fn(),
    getState: vi.fn(() => ({ sessions: {} })),
    generateOperationId: vi.fn(() => '9e32e76b-b5b1-47f0-b261-3744f13a41ca'),
    getIndependentSessionDataKey: vi.fn(() => new Uint8Array(32).fill(7)),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { machineRPC },
}));

vi.mock('./sync', () => ({
    sync: {
        refreshSessions,
        generateOperationId,
        encryption: { getIndependentSessionDataKey },
    },
}));

// ops.ts imports storage (for sessionSetAgentModes), which transitively pulls
// in react-native — mock it out, these tests never touch it.
vi.mock('./storage', () => ({
    storage: { getState },
}));

describe('codex fork ops', () => {
    beforeEach(() => {
        machineRPC.mockReset();
        refreshSessions.mockReset();
        getIndependentSessionDataKey.mockReset();
        getIndependentSessionDataKey.mockReturnValue(new Uint8Array(32).fill(7));
        getState.mockReturnValue({ sessions: {} });
    });

    it('passes new-session mode defaults through spawn RPC', async () => {
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'happy-new' });

        const { machineSpawnNewSession } = await import('./ops');
        const result = await machineSpawnNewSession({
            machineId: 'machine-1',
            directory: '/tmp/project',
            agent: 'codex',
            permissionMode: 'yolo',
            modelMode: 'gpt-5.6-sol',
            effortLevel: 'max',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-new' });
        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'spawn-happy-session',
            expect.objectContaining({
                directory: '/tmp/project',
                operationId: '9e32e76b-b5b1-47f0-b261-3744f13a41ca',
                agent: 'codex',
                permissionMode: 'yolo',
                modelMode: 'gpt-5.6-sol',
                effortLevel: 'max',
            }),
        );
    });

    it('passes a stable operation ID through the Happy resume RPC', async () => {
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'happy-existing' });
        getState.mockReturnValue({
            sessions: {
                'happy-existing': {
                    metadata: { flavor: 'codex', codexSyncVersion: 4 },
                },
            },
        });

        const { machineResumeSession } = await import('./ops');
        const result = await machineResumeSession({
            operationId: 'f24d3f6c-1ee8-4098-9cc0-a273c3b04f65',
            machineId: 'machine-1',
            sessionId: 'happy-existing',
            model: 'gpt-5.6-sol',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-existing' });
        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'resume-happy-session',
            {
                operationId: 'f24d3f6c-1ee8-4098-9cc0-a273c3b04f65',
                sessionId: 'happy-existing',
                model: 'gpt-5.6-sol',
                permissionMode: undefined,
            },
            { timeoutMs: 120_000 },
        );
    });

    it('sends the independent session key only after the daemon requests it', async () => {
        machineRPC
            .mockResolvedValueOnce({ type: 'resumeMaterialRequired', sessionId: 'happy-existing' })
            .mockResolvedValueOnce({ type: 'success', sessionId: 'happy-existing' });
        getState.mockReturnValue({
            sessions: {
                'happy-existing': {
                    metadata: { flavor: 'codex', codexSyncVersion: 4 },
                },
            },
        });

        const { machineResumeSession } = await import('./ops');
        await expect(machineResumeSession({
            machineId: 'machine-1',
            sessionId: 'happy-existing',
        })).resolves.toEqual({ type: 'success', sessionId: 'happy-existing' });

        expect(machineRPC).toHaveBeenCalledTimes(2);
        expect(machineRPC.mock.calls[0][2]).not.toHaveProperty('dataEncryptionKey');
        expect(machineRPC.mock.calls[1][2]).toEqual(expect.objectContaining({
            sessionId: 'happy-existing',
            dataEncryptionKey: expect.any(String),
        }));
        expect(machineRPC.mock.calls[1][2].operationId).toBe(machineRPC.mock.calls[0][2].operationId);
        expect(getIndependentSessionDataKey).toHaveBeenCalledWith('happy-existing');
    });

    it('rejects an unexpected resume-material challenge without disclosing a key', async () => {
        machineRPC.mockResolvedValue({
            type: 'resumeMaterialRequired',
            sessionId: 'happy-other',
        });
        getState.mockReturnValue({
            sessions: {
                'happy-existing': {
                    metadata: { flavor: 'codex', codexSyncVersion: 4 },
                },
            },
        });

        const { machineResumeSession } = await import('./ops');
        await expect(machineResumeSession({
            machineId: 'machine-1',
            sessionId: 'happy-existing',
        })).resolves.toMatchObject({ type: 'error' });

        expect(machineRPC).toHaveBeenCalledOnce();
        expect(getIndependentSessionDataKey).not.toHaveBeenCalled();
    });

    it('forks a full Codex thread and spawns a Codex session resumed to the new thread', async () => {
        getState.mockReturnValue({
            sessions: {
                'happy-source': {
                    metadata: {
                        flavor: 'codex',
                        codexSyncVersion: 4,
                        machineId: 'machine-1',
                        path: '/tmp/project',
                        codexThreadId: 'thread-source',
                    },
                },
            },
        });
        machineRPC.mockImplementation(async (_machineId: string, method: string) => {
            if (method === 'codex-fork-thread') {
                return { type: 'success', newCodexThreadId: 'thread-forked' };
            }
            if (method === 'spawn-happy-session') {
                return { type: 'success', sessionId: 'happy-forked' };
            }
            throw new Error(`unexpected method ${method}`);
        });

        const { forkAndSpawn } = await import('./ops');
        const result = await forkAndSpawn({
            kind: 'codex',
            sessionId: 'happy-source',
            machineId: 'machine-1',
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-forked' });
        expect(machineRPC).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            'codex-fork-thread',
            { directory: '/tmp/project', codexThreadId: 'thread-source' },
        );
        expect(machineRPC).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            'spawn-happy-session',
            expect.objectContaining({
                agent: 'codex',
                directory: '/tmp/project',
                resumeCodexThreadId: 'thread-forked',
                parentSessionId: 'happy-source',
            }),
        );
        expect(refreshSessions).toHaveBeenCalledTimes(1);
    });

    it('duplicates a Codex thread from a selected user item before spawning', async () => {
        getState.mockReturnValue({
            sessions: {
                'happy-source': {
                    metadata: {
                        flavor: 'codex',
                        codexSyncVersion: 4,
                        machineId: 'machine-1',
                        path: '/tmp/project',
                        codexThreadId: 'thread-source',
                    },
                },
            },
        });
        machineRPC.mockImplementation(async (_machineId: string, method: string) => {
            if (method === 'codex-duplicate-thread') {
                return { type: 'success', newCodexThreadId: 'thread-cut' };
            }
            if (method === 'spawn-happy-session') {
                return { type: 'success', sessionId: 'happy-cut' };
            }
            throw new Error(`unexpected method ${method}`);
        });

        const { forkAndSpawn } = await import('./ops');
        const result = await forkAndSpawn({
            kind: 'codex',
            sessionId: 'happy-source',
            machineId: 'machine-1',
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
        }, {
            cutAfterItemId: 'user-item-2',
            forkedFromMessageId: 'message-2',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-cut' });
        expect(machineRPC).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            'codex-duplicate-thread',
            { directory: '/tmp/project', codexThreadId: 'thread-source', cutAfterItemId: 'user-item-2' },
        );
        expect(machineRPC).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            'spawn-happy-session',
            expect.objectContaining({
                agent: 'codex',
                resumeCodexThreadId: 'thread-cut',
                forkedFromMessageId: 'message-2',
            }),
        );
    });

    it('rejects a provider-created child at the final fork boundary', async () => {
        getState.mockReturnValue({
            sessions: {
                'happy-child': {
                    metadata: {
                        flavor: 'codex',
                        codexSyncVersion: 4,
                        machineId: 'machine-1',
                        path: '/tmp/project',
                        codexThreadId: 'thread-child',
                        codexReadOnly: true,
                    },
                },
            },
        });
        const { forkAndSpawn } = await import('./ops');

        await expect(forkAndSpawn({
            kind: 'codex',
            sessionId: 'happy-child',
            machineId: 'machine-1',
            directory: '/tmp/project',
            codexThreadId: 'thread-child',
        })).rejects.toThrow('read-only');
        expect(machineRPC).not.toHaveBeenCalled();
    });
});
