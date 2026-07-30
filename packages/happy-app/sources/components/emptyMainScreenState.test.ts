import { describe, expect, it } from 'vitest';
import { resolveEmptyMainScreenState } from './emptyMainScreenState';

describe('resolveEmptyMainScreenState', () => {
    it('does not show pairing before the authoritative machine fetch completes', () => {
        expect(resolveEmptyMainScreenState(false, 0)).toBe('loading');
    });

    it('offers a new session when a registered machine exists without sessions', () => {
        expect(resolveEmptyMainScreenState(true, 1)).toBe('start-session');
    });

    it('shows pairing only after a successful empty machine snapshot', () => {
        expect(resolveEmptyMainScreenState(true, 0)).toBe('pair-machine');
    });
});
