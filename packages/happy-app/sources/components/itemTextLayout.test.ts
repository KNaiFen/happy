import { describe, expect, it } from 'vitest';
import { resolveItemSubtitleLines } from './itemTextLayout';

describe('resolveItemSubtitleLines', () => {
    it('allows settings descriptions to wrap fully by default', () => {
        expect(resolveItemSubtitleLines(undefined)).toBeUndefined();
    });

    it('treats zero and negative values as unlimited lines', () => {
        expect(resolveItemSubtitleLines(0)).toBeUndefined();
        expect(resolveItemSubtitleLines(-1)).toBeUndefined();
    });

    it('preserves explicit positive line limits', () => {
        expect(resolveItemSubtitleLines(1)).toBe(1);
        expect(resolveItemSubtitleLines(3)).toBe(3);
    });
});
