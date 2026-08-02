import type {
    CodexCommandResultEntityV4,
    CodexEntityV4,
    CodexItemEntityV4,
} from '@slopus/happy-wire';
import { describe, expect, it, vi } from 'vitest';
import {
    CodexCommandDraftRecovery,
    mergeRecoveredCodexDraft,
} from './codexCommandDraftRecovery';
import {
    applyCodexV4ProjectionUpdate,
    createCodexV4Projection,
    type CodexV4Projection,
} from './codexV4Projection';
import type { CodexCommandDraftReceipt } from './persistence';
import type { Session } from './storageTypes';

function gatewaySession(options: {
    id: string;
    generation: number;
    role: 'current' | 'draining' | 'inactive';
    previousSessionId?: string;
    nextSessionId?: string;
    draft?: string | null;
}): Session {
    return {
        id: options.id,
        draft: options.draft ?? null,
        metadata: {
            flavor: 'codex',
            codexSyncVersion: 4,
            machineId: 'machine-1',
            codexGatewayBinding: {
                gatewayId: 'gateway-1',
                generation: options.generation,
                origin: 'terminal',
                role: options.role,
                terminal: 'attached',
                changedAt: 10,
                ...(options.previousSessionId ? { previousSessionId: options.previousSessionId } : {}),
                ...(options.nextSessionId ? { nextSessionId: options.nextSessionId } : {}),
            },
        },
    } as unknown as Session;
}

function apply(projection: CodexV4Projection, entity: CodexEntityV4): CodexV4Projection {
    return applyCodexV4ProjectionUpdate(projection, { entity, revision: 1, op: 'upsert' });
}

function commandResult(
    status: CodexCommandResultEntityV4['status'] | 'cancelled',
    reason?: 'bindingSuperseded' | 'threadHandoff' | 'gatewayStopping',
): CodexCommandResultEntityV4 {
    return {
        schemaVersion: 1,
        entityType: 'codex.commandResult',
        providerId: 'result-1',
        createdAt: 20,
        updatedAt: 20,
        commandId: 'command-1',
        threadId: 'thread-1',
        turnId: null,
        status,
        providerRequestId: null,
        result: null,
        error: null,
        ...(reason ? { reason } : {}),
    } as unknown as CodexCommandResultEntityV4;
}

function providerUserMessage(): CodexItemEntityV4 {
    return {
        schemaVersion: 1,
        entityType: 'codex.item',
        providerId: 'user-item-1',
        createdAt: 21,
        updatedAt: 21,
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'user-item-1',
        itemType: 'userMessage',
        status: 'completed',
        parentItemId: null,
        clientId: 'command-1',
        phase: null,
        startedAt: 21,
        completedAt: 21,
        command: null,
        cwd: null,
        processId: null,
        exitCode: null,
        durationMs: null,
        server: null,
        tool: null,
        arguments: null,
    };
}

function fixture(initialReceipts: CodexCommandDraftReceipt[] = []) {
    let persisted: CodexCommandDraftReceipt[] = [...initialReceipts];
    const sessions: Record<string, Session> = {
        source: gatewaySession({ id: 'source', generation: 3, role: 'current' }),
    };
    const projections: Record<string, CodexV4Projection> = {};
    const updateSessionDraft = vi.fn((sessionId: string, draft: string) => {
        sessions[sessionId] = { ...sessions[sessionId], draft };
    });
    const recovery = new CodexCommandDraftRecovery({
        loadReceipts: () => persisted,
        saveReceipts: (receipts) => {
            persisted = [...receipts];
        },
        getSessions: () => sessions,
        getProjection: (sessionId) => projections[sessionId],
        updateSessionDraft,
        now: () => 1_000,
    });
    return {
        recovery,
        sessions,
        projections,
        updateSessionDraft,
        persisted: () => persisted,
    };
}

describe('Codex command draft recovery', () => {
    it('waits for an exact next-generation target before restoring a safe cancellation', () => {
        const state = fixture();
        expect(state.recovery.record({
            commandId: 'command-1',
            sourceSessionId: 'source',
            text: 'original prompt',
        })).toBe(true);
        expect(state.persisted()).toHaveLength(1);

        state.sessions.source = gatewaySession({
            id: 'source',
            generation: 3,
            role: 'draining',
            nextSessionId: 'target',
        });
        state.projections.source = apply(createCodexV4Projection(), commandResult('cancelled', 'bindingSuperseded'));
        state.recovery.reconcileSession('source');
        expect(state.updateSessionDraft).not.toHaveBeenCalled();
        expect(state.persisted()).toHaveLength(1);

        state.sessions.target = gatewaySession({
            id: 'target',
            generation: 4,
            role: 'current',
            previousSessionId: 'source',
            draft: 'newer local text',
        });
        const notified = vi.fn();
        state.recovery.subscribe('target', notified);
        state.recovery.reconcileAll();

        expect(state.updateSessionDraft).toHaveBeenCalledWith(
            'target',
            'newer local text\n\noriginal prompt',
        );
        expect(notified).toHaveBeenCalledWith('original prompt');
        expect(state.persisted()).toEqual([]);
    });

    it('does not restore when the authoritative provider user message exists', () => {
        const state = fixture();
        state.recovery.record({
            commandId: 'command-1',
            sourceSessionId: 'source',
            text: 'do not duplicate',
        });
        let projection = apply(createCodexV4Projection(), commandResult('cancelled', 'threadHandoff'));
        projection = apply(projection, providerUserMessage());
        state.projections.source = projection;

        state.recovery.reconcileSession('source');

        expect(state.updateSessionDraft).not.toHaveBeenCalled();
        expect(state.persisted()).toEqual([]);
    });

    it('consumes uncertain or provider-visible terminal results without restoring', () => {
        const state = fixture();
        state.recovery.record({
            commandId: 'command-1',
            sourceSessionId: 'source',
            text: 'do not replay',
        });
        state.projections.source = apply(createCodexV4Projection(), commandResult('resultUnknown'));

        state.recovery.reconcileSession('source');

        expect(state.updateSessionDraft).not.toHaveBeenCalled();
        expect(state.persisted()).toEqual([]);
    });

    it('keeps existing input in front and makes repeated recovery idempotent', () => {
        expect(mergeRecoveredCodexDraft('', 'recovered')).toBe('recovered');
        expect(mergeRecoveredCodexDraft('current', 'recovered')).toBe('current\n\nrecovered');
        expect(mergeRecoveredCodexDraft('current\n\nrecovered', 'recovered'))
            .toBe('current\n\nrecovered');
    });

    it('reconciles a persisted receipt after an App restart', () => {
        const state = fixture([{
            version: 1,
            commandId: 'command-1',
            sourceSessionId: 'source',
            gatewayId: 'gateway-1',
            bindingGeneration: 3,
            text: 'survived restart',
            createdAt: 900,
        }]);
        delete state.sessions.source;
        state.sessions.target = gatewaySession({
            id: 'target',
            generation: 4,
            role: 'current',
            previousSessionId: 'source',
        });
        state.projections.source = apply(
            createCodexV4Projection(),
            commandResult('cancelled', 'threadHandoff'),
        );

        state.recovery.reconcileAll();

        expect(state.updateSessionDraft).toHaveBeenCalledWith('target', 'survived restart');
        expect(state.persisted()).toEqual([]);
    });
});
