export const CODEX_QUEUED_MESSAGE_HEIGHT = 52;
export const CODEX_QUEUED_MESSAGE_OVERLAP = 4;
export const CODEX_QUEUED_MESSAGE_MAX_VISIBLE = 3;
// The ScrollView needs room above the first rounded layer, but never below the
// layer that joins the composer.
export const CODEX_QUEUED_MESSAGE_TOP_INSET = 2;

export type CodexQueuedMessageStackLayer<T> = {
    message: T;
    overlapsPrevious: boolean;
    zIndex: number;
};

export function resolveCodexQueuedMessageStack<T>(
    messages: readonly T[],
): CodexQueuedMessageStackLayer<T>[] {
    return [...messages].reverse().map((message, index) => ({
        message,
        overlapsPrevious: index > 0,
        zIndex: index + 1,
    }));
}

export function resolveCodexQueuedMessageStackHeight(messageCount: number): number {
    const visibleRows = Math.min(
        Math.max(0, Math.floor(messageCount)),
        CODEX_QUEUED_MESSAGE_MAX_VISIBLE,
    );
    if (visibleRows === 0) return 0;

    return CODEX_QUEUED_MESSAGE_HEIGHT
        + (visibleRows - 1) * (CODEX_QUEUED_MESSAGE_HEIGHT - CODEX_QUEUED_MESSAGE_OVERLAP)
        + CODEX_QUEUED_MESSAGE_TOP_INSET;
}

export function resolveCodexQueuedMessageStackInitialOffset(messageCount: number): number {
    const totalRows = Math.max(0, Math.floor(messageCount));
    if (totalRows <= CODEX_QUEUED_MESSAGE_MAX_VISIBLE) return 0;

    return (totalRows - CODEX_QUEUED_MESSAGE_MAX_VISIBLE)
        * (CODEX_QUEUED_MESSAGE_HEIGHT - CODEX_QUEUED_MESSAGE_OVERLAP);
}
