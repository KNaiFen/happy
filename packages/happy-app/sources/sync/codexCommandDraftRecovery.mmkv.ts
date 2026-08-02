import { CodexCommandDraftRecovery } from './codexCommandDraftRecovery';
import {
    loadCodexCommandDraftReceipts,
    saveCodexCommandDraftReceipts,
} from './persistence';
import { storage } from './storage';

export const codexCommandDraftRecovery = new CodexCommandDraftRecovery({
    loadReceipts: loadCodexCommandDraftReceipts,
    saveReceipts: saveCodexCommandDraftReceipts,
    getSessions: () => storage.getState().sessions,
    getProjection: (sessionId) => storage.getState().codexV4Sessions[sessionId],
    updateSessionDraft: (sessionId, draft) => {
        storage.getState().updateSessionDraft(sessionId, draft);
    },
    now: Date.now,
});
