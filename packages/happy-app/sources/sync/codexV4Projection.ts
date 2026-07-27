import type {
    CodexEntityType,
    CodexEntityV4,
    CodexItemEntityV4,
    CodexPartEntityV4,
    CodexRequestEntityV4,
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

export function applyCodexV4ProjectionUpdate(
    current: CodexV4Projection,
    update: CodexV4ProjectionUpdate,
): CodexV4Projection {
    const revisionKey = `${update.entity.entityType}:${update.entity.providerId}`;
    if ((current.revisions[revisionKey] ?? 0) >= update.revision) return current;

    const entityType = update.entity.entityType;
    const bucket = { ...current.entities[entityType] } as Record<string, CodexEntityV4>;
    if (update.op === 'delete') {
        delete bucket[update.entity.providerId];
    } else {
        bucket[update.entity.providerId] = update.entity;
    }
    const entities = {
        ...current.entities,
        [entityType]: bucket,
    } as CodexV4EntityBuckets;
    const runtime = newestEntity(Object.values(entities['codex.runtime']));
    const thread = newestEntity(Object.values(entities['codex.thread']));
    const activated = current.activated || runtime?.syncState === 'ready';

    return {
        revisions: { ...current.revisions, [revisionKey]: update.revision },
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
    const parts = Object.values(entities['codex.part']);
    const requests = Object.values(entities['codex.request']);
    const messages: Message[] = [];

    for (const item of Object.values(entities['codex.item'])) {
        const itemParts = parts
            .filter((part) => part.threadId === item.threadId && part.turnId === item.turnId && part.itemId === item.itemId)
            .sort(compareParts);
        const itemRequests = requests.filter((request) => (
            request.threadId === item.threadId
            && request.turnId === item.turnId
            && request.itemId === item.itemId
        ));
        const projected = projectItem(item, itemParts, itemRequests, turns.get(item.turnId));
        if (projected) messages.push(projected);
    }

    const attachedRequestIds = new Set(
        Object.values(entities['codex.request'])
            .filter((request) => request.itemId)
            .map((request) => request.requestId),
    );
    for (const request of requests) {
        if (request.requestType !== 'toolUserInput' || attachedRequestIds.has(request.requestId)) continue;
        messages.push(projectUserInputRequest(request));
    }

    return messages.sort((left, right) => (
        right.createdAt - left.createdAt || right.id.localeCompare(left.id)
    ));
}

function projectItem(
    item: CodexItemEntityV4,
    parts: CodexPartEntityV4[],
    requests: CodexRequestEntityV4[],
    turn: CodexTurnEntityV4 | undefined,
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

    const tool = projectTool(item, parts, requests, turn);
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
            input: { prompt: content, description: item.tool ?? undefined },
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

function mcpToolName(server: string | null, tool: string | null): string {
    const clean = (value: string | null, fallback: string) => (
        (value ?? fallback).replace(/[^a-zA-Z0-9_-]/g, '_')
    );
    return `mcp__${clean(server, 'server')}__${clean(tool, 'tool')}`;
}
