import { trimIdent } from '@/utils/trimIdent';
import type { Thread } from './protocol';
import type { SyncV4MigrationJournalState } from '@/api/syncV4Journal';

type ResumeThreadClient = {
    resumeThread: (opts: {
        threadId: string;
        cwd: string;
        mcpServers: Record<string, unknown>;
        emitSnapshot?: boolean;
    }) => Promise<{ threadId: string; model: string; thread: Thread }>;
};

type ResumeThreadSession = {
    updateMetadata: (handler: (currentMetadata: any) => any) => void;
    sendSessionEvent: (event: { type: 'message'; message: string }) => void;
};

type ResumeThreadMessageBuffer = {
    addMessage: (message: string, type: 'status') => void;
};

export interface CodexResumeSyncStrategy {
    emitLegacySnapshot: boolean;
    migrateToSyncV4: boolean;
    finalizeSyncV4Activation: boolean;
}

/** Keeps the resume snapshot and canonical migration on one coordinated branch. */
export function resolveCodexResumeSyncStrategy(
    syncV4Enabled: boolean,
    migrationState?: SyncV4MigrationJournalState,
): CodexResumeSyncStrategy {
    return {
        emitLegacySnapshot: !syncV4Enabled,
        migrateToSyncV4: syncV4Enabled
            && migrationState !== 'ready'
            && migrationState !== 'activating',
        finalizeSyncV4Activation: syncV4Enabled && migrationState === 'activating',
    };
}

export async function resumeExistingThread(opts: {
    client: ResumeThreadClient;
    session: ResumeThreadSession;
    messageBuffer: ResumeThreadMessageBuffer;
    threadId: string;
    cwd: string;
    mcpServers: Record<string, unknown>;
    emitSnapshot?: boolean;
    /**
     * Whether to surface a "Resumed Codex thread …" message in the chat UI.
     * Side chats open empty on purpose, so they pass `false` to keep this
     * internal resume detail out of the conversation. Defaults to `true`.
     */
    announce?: boolean;
}): Promise<{ threadId: string; model: string; thread: Thread }> {
    try {
        const resumedThread = await opts.client.resumeThread({
            threadId: opts.threadId,
            cwd: opts.cwd,
            mcpServers: opts.mcpServers,
            emitSnapshot: opts.emitSnapshot,
        });

        opts.session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            codexThreadId: resumedThread.threadId,
        }));
        opts.messageBuffer.addMessage(`Resumed thread ${trimIdent(resumedThread.threadId)}`, 'status');
        if (opts.announce !== false) {
            opts.session.sendSessionEvent({
                type: 'message',
                message: `Resumed Codex thread ${resumedThread.threadId}`,
            });
        }

        return resumedThread;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to resume Codex thread ${opts.threadId}: ${reason}`);
    }
}
