import type { Metadata } from './storageTypes';
import { isRigMetadata } from './rig';

export type ExistingSessionFlavor =
    | 'codex-v4'
    | 'rig'
    | 'gemini'
    | 'openclaw'
    | 'agy'
    | 'acp'
    | 'unsupported';

export function classifyExistingSessionFlavor(
    metadata: Metadata | null | undefined,
): ExistingSessionFlavor {
    if (isRigMetadata(metadata)) return 'rig';
    if (metadata?.flavor === 'codex' && metadata.codexSyncVersion === 4) return 'codex-v4';
    if (metadata?.flavor === 'gemini') return 'gemini';
    if (metadata?.flavor === 'openclaw') return 'openclaw';
    if (metadata?.flavor === 'agy') return 'agy';
    if (metadata?.flavor === 'acp' || metadata?.flavor === 'opencode') return 'acp';
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
