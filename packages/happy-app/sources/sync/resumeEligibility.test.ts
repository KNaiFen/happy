import { describe, expect, it } from 'vitest';

import type { Machine, Session } from './storageTypes';
import {
    buildResumeEligibilityFingerprint,
    isResumeEligibilityFresh,
    RESUME_ELIGIBILITY_TTL_MS,
    resolveResumeEligibilityRefreshDelay,
} from './resumeEligibilityState';

function session(overrides: Partial<Session> = {}): Session {
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
            codexThreadId: 'thread-1',
        },
        metadataVersion: 1,
        originMachineId: 'machine-1',
        machineDeletedAt: null,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...overrides,
    };
}

function machine(overrides: Partial<Machine> = {}): Machine {
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
        ...overrides,
    };
}

describe('resume eligibility fingerprints', () => {
    it('changes when session or machine resume bindings change', () => {
        const current = buildResumeEligibilityFingerprint(session(), machine());

        expect(buildResumeEligibilityFingerprint(
            session({ active: true }),
            machine(),
        )).not.toBe(current);
        expect(buildResumeEligibilityFingerprint(
            session(),
            machine({ active: false }),
        )).not.toBe(current);
        expect(buildResumeEligibilityFingerprint(
            session({
                metadata: {
                    ...session().metadata!,
                    codexThreadId: 'thread-2',
                },
            }),
            machine(),
        )).not.toBe(current);
    });

    it('accepts only matching entries inside the 20 second TTL', () => {
        const fingerprint = buildResumeEligibilityFingerprint(session(), machine());
        const checkedAt = 10_000;
        const entry = {
            fingerprint,
            state: 'eligible' as const,
            checkedAt,
        };

        expect(isResumeEligibilityFresh(entry, fingerprint, checkedAt)).toBe(true);
        expect(isResumeEligibilityFresh(
            entry,
            fingerprint,
            checkedAt + RESUME_ELIGIBILITY_TTL_MS - 1,
        )).toBe(true);
        expect(isResumeEligibilityFresh(
            entry,
            fingerprint,
            checkedAt + RESUME_ELIGIBILITY_TTL_MS,
        )).toBe(false);
        expect(isResumeEligibilityFresh(entry, 'other', checkedAt)).toBe(false);
    });

    it('schedules refresh from the request-time check without extending a slow result', () => {
        const requestStartedAt = 10_000;
        const resultAppliedAt = requestStartedAt + 2_000;
        const schedulingAt = resultAppliedAt + 500;

        expect(resolveResumeEligibilityRefreshDelay([
            { checkedAt: requestStartedAt },
        ], schedulingAt)).toBe(RESUME_ELIGIBILITY_TTL_MS - 2_500);
        expect(resolveResumeEligibilityRefreshDelay([
            { checkedAt: requestStartedAt },
        ], requestStartedAt + RESUME_ELIGIBILITY_TTL_MS)).toBe(0);
        expect(resolveResumeEligibilityRefreshDelay([], schedulingAt)).toBeNull();
    });
});
