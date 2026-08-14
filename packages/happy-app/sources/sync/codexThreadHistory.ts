import { z } from 'zod';

import { encodeBase64 } from '@/encryption/base64';
import { apiSocket } from './apiSocket';
import { sync } from './sync';
import {
    AgentStateSchema,
    MetadataSchema,
    type Session,
} from './storageTypes';
import { isSupportedExistingSession } from './sessionFlavor';

const RawSessionSchema = z.object({
    id: z.string().min(1),
    seq: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    archivedAt: z.number().nullable().optional().default(null),
    metadata: z.string(),
    metadataVersion: z.number().int().nonnegative(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number().int().nonnegative(),
    dataEncryptionKey: z.string().nullable(),
    originMachineId: z.string().nullable(),
    machineDeletedAt: z.number().nullable(),
}).passthrough();

const SessionPageSchema = z.object({
    sessions: z.array(RawSessionSchema).max(200),
    nextCursor: z.string().max(4_096).nullable(),
    hasNext: z.boolean(),
});

const CodexThreadHistoryRowSchema = z.object({
    threadId: z.string().min(1).max(256),
    title: z.string().max(4_096),
    preview: z.string().max(16_384),
    cwd: z.string().min(1).max(8_192),
    createdAt: z.number(),
    updatedAt: z.number(),
    recencyAt: z.number(),
    source: z.enum(['cli', 'vscode', 'exec', 'appServer', 'unknown']),
    status: z.enum(['notLoaded', 'idle', 'active', 'systemError']),
});

const CodexThreadListResultSchema = z.object({
    type: z.literal('success'),
    threads: z.array(CodexThreadHistoryRowSchema).max(50),
    nextCursor: z.string().max(4_096).nullable(),
});

const CodexOpenThreadResultSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('success'),
        disposition: z.enum(['existing-active', 'existing-resumed', 'created']),
        sessionId: z.string().min(1).max(256),
    }),
    z.object({
        type: z.literal('resumeMaterialRequired'),
        sessionId: z.string().min(1).max(256),
    }),
    z.object({
        type: z.literal('blocked'),
        reason: z.enum([
            'threadUnavailable',
            'externalThreadActive',
            'gatewayRecovering',
            'legacySession',
            'invalidBinding',
        ]),
        errorMessage: z.string().min(1).max(8_192),
    }),
    z.object({
        type: z.literal('error'),
        errorCode: z.enum(['operationFailed', 'outcomeUnknown']),
        errorMessage: z.string().min(1).max(8_192),
    }),
]);

export type CodexThreadHistoryStatus = z.infer<typeof CodexThreadHistoryRowSchema>['status'];
export type CodexThreadHistorySource = z.infer<typeof CodexThreadHistoryRowSchema>['source'];
export type CodexThreadHistoryRow = z.infer<typeof CodexThreadHistoryRowSchema>;

export type CodexThreadBinding =
    | {
        type: 'bound';
        sessionId: string;
        active: boolean;
        legacy: boolean;
        session: Omit<Session, 'presence'> & { presence?: 'online' | number };
    }
    | {
        type: 'duplicate';
        sessionIds: string[];
    };

export interface CodexThreadBindings {
    byThreadId: Map<string, CodexThreadBinding>;
    scannedSessionCount: number;
}

export interface CodexOpenThreadDefaults {
    permissionMode: string;
    modelMode: string;
    effortLevel: string | null;
}

export type CodexOpenThreadResult = z.infer<typeof CodexOpenThreadResultSchema>;

export async function listCodexThreads(options: {
    machineId: string;
    directory: string;
    cursor?: string | null;
    searchTerm?: string | null;
}): Promise<{ type: 'success'; threads: CodexThreadHistoryRow[]; nextCursor: string | null }> {
    const result: unknown = await apiSocket.machineRPC(
        options.machineId,
        'codex-list-threads',
        {
            directory: options.directory,
            cursor: options.cursor ?? null,
            searchTerm: options.searchTerm?.trim() || null,
        },
    );
    return CodexThreadListResultSchema.parse(result);
}

export async function scanCodexThreadBindings(machineId: string): Promise<CodexThreadBindings> {
    const rawSessions = [] as Array<z.infer<typeof RawSessionSchema>>;
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 1_000; page += 1) {
        const query = new URLSearchParams({
            originMachineId: machineId,
            limit: '200',
            ...(cursor ? { cursor } : {}),
        });
        const response = await apiSocket.request(`/v2/sessions?${query.toString()}`);
        if (!response.ok) {
            throw new Error(`Session binding scan failed with HTTP ${response.status}`);
        }
        const parsed = SessionPageSchema.safeParse(await response.json());
        if (!parsed.success) {
            throw new Error('Session binding scan returned an invalid page');
        }
        for (const session of parsed.data.sessions) {
            if (session.originMachineId !== machineId) {
                throw new Error('Session binding scan crossed the requested machine boundary');
            }
            rawSessions.push(session);
        }
        if (!parsed.data.hasNext) break;
        const nextCursor = parsed.data.nextCursor;
        if (!nextCursor || seenCursors.has(nextCursor)) {
            throw new Error('Session binding scan returned an invalid cursor');
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
        if (page === 999) throw new Error('Session binding scan exceeded 1,000 pages');
    }

    const keys = new Map<string, Uint8Array | null>();
    for (const session of rawSessions) {
        if (!session.dataEncryptionKey) {
            keys.set(session.id, null);
            continue;
        }
        const key = await sync.encryption.decryptEncryptionKey(session.dataEncryptionKey);
        if (!key) {
            throw new Error('A Happy session key could not be decrypted during binding scan');
        }
        keys.set(session.id, key);
    }
    try {
        await sync.encryption.initializeSessions(keys);
    } finally {
        // initializeSessions copies independent keys into their contexts;
        // scan-local buffers must never outlive this handoff.
        for (const key of keys.values()) key?.fill(0);
        keys.clear();
    }

    const grouped = new Map<string, Array<Extract<CodexThreadBinding, { type: 'bound' }>>>();
    for (const raw of rawSessions) {
        const encryption = sync.encryption.getSessionEncryption(raw.id);
        if (!encryption) {
            throw new Error('A Happy session encryption context is missing during binding scan');
        }
        const metadata = MetadataSchema.safeParse(
            await encryption.decryptMetadata(raw.metadataVersion, raw.metadata),
        );
        if (!metadata.success) {
            throw new Error('A Happy session metadata record could not be decrypted during binding scan');
        }
        const agentStateValue = raw.agentState
            ? await encryption.decryptAgentState(raw.agentStateVersion, raw.agentState)
            : null;
        const agentState = agentStateValue === null
            ? null
            : AgentStateSchema.safeParse(agentStateValue);
        if (agentState !== null && !agentState.success) {
            throw new Error('A Happy session state record could not be decrypted during binding scan');
        }
        if (metadata.data.flavor !== 'codex' || !metadata.data.codexThreadId) continue;

        const binding: Extract<CodexThreadBinding, { type: 'bound' }> = {
            type: 'bound',
            sessionId: raw.id,
            active: raw.active,
            // Historical sessions remain readable, but only an explicit Codex
            // Sync v4 marker may cross the writable resume boundary.
            legacy: raw.dataEncryptionKey === null || !isSupportedExistingSession(metadata.data),
            session: {
                id: raw.id,
                seq: raw.seq,
                createdAt: raw.createdAt,
                updatedAt: raw.updatedAt,
                active: raw.active,
                activeAt: raw.activeAt,
                archivedAt: raw.archivedAt,
                metadata: metadata.data,
                metadataVersion: raw.metadataVersion,
                originMachineId: raw.originMachineId,
                machineDeletedAt: raw.machineDeletedAt,
                agentState: agentState === null ? null : agentState.data,
                agentStateVersion: raw.agentStateVersion,
                thinking: false,
                thinkingAt: 0,
            },
        };
        const bindings = grouped.get(metadata.data.codexThreadId) ?? [];
        bindings.push(binding);
        grouped.set(metadata.data.codexThreadId, bindings);
    }

    const byThreadId = new Map<string, CodexThreadBinding>();
    for (const [threadId, bindings] of grouped) {
        byThreadId.set(threadId, bindings.length === 1
            ? bindings[0]
            : { type: 'duplicate', sessionIds: bindings.map((binding) => binding.sessionId) });
    }
    return { byThreadId, scannedSessionCount: rawSessions.length };
}

export async function openCodexThread(options: {
    machineId: string;
    directory: string;
    thread: CodexThreadHistoryRow;
    binding?: CodexThreadBinding;
    defaults: CodexOpenThreadDefaults;
}): Promise<CodexOpenThreadResult> {
    if (options.binding?.type === 'duplicate') {
        return {
            type: 'blocked',
            reason: 'invalidBinding',
            errorMessage: 'Multiple Happy sessions are bound to this Codex thread.',
        };
    }
    if (options.binding?.type === 'bound' && options.binding.legacy) {
        return {
            type: 'blocked',
            reason: 'legacySession',
            errorMessage: 'This session uses legacy account encryption and cannot transfer resume material.',
        };
    }

    let externalDataEncryptionKey: string | undefined;
    if (!options.binding) {
        const key = await sync.encryption.deriveCodexResumeSessionDataKey(
            options.machineId,
            options.thread.threadId,
        );
        try {
            externalDataEncryptionKey = encodeBase64(key, 'base64');
        } finally {
            key.fill(0);
        }
    }

    const request = {
        directory: options.directory,
        threadId: options.thread.threadId,
        defaults: {
            permissionMode: options.defaults.permissionMode,
            modelMode: options.defaults.modelMode,
            ...(options.defaults.effortLevel ? { effortLevel: options.defaults.effortLevel } : {}),
        },
        ...(options.binding?.type === 'bound'
            ? { binding: { sessionId: options.binding.sessionId } }
            : { externalDataEncryptionKey }),
    };

    let result = await callOpen(options.machineId, request);
    if (result.type === 'resumeMaterialRequired') {
        if (options.binding?.type !== 'bound' || result.sessionId !== options.binding.sessionId) {
            return {
                type: 'blocked',
                reason: 'invalidBinding',
                errorMessage: 'The daemon requested resume material for an unexpected Happy session.',
            };
        }
        const key = sync.encryption.getIndependentSessionDataKey(options.binding.sessionId);
        if (!key) {
            return {
                type: 'blocked',
                reason: 'legacySession',
                errorMessage: 'This session has no independent resume key.',
            };
        }
        let dataEncryptionKey: string;
        try {
            dataEncryptionKey = encodeBase64(key, 'base64');
        } finally {
            key.fill(0);
        }
        result = await callOpen(options.machineId, {
            ...request,
            binding: {
                sessionId: options.binding.sessionId,
                dataEncryptionKey,
            },
        });
    }

    if (result.type === 'success' && options.binding?.type === 'bound') {
        if (result.sessionId !== options.binding.sessionId || result.disposition === 'created') {
            return {
                type: 'blocked',
                reason: 'invalidBinding',
                errorMessage: 'The daemon returned a different Happy session for this Codex thread.',
            };
        }
    }
    if (result.type === 'success' && !options.binding && result.disposition === 'existing-resumed') {
        return {
            type: 'blocked',
            reason: 'invalidBinding',
            errorMessage: 'The daemon resumed an existing Happy binding that the App did not verify.',
        };
    }

    if (result.type === 'success' && options.binding?.type === 'bound') {
        sync.hydrateSessionFromHistory({
            ...options.binding.session,
            active: true,
            activeAt: Math.max(options.binding.session.activeAt, Date.now()),
            archivedAt: null,
        });
    }
    return result;
}

async function callOpen(machineId: string, request: Record<string, unknown>): Promise<CodexOpenThreadResult> {
    try {
        const result: unknown = await apiSocket.machineRPC(machineId, 'codex-open-thread', request);
        return CodexOpenThreadResultSchema.parse(result);
    } catch {
        return {
            type: 'error',
            errorCode: 'outcomeUnknown',
            errorMessage: 'The Codex thread operation outcome is not yet known. Retry after the machine state refreshes.',
        };
    }
}
