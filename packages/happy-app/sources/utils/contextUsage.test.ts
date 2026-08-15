import { describe, expect, it } from 'vitest';
import { getContextUsageSummary } from './contextUsage';

describe('getContextUsageSummary', () => {
    it('returns exact context totals and percentage', () => {
        expect(getContextUsageSummary(45_000, 200_000)).toEqual({
            used: 45_000,
            total: 200_000,
            remaining: 155_000,
            percentage: 23,
        });
    });

    it('clamps invalid and out-of-range usage', () => {
        expect(getContextUsageSummary(-10, 100)).toMatchObject({ used: 0, remaining: 100, percentage: 0 });
        expect(getContextUsageSummary(120, 100)).toMatchObject({ used: 100, remaining: 0, percentage: 100 });
        expect(getContextUsageSummary(Number.NaN, 100)).toMatchObject({ used: 0, remaining: 100, percentage: 0 });
    });

    it('does not invent a denominator when the context window is unavailable', () => {
        expect(getContextUsageSummary(45, undefined)).toBeNull();
        expect(getContextUsageSummary(45, 0)).toBeNull();
        expect(getContextUsageSummary(45, Number.NaN)).toBeNull();
    });
});
