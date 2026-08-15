import { describe, expect, it } from 'vitest';
import { resolveAnchoredMenuPlacement } from './anchoredActionMenuPlacement';

const viewport = { width: 408, height: 236 };
const menu = { width: 224, height: 132 };

describe('resolveAnchoredMenuPlacement', () => {
    it('opens below and aligns the trailing edge when the space is available', () => {
        expect(resolveAnchoredMenuPlacement({
            anchor: { x: 350, y: 30, width: 32, height: 32 },
            viewport,
            menu,
        })).toMatchObject({
            left: 158,
            top: 68,
            width: 224,
            height: 132,
            direction: 'below',
            alignment: 'end',
        });
    });

    it('prefers above the trigger when both sides fit', () => {
        expect(resolveAnchoredMenuPlacement({
            anchor: { x: 180, y: 200, width: 32, height: 32 },
            viewport: { width: 408, height: 360 },
            menu,
            preferAbove: true,
        })).toMatchObject({
            direction: 'above',
            top: 62,
        });
    });

    it('flips above a trigger near the bottom edge', () => {
        expect(resolveAnchoredMenuPlacement({
            anchor: { x: 350, y: 180, width: 32, height: 32 },
            viewport,
            menu,
        })).toMatchObject({
            left: 158,
            top: 42,
            direction: 'above',
            height: 132,
        });
    });

    it('clamps to safe-area bounds and limits height when neither side fits', () => {
        const placement = resolveAnchoredMenuPlacement({
            anchor: { x: 2, y: 90, width: 32, height: 32 },
            viewport: { width: 320, height: 180 },
            menu: { width: 280, height: 400 },
            safeArea: { top: 24, bottom: 20, left: 10, right: 10 },
            keyboardHeight: 40,
        });

        expect(placement.left).toBe(18);
        expect(placement.top).toBeGreaterThanOrEqual(32);
        expect(placement.top + placement.height).toBeLessThanOrEqual(120);
        expect(placement.maxHeight).toBe(placement.height);
    });

    it('keeps a narrow menu inside a narrow viewport', () => {
        const placement = resolveAnchoredMenuPlacement({
            anchor: { x: 4, y: 50, width: 24, height: 24 },
            viewport: { width: 120, height: 200 },
            menu: { width: 224, height: 88 },
        });

        expect(placement.left).toBe(8);
        expect(placement.width).toBe(104);
        expect(placement.left + placement.width).toBeLessThanOrEqual(112);
    });
});
