import type { ApiEphemeralActivityUpdate } from '../apiTypes';

export class ActivityUpdateAccumulator {
    private pendingUpdates = new Map<string, ApiEphemeralActivityUpdate>();
    private lastEmittedStates = new Map<string, SessionActivityOrderingState & { thinking: boolean }>();
    private timeoutId: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private flushHandler: (updates: Map<string, ApiEphemeralActivityUpdate>) => void,
        private debounceDelay: number = 500
    ) {}

    addUpdate(update: ApiEphemeralActivityUpdate): void {
        const sessionId = update.id;
        const lastState = this.lastEmittedStates.get(sessionId);
        const pendingState = this.pendingUpdates.get(sessionId);
        const newestState = pendingState && (!lastState || shouldApplySessionActivity(lastState, pendingState))
            ? pendingState
            : lastState;

        if (newestState && !shouldApplySessionActivity(newestState, update)) {
            return;
        }

        // Check if this is a critical timestamp update (more than half of disconnect timeout old)
        const timeSinceLastUpdate = lastState ? update.activeAt - lastState.activeAt : 0;
        const isCriticalTimestamp = timeSinceLastUpdate > 60000; // Half of 120 second timeout

        // Check if this is a significant state change that needs immediate emission
        const isSignificantChange = !lastState || 
            lastState.active !== update.active || 
            lastState.thinking !== update.thinking ||
            lastState.archivedAt !== update.archivedAt ||
            isCriticalTimestamp;

        if (isSignificantChange) {
            // Cancel any pending timeout
            if (this.timeoutId) {
                clearTimeout(this.timeoutId);
                this.timeoutId = null;
            }

            // Add the immediate update to pending updates
            this.pendingUpdates.set(sessionId, update);

            // Flush all pending updates together (batched)
            this.flushPendingUpdates();
        } else {
            // Accumulate for debounced emission (only timestamp updates)
            this.pendingUpdates.set(sessionId, update);

            // Only start a new timer if one isn't already running
            if (!this.timeoutId) {
                this.timeoutId = setTimeout(() => {
                    this.flushPendingUpdates();
                    this.timeoutId = null;
                }, this.debounceDelay);
            }
            // Don't reset the timer for subsequent updates - let it fire!
        }
    }

    private flushPendingUpdates(): void {
        if (this.pendingUpdates.size > 0) {
            // Create a copy of the pending updates
            const updatesToFlush = new Map(this.pendingUpdates);
            
            // Emit all updates in a single batch
            this.flushHandler(updatesToFlush);
            
            // Update last emitted states for all flushed updates
            for (const [sessionId, update] of updatesToFlush) {
                this.lastEmittedStates.set(sessionId, {
                    active: update.active,
                    thinking: update.thinking,
                    activeAt: update.activeAt,
                    archivedAt: update.archivedAt,
                });
            }
            
            // Clear pending updates
            this.pendingUpdates.clear();
        }
    }

    cancel(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        this.pendingUpdates.clear();
    }

    reset(): void {
        this.cancel();
        this.lastEmittedStates.clear();
    }

    flush(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        this.flushPendingUpdates();
    }
}

type SessionActivityOrderingState = Pick<ApiEphemeralActivityUpdate, 'active' | 'activeAt'> & {
    archivedAt?: number | null;
};

export function shouldApplySessionActivity(
    current: SessionActivityOrderingState,
    update: SessionActivityOrderingState,
): boolean {
    const currentArchived = current.archivedAt != null;
    const updateDeclaresArchiveState = update.archivedAt !== undefined;
    const updateArchived = update.archivedAt != null;

    // Legacy events cannot clear a durable tombstone. Unarchive is authoritative
    // only when the server explicitly sends archivedAt: null.
    if (currentArchived && !updateDeclaresArchiveState) return false;
    if (update.activeAt < current.activeAt) return false;
    if (update.activeAt === current.activeAt) {
        if (currentArchived !== updateArchived) return updateArchived;
        if (!current.active && update.active) return false;
    }
    return true;
}
