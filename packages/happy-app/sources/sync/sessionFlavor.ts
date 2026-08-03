import type { Metadata } from './storageTypes';

export type ExistingSessionFlavor =
    | 'codex-v4'
    | 'unsupported';

export function classifyExistingSessionFlavor(
    metadata: Metadata | null | undefined,
): ExistingSessionFlavor {
    if (metadata?.flavor === 'codex' && metadata.codexSyncVersion === 4) return 'codex-v4';
    return 'unsupported';
}

export function isSupportedExistingSession(metadata: Metadata | null | undefined): boolean {
    return classifyExistingSessionFlavor(metadata) !== 'unsupported';
}

export function assertSupportedExistingSession(metadata: Metadata | null | undefined): void {
    if (!isSupportedExistingSession(metadata)) {
        throw new Error('This session provider is no longer supported and the session is read-only');
    }
}
