import { describe, expect, it } from 'vitest';
import type { DecryptedSession } from './api';
import { isSupportedAgentSession } from './sessionClassification';

function session(metadata: Record<string, unknown>): DecryptedSession {
    return { metadata } as DecryptedSession;
}

describe('isSupportedAgentSession', () => {
    it.each([
        [{ flavor: 'codex', codexSyncVersion: 4 }, true],
        [{ flavor: 'codex', codexSyncVersion: 3 }, false],
        [{ flavor: 'claude' }, false],
        [{}, false],
        [{ flavor: 'unknown' }, false],
        [{ flavor: 'gemini' }, false],
        [{ flavor: 'openclaw' }, false],
        [{ flavor: 'agy' }, false],
    ])('classifies metadata %j as %s', (metadata, expected) => {
        expect(isSupportedAgentSession(session(metadata))).toBe(expected);
    });
});
