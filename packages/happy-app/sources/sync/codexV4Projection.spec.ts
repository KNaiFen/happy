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
    codexV4QueuedMessages,
    createCodexV4Projection,
    resetCodexV4Projection,
    selectCodexV4ProjectionThread,
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

    it('keeps historical MCP startup entities cached but out of chat', () => {
        const startupItem: CodexItemEntityV4 = {
            ...item,
            providerId: 'startup-item',
            itemId: 'startup-item',
            itemType: 'mcpStartup',
            server: 'example',
            tool: 'startup',
        };
        const startupPart: CodexPartEntityV4 = {
            ...part('{"status":"ready"}', 'mcpProgress'),
            providerId: 'startup-part',
            partId: 'startup-part',
            itemId: 'startup-item',
        };

        const projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), [
            { entity: startupItem, revision: 1, op: 'upsert' },
            { entity: startupPart, revision: 1, op: 'upsert' },
        ]);

        expect(projection.entities['codex.item']['startup-item']).toBeDefined();
        expect(projection.entities['codex.part']['startup-part']).toBeDefined();
        expect(projection.messages).toEqual([]);
    });

    it('updates one MCP tool message through progress and completion', () => {
        const mcpItem: CodexItemEntityV4 = {
            ...item,
            providerId: 'mcp-item',
            itemId: 'mcp-item',
            itemType: 'mcpToolCall',
            eventSequence: 1,
            server: 'happy',
            tool: 'change_title',
        };
        const mcpPart: CodexPartEntityV4 = {
            ...part('{"result":"starting"}', 'mcpProgress'),
            providerId: 'mcp-part',
            partId: 'mcp-part',
            itemId: 'mcp-item',
        };
        let projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), [
            { entity: turn, revision: 1, op: 'upsert' },
            { entity: mcpItem, revision: 1, op: 'upsert' },
            { entity: mcpPart, revision: 1, op: 'upsert' },
        ]);

        expect(projection.messages).toHaveLength(1);
        expect(projection.messages[0]).toMatchObject({
            id: 'codex-v4:item:mcp-item',
            tool: { name: 'mcp__happy__change_title', state: 'running' },
        });

        projection = apply(projection, {
            ...mcpPart,
            content: '{"result":"done"}',
            final: true,
            updatedAt: 13,
        }, 2);
        projection = apply(projection, {
            ...mcpItem,
            status: 'completed',
            completedAt: 14,
            updatedAt: 14,
        }, 2);

        expect(projection.messages).toHaveLength(1);
        expect(projection.messages[0]).toMatchObject({
            id: 'codex-v4:item:mcp-item',
            tool: { state: 'completed', result: { result: 'done' } },
        });
    });

    it('projects compact and review lifecycle as stable timeline dividers', () => {
        const compactCommand: CodexCommandEntityV4 = {
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
        const compactResult: CodexCommandResultEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.commandResult',
            providerId: 'result-compact',
            createdAt: 11,
            updatedAt: 11,
            commandId: 'command-compact',
            threadId: 'thread-1',
            turnId: 'turn-1',
            status: 'succeeded',
            providerRequestId: null,
            result: null,
            error: null,
        };
        const compactItem: CodexItemEntityV4 = {
            ...item,
            providerId: 'compact-item',
            itemId: 'compact-item',
            itemType: 'contextCompaction',
            eventSequence: 1,
            status: 'completed',
            completedAt: 13,
        };
        const reviewStarted: CodexItemEntityV4 = {
            ...item,
            providerId: 'review-started',
            itemId: 'review-started',
            itemType: 'enteredReviewMode',
            eventSequence: 2,
            status: 'completed',
            completedAt: 14,
        };
        const reviewFinished: CodexItemEntityV4 = {
            ...item,
            providerId: 'review-finished',
            itemId: 'review-finished',
            itemType: 'exitedReviewMode',
            eventSequence: 3,
            status: 'completed',
            completedAt: 15,
        };
        const projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), [
            { entity: reviewFinished, revision: 1, op: 'upsert' },
            { entity: compactResult, revision: 1, op: 'upsert' },
            { entity: compactCommand, revision: 1, op: 'upsert' },
            { entity: compactItem, revision: 2, op: 'upsert' },
            { entity: reviewStarted, revision: 1, op: 'upsert' },
        ]);

        expect(projection.messages.map((message) => ({ id: message.id, kind: message.kind }))).toEqual([
            { id: 'codex-v4:item:review-finished', kind: 'timeline-event' },
            { id: 'codex-v4:item:review-started', kind: 'timeline-event' },
            { id: 'codex-v4:item:compact-item', kind: 'timeline-event' },
            { id: 'codex-v4:command:command-compact', kind: 'user-text' },
        ]);
        expect(projection.messages.filter((message) => message.kind === 'tool-call')).toEqual([]);
        expect(projection.messages[2]).toMatchObject({ event: 'context-compaction' });
    });

    it('prefers canonical plan and file-change items over turn-level synthetic copies', () => {
        const entity = (
            providerId: string,
            itemId: string,
            itemType: string,
            eventSequence: number,
        ): CodexItemEntityV4 => ({
            ...item,
            providerId,
            itemId,
            itemType,
            eventSequence,
        });
        const entityPart = (
            providerId: string,
            itemId: string,
            kind: CodexPartEntityV4['kind'],
            content: string,
        ): CodexPartEntityV4 => ({
            ...part(content, kind),
            providerId,
            partId: providerId,
            itemId,
        });
        const updates = [
            entity('synthetic-plan', '__turn_plan__', 'plan', 1),
            entityPart('synthetic-plan-part', '__turn_plan__', 'plan', 'synthetic plan'),
            entity('canonical-plan', 'plan-1', 'plan', 2),
            entityPart('canonical-plan-part', 'plan-1', 'plan', 'canonical plan'),
            entity('synthetic-diff', '__turn_diff__', 'turnDiff', 3),
            entityPart('synthetic-diff-part', '__turn_diff__', 'patch', 'synthetic diff'),
            entity('canonical-change', 'change-1', 'fileChange', 4),
            entityPart('canonical-change-part', 'change-1', 'patch', '{"file":"change"}'),
        ];
        const projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), updates.map((entry) => ({
            entity: entry,
            revision: 1,
            op: 'upsert' as const,
        })));

        expect(projection.messages.map((message) => message.id)).toEqual([
            'codex-v4:item:canonical-change',
            'codex-v4:item:canonical-plan',
        ]);
    });

    it('orders provider events by their stable turn sequence instead of skewed timestamps', () => {
        const userItem: CodexItemEntityV4 = {
            ...item,
            providerId: 'user-item',
            itemId: 'user-item',
            itemType: 'userMessage',
            clientId: 'command-1',
            eventSequence: 0,
            createdAt: 100,
            updatedAt: 100,
            startedAt: 100,
        };
        const userPart: CodexPartEntityV4 = {
            ...part('hello'),
            providerId: 'user-part',
            partId: 'user-part',
            itemId: 'user-item',
            createdAt: 100,
            updatedAt: 100,
        };
        const mcpItem: CodexItemEntityV4 = {
            ...item,
            providerId: 'mcp-item',
            itemId: 'mcp-item',
            itemType: 'mcpToolCall',
            eventSequence: 1,
            createdAt: 90,
            updatedAt: 90,
            startedAt: 90,
            server: 'test',
            tool: 'lookup',
        };

        const projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), [
            { entity: turn, revision: 1, op: 'upsert' },
            { entity: userItem, revision: 1, op: 'upsert' },
            { entity: userPart, revision: 1, op: 'upsert' },
            { entity: mcpItem, revision: 1, op: 'upsert' },
        ]);

        expect(projection.messages.map((message) => message.id)).toEqual([
            'codex-v4:item:mcp-item',
            'codex-v4:item:user-item',
        ]);
    });

    it('keeps a fast provider tool after the local prompt before the user item arrives', () => {
        const command: CodexCommandEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.command',
            providerId: 'command-fast',
            createdAt: 300,
            updatedAt: 300,
            commandId: 'command-fast',
            threadId: 'thread-1',
            expectedTurnId: null,
            command: 'turn.start',
            payload: { displayText: 'hello', text: 'hello' },
            clientUserMessageId: 'command-fast',
            replacesCommandId: null,
        };
        const result: CodexCommandResultEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.commandResult',
            providerId: 'command-result-fast',
            createdAt: 301,
            updatedAt: 301,
            commandId: 'command-fast',
            threadId: 'thread-1',
            turnId: 'turn-1',
            status: 'succeeded',
            providerRequestId: null,
            result: null,
            error: null,
        };
        const fastTool: CodexItemEntityV4 = {
            ...item,
            providerId: 'fast-tool',
            itemId: 'fast-tool',
            itemType: 'mcpToolCall',
            eventSequence: 1,
            createdAt: 100,
            updatedAt: 100,
            startedAt: 100,
            server: 'test',
            tool: 'lookup',
        };

        const projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), [
            { entity: command, revision: 1, op: 'upsert' },
            { entity: fastTool, revision: 1, op: 'upsert' },
            { entity: result, revision: 1, op: 'upsert' },
        ]);

        expect(projection.messages.map((message) => message.id)).toEqual([
            'codex-v4:item:fast-tool',
            'codex-v4:command:command-fast',
        ]);
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

    it('uses one semantic slot for a tool and all of its linked approvals', () => {
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
        expect(projection.messages).toHaveLength(1);
        expect(projection.messages[0]).toMatchObject({
            id: 'codex-v4:item:item-1',
            kind: 'tool-call',
            tool: {
                name: 'CodexApproval',
                permission: { id: 'request-1', status: 'pending' },
                input: { pendingRequestCount: 2 },
            },
        });

        projection = apply(projection, {
            ...firstRequest,
            status: 'accepted',
            response: { decision: 'accept' },
            resolvedAt: 15,
            updatedAt: 15,
        }, 2);

        expect(projection.messages).toHaveLength(1);
        expect(projection.messages[0]).toMatchObject({
            id: 'codex-v4:item:item-1',
            tool: {
                name: 'CodexApproval',
                permission: { id: 'request-2', status: 'pending' },
                input: { pendingRequestCount: 1 },
            },
        });

        projection = apply(projection, {
            ...secondRequest,
            status: 'resolved',
            response: { scope: 'turn' },
            resolvedAt: 16,
            updatedAt: 16,
        }, 2);

        expect(projection.messages).toHaveLength(1);
        expect(projection.messages[0]).toMatchObject({
            id: 'codex-v4:item:item-1',
            tool: { name: 'CodexBash' },
        });
    });

    it('rebinds an approval that arrives before its MCP item into one item slot', () => {
        const request: CodexRequestEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.request',
            providerId: 'request-before-item',
            createdAt: 10,
            updatedAt: 10,
            requestId: 'request-before-item',
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            requestType: 'permissions',
            status: 'pending',
            title: null,
            prompt: 'Allow MCP call?',
            options: {},
            response: null,
            resolvedAt: null,
        };
        let projection = apply(createCodexV4Projection(), request);
        expect(projection.messages).toMatchObject([{
            id: 'codex-v4:request:request-before-item',
            tool: { name: 'CodexApproval' },
        }]);

        projection = apply(projection, {
            ...item,
            itemType: 'mcpToolCall',
            server: 'happy',
            tool: 'change_title',
        });

        expect(projection.messages).toHaveLength(1);
        expect(projection.messages[0]).toMatchObject({
            id: 'codex-v4:item:item-1',
            tool: {
                name: 'CodexApproval',
                permission: { id: 'request-before-item', status: 'pending' },
            },
        });
    });

    it('replaces a failed compaction divider with a visible compact error', () => {
        const failedCompaction: CodexItemEntityV4 = {
            ...item,
            itemType: 'contextCompaction',
            status: 'failed',
            completedAt: 13,
        };
        const projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), [
            { entity: turn, revision: 1, op: 'upsert' },
            { entity: failedCompaction, revision: 1, op: 'upsert' },
            { entity: part('Compaction failed', 'error'), revision: 1, op: 'upsert' },
        ]);

        expect(projection.messages).toMatchObject([{
            id: 'codex-v4:item:item-1',
            kind: 'tool-call',
            tool: {
                name: 'CodexActivity',
                state: 'error',
                result: 'Compaction failed',
            },
        }]);
    });

    it('keeps a rejected linked approval as one compact outcome', () => {
        const approvalItem: CodexItemEntityV4 = {
            ...item,
            itemType: 'mcpToolCall',
            server: 'happy',
            tool: 'change_title',
        };
        const request: CodexRequestEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.request',
            providerId: 'request-denied',
            createdAt: 12,
            updatedAt: 13,
            requestId: 'request-denied',
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            requestType: 'permissions',
            status: 'declined',
            title: null,
            prompt: 'Allow title change?',
            options: {},
            response: { decision: 'decline' },
            resolvedAt: 13,
        };
        const projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), [
            { entity: turn, revision: 1, op: 'upsert' },
            { entity: approvalItem, revision: 1, op: 'upsert' },
            { entity: request, revision: 1, op: 'upsert' },
        ]);

        expect(projection.messages).toHaveLength(1);
        expect(projection.messages[0]).toMatchObject({
            id: 'codex-v4:item:item-1',
            tool: {
                name: 'CodexApproval',
                state: 'completed',
                permission: { id: 'request-denied', status: 'denied' },
            },
        });
    });

    it('keeps standalone tool user input independent and actionable', () => {
        const request: CodexRequestEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.request',
            providerId: 'elicitation-1',
            createdAt: 12,
            updatedAt: 12,
            requestId: 'elicitation-1',
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: null,
            requestType: 'toolUserInput',
            status: 'pending',
            title: 'MCP input',
            prompt: 'Choose a value',
            options: { requestMethod: 'mcpServer/elicitation/request' },
            response: null,
            resolvedAt: null,
        };
        const projection = apply(createCodexV4Projection(), request);

        expect(projection.messages).toMatchObject([{
            id: 'codex-v4:request:elicitation-1',
            tool: {
                name: 'AskUserQuestion',
                permission: { id: 'elicitation-1', status: 'pending' },
                requestInteraction: { state: 'awaitingInput' },
            },
        }]);
    });

    it('reprojects request resolution attempts into the source card without control cards', () => {
        const request: CodexRequestEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.request',
            providerId: 'elicitation-durable',
            createdAt: 12,
            updatedAt: 12,
            requestId: 'request-durable',
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: null,
            requestType: 'toolUserInput',
            status: 'pending',
            title: 'MCP input',
            prompt: 'Choose a value',
            options: { requestMethod: 'mcpServer/elicitation/request' },
            response: null,
            resolvedAt: null,
        };
        const response = { action: 'accept', content: { choice: 'resume' } };
        const firstCommand: CodexCommandEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.command',
            providerId: 'resolve-first',
            createdAt: 20,
            updatedAt: 20,
            commandId: 'resolve-first',
            threadId: 'thread-1',
            expectedTurnId: 'turn-1',
            command: 'request.resolve',
            payload: {
                requestId: 'request-durable',
                response,
                displayText: 'must stay on the request card',
            },
            clientUserMessageId: 'resolve-first',
            replacesCommandId: null,
            bindingGeneration: 1,
        };
        const firstFailure: CodexCommandResultEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.commandResult',
            providerId: 'resolve-first-result',
            createdAt: 21,
            updatedAt: 21,
            commandId: 'resolve-first',
            threadId: 'thread-1',
            turnId: 'turn-1',
            status: 'cancelled',
            providerRequestId: null,
            result: null,
            error: 'binding superseded',
            reason: 'bindingSuperseded',
        };
        let projection = apply(createCodexV4Projection(), request);
        expect(projection.messages[0]).toMatchObject({
            tool: { requestInteraction: { state: 'awaitingInput' } },
        });

        projection = apply(projection, firstCommand);
        expect(projection.messages).toHaveLength(1);
        expect(projection.messages[0]).toMatchObject({
            tool: {
                requestInteraction: {
                    state: 'submitting',
                    commandId: 'resolve-first',
                    response,
                },
            },
        });

        projection = apply(projection, firstFailure);
        expect(projection.messages).toHaveLength(1);
        expect(projection.messages[0]).toMatchObject({
            id: 'codex-v4:request:elicitation-durable',
            tool: {
                name: 'AskUserQuestion',
                requestInteraction: {
                    state: 'retryableError',
                    error: 'binding superseded',
                },
            },
        });

        projection = applyCodexV4ProjectionUpdate(projection, {
            entity: { ...firstFailure, updatedAt: 22 },
            revision: 2,
            op: 'delete',
        });
        expect(projection.messages[0]).toMatchObject({
            tool: { requestInteraction: { state: 'submitting', commandId: 'resolve-first' } },
        });
        projection = apply(projection, { ...firstFailure, updatedAt: 23 }, 3);
        expect(projection.messages[0]).toMatchObject({
            tool: { requestInteraction: { state: 'retryableError' } },
        });

        const retryCommand: CodexCommandEntityV4 = {
            ...firstCommand,
            providerId: 'resolve-retry',
            createdAt: 30,
            updatedAt: 30,
            commandId: 'resolve-retry',
            clientUserMessageId: 'resolve-retry',
            bindingGeneration: 2,
        };
        projection = apply(projection, retryCommand);
        expect(projection.messages[0]).toMatchObject({
            tool: { requestInteraction: { state: 'submitting', commandId: 'resolve-retry' } },
        });

        projection = apply(projection, {
            ...firstFailure,
            providerId: 'resolve-retry-result',
            createdAt: 31,
            updatedAt: 31,
            commandId: 'resolve-retry',
            status: 'succeeded',
            error: null,
            reason: null,
        });
        expect(projection.messages[0]).toMatchObject({
            tool: { requestInteraction: { state: 'awaitingConfirmation' } },
        });

        projection = apply(projection, {
            ...request,
            status: 'accepted',
            response,
            resolvedAt: 32,
            updatedAt: 32,
        }, 2);
        expect(projection.messages[0]).toMatchObject({
            tool: {
                state: 'completed',
                requestInteraction: { state: 'settled', response },
            },
        });
    });

    it('isolates reused request ids by thread in the projection indexes', () => {
        const requestForThread = (threadId: string): CodexRequestEntityV4 => ({
            schemaVersion: 1,
            entityType: 'codex.request',
            providerId: `request-${threadId}`,
            createdAt: threadId === 'thread-1' ? 10 : 11,
            updatedAt: threadId === 'thread-1' ? 10 : 11,
            requestId: 'request-reused',
            threadId,
            turnId: null,
            itemId: null,
            requestType: 'toolUserInput',
            status: 'pending',
            title: null,
            prompt: 'Choose',
            options: {},
            response: null,
            resolvedAt: null,
        });
        const secondThreadCommand: CodexCommandEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.command',
            providerId: 'resolve-thread-2',
            createdAt: 12,
            updatedAt: 12,
            commandId: 'resolve-thread-2',
            threadId: 'thread-2',
            expectedTurnId: null,
            command: 'request.resolve',
            payload: { requestId: 'request-reused', response: { answers: {} } },
            clientUserMessageId: 'resolve-thread-2',
            replacesCommandId: null,
        };
        const projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), [
            { entity: requestForThread('thread-1'), revision: 1, op: 'upsert' },
            { entity: requestForThread('thread-2'), revision: 1, op: 'upsert' },
            { entity: secondThreadCommand, revision: 1, op: 'upsert' },
        ]);
        const states = Object.fromEntries(projection.messages.map((message) => [
            message.id,
            message.kind === 'tool-call' ? message.tool.requestInteraction?.state : null,
        ]));

        expect(states).toEqual({
            'codex-v4:request:request-thread-1': 'awaitingInput',
            'codex-v4:request:request-thread-2': 'submitting',
        });
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

    it('keeps durable follow-ups in queue cards and preserves FIFO identity across edits', () => {
        const original = {
            schemaVersion: 1,
            entityType: 'codex.command',
            providerId: 'queue-command-original',
            createdAt: 10,
            updatedAt: 10,
            commandId: 'queue-command-original',
            threadId: 'thread-1',
            expectedTurnId: 'turn-active',
            command: 'turn.queue',
            payload: { text: 'first', displayText: 'first' },
            clientUserMessageId: 'queue-command-original',
            replacesCommandId: null,
            queueEntryId: 'queue-entry-1',
            queuedAt: 10,
        } as unknown as CodexCommandEntityV4;
        const replacement = {
            ...original,
            providerId: 'queue-command-edit',
            createdAt: 20,
            updatedAt: 20,
            commandId: 'queue-command-edit',
            payload: { text: 'edited', displayText: 'edited' },
            clientUserMessageId: 'queue-command-edit',
            replacesCommandId: original.commandId,
        } as unknown as CodexCommandEntityV4;
        const result = (
            commandId: string,
            status: string,
            overrides: Record<string, unknown> = {},
        ) => ({
            schemaVersion: 1,
            entityType: 'codex.commandResult',
            providerId: `result-${commandId}`,
            createdAt: 11,
            updatedAt: 11,
            commandId,
            threadId: 'thread-1',
            turnId: null,
            status,
            providerRequestId: null,
            result: null,
            error: null,
            ...overrides,
        }) as unknown as CodexCommandResultEntityV4;

        let projection = apply(createCodexV4Projection('thread-1'), original);
        projection = apply(projection, result(original.commandId, 'received'));
        expect(projection.messages).toEqual([]);
        expect(codexV4QueuedMessages(projection)).toMatchObject([{
            id: 'queue-entry-1',
            commandId: original.commandId,
            text: 'first',
            createdAt: 10,
        }]);

        projection = apply(projection, replacement);
        projection = apply(projection, result(original.commandId, 'cancelled', {
            reason: 'commandReplaced',
            updatedAt: 20,
        }), 2);
        projection = apply(projection, result(replacement.commandId, 'received'));
        expect(projection.messages).toEqual([]);
        expect(codexV4QueuedMessages(projection)).toMatchObject([{
            id: 'queue-entry-1',
            commandId: replacement.commandId,
            text: 'edited',
            createdAt: 10,
        }]);
    });

    it('keeps the original queue card when a late edit replacement is rejected', () => {
        const original = {
            schemaVersion: 1,
            entityType: 'codex.command',
            providerId: 'queue-original',
            createdAt: 10,
            updatedAt: 10,
            commandId: 'queue-original',
            threadId: 'thread-1',
            expectedTurnId: 'turn-active',
            command: 'turn.queue',
            payload: { text: 'original', displayText: 'original' },
            clientUserMessageId: 'queue-original',
            replacesCommandId: null,
            queueEntryId: 'queue-entry-1',
            queuedAt: 10,
        } as unknown as CodexCommandEntityV4;
        const rejected = {
            ...original,
            providerId: 'queue-rejected-edit',
            commandId: 'queue-rejected-edit',
            clientUserMessageId: 'queue-rejected-edit',
            replacesCommandId: original.commandId,
            payload: { text: 'too late', displayText: 'too late' },
            createdAt: 20,
            updatedAt: 20,
        } as unknown as CodexCommandEntityV4;
        const failedResult = {
            schemaVersion: 1,
            entityType: 'codex.commandResult',
            providerId: 'result-rejected-edit',
            createdAt: 20,
            updatedAt: 20,
            commandId: rejected.commandId,
            threadId: 'thread-1',
            turnId: null,
            status: 'failed',
            providerRequestId: null,
            result: null,
            error: 'The queued message is no longer available for replacement',
        } as CodexCommandResultEntityV4;
        let projection = apply(createCodexV4Projection('thread-1'), original);
        projection = apply(projection, rejected);
        projection = apply(projection, failedResult);

        expect(codexV4QueuedMessages(projection)).toMatchObject([{
            id: 'queue-entry-1',
            commandId: original.commandId,
            text: 'original',
        }]);
    });

    it('hides a cancelled queue entry without projecting a blank provider message', () => {
        const queued = {
            schemaVersion: 1,
            entityType: 'codex.command',
            providerId: 'queue-command',
            createdAt: 10,
            updatedAt: 10,
            commandId: 'queue-command',
            threadId: 'thread-1',
            expectedTurnId: 'turn-active',
            command: 'turn.queue',
            payload: { text: 'queued text', displayText: 'queued text' },
            clientUserMessageId: 'queue-command',
            replacesCommandId: null,
            queueEntryId: 'queue-entry-1',
            queuedAt: 10,
            bindingGeneration: 3,
        } as unknown as CodexCommandEntityV4;
        const cancellation = {
            ...queued,
            providerId: 'queue-cancel',
            createdAt: 20,
            updatedAt: 20,
            commandId: 'queue-cancel',
            command: 'turn.queue.cancel',
            payload: {},
            clientUserMessageId: 'queue-cancel',
            replacesCommandId: queued.commandId,
        } as unknown as CodexCommandEntityV4;
        const cancelled = {
            schemaVersion: 1,
            entityType: 'codex.commandResult',
            providerId: 'queue-command-result',
            createdAt: 20,
            updatedAt: 20,
            commandId: queued.commandId,
            threadId: 'thread-1',
            turnId: null,
            status: 'cancelled',
            providerRequestId: null,
            result: null,
            error: 'Queued message cancelled',
            reason: 'queueCancelled',
        } as unknown as CodexCommandResultEntityV4;
        const cancellationResult = {
            ...cancelled,
            providerId: 'queue-cancel-result',
            commandId: cancellation.commandId,
            status: 'succeeded',
            result: { cancelledCommandId: queued.commandId },
            error: null,
            reason: null,
        } as unknown as CodexCommandResultEntityV4;

        let projection = apply(createCodexV4Projection('thread-1'), queued);
        projection = apply(projection, cancellation);
        projection = apply(projection, cancelled);
        projection = apply(projection, cancellationResult);

        expect(codexV4QueuedMessages(projection)).toEqual([]);
        expect(projection.messages).toEqual([]);
    });

    it('hides control progress but keeps failures as compact stable messages', () => {
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
        expect(projection.messages).toMatchObject([{
            id: 'codex-v4:command:command-compact',
            kind: 'user-text',
            text: '/compact',
        }]);

        projection = apply(projection, { ...result, status: 'failed', error: 'compact failed', updatedAt: 12 }, 2);
        expect(projection.messages).toHaveLength(2);
        expect(projection.messages.find((message) => message.kind === 'tool-call')).toMatchObject({
            id: 'codex-v4:command-result:command-compact',
            tool: { name: 'CodexControlCommand', state: 'error', result: 'compact failed' },
        });
    });

    it('keeps query command results as one compact row', () => {
        const command: CodexCommandEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.command',
            providerId: 'command-skills',
            createdAt: 10,
            updatedAt: 10,
            commandId: 'command-skills',
            threadId: 'thread-1',
            expectedTurnId: null,
            command: 'skills.list',
            payload: { displayText: '/skills' },
            clientUserMessageId: 'command-skills',
            replacesCommandId: null,
        };
        const result: CodexCommandResultEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.commandResult',
            providerId: 'result-skills',
            createdAt: 11,
            updatedAt: 12,
            commandId: 'command-skills',
            threadId: 'thread-1',
            turnId: null,
            status: 'succeeded',
            providerRequestId: null,
            result: { skills: ['one'] },
            error: null,
        };
        const projection = applyCodexV4ProjectionUpdates(createCodexV4Projection(), [
            { entity: command, revision: 1, op: 'upsert' },
            { entity: result, revision: 1, op: 'upsert' },
        ]);

        expect(projection.messages).toHaveLength(2);
        expect(projection.messages.find((message) => message.kind === 'tool-call')).toMatchObject({
            id: 'codex-v4:command-result:result-skills',
            tool: { name: 'CodexControlCommand', state: 'completed' },
        });
    });

    it('keeps metadata-selected thread state isolated from newer late updates', () => {
        const usage = (totalTokens: number) => ({
            totalTokens,
            inputTokens: totalTokens - 10,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 10,
            reasoningOutputTokens: 0,
        });
        const threadEntity = (
            threadId: string,
            updatedAt: number,
            totalTokens: number,
        ): CodexThreadEntityV4 => ({
            schemaVersion: 1,
            entityType: 'codex.thread',
            providerId: `thread:${threadId}`,
            createdAt: 1,
            updatedAt,
            threadId,
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
                total: usage(totalTokens),
                last: usage(totalTokens),
                modelContextWindow: 200_000,
            },
        });
        const runtimeEntity = (
            threadId: string,
            updatedAt: number,
            execution: CodexRuntimeEntityV4['execution'],
        ): CodexRuntimeEntityV4 => ({
            schemaVersion: 1,
            entityType: 'codex.runtime',
            providerId: `runtime:${threadId}`,
            createdAt: 1,
            updatedAt,
            threadId,
            connection: 'connected',
            execution,
            statusUnknown: false,
            protocolVersion: 'v2',
            codexCliVersion: '0.145.0',
            syncState: 'ready',
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            activeSubagentCount: 0,
            lastError: null,
            lastKnownAt: updatedAt,
        });
        const turnEntity = (threadId: string, totalTokens: number): CodexTurnEntityV4 => ({
            ...turn,
            providerId: `turn:${threadId}`,
            threadId,
            turnId: `turn:${threadId}`,
            usage: usage(totalTokens),
        });
        const itemEntity = (threadId: string): CodexItemEntityV4 => ({
            ...item,
            providerId: `item:${threadId}`,
            threadId,
            turnId: `turn:${threadId}`,
            itemId: `item:${threadId}`,
        });
        const partEntity = (threadId: string, content: string): CodexPartEntityV4 => ({
            ...part(content),
            providerId: `part:${threadId}`,
            threadId,
            turnId: `turn:${threadId}`,
            itemId: `item:${threadId}`,
            partId: `part:${threadId}`,
        });
        const threadA = threadEntity('thread-a', 100, 111);
        const runtimeA = runtimeEntity(
            'thread-a',
            100,
            { type: 'active', activeFlags: [] },
        );
        const threadB = threadEntity('thread-b', 10, 222);
        const runtimeB = runtimeEntity('thread-b', 10, { type: 'idle' });
        let projection = applyCodexV4ProjectionUpdates(
            createCodexV4Projection('thread-b'),
            [
                { entity: threadA, revision: 1, op: 'upsert' },
                { entity: runtimeA, revision: 1, op: 'upsert' },
                { entity: turnEntity('thread-a', 111), revision: 1, op: 'upsert' },
                { entity: itemEntity('thread-a'), revision: 1, op: 'upsert' },
                { entity: partEntity('thread-a', 'Old thread'), revision: 1, op: 'upsert' },
                { entity: threadB, revision: 1, op: 'upsert' },
                { entity: runtimeB, revision: 1, op: 'upsert' },
                { entity: turnEntity('thread-b', 222), revision: 1, op: 'upsert' },
                { entity: itemEntity('thread-b'), revision: 1, op: 'upsert' },
                { entity: partEntity('thread-b', 'Selected thread'), revision: 1, op: 'upsert' },
            ],
        );

        expect(projection.thread?.threadId).toBe('thread-b');
        expect(projection.runtime?.threadId).toBe('thread-b');
        expect(projection.runtime?.execution).toEqual({ type: 'idle' });
        expect(projection.usage?.contextSize).toBe(222);
        expect(projection.messages).toMatchObject([{
            kind: 'agent-text',
            text: 'Selected thread',
        }]);
        const selectedMessages = projection.messages;
        const selectedThread = projection.thread;
        const selectedRuntime = projection.runtime;
        const selectedUsage = projection.usage;

        projection = applyCodexV4ProjectionUpdates(projection, [
            { entity: { ...threadA, updatedAt: 1_000 }, revision: 2, op: 'upsert' },
            { entity: { ...runtimeA, updatedAt: 1_000 }, revision: 2, op: 'upsert' },
            {
                entity: {
                    ...partEntity('thread-a', 'Late old-thread update'),
                    updatedAt: 1_000,
                },
                revision: 2,
                op: 'upsert',
            },
        ]);

        expect(projection.thread).toBe(selectedThread);
        expect(projection.runtime).toBe(selectedRuntime);
        expect(projection.usage).toBe(selectedUsage);
        expect(projection.messages).toBe(selectedMessages);

        projection = selectCodexV4ProjectionThread(projection, 'thread-a');
        expect(projection.thread?.threadId).toBe('thread-a');
        expect(projection.runtime?.execution).toEqual({ type: 'active', activeFlags: [] });
        expect(projection.usage?.contextSize).toBe(111);
        expect(projection.messages).toMatchObject([{
            kind: 'agent-text',
            text: 'Late old-thread update',
        }]);
    });
});
