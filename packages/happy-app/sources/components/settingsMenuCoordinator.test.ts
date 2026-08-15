import { describe, expect, it, vi } from 'vitest';
import { claimSettingsMenu, releaseSettingsMenu } from './settingsMenuCoordinator';

describe('settings menu coordinator', () => {
    it('rejects a second menu until the active menu releases its claim', () => {
        const first = {};
        const second = {};
        const closeFirst = vi.fn();

        expect(claimSettingsMenu(first, closeFirst)).toBe(true);
        expect(claimSettingsMenu(second, vi.fn())).toBe(false);
        expect(closeFirst).toHaveBeenCalledOnce();

        releaseSettingsMenu(first);
        expect(claimSettingsMenu(second, vi.fn())).toBe(true);
        releaseSettingsMenu(second);
    });

    it('does not release the active menu for a stale token', () => {
        const active = {};
        const stale = {};
        const closeActive = vi.fn();

        expect(claimSettingsMenu(active, closeActive)).toBe(true);
        releaseSettingsMenu(stale);
        expect(claimSettingsMenu(stale, vi.fn())).toBe(false);
        expect(closeActive).toHaveBeenCalledOnce();
        releaseSettingsMenu(active);
    });
});
