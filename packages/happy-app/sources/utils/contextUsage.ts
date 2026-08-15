export type ContextUsageSummary = {
    used: number;
    total: number;
    remaining: number;
    percentage: number;
};

export function getContextUsageSummary(
    contextSize: number | null | undefined,
    contextWindow: number | null | undefined,
): ContextUsageSummary | null {
    if (!Number.isFinite(contextWindow) || (contextWindow ?? 0) <= 0) {
        return null;
    }

    const total = Math.max(1, Math.floor(contextWindow!));
    const rawUsed = Number.isFinite(contextSize) ? Math.floor(contextSize ?? 0) : 0;
    const used = Math.min(total, Math.max(0, rawUsed));

    return {
        used,
        total,
        remaining: total - used,
        percentage: Math.round((used / total) * 100),
    };
}
