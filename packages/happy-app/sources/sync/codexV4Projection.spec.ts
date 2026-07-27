import type {
    CodexEntityV4,
    CodexCommandEntityV4,
    CodexCommandResultEntityV4,
    CodexItemEntityV4,
    CodexPartEntityV4,
    CodexRelationEntityV4,
    CodexRuntimeEntityV4,
    CodexTurnEntityV4,
} from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';
import {
    applyCodexV4ProjectionUpdate,
    createCodexV4Projection,
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

    it('ignores duplicate and lower entity revisions', () => {
        let projection = apply(createCodexV4Projection(), part('new'), 3);
        const unchanged = apply(projection, { ...part('old'), updatedAt: 9 }, 2);
        expect(unchanged).toBe(projection);
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
