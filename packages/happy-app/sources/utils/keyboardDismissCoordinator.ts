export interface KeyboardDismissSubscription {
    remove(): void;
}

export interface KeyboardDismissAdapter {
    isWeb(): boolean;
    isVisible(): boolean;
    addDidHideListener(listener: () => void): KeyboardDismissSubscription;
    dismiss(): void;
}

export class KeyboardDismissCoordinator<Key extends string> {
    private pending: { key: Key; action: () => void } | null = null;
    private recentAction: { key: Key; expiresAt: number } | null = null;
    private subscription: KeyboardDismissSubscription | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly adapter: KeyboardDismissAdapter,
        private readonly fallbackMs: number = 420,
        private readonly duplicateWindowMs: number = 300,
    ) {}

    isPending(key: Key): boolean {
        return this.pending?.key === key;
    }

    schedule(
        key: Key,
        action: () => void,
        blur?: () => void,
        options: { immediate?: boolean } = {},
    ): boolean {
        if (
            this.pending?.key === key
            || (this.recentAction?.key === key && this.recentAction.expiresAt > Date.now())
        ) return false;
        this.cancel();

        const shouldWait = options.immediate !== true
            && !this.adapter.isWeb()
            && this.adapter.isVisible();
        if (!shouldWait) {
            blur?.();
            this.markAction(key);
            action();
            return true;
        }

        this.pending = { key, action };
        const finish = () => {
            const pending = this.pending;
            this.cancel();
            if (pending) {
                this.markAction(pending.key);
                pending.action();
            }
        };
        this.subscription = this.adapter.addDidHideListener(finish);
        this.timer = setTimeout(finish, this.fallbackMs);
        blur?.();
        this.adapter.dismiss();
        return true;
    }

    cancel(): void {
        this.pending = null;
        this.subscription?.remove();
        this.subscription = null;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    dispose(): void {
        this.cancel();
        this.recentAction = null;
    }

    private markAction(key: Key): void {
        this.recentAction = {
            key,
            expiresAt: Date.now() + this.duplicateWindowMs,
        };
    }
}
