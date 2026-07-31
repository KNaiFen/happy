import type { Session } from '@/sync/storageTypes';

export type CodexForkSource = {
    kind: 'codex';
    sessionId: string;
    machineId: string;
    directory: string;
    codexThreadId: string;
};

export type ForkSource = CodexForkSource;

function nonEmpty(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

export function getSessionForkSource(session: Session): ForkSource | null {
    const machineId = session.metadata?.machineId;
    const directory = session.metadata?.path;
    if (!nonEmpty(machineId) || !nonEmpty(directory)) {
        return null;
    }

    if (session.metadata?.flavor !== 'codex' || session.metadata.codexSyncVersion !== 4) {
        return null;
    }
    if (session.metadata.codexReadOnly === true) {
        return null;
    }
    const codexThreadId = session.metadata?.codexThreadId;
    if (!nonEmpty(codexThreadId)) return null;
    return {
        kind: 'codex',
        sessionId: session.id,
        machineId,
        directory,
        codexThreadId,
    };
}
