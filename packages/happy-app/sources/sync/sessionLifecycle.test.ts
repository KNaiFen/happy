import { describe, expect, it } from 'vitest';

import { normalizeFetchedSessionLifecycle, resolveSessionLifecycle } from './sessionLifecycle';

describe('resolveSessionLifecycle', () => {
    it('preserves a missing archivedAt from a legacy Relay response', () => {
        const lifecycle = normalizeFetchedSessionLifecycle({ active: true, activeAt: 3_000 });

        expect(lifecycle).toEqual({ active: true, activeAt: 3_000 });
        expect(Object.hasOwn(lifecycle, 'archivedAt')).toBe(false);
    });

    it('keeps a local tombstone when an older full-session snapshot arrives', () => {
        expect(resolveSessionLifecycle(
            { active: false, activeAt: 2_000, archivedAt: 2_000 },
            { active: true, activeAt: 1_999, archivedAt: null },
        )).toEqual({ active: false, activeAt: 2_000, archivedAt: 2_000 });
    });

    it('does not let a legacy snapshot with no archivedAt clear a tombstone', () => {
        expect(resolveSessionLifecycle(
            { active: false, activeAt: 2_000, archivedAt: 2_000 },
            { active: true, activeAt: 3_000 },
        )).toEqual({ active: false, activeAt: 2_000, archivedAt: 2_000 });
    });

    it('accepts a newer explicit unarchive snapshot as inactive', () => {
        expect(resolveSessionLifecycle(
            { active: false, activeAt: 2_000, archivedAt: 2_000 },
            { active: false, activeAt: 2_001, archivedAt: null },
        )).toEqual({ active: false, activeAt: 2_001, archivedAt: null });
    });
});
