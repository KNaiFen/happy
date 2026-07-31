import type { DecryptedSession } from './api';

const RETAINED_V3_FLAVORS = new Set(['gemini', 'openclaw', 'agy']);

export function isSupportedAgentSession(session: DecryptedSession): boolean {
    const metadata = session.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
    const flavor = (metadata as Record<string, unknown>).flavor;
    if (flavor === 'codex') {
        return (metadata as Record<string, unknown>).codexSyncVersion === 4;
    }
    return typeof flavor === 'string' && RETAINED_V3_FLAVORS.has(flavor);
}

export function filterSupportedAgentSessions(sessions: DecryptedSession[]): DecryptedSession[] {
    return sessions.filter(isSupportedAgentSession);
}
