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
            operationId: 'f24d3f6c-1ee8-4098-9cc0-a273c3b04f65',
            directory: '/tmp/project',
            agent: 'codex',
            resumeCodexThreadId: 'thread-forked',
            parentSessionId: 'happy-source',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-forked' });
        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/tmp/project',
            operationId: 'f24d3f6c-1ee8-4098-9cc0-a273c3b04f65',
            agent: 'codex',
            resumeCodexThreadId: 'thread-forked',
            parentSessionId: 'happy-source',
        }));
    });

    it('rejects a malformed App operation ID before spawning', async () => {
        const spawnSession = vi.fn();
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession,
            listCodexThreads: vi.fn(),
            openCodexThread: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        await expect(handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            operationId: 'not-a-uuid',
            directory: '/tmp/project',
            agent: 'codex',
        })).rejects.toThrow('operationId must be a UUID');
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('validates and forwards the App operation ID when resuming a Happy session', async () => {
        const resumeSession = vi.fn().mockResolvedValue({
            type: 'success',
            sessionId: 'happy-existing',
        });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            resumeSession,
            listCodexThreads: vi.fn(),
            openCodexThread: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });
        const handler = handlersFrom(client).get('machine-1:resume-happy-session');

        const result = await handler?.({
            operationId: 'f24d3f6c-1ee8-4098-9cc0-a273c3b04f65',
            sessionId: 'happy-existing',
            directory: '/tmp/project',
            threadId: 'thread-existing',
            model: 'gpt-5.6-sol',
        });
        expect(result).toEqual({ type: 'success', sessionId: 'happy-existing' });
        expect(resumeSession).toHaveBeenCalledWith('happy-existing', {
            operationId: 'f24d3f6c-1ee8-4098-9cc0-a273c3b04f65',
            directory: '/tmp/project',
            threadId: 'thread-existing',
            model: 'gpt-5.6-sol',
            permissionMode: undefined,
            effort: undefined,
            dataEncryptionKey: undefined,
        });

        await expect(handler?.({
            operationId: 'not-a-uuid',
            sessionId: 'happy-existing',
            directory: '/tmp/project',
            threadId: 'thread-existing',
        })).rejects.toThrow('operationId must be a UUID');
        expect(resumeSession).toHaveBeenCalledOnce();
    });

    it('returns a resume-material challenge and validates the encrypted retry material', async () => {
        const resumeSession = vi.fn()
            .mockResolvedValueOnce({
                type: 'resumeMaterialRequired',
                sessionId: 'happy-existing',
            })
            .mockResolvedValueOnce({
                type: 'success',
                sessionId: 'happy-existing',
            });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            resumeSession,
            listCodexThreads: vi.fn(),
            openCodexThread: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });
        const handler = handlersFrom(client).get('machine-1:resume-happy-session');

        await expect(handler?.({
            sessionId: 'happy-existing',
            directory: '/tmp/project',
            threadId: 'thread-existing',
        })).resolves.toEqual({
            type: 'resumeMaterialRequired',
            sessionId: 'happy-existing',
        });
        await expect(handler?.({
            sessionId: 'happy-existing',
            directory: '/tmp/project',
            threadId: 'thread-existing',
            dataEncryptionKey: 'resume-key',
        })).resolves.toEqual({ type: 'success', sessionId: 'happy-existing' });
        expect(resumeSession).toHaveBeenLastCalledWith('happy-existing', expect.objectContaining({
            dataEncryptionKey: 'resume-key',
        }));

        await expect(handler?.({
            sessionId: 'happy-existing',
            directory: '/tmp/project',
            threadId: 'thread-existing',
            dataEncryptionKey: 'x'.repeat(129),
        })).rejects.toThrow('dataEncryptionKey');
        expect(resumeSession).toHaveBeenCalledTimes(2);
    });

    it('returns stable resume failures without turning them into encrypted RPC errors', async () => {
        const resumeSession = vi.fn()
            .mockResolvedValueOnce({ type: 'blocked', reason: 'threadUnavailable' })
            .mockResolvedValueOnce({ type: 'error', error: 'outcomeUnknown' });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            resumeSession,
            listCodexThreads: vi.fn(),
            openCodexThread: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });
        const handler = handlersFrom(client).get('machine-1:resume-happy-session');
        const request = {
            sessionId: 'happy-existing',
            directory: '/tmp/project',
            threadId: 'thread-existing',
        };

        await expect(handler?.(request)).resolves.toEqual({
            type: 'blocked',
            reason: 'threadUnavailable',
        });
        await expect(handler?.(request)).resolves.toEqual({
            type: 'error',
            error: 'outcomeUnknown',
        });
    });

    it('registers the read-only resume preflight RPC with bounded independent keys', async () => {
        const preflightResumeSessions = vi.fn().mockResolvedValue({
            type: 'success',
            results: [{ type: 'eligible', sessionId: 'happy-existing' }],
        });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            listCodexThreads: vi.fn(),
            openCodexThread: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
            preflightResumeSessions,
        });
        const dataEncryptionKey = Buffer.alloc(32, 7).toString('base64');

        await expect(handlersFrom(client).get('machine-1:preflight-resume-sessions')?.({
            sessions: [{
                sessionId: 'happy-existing',
                directory: '/tmp/project',
                threadId: 'thread-1',
                dataEncryptionKey,
            }],
        })).resolves.toEqual({
            type: 'success',
            results: [{ type: 'eligible', sessionId: 'happy-existing' }],
        });
        expect(preflightResumeSessions).toHaveBeenCalledWith({
            sessions: [{
                sessionId: 'happy-existing',
                directory: '/tmp/project',
                threadId: 'thread-1',
                dataEncryptionKey,
            }],
        });

        await expect(handlersFrom(client).get('machine-1:preflight-resume-sessions')?.({
            sessions: [],
        })).rejects.toThrow('between 1 and 25');
        await expect(handlersFrom(client).get('machine-1:preflight-resume-sessions')?.({
            sessions: [{
                sessionId: 'happy-existing',
                directory: '/tmp/project',
                threadId: 'thread-1',
                dataEncryptionKey: 'not-a-key',
            }],
        })).rejects.toThrow('must decode to 32 bytes');
        expect(preflightResumeSessions).toHaveBeenCalledOnce();
    });

    it('keeps the legacy resume request shape compatible while the daemon derives its binding', async () => {
        const resumeSession = vi.fn().mockResolvedValue({
            type: 'resumeMaterialRequired',
            sessionId: 'happy-existing',
        });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            resumeSession,
            listCodexThreads: vi.fn(),
            openCodexThread: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });
        const handler = handlersFrom(client).get('machine-1:resume-happy-session');

        await expect(handler?.({ sessionId: 'happy-existing' })).resolves.toEqual({
            type: 'resumeMaterialRequired',
            sessionId: 'happy-existing',
        });
        expect(resumeSession).toHaveBeenCalledWith('happy-existing', expect.objectContaining({
            directory: undefined,
            threadId: undefined,
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

    it('forwards the expected Gateway generation through stop-session', async () => {
        const stopSession = vi.fn().mockResolvedValue({ outcome: 'stopped', message: 'Session stopped' });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            listCodexThreads: vi.fn(),
            openCodexThread: vi.fn(),
            stopSession,
            requestShutdown: vi.fn(),
        });

        await expect(handlersFrom(client).get('machine-1:stop-session')?.({
            sessionId: 'session-current',
            expectedGatewayId: 'gateway-1',
            bindingGeneration: 4,
        })).resolves.toEqual({ outcome: 'stopped', message: 'Session stopped' });
        expect(stopSession).toHaveBeenCalledWith('session-current', {
            gatewayId: 'gateway-1',
            generation: 4,
        });
    });

    it.each(['missing', 'unverified'] as const)(
        'returns the %s Gateway outcome without turning it into an RPC failure',
        async (outcome) => {
            const stopSession = vi.fn().mockResolvedValue({ outcome, message: `Gateway ${outcome}` });
            const { ApiMachineClient } = await import('./apiMachine');
            const client = new ApiMachineClient('token', machineClient());
            client.setRPCHandlers({
                spawnSession: vi.fn(),
                listCodexThreads: vi.fn(),
                openCodexThread: vi.fn(),
                stopSession,
                requestShutdown: vi.fn(),
            });

            await expect(handlersFrom(client).get('machine-1:stop-session')?.({
                sessionId: 'session-current',
                expectedGatewayId: 'gateway-1',
                bindingGeneration: 4,
            })).resolves.toEqual({ outcome, message: `Gateway ${outcome}` });
        },
    );

    it('keeps a failed Gateway stop as an RPC failure', async () => {
        const stopSession = vi.fn().mockResolvedValue({
            outcome: 'failed',
            message: 'Gateway control channel unavailable',
        });
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            listCodexThreads: vi.fn(),
            openCodexThread: vi.fn(),
            stopSession,
            requestShutdown: vi.fn(),
        });

        await expect(handlersFrom(client).get('machine-1:stop-session')?.({
            sessionId: 'session-current',
            expectedGatewayId: 'gateway-1',
            bindingGeneration: 4,
        })).rejects.toThrow('Gateway control channel unavailable');
    });

    it('rejects stop-session without a complete Gateway expectation', async () => {
        const stopSession = vi.fn();
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            listCodexThreads: vi.fn(),
            openCodexThread: vi.fn(),
            stopSession,
            requestShutdown: vi.fn(),
        });

        await expect(handlersFrom(client).get('machine-1:stop-session')?.({
            sessionId: 'session-current',
        })).rejects.toThrow('expectedGatewayId');
        expect(stopSession).not.toHaveBeenCalled();
    });
});
