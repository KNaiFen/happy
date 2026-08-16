type MenuToken = object;

let activeToken: MenuToken | null = null;
let activeClose: (() => void) | null = null;

/**
 * Native and web settings triggers share one close gate. A second trigger is
 * rejected while the first menu is closing, so a stale overlay cannot receive
 * a click intended for the next menu.
 */
export function claimSettingsMenu(token: MenuToken, close: () => void): boolean {
    if (activeToken && activeToken !== token) {
        activeClose?.();
        return false;
    }
    activeToken = token;
    activeClose = close;
    return true;
}

export function releaseSettingsMenu(token: MenuToken): void {
    if (activeToken !== token) return;
    activeToken = null;
    activeClose = null;
}
