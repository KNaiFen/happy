import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    machineRPC,
    request,
    decryptEncryptionKey,
    initializeSessions,
    getSessionEncryption,
    getIndependentSessionDataKey,
    deriveCodexResumeSessionDataKey,
    hydrateSessionFromHistory,
    metadataByCiphertext,
} = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    request: vi.fn(),
    decryptEncryptionKey: vi.fn(),
    initializeSessions: vi.fn(),
    getSessionEncryption: vi.fn(),
    getIndependentSessionDataKey: vi.fn(),
    deriveCodexResumeSessionDataKey: vi.fn(),
    hydrateSessionFromHistory: vi.fn(),
    metadataByCiphertext: new Map<string, unknown>(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { machineRPC, request },
}));

vi.mock('./sync', () => ({
    sync: {
        encryption: {
            decryptEncryptionKey,
            initializeSessions,
            getSessionEncryption,
            getIndependentSessionDataKey,
            deriveCodexResumeSessionDataKey,
        },
        hydrateSessionFromHistory,
    },
}));

function rawSession(index: number, overrides: Record<string, unknown> = {}) {
    return {
        id: `session-${index}`,
        seq: index,
        createdAt: index,
        updatedAt: index,
        active: false,
        activeAt: index,
        metadata: `metadata-${index}`,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: 'wrapped-key',
        originMachineId: 'machine-1',
        machineDeletedAt: null,
        ...overrides,
    };
}

describe('Codex thread history App coordination', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        metadataByCiphertext.clear();
        decryptEncryptionKey.mockResolvedValue(new Uint8Array(32).fill(5));
        initializeSessions.mockResolvedValue(undefined);
        getSessionEncryption.mockImplementation(() => ({
            decryptMetadata: vi.fn(async (_version: number, ciphertext: string) => metadataByCiphertext.get(ciphertext)),
            decryptAgentState: vi.fn(async () => null),
        }));
        getIndependentSessionDataKey.mockReturnValue(new Uint8Array(32).fill(7));
        deriveCodexResumeSessionDataKey.mockResolvedValue(new Uint8Array(32).fill(9));
    });

    it('scans beyond 150 sessions and reports duplicate provider bindings', async () => {
        const firstPage = Array.from({ length: 200 }, (_, index) => rawSession(index));
        const secondPage = [rawSession(200), rawSession(201)];
        for (const raw of [...firstPage, ...secondPage]) {
            metadataByCiphertext.set(raw.metadata, {
                path: '/tmp/project',
                host: 'test-host',
                machineId: 'machine-1',
                flavor: 'codex',
                codexThreadId: raw.id === 'session-200' || raw.id === 'session-201'
                    ? 'thread-duplicate'
                    : `thread-${raw.id}`,
            });
        }
        request
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ sessions: firstPage, nextCursor: 'cursor-2', hasNext: true }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ sessions: secondPage, nextCursor: null, hasNext: false }),
            });

        const { scanCodexThreadBindings } = await import('./codexThreadHistory');
        const result = await scanCodexThreadBindings('machine-1');

        expect(result.scannedSessionCount).toBe(202);
        expect(request).toHaveBeenNthCalledWith(1, '/v2/sessions?originMachineId=machine-1&limit=200');
        expect(request).toHaveBeenNthCalledWith(2, '/v2/sessions?originMachineId=machine-1&limit=200&cursor=cursor-2');
        expect(result.byThreadId.get('thread-duplicate')).toEqual({
            type: 'duplicate',
            sessionIds: ['session-200', 'session-201'],
        });
    });

    it('sends an existing session key only after the daemon requests resume material', async () => {
        machineRPC
            .mockResolvedValueOnce({ type: 'resumeMaterialRequired', sessionId: 'session-1' })
            .mockResolvedValueOnce({ type: 'success', disposition: 'existing-resumed', sessionId: 'session-1' });
        const binding = {
            type: 'bound' as const,
            sessionId: 'session-1',
            active: false,
            legacy: false,
            session: {
                id: 'session-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                metadata: {
                    path: '/tmp/project',
                    host: 'test-host',
                    flavor: 'codex',
                    codexThreadId: 'thread-1',
                },
                metadataVersion: 1,
                originMachineId: 'machine-1',
                machineDeletedAt: null,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
            },
        };

        const { openCodexThread } = await import('./codexThreadHistory');
        await expect(openCodexThread({
            machineId: 'machine-1',
            directory: '/tmp/project',
            thread: {
                threadId: 'thread-1',
                title: 'Thread',
                preview: '',
                cwd: '/tmp/project',
                createdAt: 1,
                updatedAt: 1,
                recencyAt: 1,
                source: 'cli',
                status: 'idle',
            },
            binding,
            defaults: { permissionMode: 'yolo', modelMode: 'gpt-5.5', effortLevel: 'max' },
        })).resolves.toMatchObject({ type: 'success', disposition: 'existing-resumed' });

        const firstRequest = machineRPC.mock.calls[0][2];
        const secondRequest = machineRPC.mock.calls[1][2];
        expect(firstRequest.binding).toEqual({ sessionId: 'session-1' });
        expect(firstRequest.binding).not.toHaveProperty('dataEncryptionKey');
        expect(secondRequest.binding).toEqual({
            sessionId: 'session-1',
            dataEncryptionKey: expect.any(String),
        });
        expect(getIndependentSessionDataKey).toHaveBeenCalledWith('session-1');
        expect(hydrateSessionFromHistory).toHaveBeenCalledWith(expect.objectContaining({
            id: 'session-1',
            active: true,
        }));
    });

    it('derives an external thread key without reusing a Happy session key', async () => {
        machineRPC.mockResolvedValue({ type: 'success', disposition: 'created', sessionId: 'session-new' });
        const { openCodexThread } = await import('./codexThreadHistory');

        await openCodexThread({
            machineId: 'machine-1',
            directory: '/tmp/project',
            thread: {
                threadId: 'thread-external',
                title: 'External',
                preview: '',
                cwd: '/tmp/project',
                createdAt: 1,
                updatedAt: 1,
                recencyAt: 1,
                source: 'cli',
                status: 'idle',
            },
            defaults: { permissionMode: 'read-only', modelMode: 'gpt-5.5', effortLevel: 'max' },
        });

        expect(deriveCodexResumeSessionDataKey).toHaveBeenCalledWith('machine-1', 'thread-external');
        expect(getIndependentSessionDataKey).not.toHaveBeenCalled();
        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'codex-open-thread',
            expect.objectContaining({ externalDataEncryptionKey: expect.any(String) }),
        );
    });

    it('rejects malformed machine RPC results before they enter App state', async () => {
        machineRPC.mockResolvedValueOnce({
            type: 'success',
            threads: [{
                threadId: 'thread-1',
                title: 'Invalid status',
                preview: '',
                cwd: '/tmp/project',
                createdAt: 1,
                updatedAt: 1,
                recencyAt: 1,
                source: 'cli',
                status: 'finished',
            }],
            nextCursor: null,
        });
        const { listCodexThreads, openCodexThread } = await import('./codexThreadHistory');

        await expect(listCodexThreads({
            machineId: 'machine-1',
            directory: '/tmp/project',
        })).rejects.toThrow();

        machineRPC.mockResolvedValueOnce({
            type: 'success',
            disposition: 'created',
            sessionId: '',
        });
        await expect(openCodexThread({
            machineId: 'machine-1',
            directory: '/tmp/project',
            thread: {
                threadId: 'thread-external',
                title: 'External',
                preview: '',
                cwd: '/tmp/project',
                createdAt: 1,
                updatedAt: 1,
                recencyAt: 1,
                source: 'cli',
                status: 'idle',
            },
            defaults: { permissionMode: 'read-only', modelMode: 'gpt-5.5', effortLevel: 'max' },
        })).resolves.toMatchObject({ type: 'error' });
    });

    it('rejects successful open results that do not match the verified binding', async () => {
        machineRPC.mockResolvedValue({
            type: 'success',
            disposition: 'existing-resumed',
            sessionId: 'session-other',
        });
        const { openCodexThread } = await import('./codexThreadHistory');
        const binding = {
            type: 'bound' as const,
            sessionId: 'session-1',
            active: false,
            legacy: false,
            session: {
                id: 'session-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                metadata: {
                    path: '/tmp/project',
                    host: 'test-host',
                    flavor: 'codex',
                    codexThreadId: 'thread-1',
                },
                metadataVersion: 1,
                originMachineId: 'machine-1',
                machineDeletedAt: null,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
            },
        };

        await expect(openCodexThread({
            machineId: 'machine-1',
            directory: '/tmp/project',
            thread: {
                threadId: 'thread-1',
                title: 'Thread',
                preview: '',
                cwd: '/tmp/project',
                createdAt: 1,
                updatedAt: 1,
                recencyAt: 1,
                source: 'cli',
                status: 'idle',
            },
            binding,
            defaults: { permissionMode: 'yolo', modelMode: 'gpt-5.5', effortLevel: 'max' },
        })).resolves.toMatchObject({ type: 'blocked', reason: 'invalidBinding' });
        expect(hydrateSessionFromHistory).not.toHaveBeenCalled();
    });
});
