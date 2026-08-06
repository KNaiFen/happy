import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResumeEligibilityEntry } from './storage';
import type { Machine, Session } from './storageTypes';

const {
    getIndependentSessionDataKey,
    machinePreflightResumeSessions,
    refreshSessions,
    state,
} = vi.hoisted(() => {
    const state = {
        resumeEligibilityBySessionId: {} as Record<string, ResumeEligibilityEntry>,
        applyResumeEligibility(entries: Record<string, unknown>) {
            Object.assign(this.resumeEligibilityBySessionId, entries);
        },
    };
    return {
        getIndependentSessionDataKey: vi.fn(() => new Uint8Array(32).fill(7)),
        machinePreflightResumeSessions: vi.fn(),
        refreshSessions: vi.fn(),
        state,
    };
});

vi.mock('./ops', () => ({ machinePreflightResumeSessions }));
vi.mock('./storage', () => ({
    storage: { getState: () => state },
}));
vi.mock('./sync', () => ({
    sync: {
        encryption: { getIndependentSessionDataKey },
        refreshSessions,
    },
}));
vi.mock('./sessionMachineAccess', () => ({
    isSessionMachineDeleted: () => false,
}));

function session(threadId = 'thread-1'): Session {
    return {
        id: 'session-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        archivedAt: null,
        metadata: {
            path: '/tmp/project',
            host: 'test-host',
            machineId: 'machine-1',
            flavor: 'codex',
            codexSyncVersion: 4,
            codexThreadId: threadId,
        },
        metadataVersion: 1,
        originMachineId: 'machine-1',
        machineDeletedAt: null,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
    };
}

function machine(): Machine {
    return {
        id: 'machine-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: 'test-host',
            platform: 'darwin',
            happyCliVersion: '1.4.45',
            happyHomeDir: '/tmp/.happy',
            homeDir: '/tmp',
            resumeSupport: {
                rpcAvailable: true,
                preflightRpcAvailable: true,
                requiresSameMachine: true,
                detectedAt: 1,
            },
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('resume eligibility preflight coordination', () => {
    beforeEach(() => {
        vi.useRealTimers();
        machinePreflightResumeSessions.mockReset();
        refreshSessions.mockReset();
        getIndependentSessionDataKey.mockReset();
        getIndependentSessionDataKey.mockReturnValue(new Uint8Array(32).fill(7));
        state.resumeEligibilityBySessionId = {};
    });

    it('coalesces concurrent checks for the same session fingerprint', async () => {
        const response = deferred<{
            type: 'success';
            results: Array<{ type: 'eligible'; sessionId: string }>;
        }>();
        machinePreflightResumeSessions.mockReturnValue(response.promise);
        const { ensureResumeEligibilityForSessions } = await import('./resumeEligibility');
        const options = { sessions: [session()], machines: [machine()], machinesLoaded: true };

        const first = ensureResumeEligibilityForSessions(options);
        const second = ensureResumeEligibilityForSessions(options);

        expect(machinePreflightResumeSessions).toHaveBeenCalledTimes(1);
        response.resolve({
            type: 'success',
            results: [{ type: 'eligible', sessionId: 'session-1' }],
        });
        await Promise.all([first, second]);
        expect(state.resumeEligibilityBySessionId['session-1']?.state).toBe('eligible');
    });

    it('does not let an older fingerprint response overwrite a newer check', async () => {
        const oldResponse = deferred<{
            type: 'success';
            results: Array<{ type: 'ineligible'; sessionId: string; reason: 'threadUnavailable' }>;
        }>();
        const newResponse = deferred<{
            type: 'success';
            results: Array<{ type: 'eligible'; sessionId: string }>;
        }>();
        machinePreflightResumeSessions
            .mockReturnValueOnce(oldResponse.promise)
            .mockReturnValueOnce(newResponse.promise);
        const { ensureResumeEligibilityForSessions } = await import('./resumeEligibility');
        const oldCheck = ensureResumeEligibilityForSessions({
            sessions: [session('thread-old')],
            machines: [machine()],
            machinesLoaded: true,
        });
        const newCheck = ensureResumeEligibilityForSessions({
            sessions: [session('thread-new')],
            machines: [machine()],
            machinesLoaded: true,
        });

        oldResponse.resolve({
            type: 'success',
            results: [{
                type: 'ineligible',
                sessionId: 'session-1',
                reason: 'threadUnavailable',
            }],
        });
        await oldCheck;
        expect(state.resumeEligibilityBySessionId['session-1']?.state).toBe('checking');

        newResponse.resolve({
            type: 'success',
            results: [{ type: 'eligible', sessionId: 'session-1' }],
        });
        await newCheck;
        expect(state.resumeEligibilityBySessionId['session-1']?.state).toBe('eligible');
    });

    it('expires a response from the request start and force bypasses a fresh cache', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const firstResponse = deferred<{
            type: 'success';
            results: Array<{ type: 'eligible'; sessionId: string }>;
        }>();
        machinePreflightResumeSessions.mockReturnValueOnce(firstResponse.promise);
        const {
            buildResumeEligibilityFingerprint,
            ensureResumeEligibilityForSession,
            isResumeEligibilityFresh,
        } = await import('./resumeEligibility');
        const currentSession = session();
        const currentMachine = machine();
        const firstCheck = ensureResumeEligibilityForSession({
            session: currentSession,
            machine: currentMachine,
            machinesLoaded: true,
        });

        vi.setSystemTime(30_000);
        firstResponse.resolve({
            type: 'success',
            results: [{ type: 'eligible', sessionId: 'session-1' }],
        });
        expect(await firstCheck).toBeNull();
        const expired = state.resumeEligibilityBySessionId['session-1'];
        expect(expired?.checkedAt).toBe(10_000);
        expect(isResumeEligibilityFresh(
            expired,
            buildResumeEligibilityFingerprint(currentSession, currentMachine),
            30_000,
        )).toBe(false);

        const forcedResponse = deferred<{
            type: 'success';
            results: Array<{ type: 'eligible'; sessionId: string }>;
        }>();
        machinePreflightResumeSessions.mockReturnValueOnce(forcedResponse.promise);
        const forcedCheck = ensureResumeEligibilityForSession({
            session: currentSession,
            machine: currentMachine,
            machinesLoaded: true,
            force: true,
        });
        expect(machinePreflightResumeSessions).toHaveBeenCalledTimes(2);
        forcedResponse.resolve({
            type: 'success',
            results: [{ type: 'eligible', sessionId: 'session-1' }],
        });
        expect((await forcedCheck)?.state).toBe('eligible');
    });
});
