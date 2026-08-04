import { assertCodexSessionWritable, resolveCodexGatewayBinding } from './codexV4Capabilities';
import { sessionArchive, sessionKill } from './ops';
import { beginSessionArchive, endSessionArchive } from './sessionArchiveState';
import { storage } from './storage';
import type { Session } from './storageTypes';

const ARCHIVE_KILL_TIMEOUT_MS = 5_000;
const inFlightArchives = new Map<string, Promise<void>>();

export function archiveSession(
    sessionId: string,
    options: { beforeStop?: () => Promise<void> } = {},
): Promise<void> {
    const existing = inFlightArchives.get(sessionId);
    if (existing) return existing;

    const previous = storage.getState().sessions[sessionId] ?? null;
    try {
        assertCodexSessionWritable(previous?.metadata);
    } catch (error) {
        return Promise.reject(error);
    }
    const gatewayBinding = resolveCodexGatewayBinding(previous?.metadata);
    const stopBeforeArchive = (
        gatewayBinding?.role === 'current'
        || gatewayBinding?.role === 'recovering'
    );
    let rollbackSnapshot = previous;
    let optimisticActiveAt: number | null = null;
    beginSessionArchive(sessionId);
    if (previous && !stopBeforeArchive) {
        optimisticActiveAt = Date.now();
        applySessionActivity(previous, false, optimisticActiveAt);
    }

    const archive = (async () => {
        if (stopBeforeArchive) {
            await stopGatewayBeforeArchive(sessionId, options.beforeStop);
            const current = storage.getState().sessions[sessionId] ?? previous;
            if (current) {
                rollbackSnapshot = current;
                optimisticActiveAt = Date.now();
                applySessionActivity(current, false, optimisticActiveAt);
            }
        }

        const result = await sessionArchive(sessionId);
        if (!result.success) {
            rollbackOptimisticArchive(rollbackSnapshot, optimisticActiveAt);
            throw new Error(result.message || 'Failed to archive session');
        }

        const current = storage.getState().sessions[sessionId];
        if (current) {
            const archivedAt = result.archivedAt ?? optimisticActiveAt ?? Date.now();
            // The Relay clock can be behind this device. Keep the lifecycle
            // ordering timestamp monotonic while retaining the authoritative
            // tombstone timestamp for display and persistence.
            applySessionActivity(current, false, Math.max(current.activeAt, archivedAt), archivedAt);
        }

        if (gatewayBinding === null) {
            void stopSessionInBackground(sessionId, options.beforeStop);
        }
    })().finally(() => {
        endSessionArchive(sessionId);
        if (inFlightArchives.get(sessionId) === archive) {
            inFlightArchives.delete(sessionId);
        }
    });
    inFlightArchives.set(sessionId, archive);
    return archive;
}

async function stopGatewayBeforeArchive(
    sessionId: string,
    beforeStop: (() => Promise<void>) | undefined,
): Promise<void> {
    try {
        await beforeStop?.();
    } catch {
        // Worktree cleanup is optional; it must not prevent a requested stop.
    }
    const result = await sessionKill(sessionId, { timeoutMs: ARCHIVE_KILL_TIMEOUT_MS });
    if (!result.success && result.outcome !== 'missing' && result.outcome !== 'unverified') {
        throw new Error(result.message || 'Failed to stop Codex Gateway');
    }
}

async function stopSessionInBackground(
    sessionId: string,
    beforeStop: (() => Promise<void>) | undefined,
): Promise<void> {
    try {
        await beforeStop?.();
    } catch {
        // Cleanup is optional; it must not leave the archived CLI running.
    }
    await sessionKill(sessionId, { timeoutMs: ARCHIVE_KILL_TIMEOUT_MS }).catch(() => undefined);
}

function rollbackOptimisticArchive(previous: Session | null, optimisticActiveAt: number | null): void {
    if (!previous || optimisticActiveAt === null) return;
    const current = storage.getState().sessions[previous.id];
    if (!current || current.active || current.activeAt !== optimisticActiveAt) return;
    storage.getState().applySessions([previous]);
}

function applySessionActivity(
    session: Session,
    active: boolean,
    activeAt: number,
    archivedAt: number | null = session.archivedAt,
): void {
    storage.getState().applySessions([{
        ...session,
        active: archivedAt === null && active,
        activeAt,
        archivedAt,
        presence: archivedAt === null && active ? session.presence : activeAt,
    }]);
}
