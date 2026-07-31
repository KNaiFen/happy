const pendingSessionArchives = new Set<string>();

export function beginSessionArchive(sessionId: string): void {
    pendingSessionArchives.add(sessionId);
}

export function endSessionArchive(sessionId: string): void {
    pendingSessionArchives.delete(sessionId);
}

export function isSessionArchivePending(sessionId: string): boolean {
    return pendingSessionArchives.has(sessionId);
}
