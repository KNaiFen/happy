import { isCodexSessionReadOnly } from './codexV4Capabilities';
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
    const optimisticActiveAt = Date.now();
    beginSessionArchive(sessionId);
    if (previous) {
        applySessionActivity(previous, false, optimisticActiveAt);
    }

    const archive = (async () => {
        const result = await sessionArchive(sessionId);
        if (!result.success) {
            rollbackOptimisticArchive(previous, optimisticActiveAt);
            throw new Error(result.message || 'Failed to archive session');
        }

        const current = storage.getState().sessions[sessionId];
        if (current && !current.active) {
            applySessionActivity(current, false, result.archivedAt ?? optimisticActiveAt);
        }

        if (!isCodexSessionReadOnly(previous?.metadata)) {
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

function rollbackOptimisticArchive(previous: Session | null, optimisticActiveAt: number): void {
    if (!previous) return;
    const current = storage.getState().sessions[previous.id];
    if (!current || current.active || current.activeAt !== optimisticActiveAt) return;
    storage.getState().applySessions([previous]);
}

function applySessionActivity(
    session: Session,
    active: boolean,
    activeAt: number,
): void {
    storage.getState().applySessions([{
        ...session,
        active,
        activeAt,
        presence: active ? session.presence : activeAt,
    }]);
}
