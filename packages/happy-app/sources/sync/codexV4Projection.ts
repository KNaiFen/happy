import type {
    CodexEntityType,
    CodexCommandEntityV4,
    CodexCommandResultEntityV4,
    CodexEntityV4,
    CodexItemEntityV4,
    CodexPartEntityV4,
    CodexRequestEntityV4,
    CodexRelationEntityV4,
    CodexRuntimeEntityV4,
    CodexThreadEntityV4,
    CodexTurnEntityV4,
    SyncMutationOperationV4,
} from '@slopus/happy-wire';
import type { Message, ToolCall, ToolCallMessage } from './typesMessage';

type EntityOfType<T extends CodexEntityType> = Extract<CodexEntityV4, { entityType: T }>;

export type CodexV4EntityBuckets = {
    [T in CodexEntityType]: Record<string, EntityOfType<T>>;
};

export interface CodexV4Projection {
    revisions: Record<string, number>;
    entities: CodexV4EntityBuckets;
    thread: CodexThreadEntityV4 | null;
    runtime: CodexRuntimeEntityV4 | null;
    activated: boolean;
    messages: Message[];
}

export interface CodexV4ProjectionUpdate {
    entity: CodexEntityV4;
    op: SyncMutationOperationV4;
    revision: number;
}

export function createCodexV4Projection(): CodexV4Projection {
    return {
        revisions: {},
        entities: {
            'codex.thread': {},
            'codex.runtime': {},
            'codex.turn': {},
            'codex.item': {},
            'codex.part': {},
            'codex.request': {},
            'codex.command': {},
            'codex.commandResult': {},
            'codex.relation': {},
        },
        thread: null,
        runtime: null,
        activated: false,
        messages: [],
    };
}

export function resetCodexV4Projection(current: CodexV4Projection): CodexV4Projection {
    return {
        ...createCodexV4Projection(),
        activated: current.activated,
    };
}

export function applyCodexV4ProjectionUpdate(
    current: CodexV4Projection,
    update: CodexV4ProjectionUpdate,
): CodexV4Projection {
    return applyCodexV4ProjectionUpdates(current, [update]);
}

export function applyCodexV4ProjectionUpdates(
    current: CodexV4Projection,
    updates: readonly CodexV4ProjectionUpdate[],
): CodexV4Projection {
    let revisions = current.revisions;
    const changedBuckets = new Map<CodexEntityType, Record<string, CodexEntityV4>>();
    let changed = false;

    for (const update of updates) {
        const revisionKey = `${update.entity.entityType}:${update.entity.providerId}`;
        if ((revisions[revisionKey] ?? 0) >= update.revision) continue;
        if (!changed) revisions = { ...current.revisions };
        revisions[revisionKey] = update.revision;
        changed = true;

        const entityType = update.entity.entityType;
        let bucket = changedBuckets.get(entityType);
        if (!bucket) {
            bucket = { ...current.entities[entityType] } as Record<string, CodexEntityV4>;
            changedBuckets.set(entityType, bucket);
        }
        if (update.op === 'delete') {
            delete bucket[update.entity.providerId];
        } else {
            bucket[update.entity.providerId] = update.entity;
        }
    }
    if (!changed) return current;

    let entities = current.entities;
    for (const [entityType, bucket] of changedBuckets) {
        entities = { ...entities, [entityType]: bucket } as CodexV4EntityBuckets;
    }
    const runtime = newestEntity(Object.values(entities['codex.runtime']));
    const thread = newestEntity(Object.values(entities['codex.thread']));
    const activated = current.activated || runtime?.syncState === 'ready';

    return {
        revisions,
        entities,
        runtime,
        thread,
        activated,
        messages: projectMessages(entities),
    };
}

function newestEntity<T extends { updatedAt: number; providerId: string }>(entities: T[]): T | null {
    let newest: T | null = null;
    for (const entity of entities) {
        if (
            !newest
            || entity.updatedAt > newest.updatedAt
            || (entity.updatedAt === newest.updatedAt && entity.providerId > newest.providerId)
        ) {
            newest = entity;
        }
    }
    return newest;
}

function projectMessages(entities: CodexV4EntityBuckets): Message[] {
    const turns = new Map(Object.values(entities['codex.turn']).map((turn) => [turn.turnId, turn]));
    const items = Object.values(entities['codex.item']);
    const parts = Object.values(entities['codex.part']);
    const requests = Object.values(entities['codex.request']);
    const relations = Object.values(entities['codex.relation']);
    const commands = Object.values(entities['codex.command']);
    const commandsById = new Map(commands.map((command) => [command.commandId, command]));
    const partsByItem = new Map<string, CodexPartEntityV4[]>();
    const requestsByItem = new Map<string, CodexRequestEntityV4[]>();
    const relationsByItem = new Map<string, CodexRelationEntityV4>();
    for (const part of parts) {
        appendGrouped(partsByItem, itemKey(part.threadId, part.turnId, part.itemId), part);
    }
    for (const groupedParts of partsByItem.values()) groupedParts.sort(compareParts);
    for (const request of requests) {
        if (request.turnId === null || request.itemId === null) continue;
        appendGrouped(requestsByItem, itemKey(request.threadId, request.turnId, request.itemId), request);
    }
    for (const relation of relations) {
        if (relation.parentTurnId === null || relation.delegationItemId === null) continue;
        const key = itemKey(relation.parentThreadId, relation.parentTurnId, relation.delegationItemId);
        const current = relationsByItem.get(key);
        if (!current || newestEntity([current, relation]) === relation) relationsByItem.set(key, relation);
    }
    const providerUserMessageIds = new Set(
        items
            .filter((item) => item.itemType.toLowerCase() === 'usermessage' && item.clientId)
            .map((item) => item.clientId!),
    );
    const replacedCommandIds = new Set(
        commands
            .map((command) => command.replacesCommandId)
            .filter((commandId): commandId is string => Boolean(commandId)),
    );
    const messages: Message[] = [];
    const attachedRequestIds = new Set<string>();

    for (const item of items) {
        const key = itemKey(item.threadId, item.turnId, item.itemId);
        const itemParts = partsByItem.get(key) ?? [];
        const itemRequests = requestsByItem.get(key) ?? [];
        for (const request of itemRequests) attachedRequestIds.add(request.requestId);
        const relation = relationsByItem.get(key);
        const projected = projectItem(item, itemParts, itemRequests, turns.get(item.turnId), relation);
        if (projected) messages.push(projected);
    }

    for (const request of requests) {
        if (request.requestType !== 'toolUserInput' || attachedRequestIds.has(request.requestId)) continue;
        messages.push(projectUserInputRequest(request));
    }

    for (const command of commands) {
        if (providerUserMessageIds.has(command.clientUserMessageId) || replacedCommandIds.has(command.commandId)) continue;
        const displayText = jsonObject(command.payload).displayText;
        if (typeof displayText !== 'string' || displayText.length === 0) continue;
        messages.push({
            kind: 'user-text',
            id: `codex-v4:command:${command.providerId}`,
            localId: command.clientUserMessageId,
            createdAt: command.createdAt,
            text: displayText,
        });
    }

    for (const result of Object.values(entities['codex.commandResult'])) {
        const command = commandsById.get(result.commandId);
        if (isTextTurnCommand(command) && !isCommandFailure(result.status)) continue;
        messages.push(projectCommandResult(result, command));
    }

    return messages.sort((left, right) => (
        right.createdAt - left.createdAt || right.id.localeCompare(left.id)
    ));
}

function itemKey(threadId: string, turnId: string, itemId: string): string {
    return JSON.stringify([threadId, turnId, itemId]);
}

function appendGrouped<T>(groups: Map<string, T[]>, key: string, value: T): void {
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
}

function projectCommandResult(
    result: CodexCommandResultEntityV4,
    command: CodexCommandEntityV4 | undefined,
): ToolCallMessage {
    const failed = isCommandFailure(result.status);
    const completed = result.status === 'succeeded' || failed;
    return {
        kind: 'tool-call',
        id: `codex-v4:command-result:${result.providerId}`,
        localId: null,
        createdAt: result.createdAt,
        children: [],
        tool: {
            name: 'CodexControlCommand',
            state: failed ? 'error' : completed ? 'completed' : 'running',
            input: { command: command?.command ?? 'unknown' },
            result: result.error ?? result.result ?? { status: result.status },
            createdAt: result.createdAt,
            startedAt: result.createdAt,
            completedAt: completed ? result.updatedAt : null,
            description: null,
        },
    };
}

function isTextTurnCommand(command: CodexCommandEntityV4 | undefined): boolean {
    return command?.command === 'turn.start' || command?.command === 'turn.steer';
}

function isCommandFailure(status: CodexCommandResultEntityV4['status']): boolean {
    return status === 'failed' || status === 'resultUnknown' || status === 'notReplayed';
}

function projectItem(
    item: CodexItemEntityV4,
    parts: CodexPartEntityV4[],
    requests: CodexRequestEntityV4[],
    turn: CodexTurnEntityV4 | undefined,
    relation: CodexRelationEntityV4 | undefined,
): Message | null {
    const itemType = item.itemType.toLowerCase();
    const createdAt = item.startedAt ?? item.createdAt;
    const text = contentForKinds(parts, ['text', 'userInput']);

    if (itemType === 'usermessage') {
        if (!text) return null;
        return {
            kind: 'user-text',
            id: `codex-v4:item:${item.providerId}`,
            localId: item.clientId,
            createdAt,
            text,
            codexItemId: item.itemId,
        };
    }

    if (itemType === 'agentmessage') {
        if (!text) return null;
        return {
            kind: 'agent-text',
            id: `codex-v4:item:${item.providerId}`,
            localId: null,
            createdAt,
            text,
        };
    }

    const tool = projectTool(item, parts, requests, turn, relation);
    return tool ? {
        kind: 'tool-call',
        id: `codex-v4:item:${item.providerId}`,
        localId: null,
        createdAt,
        tool,
        children: [],
    } : null;
}

function projectTool(
    item: CodexItemEntityV4,
    parts: CodexPartEntityV4[],
    requests: CodexRequestEntityV4[],
    turn: CodexTurnEntityV4 | undefined,
    relation: CodexRelationEntityV4 | undefined,
): ToolCall | null {
    const itemType = item.itemType.toLowerCase();
    const content = contentForKinds(parts, [
        'text',
        'reasoningSummary',
        'commandOutput',
        'patch',
        'mcpProgress',
        'plan',
        'warning',
        'error',
    ]);
    const state = toolState(item, turn);
    const createdAt = item.startedAt ?? item.createdAt;
    const completedAt = item.completedAt ?? turn?.completedAt ?? null;
    const permission = projectPermission(requests[0]);
    const base = {
        state,
        createdAt,
        startedAt: item.startedAt,
        completedAt,
        description: null,
        permission,
    } satisfies Omit<ToolCall, 'name' | 'input'>;

    if (itemType === 'reasoning') {
        const summary = contentForKinds(parts, ['reasoningSummary']);
        if (!summary) return null;
        return {
            ...base,
            name: 'CodexReasoningSummary',
            input: {},
            result: { content: summary, status: state === 'running' ? 'in_progress' : state },
        };
    }
    if (itemType === 'commandexecution') {
        return {
            ...base,
            name: 'CodexBash',
            input: { command: item.command ?? '', cwd: item.cwd },
            result: content || (item.exitCode !== null ? { exitCode: item.exitCode } : undefined),
        };
    }
    if (itemType === 'filechange') {
        return {
            ...base,
            name: 'CodexPatch',
            input: { changes: parseJsonContent(content) ?? content },
            result: state === 'error' ? content : undefined,
        };
    }
    if (itemType === 'mcptoolcall') {
        return {
            ...base,
            name: mcpToolName(item.server, item.tool),
            input: item.arguments ?? {},
            result: (parseJsonContent(content) ?? content) || undefined,
        };
    }
    if (itemType === 'collabagenttoolcall') {
        return {
            ...base,
            name: 'Task',
            input: {
                prompt: content,
                description: item.tool ?? undefined,
                childSessionId: relation?.childSessionId,
                childStatus: relation?.status,
            },
            result: content || undefined,
        };
    }
    if (itemType === 'contextcompaction') {
        return {
            ...base,
            name: 'CodexCompact',
            input: {},
            result: content || undefined,
        };
    }
    if (content || permission) {
        return {
            ...base,
            name: item.tool ?? `Codex:${item.itemType}`,
            input: item.arguments ?? {},
            result: (parseJsonContent(content) ?? content) || undefined,
        };
    }
    return null;
}

function projectPermission(request: CodexRequestEntityV4 | undefined): ToolCall['permission'] {
    if (!request) return undefined;
    const status = request.status === 'pending'
        ? 'pending'
        : request.status === 'accepted' || request.status === 'resolved'
            ? 'approved'
            : request.status === 'declined'
                ? 'denied'
                : 'canceled';
    return {
        id: request.requestId,
        status,
        reason: request.prompt ?? undefined,
        date: request.resolvedAt ?? request.createdAt,
    };
}

function projectUserInputRequest(request: CodexRequestEntityV4): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: `codex-v4:request:${request.providerId}`,
        localId: null,
        createdAt: request.createdAt,
        children: [],
        tool: {
            name: 'AskUserQuestion',
            state: request.status === 'pending' ? 'running' : request.status === 'error' ? 'error' : 'completed',
            input: request.options ?? { questions: request.prompt ? [{ question: request.prompt }] : [] },
            result: request.response ?? undefined,
            createdAt: request.createdAt,
            startedAt: request.createdAt,
            completedAt: request.resolvedAt,
            description: request.title,
            permission: projectPermission(request),
        },
    };
}

function contentForKinds(parts: CodexPartEntityV4[], kinds: CodexPartEntityV4['kind'][]): string {
    const allowed = new Set(kinds);
    const groups = new Map<number, CodexPartEntityV4[]>();
    for (const part of parts) {
        if (!allowed.has(part.kind)) continue;
        const group = groups.get(part.index) ?? [];
        group.push(part);
        groups.set(part.index, group);
    }
    return [...groups.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, chunks]) => chunks.sort(compareParts).map((part) => part.content).join(''))
        .join('\n\n');
}

function compareParts(left: CodexPartEntityV4, right: CodexPartEntityV4): number {
    return left.index - right.index
        || left.chunkIndex - right.chunkIndex
        || left.providerId.localeCompare(right.providerId);
}

function toolState(item: CodexItemEntityV4, turn: CodexTurnEntityV4 | undefined): ToolCall['state'] {
    const status = (item.status ?? turn?.status ?? '').toLowerCase();
    if (status.includes('fail') || status.includes('error')) return 'error';
    if (item.completedAt !== null || status === 'completed' || status === 'interrupted') return 'completed';
    return 'running';
}

function parseJsonContent(content: string): unknown | null {
    if (!content) return null;
    try {
        return JSON.parse(content);
    } catch {
        return null;
    }
}

function jsonObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function mcpToolName(server: string | null, tool: string | null): string {
    const clean = (value: string | null, fallback: string) => (
        (value ?? fallback).replace(/[^a-zA-Z0-9_-]/g, '_')
    );
    return `mcp__${clean(server, 'server')}__${clean(tool, 'tool')}`;
}
