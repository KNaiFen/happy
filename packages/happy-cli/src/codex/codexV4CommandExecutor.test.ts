import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    type CodexCommandEntityV4,
} from '@slopus/happy-wire';
import { describe, expect, it, vi } from 'vitest';
import type { CodexAppServerClient } from './codexAppServerClient';
import { CodexV4CommandExecutor } from './codexV4CommandExecutor';

function command(
    name: string,
    payload: CodexCommandEntityV4['payload'],
    overrides: Partial<CodexCommandEntityV4> = {},
): CodexCommandEntityV4 {
    return {
        schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
        entityType: 'codex.command',
        providerId: 'command-1',
        createdAt: 100,
        updatedAt: 100,
        commandId: 'command-1',
        threadId: 'thread-1',
        expectedTurnId: null,
        command: name,
        payload,
        clientUserMessageId: 'command-1',
        replacesCommandId: null,
        ...overrides,
    };
}

function fakeClient(overrides: Record<string, unknown> = {}): CodexAppServerClient {
    return {
        threadId: 'thread-1',
        startThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-test' })),
        resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-test' })),
        startTurnOnThread: vi.fn(async () => ({ turnId: 'turn-1' })),
        steerTurnOnThread: vi.fn(async () => undefined),
        interruptTurnOnThread: vi.fn(async () => undefined),
        compactThread: vi.fn(async () => ({})),
        startReview: vi.fn(async () => ({
            reviewThreadId: 'thread-1',
            turn: { id: 'review-turn-1' },
        })),
        readThread: vi.fn(async () => ({
            thread: { id: 'thread-1', turns: [] },
        })),
        forkThread: vi.fn(),
        rollbackThread: vi.fn(),
        setGoal: vi.fn(),
        clearGoal: vi.fn(),
        listSkills: vi.fn(async () => ({ data: [] })),
        listMcpServerStatus: vi.fn(async () => []),
        listModels: vi.fn(async () => []),
        ...overrides,
    } as unknown as CodexAppServerClient;
}

function executor(client: CodexAppServerClient) {
    return new CodexV4CommandExecutor({
        client,
        requestBroker: { resolve: vi.fn(async ({ requestId }) => ({ providerRequestId: requestId })) },
        defaultCwd: '/workspace',
        preparePrompt: (text) => `[prepared] ${text}`,
    });
}

describe('CodexV4CommandExecutor', () => {
    it('starts turns with commandId as the provider idempotency key', async () => {
        const client = fakeClient();
        const result = await executor(client).execute(command('turn.start', {
            text: 'hello',
            model: 'gpt-test',
            effort: 'high',
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
        }));

        expect(client.startTurnOnThread).toHaveBeenCalledWith('thread-1', '[prepared] hello', {
            model: 'gpt-test',
            cwd: undefined,
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
            effort: 'high',
            clientUserMessageId: 'command-1',
            extraInputItems: [],
        });
        expect(result).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    });

    it('routes compact to one protocol call and never starts a text turn', async () => {
        const client = fakeClient();
        const result = await executor(client).execute(command('thread.compact', {}));
        expect(client.compactThread).toHaveBeenCalledWith('thread-1');
        expect(client.startTurnOnThread).not.toHaveBeenCalled();
        expect(result).toEqual({ threadId: 'thread-1', result: { started: true } });
    });

    it('reconciles turn submission through official UserMessage.clientId', async () => {
        const client = fakeClient({
            readThread: vi.fn(async () => ({
                thread: {
                    id: 'thread-1',
                    turns: [{
                        id: 'turn-from-snapshot',
                        items: [{ type: 'userMessage', id: 'item-1', clientId: 'command-1', content: [] }],
                    }],
                },
            })),
        });
        await expect(executor(client).reconcile(command('turn.start', { text: 'hello' }))).resolves.toEqual({
            action: 'succeeded',
            threadId: 'thread-1',
            turnId: 'turn-from-snapshot',
        });
    });

    it('does not replay an uncertain compact command', async () => {
        const client = fakeClient();
        await expect(executor(client).reconcile(command('thread.compact', {}))).resolves.toEqual({
            action: 'notReplayed',
            error: 'thread.compact outcome is unknown and the operation is not safe to replay',
        });
        expect(client.compactThread).not.toHaveBeenCalled();
    });

    it('rejects unknown control commands instead of treating them as prompts', async () => {
        const client = fakeClient();
        await expect(executor(client).execute(command('thread.magic', { text: 'do magic' })))
            .rejects.toThrow('Unsupported Codex v4 command: thread.magic');
        expect(client.startTurnOnThread).not.toHaveBeenCalled();
    });
});
