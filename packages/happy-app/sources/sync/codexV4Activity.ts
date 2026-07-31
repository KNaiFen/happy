import type { Message } from './typesMessage';
import type { CodexV4Projection } from './codexV4Projection';

export interface CodexV4Activity {
    id: string;
    threadId: string;
    turnId: string | null;
}

export function shouldCollapseCurrentCodexV4Turn(
    projection: CodexV4Projection | null | undefined,
): boolean {
    if (!projection) return true;
    const threadId = projection.selectedThreadId ?? projection.runtime?.threadId ?? null;
    if (!threadId) return true;
    const hasActiveTurn = Object.values(projection.entities['codex.turn']).some((turn) => (
        turn.threadId === threadId && turn.status === 'inProgress'
    ));
    const hasPendingRequest = Object.values(projection.entities['codex.request']).some((request) => (
        request.threadId === threadId && request.status === 'pending'
    ));
    return projection.runtime?.execution.type !== 'active' && !hasActiveTurn && !hasPendingRequest;
}

export function resolveCodexV4Activity(
    projection: CodexV4Projection | null | undefined,
): CodexV4Activity | null {
    const runtime = projection?.runtime;
    if (!projection || !runtime || runtime.execution.type !== 'active') return null;
    if (
        runtime.execution.activeFlags.length > 0
        || runtime.pendingApprovalCount > 0
        || runtime.pendingUserInputCount > 0
    ) return null;

    const threadId = projection.selectedThreadId ?? runtime.threadId;
    const turn = newestActiveTurn(projection, threadId);
    if (hasPendingRequest(projection, threadId, turn?.turnId ?? null)) return null;

    const turnMessages = projection.messages.filter((message) => (
        belongsToTurn(message, threadId, turn?.turnId ?? null)
    ));
    if (turnMessages.some((message) => (
        message.kind === 'tool-call' && message.tool.state !== 'completed'
    ))) return null;

    const latestVisiblePhase = turnMessages[0];
    if (
        latestVisiblePhase?.kind === 'agent-text'
    ) return null;

    return {
        id: `codex-v4:activity:${threadId}:${turn?.turnId ?? 'pending'}`,
        threadId,
        turnId: turn?.turnId ?? null,
    };
}

function newestActiveTurn(projection: CodexV4Projection, threadId: string) {
    return Object.values(projection.entities['codex.turn'])
        .filter((turn) => turn.threadId === threadId && turn.status === 'inProgress')
        .sort((left, right) => (
            right.updatedAt - left.updatedAt || right.providerId.localeCompare(left.providerId)
        ))[0];
}

function hasPendingRequest(
    projection: CodexV4Projection,
    threadId: string,
    turnId: string | null,
): boolean {
    return Object.values(projection.entities['codex.request']).some((request) => (
        request.threadId === threadId
        && request.status === 'pending'
        && (turnId === null || request.turnId === null || request.turnId === turnId)
    ));
}

function belongsToTurn(message: Message, threadId: string, turnId: string | null): boolean {
    if (message.codexThreadId !== threadId) return false;
    return turnId === null || message.codexTurnId === turnId;
}
