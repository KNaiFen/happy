import { beforeEach, describe, expect, it, vi } from 'vitest';

const { codexClientMethods } = vi.hoisted(() => ({
    codexClientMethods: {
        connect: vi.fn(),
        disconnect: vi.fn(),
        forkThread: vi.fn(),
        readThread: vi.fn(),
        rollbackThread: vi.fn(),
        injectItems: vi.fn(),
    },
}));

vi.mock('@/codex/codexAppServerClient', () => ({
    CodexAppServerClient: vi.fn().mockImplementation(() => codexClientMethods),
}));

function machineClient() {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
    } as any;
}

function handlersFrom(client: any): Map<string, (params: any) => Promise<any>> {
    return client.rpcHandlerManager.handlers;
}

describe('ApiMachineClient Codex fork RPCs', () => {
    beforeEach(() => {
        for (const method of Object.values(codexClientMethods)) {
            method.mockReset();
        }
        codexClientMethods.connect.mockResolvedValue(undefined);
        codexClientMethods.disconnect.mockResolvedValue(undefined);
    });

    it('registers a full Codex thread fork RPC', async () => {
        codexClientMethods.forkThread.mockResolvedValue({
            threadId: 'thread-forked',
            thread: { id: 'thread-forked', turns: [] },
        });

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            listCodexThreads: vi.fn(),
            openCodexThread: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:codex-fork-thread')?.({
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
        });

        expect(result).toEqual({ type: 'success', newCodexThreadId: 'thread-forked' });
        expect(codexClientMethods.connect).toHaveBeenCalledOnce();
        expect(codexClientMethods.forkThread).toHaveBeenCalledWith({
            threadId: 'thread-source',
            cwd: '/tmp/project',
        });
        expect(codexClientMethods.disconnect).toHaveBeenCalledOnce();
    });

    it('forwards resumeCodexThreadId through the spawn RPC', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-forked' });

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession,
            listCodexThreads: vi.fn(),
            openCodexThread: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'codex',
            resumeCodexThreadId: 'thread-forked',
            parentSessionId: 'happy-source',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-forked' });
        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/tmp/project',
            agent: 'codex',
            resumeCodexThreadId: 'thread-forked',
            parentSessionId: 'happy-source',
        }));
    });

    it('forwards encrypted Codex history list and open requests to daemon handlers', async () => {
        const listCodexThreads = vi.fn().mockResolvedValue({
            type: 'success',
            threads: [],
            nextCursor: null,
        });
        const openCodexThread = vi.fn().mockResolvedValue({
            type: 'resumeMaterialRequired',
            sessionId: 'happy-existing',
        });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            listCodexThreads,
            openCodexThread,
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        await handlersFrom(client).get('machine-1:codex-list-threads')?.({
            directory: '/tmp/project',
            cursor: 'next',
            searchTerm: 'title',
        });
        const result = await handlersFrom(client).get('machine-1:codex-open-thread')?.({
            directory: '/tmp/project',
            threadId: 'thread-1',
            binding: { sessionId: 'happy-existing' },
            defaults: { modelMode: 'gpt-5.5', effortLevel: 'max' },
        });

        expect(listCodexThreads).toHaveBeenCalledWith({
            directory: '/tmp/project',
            cursor: 'next',
            searchTerm: 'title',
        });
        expect(openCodexThread).toHaveBeenCalledWith({
            directory: '/tmp/project',
            threadId: 'thread-1',
            binding: { sessionId: 'happy-existing' },
            defaults: { modelMode: 'gpt-5.5', effortLevel: 'max' },
        });
        expect(result).toEqual({ type: 'resumeMaterialRequired', sessionId: 'happy-existing' });
    });

    it('rejects ambiguous or empty Codex open-thread resume material', async () => {
        const openCodexThread = vi.fn();
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            listCodexThreads: vi.fn(),
            openCodexThread,
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });
        const handler = handlersFrom(client).get('machine-1:codex-open-thread');

        await expect(handler?.({
            directory: '/tmp/project',
            threadId: 'thread-1',
            binding: { sessionId: 'happy-existing' },
            externalDataEncryptionKey: 'external-key',
        })).rejects.toThrow('mutually exclusive');
        await expect(handler?.({
            directory: '/tmp/project',
            threadId: 'thread-1',
            binding: { sessionId: ' ' },
        })).rejects.toThrow('binding is invalid');
        await expect(handler?.({
            directory: '/tmp/project',
            threadId: 'thread-1',
            externalDataEncryptionKey: 'x'.repeat(129),
        })).rejects.toThrow('externalDataEncryptionKey must be a string');
        await expect(handler?.({
            directory: '/tmp/project',
            threadId: 'thread-1',
            externalDataEncryptionKey: 'external-key',
            defaults: {
                permissionMode: 'bypassPermissions',
                modelMode: 'gpt-5.5',
                effortLevel: 'medium',
            },
        })).rejects.toThrow('not supported by Codex');
        expect(openCodexThread).not.toHaveBeenCalled();
    });

    it('rejects oversized Codex thread search input at the RPC boundary', async () => {
        const listCodexThreads = vi.fn();
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            listCodexThreads,
            openCodexThread: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        await expect(handlersFrom(client).get('machine-1:codex-list-threads')?.({
            directory: '/tmp/project',
            searchTerm: 'x'.repeat(513),
        })).rejects.toThrow('searchTerm');
        expect(listCodexThreads).not.toHaveBeenCalled();
    });

    it('lists Codex rewind points from thread/read', async () => {
        codexClientMethods.readThread.mockResolvedValue({
            thread: {
                id: 'thread-source',
                turns: [{
                    id: 'turn-1',
                    startedAt: 10,
                    items: [
                        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
                    ],
                }],
            },
        });

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            listCodexThreads: vi.fn(),
            openCodexThread: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:codex-list-rewind-points')?.({
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
        });

        expect(result).toEqual({
            type: 'success',
            points: [{ itemId: 'user-1', text: 'hello', timestamp: 10_000 }],
        });
        expect(codexClientMethods.readThread).toHaveBeenCalledWith({
            threadId: 'thread-source',
            includeTurns: true,
        });
    });

    it('duplicates a Codex thread by rolling back turns after the selected item', async () => {
        codexClientMethods.forkThread.mockResolvedValue({
            threadId: 'thread-forked',
            thread: {
                id: 'thread-forked',
                turns: [
                    { id: 'turn-1', items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'one' }] }] },
                    { id: 'turn-2', items: [{ id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'two' }] }] },
                ],
            },
        });
        codexClientMethods.rollbackThread.mockResolvedValue({ thread: { id: 'thread-forked', turns: [] } });
        codexClientMethods.injectItems.mockResolvedValue({});

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            listCodexThreads: vi.fn(),
            openCodexThread: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:codex-duplicate-thread')?.({
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
            cutAfterItemId: 'user-1',
        });

        expect(result).toEqual({ type: 'success', newCodexThreadId: 'thread-forked' });
        expect(codexClientMethods.rollbackThread).toHaveBeenCalledWith({
            threadId: 'thread-forked',
            numTurns: 2,
        });
        expect(codexClientMethods.injectItems).toHaveBeenCalledWith({
            threadId: 'thread-forked',
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'one' }],
            }],
        });
    });
});
