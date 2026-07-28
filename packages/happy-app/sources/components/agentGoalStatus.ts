import type { CodexThreadEntityV4 } from '@slopus/happy-wire';
import type { AgentGoalStatus, Session } from '@/sync/storageTypes';
import { isCodexV4SyncActive } from '@/sync/codexV4ClientRegistry';

export type VisibleAgentGoalStatus = AgentGoalStatus & { status: 'active'; text: string; sourceSessionId: string };

type GoalSession = Pick<Session, 'agentState' | 'presence' | 'metadata'>;
type CodexV4GoalProjection = {
    activated: boolean;
    thread: Pick<CodexThreadEntityV4, 'threadId' | 'goal'> | null;
};

function expectedSourceSessionId(session: GoalSession, source: AgentGoalStatus['source']): string | null {
    if (source === 'claude') {
        return session.metadata?.claudeSessionId ?? null;
    }
    if (source === 'codex') {
        return session.metadata?.codexThreadId ?? null;
    }
    return null;
}

function sourceIdentityMatches(session: GoalSession, goal: VisibleAgentGoalStatus): boolean {
    const expected = expectedSourceSessionId(session, goal.source);
    return expected !== null
        && typeof goal.sourceSessionId === 'string'
        && goal.sourceSessionId.trim().length > 0
        && goal.sourceSessionId === expected;
}

export function resolveVisibleAgentGoalStatus(
    session: GoalSession,
    codexV4?: CodexV4GoalProjection | null,
): VisibleAgentGoalStatus | null {
    if (isCodexV4SyncActive(session.metadata, codexV4)) {
        const goal = codexV4.thread?.goal;
        if (!goal || goal.status === 'complete') return null;
        return {
            source: 'codex',
            observedAt: goal.updatedAt,
            sourceSessionId: codexV4.thread!.threadId,
            sourceRevision: goal.updatedAt,
            status: 'active',
            text: goal.objective,
            capabilities: { clear: true, edit: true },
        };
    }

    const goal = session.agentState?.agentGoalStatus;
    if (!goal || goal.status !== 'active') {
        return null;
    }

    if (session.presence !== 'online') {
        return null;
    }

    if (!sourceIdentityMatches(session, goal)) {
        return null;
    }

    return goal;
}
