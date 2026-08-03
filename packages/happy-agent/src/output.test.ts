import { describe, expect, it } from 'vitest';
import type { DecryptedMachine, DecryptedSession } from './api';
import {
    formatJson,
    formatMachineTable,
    formatMessageHistory,
    formatSessionStatus,
    formatSessionTable,
} from './output';
import type { CodexV4HistoryEntry, CodexV4Snapshot } from './session';

function session(overrides: Partial<DecryptedSession> = {}): DecryptedSession {
    return {
        id: 'session-1',
        seq: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        active: true,
        activeAt: 1_700_000_000_000,
        metadata: {
            flavor: 'codex',
            codexSyncVersion: 4,
            codexThreadId: 'thread-1',
            path: '/workspace',
            summary: 'Codex session',
        },
        dataEncryptionKey: 'secret',
        encryption: { key: new Uint8Array(32), variant: 'dataKey' },
        ...overrides,
    };
}

function snapshot(overrides: Partial<CodexV4Snapshot> = {}): CodexV4Snapshot {
    return {
        highWatermark: 12,
        entities: [],
        thread: {
            threadId: 'thread-1',
            status: { type: 'idle' },
        } as CodexV4Snapshot['thread'],
        runtime: {
            connection: 'connected',
            execution: { type: 'idle' },
            statusUnknown: false,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
        } as CodexV4Snapshot['runtime'],
        turns: [],
        items: [],
        parts: [],
        commandResults: [],
        ...overrides,
    };
}

describe('output formatting', () => {
    it('formats only the useful Codex session list fields', () => {
        const output = formatSessionTable([session()]);
        expect(output).toContain('## Sessions');
        expect(output).toContain('Codex session');
        expect(output).toContain('/workspace');
    });

    it('formats machine state', () => {
        const machine = {
            id: 'machine-1',
            active: true,
            activeAt: 1_700_000_000_000,
            metadata: { host: 'devbox', platform: 'darwin', homeDir: '/Users/dev' },
            daemonState: { status: 'online' },
        } as DecryptedMachine;
        const output = formatMachineTable([machine]);
        expect(output).toContain('devbox');
        expect(output).toContain('online');
    });

    it('formats authoritative V4 runtime state instead of legacy agentState', () => {
        const output = formatSessionStatus(session(), snapshot({
            runtime: {
                connection: 'connected',
                execution: { type: 'active', activeFlags: ['waitingOnApproval'] },
                statusUnknown: false,
                pendingApprovalCount: 1,
                pendingUserInputCount: 0,
            } as CodexV4Snapshot['runtime'],
        }));
        expect(output).toContain('- Sync Watermark: 12');
        expect(output).toContain('- Codex Thread: thread-1');
        expect(output).toContain('- Codex Execution: active');
        expect(output).toContain('- Pending Approvals: 1');
        expect(output).not.toContain('controlledByUser');
    });

    it('formats V4 part history', () => {
        const messages: CodexV4HistoryEntry[] = [{
            id: 'item-1',
            createdAt: 1_700_000_000_000,
            role: 'assistant',
            text: 'Completed',
            turnId: 'turn-1',
            itemId: 'item-1',
            kind: 'text',
        }];
        const output = formatMessageHistory(messages);
        expect(output).toContain('- Role: assistant');
        expect(output).toContain('- Kind: text');
        expect(output).toContain('Completed');
    });

    it('does not expose encryption material in JSON output', () => {
        const output = formatJson(session());
        expect(output).not.toContain('dataEncryptionKey');
        expect(output).not.toContain('encryption');
        expect(output).not.toContain('secret');
    });
});
