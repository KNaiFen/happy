import { describe, expect, it, vi } from 'vitest';
import type { TrackedSession } from './types';
import {
    isVerifiedLegacyCodexAdapterSession,
    retireVerifiedLegacyCodexAdapters,
} from './legacyCodexAdapterRetirement';

const currentProfile = {
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/opt/happy',
};

describe('legacy Codex adapter retirement', () => {
    it('requires a persisted daemon Codex session from the exact local profile', () => {
        const tracked = legacySession();
        expect(isVerifiedLegacyCodexAdapterSession(tracked, currentProfile)).toBe(true);
        expect(isVerifiedLegacyCodexAdapterSession({
            ...tracked,
            codexGatewayId: 'gateway-a',
        }, currentProfile)).toBe(false);
        expect(isVerifiedLegacyCodexAdapterSession({
            ...tracked,
            happySessionMetadataFromLocalWebhook: {
                ...tracked.happySessionMetadataFromLocalWebhook!,
                hostPid: 99,
            },
        }, currentProfile)).toBe(false);
        expect(isVerifiedLegacyCodexAdapterSession({
            ...tracked,
            happySessionMetadataFromLocalWebhook: {
                ...tracked.happySessionMetadataFromLocalWebhook!,
                happyHomeDir: '/home/other/.happy',
            },
        }, currentProfile)).toBe(false);
    });

    it('checks process identity twice and signals each verified PID only once', () => {
        const isExpectedProcess = vi.fn(() => true);
        const signal = vi.fn();
        const tracked = legacySession();
        expect(retireVerifiedLegacyCodexAdapters([tracked, tracked], {
            ...currentProfile,
            isExpectedProcess,
            signal,
        })).toBe(1);
        expect(isExpectedProcess).toHaveBeenCalledTimes(2);
        expect(signal).toHaveBeenCalledOnce();
        expect(signal).toHaveBeenCalledWith(42);
    });

    it('skips the signal when the second identity check no longer matches', () => {
        const isExpectedProcess = vi.fn()
            .mockReturnValueOnce(true)
            .mockReturnValueOnce(false);
        const signal = vi.fn();
        expect(retireVerifiedLegacyCodexAdapters([legacySession()], {
            ...currentProfile,
            isExpectedProcess,
            signal,
        })).toBe(0);
        expect(signal).not.toHaveBeenCalled();
    });
});

function legacySession(): TrackedSession {
    return {
        startedBy: 'persisted',
        pid: 42,
        happySessionMetadataFromLocalWebhook: {
            path: '/workspace',
            host: 'host',
            homeDir: '/home/user',
            happyHomeDir: currentProfile.happyHomeDir,
            happyLibDir: currentProfile.happyLibDir,
            happyToolsDir: '/home/user/.happy/tools',
            hostPid: 42,
            startedBy: 'daemon',
            flavor: 'codex',
        },
    };
}
