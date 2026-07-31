import type {
    CodexItemEntityV4,
    CodexPartEntityV4,
    CodexRequestEntityV4,
    CodexRuntimeEntityV4,
    CodexTurnEntityV4,
} from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';
import { resolveCodexV4Activity, shouldCollapseCurrentCodexV4Turn } from './codexV4Activity';
import { applyCodexV4ProjectionUpdates, createCodexV4Projection } from './codexV4Projection';

const runtime: CodexRuntimeEntityV4 = {
    schemaVersion: 1,
    entityType: 'codex.runtime',
    providerId: 'runtime-1',
    createdAt: 1,
    updatedAt: 10,
    threadId: 'thread-1',
    connection: 'connected',
    execution: { type: 'active', activeFlags: [] },
    statusUnknown: false,
    protocolVersion: 'v2',
    codexCliVersion: '0.145.0',
    syncState: 'ready',
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    activeSubagentCount: 0,
    lastError: null,
    lastKnownAt: 10,
};

const turn: CodexTurnEntityV4 = {
    schemaVersion: 1,
    entityType: 'codex.turn',
    providerId: 'turn-1',
    createdAt: 2,
    updatedAt: 10,
    threadId: 'thread-1',
    turnId: 'turn-1',
    status: 'inProgress',
    startedAt: 2,
    completedAt: null,
    durationMs: null,
    error: null,
    usage: null,
    planRevision: 0,
    diffRevision: 0,
};

const mcpItem: CodexItemEntityV4 = {
    schemaVersion: 1,
    entityType: 'codex.item',
    providerId: 'mcp-1',
    createdAt: 3,
    updatedAt: 3,
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'mcp-1',
    itemType: 'mcpToolCall',
    eventSequence: 1,
    status: 'inProgress',
    parentItemId: null,
    clientId: null,
    phase: null,
    startedAt: 3,
    completedAt: null,
    command: null,
    cwd: null,
    processId: null,
    exitCode: null,
    durationMs: null,
    server: 'test',
    tool: 'lookup',
    arguments: {},
};

const agentItem: CodexItemEntityV4 = {
    ...mcpItem,
    providerId: 'agent-1',
    itemId: 'agent-1',
    itemType: 'agentMessage',
    eventSequence: 2,
    server: null,
    tool: null,
    arguments: null,
};

const agentPart: CodexPartEntityV4 = {
    schemaVersion: 1,
    entityType: 'codex.part',
    providerId: 'part-1',
    createdAt: 4,
    updatedAt: 4,
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'agent-1',
    partId: 'part-1',
    kind: 'text',
    index: 0,
    chunkIndex: 0,
    content: 'reply',
    contentType: 'text',
    final: false,
};

function projection(...entities: Array<CodexRuntimeEntityV4 | CodexTurnEntityV4 | CodexItemEntityV4 | CodexPartEntityV4 | CodexRequestEntityV4>) {
    return applyCodexV4ProjectionUpdates(
        createCodexV4Projection('thread-1'),
        entities.map((entity) => ({ entity, revision: 1, op: 'upsert' as const })),
    );
}

describe('Codex v4 chat activity', () => {
    it('shows thinking while an official turn is active, including during transport disconnect', () => {
        expect(resolveCodexV4Activity(projection(runtime, turn))).not.toBeNull();
        expect(resolveCodexV4Activity(projection({
            ...runtime,
            connection: 'disconnected',
            statusUnknown: true,
        }, turn))).not.toBeNull();
    });

    it('switches immediately to visible MCP and reply phases', () => {
        expect(resolveCodexV4Activity(projection(runtime, turn, mcpItem))).toBeNull();
        expect(resolveCodexV4Activity(projection(runtime, turn, agentItem, agentPart))).toBeNull();
    });

    it('returns to thinking after a tool completes while the turn remains active', () => {
        expect(resolveCodexV4Activity(projection(runtime, turn, {
            ...mcpItem,
            status: 'completed',
            completedAt: 5,
        }))).not.toBeNull();
    });

    it('keeps the tool phase while any parallel tool is still running', () => {
        expect(resolveCodexV4Activity(projection(
            runtime,
            turn,
            mcpItem,
            {
                ...mcpItem,
                providerId: 'mcp-newer-completed',
                itemId: 'mcp-newer-completed',
                eventSequence: 2,
                status: 'completed',
                completedAt: 5,
            },
        ))).toBeNull();
    });

    it('hides for approvals, errors, and completed turns without debounce', () => {
        const request: CodexRequestEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.request',
            providerId: 'request-1',
            createdAt: 5,
            updatedAt: 5,
            requestId: 'request-1',
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: null,
            requestType: 'permissions',
            status: 'pending',
            title: null,
            prompt: null,
            options: null,
            response: null,
            resolvedAt: null,
        };
        expect(resolveCodexV4Activity(projection(runtime, turn, request))).toBeNull();
        expect(resolveCodexV4Activity(projection({
            ...runtime,
            execution: { type: 'systemError' },
        }, turn))).toBeNull();
        expect(resolveCodexV4Activity(projection({
            ...runtime,
            execution: { type: 'idle' },
        }, { ...turn, status: 'completed', completedAt: 6 }))).toBeNull();

        expect(shouldCollapseCurrentCodexV4Turn(projection(runtime, turn, request))).toBe(false);
        expect(shouldCollapseCurrentCodexV4Turn(projection({
            ...runtime,
            connection: 'disconnected',
            statusUnknown: true,
        }, turn))).toBe(false);
        expect(shouldCollapseCurrentCodexV4Turn(projection({
            ...runtime,
            execution: { type: 'idle' },
        }, { ...turn, status: 'completed', completedAt: 6 }))).toBe(true);
    });
});
