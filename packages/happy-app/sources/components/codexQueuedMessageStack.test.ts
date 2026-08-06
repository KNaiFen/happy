import { describe, expect, it } from 'vitest';
import {
    resolveCodexQueuedMessageStack,
    resolveCodexQueuedMessageStackHeight,
    resolveCodexQueuedMessageStackInitialOffset,
} from './codexQueuedMessageStack';

describe('resolveCodexQueuedMessageStack', () => {
    it('places the newest message at the top and the earliest message at the bottom', () => {
        const messages = ['earliest', 'middle', 'newest'];

        expect(resolveCodexQueuedMessageStack(messages)).toEqual([
            { message: 'newest', overlapsPrevious: false, zIndex: 1 },
            { message: 'middle', overlapsPrevious: true, zIndex: 2 },
            { message: 'earliest', overlapsPrevious: true, zIndex: 3 },
        ]);
        expect(messages).toEqual(['earliest', 'middle', 'newest']);
    });

    it('caps the viewport at three overlapping 52dp layers', () => {
        expect(resolveCodexQueuedMessageStackHeight(0)).toBe(0);
        expect(resolveCodexQueuedMessageStackHeight(1)).toBe(54);
        expect(resolveCodexQueuedMessageStackHeight(2)).toBe(102);
        expect(resolveCodexQueuedMessageStackHeight(3)).toBe(150);
        expect(resolveCodexQueuedMessageStackHeight(7)).toBe(150);
    });

    it('anchors overflow at the earliest messages beside the composer', () => {
        expect(resolveCodexQueuedMessageStackInitialOffset(0)).toBe(0);
        expect(resolveCodexQueuedMessageStackInitialOffset(3)).toBe(0);
        expect(resolveCodexQueuedMessageStackInitialOffset(4)).toBe(48);
        expect(resolveCodexQueuedMessageStackInitialOffset(7)).toBe(192);
    });
});
