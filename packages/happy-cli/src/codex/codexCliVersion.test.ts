import { describe, expect, it } from 'vitest';
import {
    assertMinimumCodexCliVersion,
    isCodexCliVersionAtLeast,
    MINIMUM_CODEX_CLI_VERSION,
    parseCodexCliVersion,
} from './codexCliVersion';

describe('Codex CLI version gate', () => {
    it('parses the official version output', () => {
        expect(parseCodexCliVersion('codex-cli 0.145.0')).toEqual({ major: 0, minor: 145, patch: 0 });
        expect(parseCodexCliVersion('unexpected')).toBeNull();
    });

    it('accepts 0.145.0 and newer versions', () => {
        expect(isCodexCliVersionAtLeast({ major: 0, minor: 145, patch: 0 }, MINIMUM_CODEX_CLI_VERSION)).toBe(true);
        expect(isCodexCliVersionAtLeast({ major: 0, minor: 146, patch: 0 }, MINIMUM_CODEX_CLI_VERSION)).toBe(true);
        expect(isCodexCliVersionAtLeast({ major: 1, minor: 0, patch: 0 }, MINIMUM_CODEX_CLI_VERSION)).toBe(true);
    });

    it('rejects missing and older versions with an actionable error', () => {
        expect(() => assertMinimumCodexCliVersion(null)).toThrow('0.145.0 or newer');
        expect(() => assertMinimumCodexCliVersion({ major: 0, minor: 144, patch: 9 })).toThrow('found 0.144.9');
    });
});
