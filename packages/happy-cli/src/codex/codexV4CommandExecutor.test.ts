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
        readThreadComplete: vi.fn(async () => ({
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

function executor(
    client: CodexAppServerClient,
    overrides: Partial<ConstructorParameters<typeof CodexV4CommandExecutor>[0]> = {},
) {
    return new CodexV4CommandExecutor({
        client,
        requestBroker: { resolve: vi.fn(async ({ requestId }) => ({ providerRequestId: requestId })) },
        defaultCwd: '/workspace',
        preparePrompt: (text) => `[prepared] ${text}`,
        ...overrides,
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

    it('starts a queued follow-up as a new official turn with the same idempotency key', async () => {
        const client = fakeClient();
        const result = await executor(client).execute(command('turn.queue', { text: 'next' }));

        expect(client.steerTurnOnThread).not.toHaveBeenCalled();
        expect(client.startTurnOnThread).toHaveBeenCalledWith(
            'thread-1',
            '[prepared] next',
            expect.objectContaining({ clientUserMessageId: 'command-1' }),
        );
        expect(result).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    });

    it('starts a new turn when an explicit steer loses the active-turn race locally', async () => {
        const client = fakeClient();
        const result = await executor(client, {
            activeTurnId: () => null,
        }).execute(command('turn.steer', { text: 'redirect' }, {
            expectedTurnId: 'turn-finished',
        }));

        expect(client.steerTurnOnThread).not.toHaveBeenCalled();
        expect(client.startTurnOnThread).toHaveBeenCalledWith(
            'thread-1',
            '[prepared] redirect',
            expect.objectContaining({ clientUserMessageId: 'command-1' }),
        );
        expect(result).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    });

    it('reconciles a failed steer snapshot and starts after the provider turn ended', async () => {
        const client = fakeClient({
            steerTurnOnThread: vi.fn(async () => { throw new Error('turn is no longer active'); }),
            readThreadComplete: vi.fn(async () => ({
                thread: { id: 'thread-1', turns: [{ id: 'turn-finished', status: 'completed', items: [] }] },
            })),
        });
        const result = await executor(client).execute(command('turn.steer', { text: 'redirect' }, {
            expectedTurnId: 'turn-finished',
        }));

        expect(client.startTurnOnThread).toHaveBeenCalledOnce();
        expect(result).toEqual({
            threadId: 'thread-1',
            turnId: 'turn-1',
            result: { deliveryMode: 'startAfterSteerRace' },
        });
    });

    it('checks the binding immediately after asynchronous input preparation and before the provider call', async () => {
        const client = fakeClient();
        const prepareAttachments = vi.fn(async () => ([{
            type: 'localImage' as const,
            path: '/tmp/image.png',
        }]));
        const beforeProviderCall = vi.fn(() => {
            throw new Error('binding superseded');
        });

        await expect(executor(client, {
            prepareAttachments,
            beforeProviderCall,
        }).execute(command('turn.start', {
            text: 'inspect',
            attachments: [{ ref: 'blob-1', name: 'image.png', mimeType: 'image/png' }],
        }))).rejects.toThrow('binding superseded');

        expect(prepareAttachments).toHaveBeenCalledOnce();
        expect(beforeProviderCall).toHaveBeenCalledOnce();
        expect(client.startTurnOnThread).not.toHaveBeenCalled();
    });

    it('uses the canonical command thread when a payload also carries a thread target', async () => {
        const client = fakeClient();
        await executor(client).execute(command('turn.start', {
            threadId: 'thread-payload',
            text: 'hello',
        }, {
            threadId: 'thread-canonical',
        }));

        expect(client.resumeThread).toHaveBeenCalledWith(expect.objectContaining({
            threadId: 'thread-canonical',
        }));
        expect(client.startTurnOnThread).toHaveBeenCalledWith(
            'thread-canonical',
            '[prepared] hello',
            expect.any(Object),
        );
    });

    it('routes compact to one protocol call and never starts a text turn', async () => {
        const client = fakeClient();
        const result = await executor(client).execute(command('thread.compact', {}));
        expect(client.compactThread).toHaveBeenCalledWith('thread-1');
        expect(client.startTurnOnThread).not.toHaveBeenCalled();
        expect(result).toEqual({ threadId: 'thread-1', result: { started: true } });
    });

    it('propagates interrupt failures so uncertain outcomes can be reconciled', async () => {
        const client = fakeClient({
            interruptTurnOnThread: vi.fn(async () => {
                throw new Error('transport closed');
            }),
        });
        await expect(executor(client).execute(command(
            'turn.interrupt',
            {},
            { expectedTurnId: 'turn-active' },
        ))).rejects.toThrow('transport closed');
        expect(client.interruptTurnOnThread).toHaveBeenCalledWith('thread-1', 'turn-active', {
            propagateErrors: true,
        });
    });

    it('checks the binding before direct control and request side effects', async () => {
        const client = fakeClient();
        const requestBroker = {
            resolve: vi.fn(async ({ requestId }: { requestId: string }) => ({ providerRequestId: requestId })),
        };
        const beforeProviderCall = vi.fn(() => {
            throw new Error('binding superseded');
        });
        const guarded = executor(client, { beforeProviderCall, requestBroker });

        await expect(guarded.execute(command('turn.interrupt', {}, {
            expectedTurnId: 'turn-active',
        }))).rejects.toThrow('binding superseded');
        await expect(guarded.execute(command('goal.set', {
            objective: 'finish',
        }))).rejects.toThrow('binding superseded');
        await expect(guarded.execute(command('goal.clear', {}))).rejects.toThrow('binding superseded');
        await expect(guarded.execute(command('request.resolve', {
            requestId: 'request-1',
            response: { decision: 'accept' },
        }))).rejects.toThrow('binding superseded');

        expect(client.interruptTurnOnThread).not.toHaveBeenCalled();
        expect(client.setGoal).not.toHaveBeenCalled();
        expect(client.clearGoal).not.toHaveBeenCalled();
        expect(requestBroker.resolve).not.toHaveBeenCalled();
        expect(beforeProviderCall).toHaveBeenCalledTimes(4);
    });

    it('passes a valid request response to the broker after the binding check', async () => {
        const client = fakeClient();
        const requestBroker = {
            resolve: vi.fn(async ({ requestId }: { requestId: string }) => ({ providerRequestId: requestId })),
        };
        const beforeProviderCall = vi.fn();

        await expect(executor(client, { beforeProviderCall, requestBroker }).execute(command(
            'request.resolve',
            { requestId: 'request-1', response: { decision: 'accept' } },
        ))).resolves.toEqual({
            threadId: 'thread-1',
            providerRequestId: 'request-1',
        });

        expect(beforeProviderCall).toHaveBeenCalledOnce();
        expect(requestBroker.resolve).toHaveBeenCalledWith({
            threadId: 'thread-1',
            requestId: 'request-1',
            response: { decision: 'accept' },
        });
    });

    it('reconciles turn submission through official UserMessage.clientId', async () => {
        const client = fakeClient({
            readThreadComplete: vi.fn(async () => ({
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

    it('reconciles a queued turn through the same official client id', async () => {
        const client = fakeClient({
            readThreadComplete: vi.fn(async () => ({
                thread: {
                    id: 'thread-1',
                    turns: [{
                        id: 'turn-from-queue',
                        items: [{ type: 'userMessage', id: 'item-1', clientId: 'command-1', content: [] }],
                    }],
                },
            })),
        });
        await expect(executor(client).reconcile(command('turn.queue', { text: 'next' }))).resolves.toEqual({
            action: 'succeeded',
            threadId: 'thread-1',
            turnId: 'turn-from-queue',
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

    it('downloads attachment references into official localImage input items', async () => {
        const client = fakeClient();
        const prepareAttachments = vi.fn(async () => ([{
            type: 'localImage' as const,
            path: '/tmp/codex-v4/image.png',
        }]));
        await executor(client, { prepareAttachments }).execute(command('turn.start', {
            text: 'inspect',
            attachments: [{ ref: 'encrypted-ref', name: 'image.png', mimeType: 'image/png' }],
        }));

        expect(prepareAttachments).toHaveBeenCalledWith([
            { ref: 'encrypted-ref', name: 'image.png', mimeType: 'image/png' },
        ]);
        expect(client.startTurnOnThread).toHaveBeenCalledWith(
            'thread-1',
            '[prepared] inspect',
            expect.objectContaining({
                clientUserMessageId: 'command-1',
                extraInputItems: [{ type: 'localImage', path: '/tmp/codex-v4/image.png' }],
            }),
        );
    });

    it('resolves a named Codex skill to an official skill input item', async () => {
        const client = fakeClient({
            listSkills: vi.fn(async () => ({
                data: [{ cwd: '/workspace', skills: [{ name: 'release', path: '/skills/release/SKILL.md', enabled: true }] }],
            })),
        });
        await executor(client).execute(command('turn.start', { text: 'dry run', skillName: 'release' }));

        expect(client.startTurnOnThread).toHaveBeenCalledWith(
            'thread-1',
            '[prepared] dry run',
            expect.objectContaining({
                extraInputItems: [{ type: 'skill', name: 'release', path: '/skills/release/SKILL.md' }],
            }),
        );
    });

    it('maps the App permission mode and model effort before starting a turn', async () => {
        const client = fakeClient();
        const resolveExecutionPolicy = vi.fn(() => ({
            approvalPolicy: 'never' as const,
            sandbox: 'workspace-write' as const,
        }));
        const resolveEffort = vi.fn(() => 'medium');
        await executor(client, { resolveExecutionPolicy, resolveEffort }).execute(command('turn.start', {
            text: 'hello',
            model: 'gpt-test',
            effort: 'xhigh',
            permissionMode: 'acceptEdits',
        }));

        expect(resolveExecutionPolicy).toHaveBeenCalledWith('acceptEdits');
        expect(resolveEffort).toHaveBeenCalledWith('gpt-test', 'xhigh');
        expect(client.startTurnOnThread).toHaveBeenCalledWith(
            'thread-1',
            '[prepared] hello',
            expect.objectContaining({ approvalPolicy: 'never', sandbox: 'workspace-write', effort: 'medium' }),
        );
    });

    it('rolls back every official turn for /clear', async () => {
        const rollbackSnapshot = { id: 'thread-1', turns: [] };
        const client = fakeClient({
            readThreadComplete: vi.fn(async () => ({
                thread: { id: 'thread-1', turns: [{ id: 'turn-1' }, { id: 'turn-2' }, { id: 'turn-3' }] },
            })),
            rollbackThread: vi.fn(async () => ({ thread: rollbackSnapshot })),
        });
        await expect(executor(client).execute(command('thread.rollback', { allTurns: true }))).resolves.toEqual({
            threadId: 'thread-1',
            result: { rolledBackTurns: 3 },
            rollbackSnapshot,
        });
        expect(client.readThreadComplete).toHaveBeenCalledWith({
            threadId: 'thread-1',
            emitSnapshot: false,
        });
        expect(client.rollbackThread).toHaveBeenCalledWith({
            threadId: 'thread-1',
            numTurns: 3,
            emitSnapshot: false,
        });
    });

    it('reconciles an empty /clear snapshot without issuing a zero-turn rollback', async () => {
        const rollbackSnapshot = { id: 'thread-1', turns: [], status: { type: 'idle' } };
        const client = fakeClient({
            readThreadComplete: vi.fn(async () => ({ thread: rollbackSnapshot })),
            rollbackThread: vi.fn(),
        });

        await expect(executor(client).execute(command('thread.rollback', { allTurns: true }))).resolves.toEqual({
            threadId: 'thread-1',
            result: { rolledBackTurns: 0 },
            rollbackSnapshot,
        });
        expect(client.rollbackThread).not.toHaveBeenCalled();
    });

    it('fails malformed native controls without starting a prompt turn', async () => {
        const client = fakeClient();
        await expect(executor(client).execute(command('thread.compact', { unsupportedPrompt: 'custom' })))
            .rejects.toThrow('thread.compact does not support a per-request prompt');
        await expect(executor(client).execute(command('skills.list', { unsupportedArguments: 'extra' })))
            .rejects.toThrow('skills.list does not accept arguments');
        expect(client.startTurnOnThread).not.toHaveBeenCalled();
    });

    it('rejects malformed execution policy fields instead of silently using defaults', async () => {
        const client = fakeClient();
        await expect(executor(client).execute(command('turn.start', {
            text: 'hello',
            approvalPolicy: 'sometimes',
        }))).rejects.toThrow('Invalid Codex approval policy');
        await expect(executor(client).execute(command('turn.start', {
            text: 'hello',
            sandbox: 'host-write',
        }))).rejects.toThrow('Invalid Codex sandbox mode');
        expect(client.startTurnOnThread).not.toHaveBeenCalled();
    });

    it('rejects malformed review and goal fields before invoking Codex', async () => {
        const client = fakeClient();
        await expect(executor(client).execute(command('review.start', {
            target: { type: 'uncommittedChanges' },
            delivery: 'background',
        }))).rejects.toThrow('Invalid Codex review delivery');
        await expect(executor(client).execute(command('goal.set', {
            objective: 'finish',
            status: 'finished',
        }))).rejects.toThrow('Invalid Codex goal status');
        await expect(executor(client).execute(command('goal.set', {
            objective: 'finish',
            tokenBudget: 1.5,
        }))).rejects.toThrow('Codex goal tokenBudget must be a nonnegative integer or null');
        expect(client.startReview).not.toHaveBeenCalled();
        expect(client.setGoal).not.toHaveBeenCalled();
    });

    it('rejects a non-object command payload', async () => {
        const client = fakeClient();
        await expect(executor(client).execute(command('turn.start', 'hello')))
            .rejects.toThrow('Codex command payload must be an object');
        expect(client.startTurnOnThread).not.toHaveBeenCalled();
    });
});
