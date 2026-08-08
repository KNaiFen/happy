/**
 * The stack keeps a full touch row while using a shorter visual step. The
 * shared backfill below each layer covers the rounded-corner voids between
 * rows and at the composer join.
 */
export const CODEX_QUEUED_MESSAGE_HEIGHT = 40;
export const CODEX_QUEUED_MESSAGE_STEP = 29;
export const CODEX_QUEUED_MESSAGE_OVERLAP = CODEX_QUEUED_MESSAGE_HEIGHT - CODEX_QUEUED_MESSAGE_STEP;
export const CODEX_QUEUED_MESSAGE_MAX_VISIBLE = 4;
export const CODEX_QUEUED_MESSAGE_TOP_RADIUS = 20;
export const CODEX_QUEUED_MESSAGE_JOIN_DEPTH = 20;
export const CODEX_QUEUED_MESSAGE_COMPOSER_JOIN_RADIUS = 30;
export const CODEX_QUEUED_MESSAGE_TOP_INSET = 0;
export const CODEX_QUEUED_MESSAGE_DOCK_HORIZONTAL_INSET = 14;

export type CodexQueuedMessageStackLayer<T> = {
    message: T;
    overlapsPrevious: boolean;
    zIndex: number;
};

export function resolveCodexQueuedMessageStack<T>(
    messages: readonly T[],
): CodexQueuedMessageStackLayer<T>[] {
    const newestFirst = [...messages].reverse();
    return newestFirst.map((message, index) => ({
        message,
        overlapsPrevious: index > 0,
        // A higher, newer layer continues down over the next layer's rounded
        // corner void, so the input-facing stack never exposes page background.
        zIndex: newestFirst.length - index,
    }));
}

export function resolveCodexQueuedMessageStackHeight(messageCount: number): number {
    const visibleRows = Math.min(
        Math.max(0, Math.floor(messageCount)),
        CODEX_QUEUED_MESSAGE_MAX_VISIBLE,
    );
    if (visibleRows === 0) return 0;

    return CODEX_QUEUED_MESSAGE_HEIGHT
        + (visibleRows - 1) * CODEX_QUEUED_MESSAGE_STEP
        + CODEX_QUEUED_MESSAGE_TOP_INSET;
}

export function resolveCodexQueuedMessageStackInitialOffset(messageCount: number): number {
    const totalRows = Math.max(0, Math.floor(messageCount));
    if (totalRows <= CODEX_QUEUED_MESSAGE_MAX_VISIBLE) return 0;

    return (totalRows - CODEX_QUEUED_MESSAGE_MAX_VISIBLE) * CODEX_QUEUED_MESSAGE_STEP;
}
