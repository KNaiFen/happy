import type { Session } from './storageTypes';

export function isProviderReadOnlySideChat(session: Pick<Session, 'metadata'>): boolean {
    return session.metadata?.isSideChat === true && session.metadata.codexReadOnly === true;
}

export function shouldArchiveSideChatOnClose(session: Pick<Session, 'metadata'>): boolean {
    return !isProviderReadOnlySideChat(session);
}

/**
 * Active side chats remain interactive. A completed provider child is retained
 * locally as read-only history until the user explicitly closes its panel tab.
 */
export function selectVisibleSideChats(
    sessions: readonly Session[],
    parentSessionId: string | null,
): Session[] {
    if (!parentSessionId) return [];

    const active: Session[] = [];
    const providerHistory: Session[] = [];
    for (const session of sessions) {
        if (
            session.metadata?.isSideChat !== true
            || session.metadata.parentSessionId !== parentSessionId
            || session.archivedAt !== null
        ) {
            continue;
        }

        if (session.active) {
            active.push(session);
        } else if (isProviderReadOnlySideChat(session)) {
            providerHistory.push(session);
        }
    }

    active.sort((a, b) => a.createdAt - b.createdAt);
    providerHistory.sort((a, b) => a.createdAt - b.createdAt);
    return [...active, ...providerHistory];
}
