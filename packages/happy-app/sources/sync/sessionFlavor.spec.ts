import { describe, expect, it } from 'vitest';
import { classifyExistingSessionFlavor } from './sessionFlavor';
import type { Metadata } from './storageTypes';

function metadata(value: Partial<Metadata>): Metadata {
    return { path: '/workspace', host: 'test', ...value } as Metadata;
}

describe('classifyExistingSessionFlavor', () => {
    it.each([
        [{ flavor: 'codex', codexSyncVersion: 4 }, 'codex-v4'],
        [{ flavor: 'codex' }, 'unsupported'],
        [{ flavor: 'claude' }, 'unsupported'],
        [{ flavor: null }, 'unsupported'],
        [{ flavor: 'unknown' }, 'unsupported'],
        [{ flavor: 'gemini' }, 'gemini'],
        [{ flavor: 'openclaw' }, 'openclaw'],
        [{ flavor: 'agy' }, 'agy'],
        [{ flavor: 'acp' }, 'acp'],
        [{ flavor: 'opencode' }, 'acp'],
    ])('classifies %j as %s', (metadata, expected) => {
        expect(classifyExistingSessionFlavor(metadata as Metadata)).toBe(expected);
    });

    it('recognizes Rig by client identity before provider flavor', () => {
        expect(classifyExistingSessionFlavor(metadata({
            client: { id: 'rig', name: 'Rig', version: '1', provider: 'anthropic' },
            flavor: 'claude',
        }))).toBe('rig');
    });
});
