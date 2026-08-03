import type { DecryptedSession } from './api';

export function isSupportedAgentSession(session: DecryptedSession): boolean {
    const metadata = session.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
    const flavor = (metadata as Record<string, unknown>).flavor;
    return flavor === 'codex'
        && (metadata as Record<string, unknown>).codexSyncVersion === 4;
}

export function filterSupportedAgentSessions(sessions: DecryptedSession[]): DecryptedSession[] {
    return sessions.filter(isSupportedAgentSession);
}
