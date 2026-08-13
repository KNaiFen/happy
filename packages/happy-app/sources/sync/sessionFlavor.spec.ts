import { describe, expect, it } from 'vitest';
import {
    classifyExistingSessionFlavor,
    isReadableExistingSession,
    isSupportedExistingSession,
} from './sessionFlavor';
import type { Metadata } from './storageTypes';

describe('classifyExistingSessionFlavor', () => {
    it.each([
        [{ flavor: 'codex', codexSyncVersion: 4 }, 'codex-v4'],
        [{ flavor: 'codex' }, 'codex-legacy-readonly'],
        [{ flavor: 'codex', codexSyncVersion: 3 }, 'codex-legacy-readonly'],
        [{ flavor: 'codex', codexSyncVersion: 5 }, 'codex-legacy-readonly'],
        [{ flavor: 'claude' }, 'unsupported'],
        [{ flavor: null }, 'unsupported'],
        [{ flavor: 'unknown' }, 'unsupported'],
        [{ flavor: 'gemini' }, 'unsupported'],
        [{ flavor: 'openclaw' }, 'unsupported'],
        [{ flavor: 'agy' }, 'unsupported'],
        [{ flavor: 'acp' }, 'unsupported'],
        [{ flavor: 'opencode' }, 'unsupported'],
    ])('classifies %j as %s', (metadata, expected) => {
        expect(classifyExistingSessionFlavor(metadata as Metadata)).toBe(expected);
    });

    it('retains explicit legacy Codex history without making it supported for writes', () => {
        const legacy = { flavor: 'codex', codexSyncVersion: 3 } as Metadata;
        expect(isReadableExistingSession(legacy)).toBe(true);
        expect(isSupportedExistingSession(legacy)).toBe(false);
        expect(isReadableExistingSession({ flavor: 'unknown' } as Metadata)).toBe(false);
    });
});
