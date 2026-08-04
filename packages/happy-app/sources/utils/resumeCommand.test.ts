import { describe, expect, it } from 'vitest';
import { buildResumeCommand, buildResumeCommandBlock } from './resumeCommand';

describe('buildResumeCommand', () => {
    it('never offers a native CLI resume command for unsupported providers', () => {
        expect(buildResumeCommand({
            flavor: 'gemini',
            codexThreadId: 'thread-1',
            codexSyncVersion: 4,
            happySessionId: 'happy-session-1',
        })).toBeNull();
    });

    it('builds the unified Happy resume command from the Happy Session ID', () => {
        expect(buildResumeCommand({
            flavor: 'codex',
            codexThreadId: 'thread-1',
            codexSyncVersion: 4,
            happySessionId: 'happy-session-1',
        })).toBe('happy resume happy-session-1');
    });

    it('returns null when the session is not on Codex Sync V4', () => {
        expect(buildResumeCommand({
            flavor: 'codex',
            codexThreadId: 'thread-1',
            codexSyncVersion: 3,
            happySessionId: 'happy-session-1',
        })).toBeNull();
    });

    it('never offers a resume command for a read-only provider child', () => {
        expect(buildResumeCommand({
            flavor: 'codex',
            codexThreadId: 'thread-1',
            codexSyncVersion: 4,
            codexReadOnly: true,
            happySessionId: 'provider-child',
        })).toBeNull();
    });
});

describe('buildResumeCommandBlock', () => {
    it('builds a copyable unified CLI instruction', () => {
        expect(buildResumeCommandBlock({
            flavor: 'codex',
            codexThreadId: 'thread-1',
            codexSyncVersion: 4,
            happySessionId: 'happy-session-1',
        })).toEqual({
            lines: ['happy resume happy-session-1'],
            copyText: 'happy resume happy-session-1',
        });
    });

    it('requires the Happy Session ID in addition to valid Codex metadata', () => {
        expect(buildResumeCommandBlock({
            flavor: 'codex',
            codexThreadId: 'thread-1',
            codexSyncVersion: 4,
        })).toBeNull();
    });
});
