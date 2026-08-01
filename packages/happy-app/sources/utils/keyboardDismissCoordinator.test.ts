import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    KeyboardDismissCoordinator,
    type KeyboardDismissAdapter,
} from './keyboardDismissCoordinator';

function adapter(options: { web?: boolean; visible?: boolean } = {}) {
    let hideListener: (() => void) | null = null;
    const remove = vi.fn(() => { hideListener = null; });
    const value: KeyboardDismissAdapter = {
        isWeb: () => options.web === true,
        isVisible: () => options.visible === true,
        addDidHideListener: vi.fn((listener: () => void) => {
            hideListener = listener;
            return { remove };
        }),
        dismiss: vi.fn(),
    };
    return {
        value,
        remove,
        hide: () => hideListener?.(),
    };
}

describe('KeyboardDismissCoordinator', () => {
    afterEach(() => vi.useRealTimers());

    it('runs immediately on web after blurring', () => {
        const keyboard = adapter({ web: true, visible: true });
        const coordinator = new KeyboardDismissCoordinator(keyboard.value);
        const blur = vi.fn();
        const action = vi.fn();

        expect(coordinator.schedule('resume', action, blur)).toBe(true);
        expect(blur).toHaveBeenCalledOnce();
        expect(action).toHaveBeenCalledOnce();
        expect(keyboard.value.dismiss).not.toHaveBeenCalled();
    });

    it('runs immediately when the native keyboard is already hidden', () => {
        vi.useFakeTimers();
        const keyboard = adapter({ visible: false });
        const coordinator = new KeyboardDismissCoordinator(keyboard.value);
        const action = vi.fn();
        const duplicate = vi.fn();

        expect(coordinator.schedule('resume', action)).toBe(true);
        expect(coordinator.schedule('resume', duplicate)).toBe(false);

        expect(action).toHaveBeenCalledOnce();
        expect(duplicate).not.toHaveBeenCalled();
        expect(keyboard.value.addDidHideListener).not.toHaveBeenCalled();

        vi.advanceTimersByTime(300);
        expect(coordinator.schedule('resume', duplicate)).toBe(true);
        expect(duplicate).toHaveBeenCalledOnce();
    });

    it('waits for keyboardDidHide and ignores a duplicate pending action', () => {
        vi.useFakeTimers();
        const keyboard = adapter({ visible: true });
        const coordinator = new KeyboardDismissCoordinator(keyboard.value);
        const first = vi.fn();
        const duplicate = vi.fn();
        const blur = vi.fn();

        expect(coordinator.schedule('resume', first, blur)).toBe(true);
        expect(coordinator.schedule('resume', duplicate, blur)).toBe(false);
        expect(first).not.toHaveBeenCalled();
        expect(keyboard.value.dismiss).toHaveBeenCalledOnce();

        keyboard.hide();

        expect(first).toHaveBeenCalledOnce();
        expect(duplicate).not.toHaveBeenCalled();
        expect(keyboard.remove).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(420);
        expect(first).toHaveBeenCalledOnce();
    });

    it('uses the timeout fallback and cleans up on dispose', () => {
        vi.useFakeTimers();
        const keyboard = adapter({ visible: true });
        const coordinator = new KeyboardDismissCoordinator(keyboard.value);
        const fallbackAction = vi.fn();

        coordinator.schedule('resume', fallbackAction);
        vi.advanceTimersByTime(420);
        expect(fallbackAction).toHaveBeenCalledOnce();
        expect(coordinator.isPending('resume')).toBe(false);

        const disposedAction = vi.fn();
        coordinator.schedule('picker', disposedAction);
        coordinator.dispose();
        vi.advanceTimersByTime(420);
        keyboard.hide();
        expect(disposedAction).not.toHaveBeenCalled();
    });
});
