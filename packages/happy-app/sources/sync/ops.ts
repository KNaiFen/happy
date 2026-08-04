/**
 * Session operations for remote procedure calls
 * Provides strictly typed functions for all session-related RPC operations
 */

import { apiSocket } from './apiSocket';
import { sync } from './sync';
import { storage } from './storage';
import { isCodexV4SyncEligible } from './codexV4ClientRegistry';
import type { MachineMetadata, SessionAgentModesPatch } from './storageTypes';
import { markAgentModePushPending, clearAgentModePushPending, type AgentModeField } from './agentModesPending';
import { codexV4RequestResponse, findActiveCodexV4Turn } from './codexV4Commands';
import { codexV4QueuedMessages } from './codexV4Projection';
import {
    assertCodexSessionWritable,
    isCodexGatewaySession,
    isCodexSessionReadOnly,
    resolveCodexGatewayBinding,
    resolveCodexV4SessionCapabilities,
} from './codexV4Capabilities';
import { isSessionMachineDeleted } from './sessionMachineAccess';
import { assertSupportedExistingSession } from './sessionFlavor';
import { encodeBase64 } from '@/encryption/base64';

export type { SessionAgentModesPatch };

function assertSessionInteractionAllowed(sessionId: string): void {
    const state = storage.getState();
    const session = state.sessions[sessionId];
    if (
        session
        && isSessionMachineDeleted(session, state.machines, state.machinesLoaded)
    ) {
        throw new Error('The source machine was deleted; this session is read-only');
    }
    assertSupportedExistingSession(session?.metadata);
    assertCodexSessionWritable(session?.metadata);
}

// Strict type definitions for all operations

// Mode change operation types
interface SessionModeChangeRequest {
    to: 'remote' | 'local';
}

interface SessionGoalActionRequest {
    action: 'clear' | 'stop' | 'edit';
    objective?: string;
}

// Bash operation types
interface SessionBashRequest {
    command: string;
    cwd?: string;
    timeout?: number;
}

interface SessionBashResponse {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}

// Read file operation types
interface SessionReadFileRequest {
    path: string;
}

interface SessionReadFileResponse {
    success: boolean;
    content?: string; // base64 encoded
    error?: string;
}

// Write file operation types
interface SessionWriteFileRequest {
    path: string;
    content: string; // base64 encoded
    expectedHash?: string | null;
}

interface SessionWriteFileResponse {
    success: boolean;
    hash?: string;
    error?: string;
}

// List directory operation types
interface SessionListDirectoryRequest {
    path: string;
}

interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number;
}

interface SessionListDirectoryResponse {
    success: boolean;
    entries?: DirectoryEntry[];
    error?: string;
}

// Directory tree operation types
interface SessionGetDirectoryTreeRequest {
    path: string;
    maxDepth: number;
}

interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modified?: number;
    children?: TreeNode[];
}

interface SessionGetDirectoryTreeResponse {
    success: boolean;
    tree?: TreeNode;
    error?: string;
}

// Ripgrep operation types
interface SessionRipgrepRequest {
    args: string[];
    cwd?: string;
}

interface SessionRipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

// Kill session operation types
interface SessionKillRequest {
    // No parameters needed
}

interface SessionKillResponse {
    success: boolean;
    message: string;
    outcome: 'stopped' | 'missing' | 'unverified' | 'failed';
}

// Response types for spawn session
export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

type ResumeSessionRpcResult =
    | SpawnSessionResult
    | { type: 'resumeMaterialRequired'; sessionId: string };

type ResumeSessionRpcRequest = {
    operationId: string;
    sessionId: string;
    model?: string;
    permissionMode?: string;
    dataEncryptionKey?: string;
};

const RESUME_SESSION_RPC_TIMEOUT_MS = 120_000;

// Options for spawning a session
export interface SpawnSessionOptions {
    operationId?: string;
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    agent?: 'codex';
    permissionMode?: string;
    modelMode?: string;
    effortLevel?: string;
    /**
     * If set, the daemon spawns Codex with `--resume <id>` so the new Happy
     * session attaches to an app-server thread created by fork / duplicate.
     */
    resumeCodexThreadId?: string;
    /** Happy session id this fork was branched from (lineage). */
    parentSessionId?: string;
    /** Happy message id used as the rewind point (only set for "duplicate"). */
    forkedFromMessageId?: string;
    /** Marks the spawned session as a hidden side chat of `parentSessionId`. */
    isSideChat?: boolean;
}

export interface CodexForkThreadOptions {
    machineId: string;
    /** Working directory of the source session, passed to Codex thread/fork. */
    directory: string;
    /** Source Codex app-server thread id (Session.metadata.codexThreadId). */
    codexThreadId: string;
}

export type CodexForkThreadResult =
    | { type: 'success'; newCodexThreadId: string }
    | { type: 'error'; errorMessage: string };

export interface CodexRewindPoint {
    itemId: string;
    text: string;
    timestamp: number;
}

export type CodexListRewindPointsResult =
    | { type: 'success'; points: CodexRewindPoint[] }
    | { type: 'error'; errorMessage: string };

export interface ResumeSessionOptions {
    operationId?: string;
    machineId: string;
    sessionId: string;
}

// Exported session operation functions

/**
 * Spawn a new remote session on a specific machine
 */
export async function machineSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {

    const { machineId, directory, approvedNewDirectoryCreation = false, token, agent, permissionMode, modelMode, effortLevel, resumeCodexThreadId, parentSessionId, forkedFromMessageId, isSideChat } = options;
    const operationId = options.operationId ?? sync.generateOperationId();

    try {
        const result = await apiSocket.machineRPC<SpawnSessionResult, {
            type: 'spawn-in-directory'
            directory: string
            approvedNewDirectoryCreation?: boolean,
            operationId: string,
            token?: string,
            agent?: 'codex',
            permissionMode?: string,
            modelMode?: string,
            effortLevel?: string,
            resumeCodexThreadId?: string,
            parentSessionId?: string,
            forkedFromMessageId?: string,
            isSideChat?: boolean,
        }>(
            machineId,
            'spawn-happy-session',
            { type: 'spawn-in-directory', operationId, directory, approvedNewDirectoryCreation, token, agent, permissionMode, modelMode, effortLevel, resumeCodexThreadId, parentSessionId, forkedFromMessageId, isSideChat }
        );
        return result;
    } catch (error) {
        // Handle RPC errors
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to spawn session'
        };
    }
}

export async function codexForkThread(options: CodexForkThreadOptions): Promise<CodexForkThreadResult> {
    const { machineId, directory, codexThreadId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexForkThreadResult, {
            directory: string;
            codexThreadId: string;
        }>(
            machineId,
            'codex-fork-thread',
            { directory, codexThreadId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to fork Codex thread',
        };
    }
}

export async function codexDuplicateThread(
    options: CodexForkThreadOptions & { cutAfterItemId: string },
): Promise<CodexForkThreadResult> {
    const { machineId, directory, codexThreadId, cutAfterItemId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexForkThreadResult, {
            directory: string;
            codexThreadId: string;
            cutAfterItemId: string;
        }>(
            machineId,
            'codex-duplicate-thread',
            { directory, codexThreadId, cutAfterItemId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to duplicate Codex thread',
        };
    }
}

export async function codexListRewindPoints(
    options: CodexForkThreadOptions,
): Promise<CodexListRewindPointsResult> {
    const { machineId, directory, codexThreadId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexListRewindPointsResult, {
            directory: string;
            codexThreadId: string;
        }>(
            machineId,
            'codex-list-rewind-points',
            { directory, codexThreadId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to list Codex rewind points',
        };
    }
}

export async function machineResumeSession(options: ResumeSessionOptions & { model?: string; permissionMode?: string }): Promise<SpawnSessionResult> {
    const { machineId, sessionId, model, permissionMode } = options;

    try {
        assertSessionInteractionAllowed(sessionId);
        const operationId = options.operationId ?? sync.generateOperationId();
        const request: ResumeSessionRpcRequest = {
            operationId,
            sessionId,
            model,
            permissionMode,
        };
        let result = await apiSocket.machineRPC<ResumeSessionRpcResult, ResumeSessionRpcRequest>(
            machineId,
            'resume-happy-session',
            request,
            { timeoutMs: RESUME_SESSION_RPC_TIMEOUT_MS },
        );

        if (result.type === 'resumeMaterialRequired') {
            if (result.sessionId !== sessionId) {
                return {
                    type: 'error',
                    errorMessage: 'The daemon requested resume material for an unexpected Happy session.',
                };
            }
            const key = sync.encryption.getIndependentSessionDataKey(sessionId);
            if (!key) {
                return {
                    type: 'error',
                    errorMessage: 'This session has no independent resume key.',
                };
            }
            result = await apiSocket.machineRPC<ResumeSessionRpcResult, ResumeSessionRpcRequest>(
                machineId,
                'resume-happy-session',
                {
                    ...request,
                    dataEncryptionKey: encodeBase64(key, 'base64'),
                },
                { timeoutMs: RESUME_SESSION_RPC_TIMEOUT_MS },
            );
            if (result.type === 'resumeMaterialRequired') {
                return {
                    type: 'error',
                    errorMessage: 'The daemon did not accept the session resume material.',
                };
            }
        }
        if (result.type === 'success' && result.sessionId !== sessionId) {
            return {
                type: 'error',
                errorMessage: 'The daemon resumed a different Happy session.',
            };
        }
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to resume session',
        };
    }
}

/**
 * Permanently remove a machine from the server. Sessions spawned by the
 * machine are preserved; only the Machine row and its AccessKeys are deleted.
 */
export async function machineDelete(machineId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/machines/${machineId}`, {
            method: 'DELETE'
        });
        if (response.ok) {
            return { success: true };
        }
        const error = await response.text();
        return { success: false, message: error || 'Failed to delete machine' };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Stop the daemon on a specific machine
 */
export async function machineStopDaemon(machineId: string): Promise<{ message: string }> {
    const result = await apiSocket.machineRPC<{ message: string }, {}>(
        machineId,
        'stop-daemon',
        {}
    );
    return result;
}

/**
 * Execute a bash command on a specific machine
 */
export async function machineBash(
    machineId: string,
    command: string,
    cwd: string
): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
}> {
    try {
        const result = await apiSocket.machineRPC<{
            success: boolean;
            stdout: string;
            stderr: string;
            exitCode: number;
        }, {
            command: string;
            cwd: string;
        }>(
            machineId,
            'bash',
            { command, cwd }
        );
        return result;
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1
        };
    }
}

/**
 * Update machine metadata with optimistic concurrency control and automatic retry
 */
export async function machineUpdateMetadata(
    machineId: string,
    metadata: MachineMetadata,
    expectedVersion: number,
    maxRetries: number = 3
): Promise<{ version: number; metadata: string }> {
    let currentVersion = expectedVersion;
    let currentMetadata = { ...metadata };
    let retryCount = 0;

    const machineEncryption = sync.encryption.getMachineEncryption(machineId);
    if (!machineEncryption) {
        throw new Error(`Machine encryption not found for ${machineId}`);
    }

    while (retryCount < maxRetries) {
        const encryptedMetadata = await machineEncryption.encryptRaw(currentMetadata);

        const result = await apiSocket.emitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
            message?: string;
        }>('machine-update-metadata', {
            machineId,
            metadata: encryptedMetadata,
            expectedVersion: currentVersion
        });

        if (result.result === 'success') {
            return {
                version: result.version!,
                metadata: result.metadata!
            };
        } else if (result.result === 'version-mismatch') {
            // Get the latest version and metadata from the response
            currentVersion = result.version!;
            const latestMetadata = await machineEncryption.decryptRaw(result.metadata!) as MachineMetadata;

            // Merge our changes with the latest metadata
            // Preserve the displayName we're trying to set, but use latest values for other fields
            currentMetadata = {
                ...latestMetadata,
                displayName: metadata.displayName // Keep our intended displayName change
            };

            retryCount++;

            // If we've exhausted retries, throw error
            if (retryCount >= maxRetries) {
                throw new Error(`Failed to update after ${maxRetries} retries due to version conflicts`);
            }

            // Otherwise, loop will retry with updated version and merged metadata
        } else {
            throw new Error(result.message || 'Failed to update machine metadata');
        }
    }

    throw new Error('Unexpected error in machineUpdateMetadata');
}

/**
 * Persist per-session mode picks into synced session metadata with optimistic
 * concurrency and automatic retry. On version conflict the latest metadata is
 * taken from the server via the schema-free raw decrypt, so fields this app
 * version doesn't know about survive the read-modify-write.
 */
async function sessionUpdateAgentModesMetadata(
    sessionId: string,
    patch: SessionAgentModesPatch,
    maxRetries: number = 3
): Promise<void> {
    const encryption = sync.encryption.getSessionEncryption(sessionId);
    const session = storage.getState().sessions[sessionId];
    if (!encryption || !session?.metadata) {
        throw new Error(`Session ${sessionId} is not ready for metadata updates`);
    }

    let pendingPatch: SessionAgentModesPatch = { ...patch };
    let currentVersion = session.metadataVersion;
    let currentMetadata = { ...session.metadata, ...pendingPatch };

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const encrypted = await encryption.encryptRaw(currentMetadata);
        const result = await apiSocket.emitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
        }>('update-metadata', {
            sid: sessionId,
            metadata: encrypted,
            expectedVersion: currentVersion
        });

        if (result.result === 'success') {
            return;
        }
        if (result.result === 'version-mismatch') {
            currentVersion = result.version!;
            const latest = await encryption.decryptRaw(result.metadata!);
            if (!latest) {
                throw new Error('Failed to decrypt latest session metadata');
            }
            // A newer local action (another pick, an abort clearing modes) may
            // have changed the mirror since this push started — that action
            // owns the field now, and blindly replaying the original patch
            // would resurrect a pick the user already cleared.
            const liveSession = storage.getState().sessions[sessionId];
            for (const field of Object.keys(pendingPatch) as (keyof SessionAgentModesPatch)[]) {
                if ((liveSession?.[field] ?? null) !== (pendingPatch[field] ?? null)) {
                    delete pendingPatch[field];
                }
            }
            if (Object.keys(pendingPatch).length === 0) {
                return;
            }
            currentMetadata = { ...latest, ...pendingPatch };
            continue;
        }
        throw new Error('Failed to update session metadata');
    }

    throw new Error(`Failed to update session metadata after ${maxRetries} retries due to version conflicts`);
}

/**
 * Apply a per-session model / effort pick: updates local state immediately for
 * a snappy UI and pushes the pick into synced session metadata so other
 * devices receive it through the update-session broadcast. Never throws — a
 * failed push leaves the optimistic local value, and the next inbound
 * metadata update reconciles the UI.
 */
export function sessionSetAgentModes(sessionId: string, patch: SessionAgentModesPatch): void {
    const state = storage.getState();
    const session = state.sessions[sessionId];
    if (
        isCodexSessionReadOnly(session?.metadata)
        || (session && isSessionMachineDeleted(session, state.machines, state.machinesLoaded))
    ) return;
    try {
        assertSessionInteractionAllowed(sessionId);
    } catch {
        return;
    }

    // Only touch fields that actually change — clearing modes on a session
    // with no picks (e.g. every abort) must not cost a metadata round-trip.
    // A pick counts as changed when it differs from the local mirror OR from
    // synced metadata: a local-only value (e.g. the EnterPlanMode auto-switch
    // writes the mirror without metadata) must still be pushed when the user
    // picks it explicitly, or other devices never see it.
    const isChanged = (value: string | null, field: keyof SessionAgentModesPatch): boolean => {
        const mirror = session?.[field] ?? null;
        const metaRaw = session?.metadata?.[field];
        const meta = metaRaw === undefined ? null : (metaRaw ?? null);
        return value !== mirror || value !== meta;
    };
    const changed: SessionAgentModesPatch = {};
    if (patch.permissionMode !== undefined && isChanged(patch.permissionMode, 'permissionMode')) {
        changed.permissionMode = patch.permissionMode;
    }
    if (patch.modelMode !== undefined && isChanged(patch.modelMode, 'modelMode')) {
        changed.modelMode = patch.modelMode;
    }
    if (patch.effortLevel !== undefined && isChanged(patch.effortLevel, 'effortLevel')) {
        changed.effortLevel = patch.effortLevel;
    }
    if (Object.keys(changed).length === 0) {
        return;
    }

    state.updateSessionAgentModes(sessionId, changed);

    // While the push is in flight, inbound updates still carry the OLD
    // metadata; mark the fields pending so applySessions keeps the fresher
    // local mirror instead of bouncing the pick back.
    const changedFields = Object.keys(changed) as AgentModeField[];
    markAgentModePushPending(sessionId, changedFields);
    sessionUpdateAgentModesMetadata(sessionId, changed)
        .catch((error) => {
            console.error(`Failed to sync agent modes for session ${sessionId}`, error);
        })
        .finally(() => {
            clearAgentModePushPending(sessionId, changedFields);
        });
}

/**
 * Abort the current session operation
 */
export async function sessionAbort(sessionId: string): Promise<void> {
    const metadata = storage.getState().sessions[sessionId]?.metadata;
    assertSessionInteractionAllowed(sessionId);
    const projection = storage.getState().codexV4Sessions[sessionId];
    const threadId = resolveCodexV4SessionCapabilities(metadata, projection).ownedThreadId;
    const activeTurn = projection ? findActiveCodexV4Turn(projection, threadId) : null;
    if (!threadId || !activeTurn) {
        if (projection?.runtime?.execution.type === 'active') {
            throw new Error('The active Codex turn identity is not available yet');
        }
        return;
    }
    await sync.publishCodexV4Command(sessionId, {
        command: 'turn.interrupt',
        threadId,
        expectedTurnId: activeTurn.turnId,
        payload: { expectedTurnId: activeTurn.turnId },
    });
}

/** Update one CLI-owned Codex follow-up without changing its FIFO position. */
export async function sessionUpdateCodexQueuedMessage(
    sessionId: string,
    id: string,
    text: string,
): Promise<void> {
    assertSessionInteractionAllowed(sessionId);
    const projection = storage.getState().codexV4Sessions[sessionId];
    const queued = codexV4QueuedMessages(projection).find((message) => message.id === id);
    if (!queued) throw new Error('Queued Codex message not found');
    const payload = jsonObject(queued.command.payload);
    await sync.publishCodexV4Command(sessionId, {
        command: 'turn.queue',
        threadId: queued.command.threadId,
        expectedTurnId: queued.command.expectedTurnId,
        payload: { ...payload, text, displayText: text },
        replacesCommandId: queued.command.commandId,
        queueEntryId: queued.id,
        queuedAt: queued.createdAt,
        ...(commandBindingGeneration(queued.command) !== undefined
            ? { bindingGeneration: commandBindingGeneration(queued.command) }
            : {}),
    }, undefined, text);
}

/** Move one CLI-owned Codex follow-up into the currently active turn. */
export async function sessionSteerCodexQueuedMessage(sessionId: string, id: string): Promise<void> {
    assertSessionInteractionAllowed(sessionId);
    const state = storage.getState();
    const session = state.sessions[sessionId];
    const projection = state.codexV4Sessions[sessionId];
    const queued = codexV4QueuedMessages(projection).find((message) => message.id === id);
    if (!queued) throw new Error('Queued Codex message not found');
    if (session?.metadata?.codexCapabilities?.queueSteering !== true) {
        throw new Error('Codex turn steering is unavailable');
    }
    const activeTurn = findActiveCodexV4Turn(projection);
    if (!activeTurn) throw new Error('The active Codex turn is no longer available');
    const payload = jsonObject(queued.command.payload);
    await sync.publishCodexV4Command(sessionId, {
        command: 'turn.steer',
        threadId: activeTurn.threadId,
        expectedTurnId: activeTurn.turnId,
        payload: payload as typeof queued.command.payload,
        replacesCommandId: queued.command.commandId,
        queueEntryId: queued.id,
        queuedAt: queued.createdAt,
        ...(commandBindingGeneration(queued.command) !== undefined
            ? { bindingGeneration: commandBindingGeneration(queued.command) }
            : {}),
    }, undefined, queued.text);
}

function jsonObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function commandBindingGeneration(command: unknown): number | undefined {
    if (!command || typeof command !== 'object' || !('bindingGeneration' in command)) {
        return undefined;
    }
    const value = command.bindingGeneration;
    return typeof value === 'number' ? value : undefined;
}

/**
 * Allow a permission request
 */
export async function sessionAllow(
    sessionId: string,
    id: string,
    decision?: 'approved' | 'approved_for_session',
    updatedInput?: Record<string, unknown>,
): Promise<void> {
    assertSessionInteractionAllowed(sessionId);
    await resolveCodexV4Request(sessionId, id, true, decision, updatedInput);
}

/**
 * Deny a permission request
 */
export async function sessionDeny(
    sessionId: string,
    id: string,
    decision?: 'denied' | 'abort',
): Promise<void> {
    assertSessionInteractionAllowed(sessionId);
    await resolveCodexV4Request(sessionId, id, false, decision);
}

/**
 * Request mode change for a session
 */
export async function sessionSwitch(sessionId: string, to: 'remote' | 'local'): Promise<boolean> {
    assertSessionInteractionAllowed(sessionId);
    const request: SessionModeChangeRequest = { to };
    const response = await apiSocket.sessionRPC<boolean, SessionModeChangeRequest>(
        sessionId,
        'switch',
        request,
    );
    return response;
}

/**
 * Request an agent-owned goal action.
 */
export async function sessionGoalAction(
    sessionId: string,
    action: SessionGoalActionRequest['action'],
    objective?: string,
): Promise<void> {
    assertSessionInteractionAllowed(sessionId);
    const state = storage.getState();
    const threadId = resolveCodexV4SessionCapabilities(
        state.sessions[sessionId]?.metadata,
        state.codexV4Sessions[sessionId],
    ).ownedThreadId;
    if (!threadId) throw new Error('Codex thread is not available');
    if (action === 'clear') {
        await sync.publishCodexV4Command(sessionId, {
            command: 'goal.clear',
            threadId,
            payload: {},
        });
        return;
    }
    if (action === 'edit' && objective) {
        await sync.publishCodexV4Command(sessionId, {
            command: 'goal.set',
            threadId,
            payload: { objective },
        });
        return;
    }
    if (action === 'stop') {
        await sessionAbort(sessionId);
        return;
    }
    throw new Error('Codex goal action is incomplete');
}

async function resolveCodexV4Request(
    sessionId: string,
    requestId: string,
    approved: boolean,
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
    updatedInput?: Record<string, unknown>,
): Promise<void> {
    const state = storage.getState();
    const projection = state.codexV4Sessions[sessionId];
    const ownedThreadId = resolveCodexV4SessionCapabilities(
        state.sessions[sessionId]?.metadata,
        projection,
    ).ownedThreadId;
    const request = projection
        ? Object.values(projection.entities['codex.request']).find((entry) => (
            entry.requestId === requestId
            && ownedThreadId !== null
            && entry.threadId === ownedThreadId
        ))
        : null;
    if (!request || request.status !== 'pending') throw new Error('Codex request is no longer pending');
    await sync.publishCodexV4Command(sessionId, {
        command: 'request.resolve',
        threadId: request.threadId,
        expectedTurnId: request.turnId,
        payload: {
            requestId,
            response: codexV4RequestResponse({ request, approved, decision, updatedInput }),
        },
    });
}

/**
 * Execute a bash command in the session
 */
export async function sessionBash(sessionId: string, request: SessionBashRequest): Promise<SessionBashResponse> {
    try {
        assertSessionInteractionAllowed(sessionId);
        const response = await apiSocket.sessionRPC<SessionBashResponse, SessionBashRequest>(
            sessionId,
            'bash',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Read a file from the session
 */
export async function sessionReadFile(sessionId: string, path: string): Promise<SessionReadFileResponse> {
    try {
        assertSessionInteractionAllowed(sessionId);
        const request: SessionReadFileRequest = { path };
        const response = await apiSocket.sessionRPC<SessionReadFileResponse, SessionReadFileRequest>(
            sessionId,
            'readFile',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Write a file to the session
 */
export async function sessionWriteFile(
    sessionId: string,
    path: string,
    content: string,
    expectedHash?: string | null
): Promise<SessionWriteFileResponse> {
    try {
        assertSessionInteractionAllowed(sessionId);
        const request: SessionWriteFileRequest = { path, content, expectedHash };
        const response = await apiSocket.sessionRPC<SessionWriteFileResponse, SessionWriteFileRequest>(
            sessionId,
            'writeFile',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * List directory contents in the session
 */
export async function sessionListDirectory(sessionId: string, path: string): Promise<SessionListDirectoryResponse> {
    try {
        assertSessionInteractionAllowed(sessionId);
        const request: SessionListDirectoryRequest = { path };
        const response = await apiSocket.sessionRPC<SessionListDirectoryResponse, SessionListDirectoryRequest>(
            sessionId,
            'listDirectory',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Get directory tree from the session
 */
export async function sessionGetDirectoryTree(
    sessionId: string,
    path: string,
    maxDepth: number
): Promise<SessionGetDirectoryTreeResponse> {
    try {
        assertSessionInteractionAllowed(sessionId);
        const request: SessionGetDirectoryTreeRequest = { path, maxDepth };
        const response = await apiSocket.sessionRPC<SessionGetDirectoryTreeResponse, SessionGetDirectoryTreeRequest>(
            sessionId,
            'getDirectoryTree',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Run ripgrep in the session
 */
export async function sessionRipgrep(
    sessionId: string,
    args: string[],
    cwd?: string
): Promise<SessionRipgrepResponse> {
    try {
        assertSessionInteractionAllowed(sessionId);
        const request: SessionRipgrepRequest = { args, cwd };
        const response = await apiSocket.sessionRPC<SessionRipgrepResponse, SessionRipgrepRequest>(
            sessionId,
            'ripgrep',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Stop the Codex Gateway runtime through its authenticated machine RPC.
 */
export async function sessionKill(
    sessionId: string,
    options: { timeoutMs?: number } = {},
): Promise<SessionKillResponse> {
    try {
        assertSessionInteractionAllowed(sessionId);
        const metadata = storage.getState().sessions[sessionId]?.metadata;
        if (!isCodexGatewaySession(metadata)) {
            throw new Error('Codex Gateway binding is unavailable');
        }
        if (!metadata?.machineId) {
            throw new Error('Codex Gateway session is missing its machine identity');
        }
        const binding = resolveCodexGatewayBinding(metadata);
        if (!binding) {
            throw new Error('Codex Gateway session is missing its binding identity');
        }
        const response = await apiSocket.machineRPC<{
            message: string;
            outcome?: 'stopped' | 'missing' | 'unverified';
        }, {
            sessionId: string;
            expectedGatewayId: string;
            bindingGeneration: number;
        }>(
            metadata.machineId,
            'stop-session',
            {
                sessionId,
                expectedGatewayId: binding.gatewayId,
                bindingGeneration: binding.generation,
            },
            options,
        );
        const outcome = response.outcome ?? 'stopped';
        return { success: outcome === 'stopped', message: response.message, outcome };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error',
            outcome: 'failed',
        };
    }
}

/**
 * Archive a Codex v4 session through its durable lifecycle tombstone.
 */
export async function sessionArchive(sessionId: string): Promise<{ success: boolean; archivedAt?: number; message?: string }> {
    try {
        const metadata = storage.getState().sessions[sessionId]?.metadata;
        assertCodexSessionWritable(metadata);
        if (!isCodexV4SyncEligible(metadata)) {
            return { success: false, message: 'Only Codex Sync v4 sessions can be archived' };
        }
        const response = await apiSocket.request(`/v4/sessions/${encodeURIComponent(sessionId)}/archive`, {
            method: 'POST'
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => null) as { error?: unknown } | null;
            return {
                success: false,
                message: typeof payload?.error === 'string'
                    ? payload.error
                    : `Server error: ${response.status}`,
            };
        }
        const payload = await response.json().catch(() => null) as { archivedAt?: unknown } | null;
        return {
            success: true,
            archivedAt: typeof payload?.archivedAt === 'number' ? payload.archivedAt : undefined,
        };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Permanently delete a session from the server
 * This will remove the session and all its associated data (messages, usage reports, access keys)
 * The session should be inactive/archived before deletion
 */
export async function sessionDelete(sessionId: string): Promise<{ success: boolean; message?: string }> {
    try {
        assertCodexSessionWritable(storage.getState().sessions[sessionId]?.metadata);
        const response = await apiSocket.request(`/v1/sessions/${sessionId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            const result = await response.json();
            return { success: true };
        } else {
            const error = await response.text();
            return {
                success: false,
                message: error || 'Failed to delete session'
            };
        }
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

type CodexForkSource = {
    kind: 'codex';
    sessionId: string;
    machineId: string;
    directory: string;
    codexThreadId: string;
};

// Forking source description used by forkAndSpawn.
export type ForkSource = CodexForkSource;

type ForkOptions = {
    cutAfterItemId?: string;
    forkedFromMessageId?: string;
    /** Marks the forked child as a hidden side chat (kept out of the session list). */
    isSideChat?: boolean;
};

/**
 * Two-step orchestrator for the Codex thread fork / duplicate flow.
 *
 * Lineage (parentSessionId, forkedFromMessageId) rides through the spawn
 * RPC into env vars, then into the new Happy session's metadata at start
 * — so the parent link survives without any server-side schema change.
 */
export async function forkAndSpawn(
    source: ForkSource,
    opts: ForkOptions = {},
): Promise<SpawnSessionResult> {
    const sourceSession = storage.getState().sessions[source.sessionId];
    assertSessionInteractionAllowed(source.sessionId);
    if (
        !sourceSession
        || sourceSession.metadata?.flavor !== 'codex'
        || sourceSession.metadata.codexThreadId !== source.codexThreadId
        || sourceSession.metadata.machineId !== source.machineId
        || sourceSession.metadata.path !== source.directory
    ) {
        throw new Error('Codex fork source is stale or owned by another Happy session');
    }
    const forkResult = opts.cutAfterItemId
        ? await codexDuplicateThread({
            machineId: source.machineId,
            directory: source.directory,
            codexThreadId: source.codexThreadId,
            cutAfterItemId: opts.cutAfterItemId,
        })
        : await codexForkThread({
            machineId: source.machineId,
            directory: source.directory,
            codexThreadId: source.codexThreadId,
        });

    if (forkResult.type !== 'success') {
        return { type: 'error', errorMessage: forkResult.errorMessage };
    }

    const spawnResult = await machineSpawnNewSession({
        machineId: source.machineId,
        directory: source.directory,
        agent: 'codex',
        approvedNewDirectoryCreation: false,
        resumeCodexThreadId: forkResult.newCodexThreadId,
        parentSessionId: source.sessionId,
        forkedFromMessageId: opts.forkedFromMessageId,
        isSideChat: opts.isSideChat,
    });

    // Pull the newly-created session row into local sync state before we
    // hand control back to the caller — otherwise router.replace into the
    // new session id races the broadcast and the app screams
    // "Session X not found" until the next sync tick lands.
    if (spawnResult.type === 'success') {
        try {
            await sync.refreshSessions();
        } catch {
            // Refresh is best-effort; broadcast sync will still hydrate.
        }
    }

    return spawnResult;
}

/**
 * Create a "side chat" for a session: a forked child that inherits the
 * parent's full context but is provably isolated (writes only to its own
 * transcript, never back into the parent) and is flagged `isSideChat` so it
 * stays out of the top-level session list. Rendered only inside the parent's
 * sidebar panel. Reuses the fork/spawn machinery; the only difference from a
 * normal fork is the `isSideChat` marker.
 */
export async function spawnSideChat(source: ForkSource): Promise<SpawnSessionResult> {
    return forkAndSpawn(source, { isSideChat: true });
}

// Export types for external use
export type {
    SessionBashRequest,
    SessionBashResponse,
    SessionReadFileResponse,
    SessionWriteFileResponse,
    SessionListDirectoryResponse,
    DirectoryEntry,
    SessionGetDirectoryTreeResponse,
    TreeNode,
    SessionRipgrepResponse,
    SessionKillResponse
};
