import { shouldApplySessionActivity } from './reducer/activityUpdateAccumulator';

export type SessionLifecycleState = {
    active: boolean;
    activeAt: number;
    archivedAt?: number | null;
};

/** Preserve an absent archivedAt from an older Relay response. */
export function normalizeFetchedSessionLifecycle(
    lifecycle: SessionLifecycleState,
): SessionLifecycleState {
    return {
        active: lifecycle.archivedAt == null && lifecycle.active,
        activeAt: lifecycle.activeAt,
        ...(lifecycle.archivedAt !== undefined ? { archivedAt: lifecycle.archivedAt } : {}),
    };
}

export function resolveSessionLifecycle(
    previous: SessionLifecycleState | undefined,
    incoming: SessionLifecycleState,
): Required<SessionLifecycleState> {
    const shouldApply = !previous || shouldApplySessionActivity(previous, incoming);
    const selected = shouldApply ? incoming : previous;
    const archivedAt = selected.archivedAt ?? null;

    return {
        active: archivedAt === null && selected.active,
        activeAt: selected.activeAt,
        archivedAt,
    };
}
