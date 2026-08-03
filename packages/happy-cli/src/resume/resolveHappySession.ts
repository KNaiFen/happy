import { z } from 'zod';

import type { Metadata } from '@/api/types';

export const ResumableMetadataSchema = z.object({
    path: z.string().min(1),
    flavor: z.literal('codex'),
    codexSyncVersion: z.literal(4),
    codexThreadId: z.string().min(1).optional(),
}).passthrough();

export type ResumableHappySession = {
    id: string;
    active: boolean;
    metadata: Metadata;
};

export type ReconnectableHappySession = ResumableHappySession & {
    seq: number;
    metadataVersion: number;
    agentStateVersion: number;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
};

export function parseResumableMetadata(sessionId: string, metadata: unknown): Metadata {
    try {
        return ResumableMetadataSchema.parse(metadata) as Metadata;
    } catch {
        throw new Error(`Happy session ${sessionId} is not a resumable Codex Sync v4 session.`);
    }
}

export function resolveSessionRecordByPrefix<T extends { id: string }>(records: T[], sessionId: string): T {
    const trimmed = sessionId.trim();
    if (!trimmed) {
        throw new Error('Happy session ID is required: happy resume <session-id>');
    }

    const matches = records.filter((record) => record.id.startsWith(trimmed));
    if (matches.length === 0) {
        throw new Error(`No Happy session found matching "${trimmed}"`);
    }
    if (matches.length > 1) {
        throw new Error(`Ambiguous Happy session "${trimmed}" matches ${matches.length} sessions. Be more specific.`);
    }
    return matches[0];
}
