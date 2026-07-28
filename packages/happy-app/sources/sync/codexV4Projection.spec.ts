import type {
    CodexEntityV4,
    CodexCommandEntityV4,
    CodexCommandResultEntityV4,
    CodexItemEntityV4,
    CodexPartEntityV4,
    CodexRequestEntityV4,
    CodexRelationEntityV4,
    CodexRuntimeEntityV4,
    CodexThreadEntityV4,
    CodexTurnEntityV4,
} from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';
import {
    applyCodexV4ProjectionUpdate,
    applyCodexV4ProjectionUpdates,
    createCodexV4Projection,
    resetCodexV4Projection,
    type CodexV4Projection,
} from './codexV4Projection';

function apply(
    projection: CodexV4Projection,
    entity: CodexEntityV4,
    revision: number = 1,
): CodexV4Projection {
    return applyCodexV4ProjectionUpdate(projection, { entity, revision, op: 'upsert' });
}

const turn: CodexTurnEntityV4 = {
    schemaVersion: 1,
    entityType: 'codex.turn' as const,
    providerId: 'turn-1',
    createdAt: 10,
    updatedAt: 10,
    threadId: 'thread-1',
    turnId: 'turn-1',
    status: 'inProgress' as const,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
    error: null,
    usage: null,
    planRevision: 0,
    diffRevision: 0,
};

const item: CodexItemEntityV4 = {
    schemaVersion: 1,
    entityType: 'codex.item' as const,
    providerId: 'item-1',
    createdAt: 11,
    updatedAt: 11,
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    itemType: 'agentMessage',
    status: 'inProgress',
    parentItemId: null,
    clientId: null,
    phase: null,
    startedAt: 11,
    completedAt: null,
    command: null,
    cwd: null,
    processId: null,
    exitCode: null,
    durationMs: null,
    server: null,
    tool: null,
    arguments: null,
};

function part(content: string, kind: CodexPartEntityV4['kind'] = 'text'): CodexPartEntityV4 {
    return {
        schemaVersion: 1,
        entityType: 'codex.part',
        providerId: 'part-1',
        createdAt: 12,
        updatedAt: 12,
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        partId: 'part-1',
        kind,
        index: 0,
        chunkIndex: 0,
        content,
        contentType: 'text',
        final: false,
    };
}

describe('Codex v4 projection', () => {
    it('applies a page of entity updates in order and ignores stale revisions', () => {
        const projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), [
            { entity: item, revision: 1, op: 'upsert' },
            { entity: part('batched response'), revision: 1, op: 'upsert' },
            { entity: { ...item, status: 'completed', completedAt: 13 }, revision: 2, op: 'upsert' },
            { entity: { ...item, status: 'inProgress', completedAt: null }, revision: 1, op: 'upsert' },
        ]);

        expect(projection.entities['codex.item']['item-1']).toMatchObject({
            status: 'completed',
            completedAt: 13,
        });
        expect(projection.messages).toMatchObject([{
            kind: 'agent-text',
            text: 'batched response',
        }]);
    });

    it('clears snapshot-derived state without falling back after activation', () => {
        const runtime: CodexRuntimeEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.runtime',
            providerId: 'runtime-reset',
            createdAt: 1,
            updatedAt: 1,
            threadId: 'thread-1',
            connection: 'connected',
            execution: { type: 'idle' },
            statusUnknown: false,
            protocolVersion: 'v2',
            codexCliVersion: '0.145.0',
            syncState: 'ready',
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            activeSubagentCount: 0,
            lastError: null,
            lastKnownAt: 1,
        };
        const projection = resetCodexV4Projection(apply(createCodexV4Projection(), runtime));

        expect(projection.activated).toBe(true);
        expect(projection.runtime).toBeNull();
        expect(projection.messages).toEqual([]);
        expect(projection.revisions).toEqual({});
    });

    it('updates one message in place when a streaming part revision advances', () => {
        let projection = createCodexV4Projection();
        projection = apply(projection, turn);
        projection = apply(projection, item);
        projection = apply(projection, part('Hel'));
        const firstMessageId = projection.messages[0].id;

        projection = apply(projection, { ...part('Hello'), updatedAt: 13 }, 2);
        expect(projection.messages).toHaveLength(1);
        expect(projection.messages[0]).toMatchObject({
            id: firstMessageId,
            kind: 'agent-text',
            text: 'Hello',
        });
    });

    it('preserves unrelated message identity when one streaming part advances', () => {
        const secondItem = {
            ...item,
            providerId: 'item-2',
            itemId: 'item-2',
            createdAt: 20,
            startedAt: 20,
        };
        const secondPart = {
            ...part('Unchanged'),
            providerId: 'part-2',
            partId: 'part-2',
            itemId: 'item-2',
            createdAt: 21,
            updatedAt: 21,
        };
        let projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), [
            { entity: turn, revision: 1, op: 'upsert' },
            { entity: item, revision: 1, op: 'upsert' },
            { entity: part('First'), revision: 1, op: 'upsert' },
            { entity: secondItem, revision: 1, op: 'upsert' },
            { entity: secondPart, revision: 1, op: 'upsert' },
        ]);
        const firstBefore = projection.messages.find((message) => message.id === 'codex-v4:item:item-1');
        const secondBefore = projection.messages.find((message) => message.id === 'codex-v4:item:item-2');

        projection = apply(projection, { ...part('First updated'), updatedAt: 22 }, 2);

        expect(projection.messages.find((message) => message.id === 'codex-v4:item:item-1'))
            .not.toBe(firstBefore);
        expect(projection.messages.find((message) => message.id === 'codex-v4:item:item-2'))
            .toBe(secondBefore);
    });

    it('keeps 10,000-entity streaming updates scoped to one projected message', () => {
        const updates: Array<{
            entity: CodexEntityV4;
            revision: number;
            op: 'upsert';
        }> = [{ entity: turn, revision: 1, op: 'upsert' }];
        for (let index = 0; index < 5_000; index += 1) {
            updates.push({
                entity: {
                    ...item,
                    providerId: `item-${index}`,
                    itemId: `item-${index}`,
                    createdAt: 20 + index,
                    updatedAt: 20 + index,
                    startedAt: 20 + index,
                },
                revision: 1,
                op: 'upsert',
            });
            updates.push({
                entity: {
                    ...part(`Message ${index}`),
                    providerId: `part-${index}`,
                    partId: `part-${index}`,
                    itemId: `item-${index}`,
                    createdAt: 20 + index,
                    updatedAt: 20 + index,
                },
                revision: 1,
                op: 'upsert',
            });
        }
        let projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), updates);
        const previousMessages = new Map(projection.messages.map((message) => [message.id, message]));

        projection = apply(projection, {
            ...part('Updated once'),
            providerId: 'part-2500',
            partId: 'part-2500',
            itemId: 'item-2500',
            createdAt: 2_520,
            updatedAt: 10_000,
        }, 2);

        expect(projection.messages).toHaveLength(5_000);
        expect(projection.messages.reduce((count, message) => (
            count + (previousMessages.get(message.id) === message ? 0 : 1)
        ), 0)).toBe(1);
        expect(projection.messages.find((message) => message.id === 'codex-v4:item:item-2500'))
            .toMatchObject({ kind: 'agent-text', text: 'Updated once' });
    });

    it('reprojects both owners when a part moves between items and when it is deleted', () => {
        const secondItem = {
            ...item,
            providerId: 'item-2',
            itemId: 'item-2',
            createdAt: 20,
            startedAt: 20,
        };
        let projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), [
            { entity: turn, revision: 1, op: 'upsert' },
            { entity: item, revision: 1, op: 'upsert' },
            { entity: secondItem, revision: 1, op: 'upsert' },
            { entity: part('Moves'), revision: 1, op: 'upsert' },
        ]);

        projection = apply(projection, {
            ...part('Moves'),
            itemId: 'item-2',
            updatedAt: 21,
        }, 2);

        expect(projection.messages.find((message) => message.id === 'codex-v4:item:item-1'))
            .toBeUndefined();
        expect(projection.messages.find((message) => message.id === 'codex-v4:item:item-2'))
            .toMatchObject({ kind: 'agent-text', text: 'Moves' });

        projection = applyCodexV4ProjectionUpdate(projection, {
            entity: {
                ...part('Moves'),
                itemId: 'item-2',
                updatedAt: 22,
            },
            revision: 3,
            op: 'delete',
        });

        expect(projection.messages).toEqual([]);
    });

    it('ignores duplicate and lower entity revisions', () => {
        let projection = apply(createCodexV4Projection(), part('new'), 3);
        const unchanged = apply(projection, { ...part('old'), updatedAt: 9 }, 2);
        expect(unchanged).toBe(projection);
    });

    it('prefers thread usage, falls back to the latest turn, and clears legacy fallback', () => {
        const turnUsage = {
            totalTokens: 1_200,
            inputTokens: 900,
            cachedInputTokens: 250,
            cacheWriteInputTokens: 30,
            outputTokens: 300,
            reasoningOutputTokens: 100,
        };
        const thread: CodexThreadEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.thread',
            providerId: 'thread-1',
            createdAt: 1,
            updatedAt: 20,
            threadId: 'thread-1',
            sessionTreeId: null,
            forkedFromThreadId: null,
            parentThreadId: null,
            name: null,
            preview: '',
            cwd: '/workspace',
            cliVersion: '0.145.0',
            model: 'gpt-5',
            modelProvider: 'openai',
            source: 'cli',
            status: { type: 'idle' },
            canAcceptDirectInput: true,
            settings: {
                approvalPolicy: null,
                approvalsReviewer: null,
                sandboxPolicy: null,
                permissionProfile: null,
                serviceTier: null,
                reasoningEffort: null,
                reasoningSummary: null,
                collaborationMode: null,
                personality: null,
            },
            goal: null,
            tokenUsage: {
                total: {
                    ...turnUsage,
                    totalTokens: 4_000,
                    inputTokens: 3_000,
                    outputTokens: 1_000,
                },
                last: turnUsage,
                modelContextWindow: 200_000,
            },
        };
        let projection = apply(createCodexV4Projection(), {
            ...turn,
            updatedAt: 15,
            usage: {
                ...turnUsage,
                totalTokens: 900,
                inputTokens: 700,
                outputTokens: 200,
            },
        });
        expect(projection.usage).toEqual({
            inputTokens: 700,
            outputTokens: 200,
            cacheCreation: 30,
            cacheRead: 250,
            contextSize: 900,
            contextWindow: null,
        });

        projection = apply(projection, thread);
        expect(projection.usage).toEqual({
            inputTokens: 900,
            outputTokens: 300,
            cacheCreation: 30,
            cacheRead: 250,
            contextSize: 1_200,
            contextWindow: 200_000,
        });

        projection = apply(projection, {
            ...turn,
            updatedAt: 30,
            usage: {
                ...turnUsage,
                totalTokens: 2_000,
                inputTokens: 1_500,
                outputTokens: 500,
            },
        }, 2);
        expect(projection.usage?.contextSize).toBe(1_200);

        projection = applyCodexV4ProjectionUpdate(projection, {
            entity: { ...thread, updatedAt: 31 },
            revision: 2,
            op: 'delete',
        });
        expect(projection.usage).toMatchObject({
            inputTokens: 1_500,
            outputTokens: 500,
            contextSize: 2_000,
            contextWindow: null,
        });
    });

    it('activates only on ready runtime and keeps active execution while disconnected', () => {
        const runtime: CodexRuntimeEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.runtime' as const,
            providerId: 'runtime-1',
            createdAt: 10,
            updatedAt: 10,
            threadId: 'thread-1',
            connection: 'disconnected' as const,
            execution: { type: 'active' as const, activeFlags: [] },
            statusUnknown: true,
            protocolVersion: 'v2',
            codexCliVersion: '0.145.0',
            syncState: 'importing' as const,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            activeSubagentCount: 1,
            lastError: null,
            lastKnownAt: 10,
        };
        let projection = apply(createCodexV4Projection(), runtime);
        expect(projection.activated).toBe(false);

        projection = apply(projection, { ...runtime, syncState: 'ready', updatedAt: 11 }, 2);
        expect(projection.activated).toBe(true);
        expect(projection.runtime).toMatchObject({
            connection: 'disconnected',
            execution: { type: 'active' },
            statusUnknown: true,
        });
    });

    it('projects official reasoning summary as a visible dedicated tool', () => {
        let projection = apply(createCodexV4Projection(), turn);
        projection = apply(projection, { ...item, itemType: 'reasoning' });
        projection = apply(projection, part('Checked the transport.', 'reasoningSummary'));
        expect(projection.messages[0]).toMatchObject({
            kind: 'tool-call',
            tool: {
                name: 'CodexReasoningSummary',
                result: { content: 'Checked the transport.' },
            },
        });
    });

    it('projects every request for one item as an independent stable control', () => {
        const approvalItem = {
            ...item,
            itemType: 'commandExecution',
            command: 'git status',
        };
        const request = (providerId: string, requestType: CodexRequestEntityV4['requestType']): CodexRequestEntityV4 => ({
            schemaVersion: 1,
            entityType: 'codex.request',
            providerId,
            createdAt: providerId === 'request-1' ? 13 : 14,
            updatedAt: providerId === 'request-1' ? 13 : 14,
            requestId: providerId,
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            requestType,
            status: 'pending',
            title: null,
            prompt: `Approve ${providerId}`,
            options: {},
            response: null,
            resolvedAt: null,
        });
        const firstRequest = request('request-1', 'commandApproval');
        const secondRequest = request('request-2', 'permissions');
        let projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), [
            { entity: turn, revision: 1, op: 'upsert' },
            { entity: approvalItem, revision: 1, op: 'upsert' },
            { entity: part('output', 'commandOutput'), revision: 1, op: 'upsert' },
            { entity: firstRequest, revision: 1, op: 'upsert' },
            { entity: secondRequest, revision: 1, op: 'upsert' },
        ]);
        const secondBefore = projection.messages.find((message) => message.id === 'codex-v4:request:request-2');

        expect(projection.messages.filter((message) => (
            message.kind === 'tool-call' && message.tool.permission?.status === 'pending'
        )).map((message) => message.kind === 'tool-call' ? message.tool.permission?.id : null))
            .toEqual(['request-2', 'request-1']);

        projection = apply(projection, {
            ...firstRequest,
            status: 'accepted',
            response: { decision: 'accept' },
            resolvedAt: 15,
            updatedAt: 15,
        }, 2);

        expect(projection.messages.find((message) => message.id === 'codex-v4:request:request-1'))
            .toMatchObject({ tool: { permission: { status: 'approved' } } });
        expect(projection.messages.find((message) => message.id === 'codex-v4:request:request-2'))
            .toBe(secondBefore);
    });

    it('links a delegation item to its isolated child Happy session', () => {
        const relation: CodexRelationEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.relation',
            providerId: 'relation-1',
            createdAt: 12,
            updatedAt: 12,
            parentThreadId: 'thread-1',
            childThreadId: 'thread-child',
            parentTurnId: 'turn-1',
            delegationItemId: 'item-1',
            parentSessionId: 'happy-parent',
            childSessionId: 'happy-child',
            depth: 1,
            status: 'active',
        };
        let projection = apply(createCodexV4Projection(), turn);
        projection = apply(projection, {
            ...item,
            itemType: 'collabAgentToolCall',
            tool: 'spawnAgent',
        });
        projection = apply(projection, part('Investigate transport'));
        projection = apply(projection, relation);

        expect(projection.messages[0]).toMatchObject({
            kind: 'tool-call',
            tool: {
                name: 'Task',
                input: {
                    childSessionId: 'happy-child',
                    childStatus: 'active',
                },
            },
        });
    });

    it('projects a command optimistically and removes it when the provider user item arrives', () => {
        const command: CodexCommandEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.command',
            providerId: 'command-1',
            createdAt: 10,
            updatedAt: 10,
            commandId: 'command-1',
            threadId: 'thread-1',
            expectedTurnId: null,
            command: 'turn.start',
            payload: { text: 'hello', displayText: 'hello' },
            clientUserMessageId: 'command-1',
            replacesCommandId: null,
        };
        let projection = apply(createCodexV4Projection(), command);
        expect(projection.messages).toMatchObject([{
            kind: 'user-text',
            localId: 'command-1',
            text: 'hello',
        }]);

        projection = apply(projection, {
            ...item,
            itemType: 'userMessage',
            clientId: 'command-1',
        });
        projection = apply(projection, part('hello'));
        expect(projection.messages).toHaveLength(1);
        expect(projection.messages[0]).toMatchObject({
            kind: 'user-text',
            localId: 'command-1',
            text: 'hello',
            codexItemId: 'item-1',
        });
    });

    it('restores a replaced optimistic command when the replacement is deleted', () => {
        const original: CodexCommandEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.command',
            providerId: 'command-original',
            createdAt: 10,
            updatedAt: 10,
            commandId: 'command-original',
            threadId: 'thread-1',
            expectedTurnId: null,
            command: 'turn.start',
            payload: { text: 'first', displayText: 'first' },
            clientUserMessageId: 'client-original',
            replacesCommandId: null,
        };
        const replacement: CodexCommandEntityV4 = {
            ...original,
            providerId: 'command-replacement',
            createdAt: 11,
            updatedAt: 11,
            commandId: 'command-replacement',
            payload: { text: 'second', displayText: 'second' },
            clientUserMessageId: 'client-replacement',
            replacesCommandId: original.commandId,
        };
        let projection = apply(createCodexV4Projection(), original);
        projection = apply(projection, replacement);

        expect(projection.messages).toMatchObject([{
            id: 'codex-v4:command:command-replacement',
            text: 'second',
        }]);

        projection = applyCodexV4ProjectionUpdate(projection, {
            entity: { ...replacement, updatedAt: 12 },
            revision: 2,
            op: 'delete',
        });

        expect(projection.messages).toMatchObject([{
            id: 'codex-v4:command:command-original',
            text: 'first',
        }]);
    });

    it('projects control progress and failed prompt results as stable tool messages', () => {
        const control: CodexCommandEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.command',
            providerId: 'command-compact',
            createdAt: 10,
            updatedAt: 10,
            commandId: 'command-compact',
            threadId: 'thread-1',
            expectedTurnId: null,
            command: 'thread.compact',
            payload: { displayText: '/compact' },
            clientUserMessageId: 'command-compact',
            replacesCommandId: null,
        };
        const result: CodexCommandResultEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.commandResult',
            providerId: 'command-compact',
            createdAt: 11,
            updatedAt: 11,
            commandId: 'command-compact',
            threadId: 'thread-1',
            turnId: null,
            status: 'executing',
            providerRequestId: null,
            result: null,
            error: null,
        };
        let projection = apply(createCodexV4Projection(), control);
        projection = apply(projection, result);
        expect(projection.messages.find((message) => message.kind === 'tool-call')).toMatchObject({
            id: 'codex-v4:command-result:command-compact',
            tool: { state: 'running', input: { command: 'thread.compact' } },
        });

        projection = apply(projection, { ...result, status: 'failed', error: 'compact failed', updatedAt: 12 }, 2);
        expect(projection.messages.find((message) => message.kind === 'tool-call')).toMatchObject({
            id: 'codex-v4:command-result:command-compact',
            tool: { state: 'error', result: 'compact failed' },
        });
    });
});
