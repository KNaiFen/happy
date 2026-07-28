import { execFileSync } from 'node:child_process';

export interface CodexCliVersion {
    major: number;
    minor: number;
    patch: number;
}

export const MINIMUM_CODEX_CLI_VERSION: CodexCliVersion = {
    major: 0,
    minor: 145,
    patch: 0,
};

export const CODEX_CLI_VERSION_PROBE_TIMEOUT_MS = 5_000;

export function parseCodexCliVersion(output: string): CodexCliVersion | null {
    const match = output.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    const version = {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    };
    return Object.values(version).every(Number.isSafeInteger) ? version : null;
}

export function readCodexCliVersion(): CodexCliVersion | null {
    try {
        const output = execFileSync('codex', ['--version'], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: CODEX_CLI_VERSION_PROBE_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            maxBuffer: 64 * 1024,
            shell: process.platform === 'win32',
            windowsHide: true,
        });
        return parseCodexCliVersion(output.trim());
    } catch {
        return null;
    }
}

export function isCodexCliVersionAtLeast(
    version: CodexCliVersion | null,
    minimum: CodexCliVersion,
): boolean {
    if (!version) return false;
    if (version.major !== minimum.major) return version.major > minimum.major;
    if (version.minor !== minimum.minor) return version.minor > minimum.minor;
    return version.patch >= minimum.patch;
}

export function formatCodexCliVersion(version: CodexCliVersion): string {
    return `${version.major}.${version.minor}.${version.patch}`;
}

export function assertMinimumCodexCliVersion(
    version: CodexCliVersion | null = readCodexCliVersion(),
): CodexCliVersion {
    const minimum = formatCodexCliVersion(MINIMUM_CODEX_CLI_VERSION);
    if (!version) {
        throw new Error(`Codex CLI ${minimum} or newer is required, but Codex is not installed or its version could not be read.`);
    }
    if (!isCodexCliVersionAtLeast(version, MINIMUM_CODEX_CLI_VERSION)) {
        throw new Error(
            `Codex CLI ${minimum} or newer is required; found ${formatCodexCliVersion(version)}.`,
        );
    }
    return version;
}
