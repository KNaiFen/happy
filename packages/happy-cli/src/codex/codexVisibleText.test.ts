import { describe, expect, it } from 'vitest';
import { stripLegacyHappySystemBlocks } from './codexVisibleText';

describe('stripLegacyHappySystemBlocks', () => {
    it('keeps real user text while removing only marked legacy scaffolding', () => {
        expect(stripLegacyHappySystemBlocks([
            '<happy-system>',
            'legacy injected instruction',
            '</happy-system>',
            'real user text',
        ].join('\n'))).toBe('real user text');
        expect(stripLegacyHappySystemBlocks('ordinary text')).toBe('ordinary text');
    });
});
