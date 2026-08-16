import { describe, expect, it, vi } from 'vitest';
import { InvalidateSync } from './sync';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

describe('InvalidateSync', () => {
    it('reports when the active queue completes before the deadline', async () => {
        const command = deferred();
        const sync = new InvalidateSync(() => command.promise);
        sync.invalidate();
        const ready = sync.awaitQueueUntil(1_000);
        const drained = sync.awaitQueue();
        command.resolve();

        await expect(ready).resolves.toBe(true);
        await expect(drained).resolves.toBeUndefined();
    });

    it('releases a startup waiter at its deadline without stopping background sync', async () => {
        vi.useFakeTimers();
        try {
            const command = deferred();
            const sync = new InvalidateSync(() => command.promise);
            sync.invalidate();
            const ready = sync.awaitQueueUntil(2_500);

            await vi.advanceTimersByTimeAsync(2_500);
            await expect(ready).resolves.toBe(false);

            const drained = sync.awaitQueue();
            command.resolve();
            await expect(drained).resolves.toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });
});
