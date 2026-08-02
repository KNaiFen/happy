import type { CodexCommandEntityV4 } from '@slopus/happy-wire';
import type { Metadata } from './storageTypes';
import type { CodexV4Projection } from './codexV4Projection';

export interface CodexV4SessionCapabilities {
    readOnly: boolean;
    providerReadOnly: boolean;
    machineDeleted: boolean;
    ownedThreadId: string | null;
}

export interface CodexGatewayBinding {
    gatewayId: string;
    generation: number;
    origin: 'terminal' | 'app';
    role: 'current' | 'draining' | 'inactive' | 'recovering';
    terminal: 'attached' | 'unattached';
    previousSessionId?: string;
    nextSessionId?: string;
    changedAt: number;
}

const GLOBAL_READ_COMMANDS = new Set([
    'skills.list',
    'model.list',
]);

const COMMANDS_ALLOWED_BEFORE_THREAD_OWNERSHIP = new Set([
    'thread.start',
    'turn.start',
    ...GLOBAL_READ_COMMANDS,
]);

export function isCodexSessionReadOnly(metadata: Metadata | null | undefined): boolean {
    return metadata?.codexReadOnly === true;
}

export function isCodexGatewaySession(metadata: Metadata | null | undefined): boolean {
    return metadata?.flavor === 'codex'
        && metadata.codexSyncVersion === 4
        && resolveCodexGatewayBinding(metadata) !== null;
}

export function resolveCodexGatewayBinding(
    metadata: Metadata | null | undefined,
): CodexGatewayBinding | null {
    const binding = metadata?.codexGatewayBinding;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
    const value = binding as Record<string, unknown>;
    if (
        typeof value.gatewayId !== 'string'
        || value.gatewayId.length === 0
        || typeof value.generation !== 'number'
        || !Number.isSafeInteger(value.generation)
        || value.generation < 0
        || (value.origin !== 'terminal' && value.origin !== 'app')
        || !['current', 'draining', 'inactive', 'recovering'].includes(String(value.role))
        || (value.terminal !== 'attached' && value.terminal !== 'unattached')
        || typeof value.changedAt !== 'number'
        || !Number.isFinite(value.changedAt)
        || (value.previousSessionId !== undefined && typeof value.previousSessionId !== 'string')
        || (value.nextSessionId !== undefined && typeof value.nextSessionId !== 'string')
    ) {
        return null;
    }
    return value as unknown as CodexGatewayBinding;
}

export function canStopCodexGatewaySession(
    metadata: Metadata | null | undefined,
    options: { machineDeleted?: boolean } = {},
): boolean {
    const binding = resolveCodexGatewayBinding(metadata);
    return Boolean(
        binding
        && !isCodexSessionReadOnly(metadata)
        && options.machineDeleted !== true
        && typeof metadata?.machineId === 'string'
        && metadata.machineId.length > 0
        && (binding.role === 'current' || binding.role === 'recovering'),
    );
}

export function assertCodexSessionWritable(metadata: Metadata | null | undefined): void {
    if (isCodexSessionReadOnly(metadata)) {
        throw new Error('Provider-created Codex child sessions are read-only');
    }
}

export function resolveCodexV4SessionCapabilities(
    metadata: Metadata | null | undefined,
    projection?: CodexV4Projection | null,
    options: { machineDeleted?: boolean } = {},
): CodexV4SessionCapabilities {
    const metadataThreadId = nonEmptyString(metadata?.codexThreadId);
    const projectedThreadId = nonEmptyString(projection?.thread?.threadId);
    const providerReadOnly = isCodexSessionReadOnly(metadata);
    const machineDeleted = options.machineDeleted === true;
    return {
        readOnly: providerReadOnly || machineDeleted,
        providerReadOnly,
        machineDeleted,
        ownedThreadId: metadataThreadId ?? projectedThreadId,
    };
}

export function assertCodexV4CommandPublishAllowed(options: {
    command: CodexCommandEntityV4;
    metadata: Metadata | null | undefined;
    projection: CodexV4Projection | null | undefined;
}): void {
    const capabilities = resolveCodexV4SessionCapabilities(options.metadata, options.projection);
    assertCodexSessionWritable(options.metadata);

    const targetThreadId = codexV4CommandTargetThreadId(options.command);
    if (targetThreadId !== null) {
        if (!capabilities.ownedThreadId || targetThreadId !== capabilities.ownedThreadId) {
            throw new Error('Codex command targets a thread owned by another Happy session');
        }
    } else if (capabilities.ownedThreadId) {
        if (
            options.command.command !== 'thread.start'
            && !GLOBAL_READ_COMMANDS.has(options.command.command)
        ) {
            throw new Error('Codex command requires the owned thread target');
        }
    } else if (!COMMANDS_ALLOWED_BEFORE_THREAD_OWNERSHIP.has(options.command.command)) {
        throw new Error('Codex command cannot run before thread ownership is known');
    }

    const expectedTurnId = nonEmptyString(options.command.expectedTurnId);
    if (!expectedTurnId) return;
    const ownsExpectedTurn = Boolean(
        capabilities.ownedThreadId
        && Object.values(options.projection?.entities['codex.turn'] ?? {}).some((turn) => (
            turn.turnId === expectedTurnId
            && turn.threadId === capabilities.ownedThreadId
            && (targetThreadId === null || turn.threadId === targetThreadId)
        )),
    );
    if (!ownsExpectedTurn) {
        throw new Error('Codex command expected turn is not owned by this Happy session');
    }
}

export function codexV4CommandTargetThreadId(command: CodexCommandEntityV4): string | null {
    const payload = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
        ? command.payload as Record<string, unknown>
        : {};
    const canonicalThreadId = nonEmptyString(command.threadId);
    const payloadThreadId = nonEmptyString(payload.threadId);
    if (canonicalThreadId && payloadThreadId && canonicalThreadId !== payloadThreadId) {
        throw new Error('Codex command declares conflicting thread targets');
    }
    return canonicalThreadId ?? payloadThreadId;
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
