import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    type CodexCommandEntityV4,
    type CodexRequestEntityV4,
    type CodexTurnEntityV4,
} from '@slopus/happy-wire';
import type { CodexV4Projection } from './codexV4Projection';
import { resolveCodexV4GatewayGeneration } from './codexV4Capabilities';

type CodexV4Json = CodexCommandEntityV4['payload'];
type CodexV4JsonObject = { [key: string]: CodexV4Json };
export interface CodexV4CommandDraft {
    command: string;
    payload: CodexCommandEntityV4['payload'];
    threadId?: string | null;
    expectedTurnId?: string | null;
    replacesCommandId?: string | null;
    queueEntryId?: string | null;
    queuedAt?: number;
    bindingGeneration?: number;
}

export type CodexV4FollowUpMode = 'queue' | 'steer';

export interface CodexV4TurnMode {
    model?: string | null;
    effort?: string | null;
    permissionMode?: string;
    appendSystemPrompt?: string;
}

export interface CodexV4AttachmentReference {
    ref: string;
    name: string;
    mimeType: string;
}

export type ParsedCodexV4Input =
    | { kind: 'prompt'; text: string; displayText: string }
    | { kind: 'skill'; skillName: string; text: string; displayText: string }
    | {
        kind: 'control';
        command: string;
        payload: CodexCommandEntityV4['payload'];
        displayText: string;
    };

export function createCodexV4Command(
    draft: CodexV4CommandDraft,
    options: { commandId: string; now?: number },
): CodexCommandEntityV4 {
    const now = Math.max(0, Math.trunc(options.now ?? Date.now()));
    const queueEntryId = draft.command === 'turn.queue'
        ? draft.queueEntryId ?? options.commandId
        : draft.queueEntryId ?? null;
    return {
        schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
        entityType: 'codex.command',
        providerId: options.commandId,
        createdAt: now,
        updatedAt: now,
        commandId: options.commandId,
        threadId: draft.threadId ?? null,
        expectedTurnId: draft.expectedTurnId ?? null,
        command: draft.command,
        payload: draft.payload,
        clientUserMessageId: options.commandId,
        replacesCommandId: draft.replacesCommandId ?? null,
        queueEntryId,
        ...(queueEntryId ? { queuedAt: draft.queuedAt ?? now } : {}),
        ...(draft.bindingGeneration !== undefined
            ? { bindingGeneration: draft.bindingGeneration }
            : {}),
    } as CodexCommandEntityV4;
}

export function parseCodexV4Input(text: string, skillCommands: readonly string[]): ParsedCodexV4Input {
    const displayText = text;
    const match = text.trim().match(/^\/([a-zA-Z][\w:-]*)(?:\s+([\s\S]*?))?\s*$/);
    if (!match) return { kind: 'prompt', text, displayText };

    const commandName = match[1];
    const normalizedName = commandName.toLowerCase();
    const args = match[2]?.trim() ?? '';
    switch (normalizedName) {
        case 'compact':
            return {
                kind: 'control',
                command: 'thread.compact',
                payload: { displayText, ...(args ? { unsupportedPrompt: args } : {}) },
                displayText,
            };
        case 'review':
            return {
                kind: 'control',
                command: 'review.start',
                payload: {
                    displayText,
                    delivery: 'inline',
                    target: args
                        ? { type: 'custom', instructions: args }
                        : { type: 'uncommittedChanges' },
                },
                displayText,
            };
        case 'skills':
            return {
                kind: 'control',
                command: 'skills.list',
                payload: { displayText, ...(args ? { unsupportedArguments: args } : {}) },
                displayText,
            };
        case 'mcp':
            return {
                kind: 'control',
                command: 'mcp.status.list',
                payload: { displayText, ...(args ? { unsupportedArguments: args } : {}) },
                displayText,
            };
        case 'goal':
            return args.toLowerCase() === 'clear'
                ? { kind: 'control', command: 'goal.clear', payload: { displayText }, displayText }
                : {
                    kind: 'control',
                    command: 'goal.set',
                    payload: { displayText, ...(args ? { objective: args } : {}) },
                    displayText,
                };
        case 'clear':
            return {
                kind: 'control',
                command: 'thread.rollback',
                payload: { displayText, allTurns: true, ...(args ? { unsupportedArguments: args } : {}) },
                displayText,
            };
    }

    const trustedSkill = skillCommands.find((skill) => (
        skill.replace(/^\//, '').toLowerCase() === normalizedName
    ));
    if (trustedSkill) {
        return {
            kind: 'skill',
            skillName: trustedSkill.replace(/^\//, ''),
            text: args,
            displayText,
        };
    }
    return { kind: 'prompt', text, displayText };
}

export function commandForCodexV4Input(options: {
    parsed: ParsedCodexV4Input;
    projection: CodexV4Projection;
    threadId?: string | null;
    mode: CodexV4TurnMode;
    attachments?: CodexV4AttachmentReference[];
    followUpMode?: CodexV4FollowUpMode;
}): CodexV4CommandDraft {
    const bindingGeneration = resolveCodexV4GatewayGeneration(options.projection);
    const threadId = options.threadId !== undefined
        ? options.threadId
        : options.projection.thread?.threadId ?? null;
    if (options.parsed.kind === 'control') {
        return {
            command: options.parsed.command,
            threadId,
            payload: {
                ...asRecord(options.parsed.payload),
                ...(options.attachments?.length ? { unsupportedAttachments: options.attachments.length } : {}),
            },
            ...(bindingGeneration !== undefined
                ? { bindingGeneration }
                : {}),
        };
    }

    const activeTurnId = findActiveCodexV4Turn(options.projection, threadId)?.turnId ?? null;
    const payload: CodexCommandEntityV4['payload'] = {
        text: options.parsed.text,
        displayText: options.parsed.displayText,
        ...(options.parsed.kind === 'skill' ? { skillName: options.parsed.skillName } : {}),
        ...(options.mode.model !== undefined ? { model: options.mode.model } : {}),
        ...(options.mode.effort !== undefined ? { effort: options.mode.effort } : {}),
        ...(options.mode.permissionMode !== undefined ? { permissionMode: options.mode.permissionMode } : {}),
        ...(options.mode.appendSystemPrompt !== undefined ? { appendSystemPrompt: options.mode.appendSystemPrompt } : {}),
        ...(options.attachments?.length ? {
            attachments: options.attachments.map((attachment) => ({
                ref: attachment.ref,
                name: attachment.name,
                mimeType: attachment.mimeType,
            })),
        } : {}),
    };
    const runtimeIsActive = options.projection.runtime?.execution?.type === 'active';
    if (activeTurnId && options.followUpMode === 'steer') return {
        command: 'turn.steer',
        threadId,
        expectedTurnId: activeTurnId,
        payload,
        ...(bindingGeneration !== undefined
            ? { bindingGeneration }
            : {}),
    };
    return activeTurnId || runtimeIsActive ? {
        command: 'turn.queue',
        threadId,
        expectedTurnId: activeTurnId,
        payload,
        ...(bindingGeneration !== undefined
            ? { bindingGeneration }
            : {}),
    } : {
        command: 'turn.start',
        threadId,
        payload,
        ...(bindingGeneration !== undefined
            ? { bindingGeneration }
            : {}),
    };
}

export function findActiveCodexV4Turn(
    projection: CodexV4Projection,
    threadId: string | null = projection.thread?.threadId ?? null,
): CodexTurnEntityV4 | null {
    let selected: CodexTurnEntityV4 | null = null;
    for (const turn of Object.values(projection.entities['codex.turn'])) {
        if (turn.status !== 'inProgress') continue;
        if (threadId && turn.threadId !== threadId) continue;
        if (!selected || turn.updatedAt > selected.updatedAt) selected = turn;
    }
    return selected;
}

export function codexV4RequestResponse(options: {
    request: CodexRequestEntityV4;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    updatedInput?: Record<string, unknown>;
}): CodexCommandEntityV4['payload'] {
    const requestOptions = asJsonObject(options.request.options);
    if (options.request.requestType === 'commandApproval' || options.request.requestType === 'fileChangeApproval') {
        const decision = options.approved
            ? options.decision === 'approved_for_session' ? 'acceptForSession' : 'accept'
            : options.decision === 'abort' ? 'cancel' : 'decline';
        return { decision };
    }
    if (options.request.requestType === 'permissions') {
        return {
            permissions: options.approved ? asJsonObject(requestOptions.permissions) : {},
            scope: options.decision === 'approved_for_session' ? 'session' : 'turn',
        };
    }
    if (requestOptions.requestMethod === 'mcpServer/elicitation/request') {
        return options.approved
            ? { action: 'accept', content: asJsonValue(options.updatedInput), _meta: requestOptions._meta ?? null }
            : { action: options.decision === 'abort' ? 'cancel' : 'decline', content: null, _meta: requestOptions._meta ?? null };
    }

    const explicitAnswers = asJsonObject(options.updatedInput?.codexAnswers);
    if (Object.keys(explicitAnswers).length > 0) return { answers: explicitAnswers };
    const legacyAnswers = asJsonObject(options.updatedInput?.answers);
    const questions = Array.isArray(requestOptions.questions) ? requestOptions.questions : [];
    const answers: CodexV4JsonObject = {};
    for (const question of questions) {
        const value = asJsonObject(question);
        const id = typeof value.id === 'string' ? value.id : null;
        const label = typeof value.question === 'string' ? value.question : null;
        const answer = label ? legacyAnswers[label] : undefined;
        if (id && typeof answer === 'string') answers[id] = { answers: [answer] };
    }
    return { answers };
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function asJsonObject(value: unknown): CodexV4JsonObject {
    const normalized = asJsonValue(value);
    return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
        ? normalized
        : {};
}

function asJsonValue(value: unknown): CodexV4Json {
    if (value === undefined) return null;
    try {
        const encoded = JSON.stringify(value);
        return encoded === undefined ? null : JSON.parse(encoded) as CodexV4Json;
    } catch {
        return null;
    }
}
