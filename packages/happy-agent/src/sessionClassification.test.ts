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
        [{ flavor: 'gemini' }, true],
        [{ flavor: 'openclaw' }, true],
        [{ flavor: 'agy' }, true],
    ])('classifies metadata %j as %s', (metadata, expected) => {
        expect(isSupportedAgentSession(session(metadata))).toBe(expected);
    });
});
