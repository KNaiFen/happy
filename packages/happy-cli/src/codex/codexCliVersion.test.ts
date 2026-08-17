import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFileSync } = vi.hoisted(() => ({
    mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    execFileSync: mockExecFileSync,
}));

import {
    assertMinimumCodexCliVersion,
    CODEX_CLI_VERSION_PROBE_TIMEOUT_MS,
    isCodexCliVersionAtLeast,
    MINIMUM_CODEX_CLI_VERSION,
    parseCodexCliVersion,
    readCodexCliVersion,
} from './codexCliVersion';

describe('Codex CLI version gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('parses the official version output', () => {
        expect(parseCodexCliVersion('codex-cli 0.145.0')).toEqual({ major: 0, minor: 145, patch: 0 });
        expect(parseCodexCliVersion('unexpected')).toBeNull();
    });

    it('accepts 0.147.0 and newer versions', () => {
        expect(isCodexCliVersionAtLeast({ major: 0, minor: 147, patch: 0 }, MINIMUM_CODEX_CLI_VERSION)).toBe(true);
        expect(isCodexCliVersionAtLeast({ major: 0, minor: 148, patch: 0 }, MINIMUM_CODEX_CLI_VERSION)).toBe(true);
        expect(isCodexCliVersionAtLeast({ major: 1, minor: 0, patch: 0 }, MINIMUM_CODEX_CLI_VERSION)).toBe(true);
    });

    it('rejects missing and older versions with an actionable error', () => {
        expect(() => assertMinimumCodexCliVersion(null)).toThrow('0.147.0 or newer');
        expect(() => assertMinimumCodexCliVersion({ major: 0, minor: 146, patch: 9 })).toThrow('found 0.146.9');
    });

    it('bounds the provider version probe', () => {
        mockExecFileSync.mockReturnValue('codex-cli 0.147.0');

        expect(readCodexCliVersion()).toEqual({ major: 0, minor: 147, patch: 0 });
        expect(mockExecFileSync).toHaveBeenCalledWith(
            'codex',
            ['--version'],
            expect.objectContaining({
                timeout: CODEX_CLI_VERSION_PROBE_TIMEOUT_MS,
                killSignal: 'SIGKILL',
                maxBuffer: 64 * 1024,
                shell: process.platform === 'win32',
            }),
        );
    });

    it('treats a timed-out provider version probe as unreadable', () => {
        mockExecFileSync.mockImplementation(() => {
            throw new Error('timed out');
        });

        expect(readCodexCliVersion()).toBeNull();
    });
});
