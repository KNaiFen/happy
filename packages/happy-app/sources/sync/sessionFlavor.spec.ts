import { describe, expect, it } from 'vitest';
import { classifyExistingSessionFlavor } from './sessionFlavor';
import type { Metadata } from './storageTypes';

describe('classifyExistingSessionFlavor', () => {
    it.each([
        [{ flavor: 'codex', codexSyncVersion: 4 }, 'codex-v4'],
        [{ flavor: 'codex' }, 'unsupported'],
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
});
