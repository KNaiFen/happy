import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));
vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

import type { Session, CodexSessionStateV4 } from '@/sync/storageTypes';
import { resolveSessionStatus } from './sessionUtils';

function codexState(overrides: Partial<CodexSessionStateV4> = {}): CodexSessionStateV4 {
    return {
        connection: 'connected',
        execution: { type: 'idle' },
        statusUnknown: false,
        syncState: 'ready',
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        activeSubagentCount: 0,
        lastError: null,
        lastKnownAt: 10,
        ...overrides,
    };
}

function session(overrides: Partial<Session> = {}): Session {
    return {
        presence: 'online',
        thinking: false,
        agentState: null,
        ...overrides,
    } as Session;
}

describe('resolveSessionStatus', () => {
    it('uses structured Codex execution instead of a stale thinking mirror', () => {
        const status = resolveSessionStatus(session({
            thinking: true,
            codexState: codexState(),
        }), 'working...');

        expect(status).toMatchObject({ state: 'waiting', isConnected: true });
    });

    it('keeps the last active state but marks it unknown after Codex disconnects', () => {
        const status = resolveSessionStatus(session({
            codexState: codexState({
                connection: 'disconnected',
                execution: { type: 'active', activeFlags: [] },
                statusUnknown: true,
            }),
        }), 'working...');

        expect(status).toMatchObject({
            state: 'thinking',
            isConnected: false,
            isPulsing: false,
            statusColor: '#999',
        });
        expect(status.statusText).toContain('unknown');
    });

    it('derives approval and system error states from Codex runtime dimensions', () => {
        expect(resolveSessionStatus(session({
            codexState: codexState({ pendingUserInputCount: 1 }),
        }), 'working...').state).toBe('permission_required');
        expect(resolveSessionStatus(session({
            codexState: codexState({ execution: { type: 'systemError' } }),
        }), 'working...').state).toBe('error');
    });

    it('marks App sync retry as unknown without erasing the official execution state', () => {
        const status = resolveSessionStatus(session({
            codexState: codexState({
                execution: { type: 'active', activeFlags: [] },
                appSyncStatus: 'unknown',
                appSyncLastErrorAt: 20,
            }),
        }), 'working...');

        expect(status).toMatchObject({
            state: 'thinking',
            isConnected: false,
            isPulsing: false,
        });
        expect(status.statusText).toContain('unknown');
    });
});
