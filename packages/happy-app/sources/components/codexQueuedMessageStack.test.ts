import { describe, expect, it } from 'vitest';
import {
    CODEX_QUEUED_MESSAGE_COMPOSER_JOIN_RADIUS,
    CODEX_QUEUED_MESSAGE_DOCK_HORIZONTAL_INSET,
    resolveCodexQueuedMessageStack,
    resolveCodexQueuedMessageStackHeight,
    resolveCodexQueuedMessageStackInitialOffset,
} from './codexQueuedMessageStack';

describe('resolveCodexQueuedMessageStack', () => {
    it('places the newest message at the top and the earliest message at the bottom', () => {
        const messages = ['earliest', 'middle', 'newest'];

        expect(resolveCodexQueuedMessageStack(messages)).toEqual([
            { message: 'newest', overlapsPrevious: false, zIndex: 3 },
            { message: 'middle', overlapsPrevious: true, zIndex: 2 },
            { message: 'earliest', overlapsPrevious: true, zIndex: 1 },
        ]);
        expect(messages).toEqual(['earliest', 'middle', 'newest']);
    });

    it('caps the viewport at four 40dp layers with a 29dp visual step', () => {
        expect(CODEX_QUEUED_MESSAGE_COMPOSER_JOIN_RADIUS).toBe(30);
        expect(CODEX_QUEUED_MESSAGE_DOCK_HORIZONTAL_INSET).toBe(14);
        expect(resolveCodexQueuedMessageStackHeight(0)).toBe(0);
        expect(resolveCodexQueuedMessageStackHeight(1)).toBe(40);
        expect(resolveCodexQueuedMessageStackHeight(2)).toBe(69);
        expect(resolveCodexQueuedMessageStackHeight(3)).toBe(98);
        expect(resolveCodexQueuedMessageStackHeight(4)).toBe(127);
        expect(resolveCodexQueuedMessageStackHeight(7)).toBe(127);
    });

    it('anchors overflow at the earliest messages beside the composer', () => {
        expect(resolveCodexQueuedMessageStackInitialOffset(0)).toBe(0);
        expect(resolveCodexQueuedMessageStackInitialOffset(4)).toBe(0);
        expect(resolveCodexQueuedMessageStackInitialOffset(5)).toBe(29);
        expect(resolveCodexQueuedMessageStackInitialOffset(7)).toBe(87);
    });
});
