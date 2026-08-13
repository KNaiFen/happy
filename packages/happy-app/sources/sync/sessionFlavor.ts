import type { Metadata } from './storageTypes';

export type ExistingSessionFlavor =
    | 'codex-v4'
    | 'codex-legacy-readonly'
    | 'unsupported';

export function classifyExistingSessionFlavor(
    metadata: Metadata | null | undefined,
): ExistingSessionFlavor {
    if (metadata?.flavor !== 'codex') return 'unsupported';
    if (metadata.codexSyncVersion === 4) return 'codex-v4';
    return 'codex-legacy-readonly';
}

/** A retained session can render its encrypted history but need not be writable. */
export function isReadableExistingSession(metadata: Metadata | null | undefined): boolean {
    return classifyExistingSessionFlavor(metadata) !== 'unsupported';
}

export function isCodexLegacyReadOnlySession(metadata: Metadata | null | undefined): boolean {
    return classifyExistingSessionFlavor(metadata) === 'codex-legacy-readonly';
}

/** Only an explicit Sync v4 marker permits a session to reach mutation paths. */
export function isSupportedExistingSession(metadata: Metadata | null | undefined): boolean {
    return classifyExistingSessionFlavor(metadata) === 'codex-v4';
}

export function assertSupportedExistingSession(metadata: Metadata | null | undefined): void {
    const flavor = classifyExistingSessionFlavor(metadata);
    if (flavor === 'codex-legacy-readonly') {
        throw new Error('Legacy Codex sessions are read-only');
    }
    if (flavor !== 'codex-v4') {
        throw new Error('This session provider is no longer supported and the session is read-only');
    }
}
