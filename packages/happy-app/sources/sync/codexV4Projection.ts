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
import type { CodexV4RegistrySyncState } from './codexV4ClientRegistry';

type EntityOfType<T extends CodexEntityType> = Extract<CodexEntityV4, { entityType: T }>;

export type CodexV4EntityBuckets = {
    [T in CodexEntityType]: Record<string, EntityOfType<T>>;
};

interface CodexV4ProjectionIndexes {
    turnProviderIdByKey: Record<string, string>;
    itemProviderIdByKey: Record<string, string>;
    itemProviderIdsByTurn: Record<string, string[]>;
    partProviderIdsByItem: Record<string, string[]>;
    requestProviderIdsByItem: Record<string, string[]>;
    relationProviderIdsByItem: Record<string, string[]>;
    commandProviderIdByCommandId: Record<string, string>;
    commandProviderIdsByClientId: Record<string, string[]>;
    commandResultProviderIdsByCommandId: Record<string, string[]>;
    providerUserItemProviderIdsByClientId: Record<string, string[]>;
    replacementCommandProviderIdsByCommandId: Record<string, string[]>;
}

export interface CodexV4UsageProjection {
    inputTokens: number;
    outputTokens: number;
    cacheCreation: number;
    cacheRead: number;
    contextSize: number;
    contextWindow: number | null;
}

export interface CodexV4Projection {
    revisions: Record<string, number>;
    entities: CodexV4EntityBuckets;
    indexes: CodexV4ProjectionIndexes;
    selectedThreadId: string | null;
    thread: CodexThreadEntityV4 | null;
    runtime: CodexRuntimeEntityV4 | null;
    activated: boolean;
    syncHealth: CodexV4RegistrySyncState | null;
    usage: CodexV4UsageProjection | null;
    messages: Message[];
}

export interface CodexV4ProjectionUpdate {
    entity: CodexEntityV4;
    op: SyncMutationOperationV4;
    revision: number;
}

export interface CodexV4QueuedMessage {
    id: string;
    commandId: string;
    text: string;
    createdAt: number;
    command: CodexCommandEntityV4;
}

export function hasCodexV4ProviderUserMessage(
    projection: CodexV4Projection | null | undefined,
    clientUserMessageId: string,
): boolean {
    if (!projection) return false;
    return (projection.indexes.providerUserItemProviderIdsByClientId[clientUserMessageId] ?? [])
        .some((providerId) => Boolean(projection.entities['codex.item'][providerId]));
}

export function newestCodexV4CommandResult(
    projection: CodexV4Projection | null | undefined,
    commandId: string,
): CodexCommandResultEntityV4 | null {
    if (!projection) return null;
    return newestEntity(
        (projection.indexes.commandResultProviderIdsByCommandId[commandId] ?? [])
            .map((providerId) => projection.entities['codex.commandResult'][providerId])
            .filter((entity): entity is CodexCommandResultEntityV4 => Boolean(entity)),
    );
}

export function codexV4QueuedMessages(
    projection: CodexV4Projection | null | undefined,
): CodexV4QueuedMessage[] {
    if (!projection) return [];
    const groups = new Map<string, CodexCommandEntityV4[]>();
    for (const command of Object.values(projection.entities['codex.command'])) {
        const queueEntryId = commandQueueEntryId(command);
        if (!queueEntryId) continue;
        const commands = groups.get(queueEntryId) ?? [];
        commands.push(command);
        groups.set(queueEntryId, commands);
    }

    const queued: CodexV4QueuedMessage[] = [];
    for (const [queueEntryId, commands] of groups) {
        const ordered = [...commands].sort((left, right) => (
            left.createdAt - right.createdAt || left.commandId.localeCompare(right.commandId)
        ));
        const effective = [...ordered].reverse().find((command) => {
            const result = newestCodexV4CommandResult(projection, command.commandId);
            const status = result ? commandResultStatus(result) : null;
            return !result
                || (status !== 'failed'
                    && status !== 'notReplayed'
                    && !(status === 'cancelled' && commandResultReason(result) === 'commandReplaced'));
        });
        if (!effective || effective.command !== 'turn.queue') continue;
        const result = newestCodexV4CommandResult(projection, effective.commandId);
        const resultStatus = result ? commandResultStatus(result) : null;
        if (
            resultStatus === 'succeeded'
            || resultStatus === 'failed'
            || resultStatus === 'notReplayed'
            || resultStatus === 'cancelled'
            || hasCodexV4ProviderUserMessage(projection, effective.clientUserMessageId)
        ) continue;
        const payload = jsonObject(effective.payload);
        const text = typeof payload.displayText === 'string'
            ? payload.displayText
            : typeof payload.text === 'string' ? payload.text : '';
        queued.push({
            id: queueEntryId,
            commandId: effective.commandId,
            text,
            createdAt: commandQueuedAt(ordered[0]),
            command: effective,
        });
    }
    return queued.sort((left, right) => (
        left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    ));
}

export function createCodexV4Projection(selectedThreadId: string | null = null): CodexV4Projection {
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
        indexes: createProjectionIndexes(),
        selectedThreadId,
        thread: null,
        runtime: null,
        activated: false,
        syncHealth: null,
        usage: null,
        messages: [],
    };
}

function createProjectionIndexes(): CodexV4ProjectionIndexes {
    return {
        turnProviderIdByKey: {},
        itemProviderIdByKey: {},
        itemProviderIdsByTurn: {},
        partProviderIdsByItem: {},
        requestProviderIdsByItem: {},
        relationProviderIdsByItem: {},
        commandProviderIdByCommandId: {},
        commandProviderIdsByClientId: {},
        commandResultProviderIdsByCommandId: {},
        providerUserItemProviderIdsByClientId: {},
        replacementCommandProviderIdsByCommandId: {},
    };
}

export function resetCodexV4Projection(current: CodexV4Projection): CodexV4Projection {
    return {
        ...createCodexV4Projection(current.selectedThreadId),
        activated: current.activated,
        syncHealth: current.syncHealth,
    };
}

export function replaceCodexV4Projection(
    current: CodexV4Projection,
    updates: readonly CodexV4ProjectionUpdate[],
    selectedThreadId: string | null = current.selectedThreadId,
): CodexV4Projection {
    return applyCodexV4ProjectionUpdates(
        {
            ...resetCodexV4Projection(current),
            selectedThreadId,
        },
        updates,
        selectedThreadId,
    );
}

export function applyCodexV4SyncState(
    current: CodexV4Projection,
    syncHealth: CodexV4RegistrySyncState,
): CodexV4Projection {
    if (
        current.syncHealth?.type === syncHealth.type
        && current.syncHealth.attempt === syncHealth.attempt
        && current.syncHealth.nextRetryAt === syncHealth.nextRetryAt
        && current.syncHealth.lastErrorAt === syncHealth.lastErrorAt
    ) return current;
    return { ...current, syncHealth };
}

export function applyCodexV4ProjectionUpdate(
    current: CodexV4Projection,
    update: CodexV4ProjectionUpdate,
    selectedThreadId: string | null = current.selectedThreadId,
): CodexV4Projection {
    return applyCodexV4ProjectionUpdates(current, [update], selectedThreadId);
}

export function applyCodexV4ProjectionUpdates(
    current: CodexV4Projection,
    updates: readonly CodexV4ProjectionUpdate[],
    selectedThreadId: string | null = current.selectedThreadId,
): CodexV4Projection {
    const selectionChanged = current.selectedThreadId !== selectedThreadId;
    let revisions = current.revisions;
    const changedBuckets = new Map<CodexEntityType, Record<string, CodexEntityV4>>();
    const indexBuilder = new ProjectionIndexBuilder(current.indexes);
    const affected = createAffectedOwners();
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
        const previous = bucket[update.entity.providerId] ?? null;
        if (
            previous
            && !selectionChanged
            && entityAffectsSelectedThread(previous, selectedThreadId)
        ) {
            collectAffectedOwners(previous, indexBuilder, affected);
        }
        if (update.op === 'delete') {
            delete bucket[update.entity.providerId];
        } else {
            bucket[update.entity.providerId] = update.entity;
        }
        const next = update.op === 'delete' ? null : update.entity;
        if (!hasSameIndexMembership(previous, next)) {
            if (previous) removeEntityFromIndexes(previous, indexBuilder);
            if (next) addEntityToIndexes(next, indexBuilder);
        }
        if (
            next
            && !selectionChanged
            && entityAffectsSelectedThread(next, selectedThreadId)
        ) {
            collectAffectedOwners(next, indexBuilder, affected);
        }
    }
    if (!changed) {
        return selectionChanged
            ? selectCodexV4ProjectionThread(current, selectedThreadId)
            : current;
    }

    let entities = current.entities;
    for (const [entityType, bucket] of changedBuckets) {
        entities = { ...entities, [entityType]: bucket } as CodexV4EntityBuckets;
    }
    const indexes = indexBuilder.finish();
    const runtime = selectionChanged || changedBuckets.has('codex.runtime')
        ? currentEntityForThread(Object.values(entities['codex.runtime']), selectedThreadId)
        : current.runtime;
    const thread = selectionChanged || changedBuckets.has('codex.thread')
        ? currentEntityForThread(Object.values(entities['codex.thread']), selectedThreadId)
        : current.thread;
    const activated = current.activated || runtime?.syncState === 'ready';
    const projectedUsage = selectionChanged
        || changedBuckets.has('codex.thread')
        || changedBuckets.has('codex.turn')
        ? projectUsage(thread, Object.values(entities['codex.turn']), selectedThreadId)
        : current.usage;
    const usage = sameUsageProjection(projectedUsage, current.usage)
        ? current.usage
        : projectedUsage;
    const messages = selectionChanged
        ? projectAllMessages(entities, indexes, selectedThreadId)
        : projectAffectedMessages(
            current.messages,
            entities,
            indexes,
            affected,
            selectedThreadId,
        );

    return {
        revisions,
        entities,
        indexes,
        selectedThreadId,
        runtime,
        thread,
        activated,
        syncHealth: current.syncHealth,
        usage,
        messages,
    };
}

export function selectCodexV4ProjectionThread(
    current: CodexV4Projection,
    selectedThreadId: string | null,
): CodexV4Projection {
    if (current.selectedThreadId === selectedThreadId) return current;
    const thread = currentEntityForThread(
        Object.values(current.entities['codex.thread']),
        selectedThreadId,
    );
    const runtime = currentEntityForThread(
        Object.values(current.entities['codex.runtime']),
        selectedThreadId,
    );
    return {
        ...current,
        selectedThreadId,
        thread,
        runtime,
        activated: current.activated || runtime?.syncState === 'ready',
        usage: projectUsage(
            thread,
            Object.values(current.entities['codex.turn']),
            selectedThreadId,
        ),
        messages: projectAllMessages(current.entities, current.indexes, selectedThreadId),
    };
}

function projectUsage(
    thread: CodexThreadEntityV4 | null,
    turns: CodexTurnEntityV4[],
    selectedThreadId: string | null,
): CodexV4UsageProjection | null {
    const threadUsage = thread?.tokenUsage;
    if (threadUsage) {
        return {
            inputTokens: threadUsage.last.inputTokens,
            outputTokens: threadUsage.last.outputTokens,
            cacheCreation: threadUsage.last.cacheWriteInputTokens,
            cacheRead: threadUsage.last.cachedInputTokens,
            contextSize: threadUsage.last.totalTokens,
            contextWindow: threadUsage.modelContextWindow,
        };
    }
    const turn = newestEntity(turns.filter((entry) => (
        entry.usage !== null
        && (selectedThreadId === null || entry.threadId === selectedThreadId)
    )));
    if (!turn?.usage) return null;
    return {
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        cacheCreation: turn.usage.cacheWriteInputTokens,
        cacheRead: turn.usage.cachedInputTokens,
        contextSize: turn.usage.totalTokens,
        contextWindow: null,
    };
}

function sameUsageProjection(
    left: CodexV4UsageProjection | null,
    right: CodexV4UsageProjection | null,
): boolean {
    return left === right || Boolean(
        left
        && right
        && left.inputTokens === right.inputTokens
        && left.outputTokens === right.outputTokens
        && left.cacheCreation === right.cacheCreation
        && left.cacheRead === right.cacheRead
        && left.contextSize === right.contextSize
        && left.contextWindow === right.contextWindow
    );
}

function currentEntityForThread<T extends {
    threadId: string;
    updatedAt: number;
    providerId: string;
}>(entities: T[], selectedThreadId: string | null): T | null {
    return newestEntity(selectedThreadId === null
        ? entities
        : entities.filter((entity) => entity.threadId === selectedThreadId));
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

type GroupIndexName =
    | 'itemProviderIdsByTurn'
    | 'partProviderIdsByItem'
    | 'requestProviderIdsByItem'
    | 'relationProviderIdsByItem'
    | 'commandProviderIdsByClientId'
    | 'commandResultProviderIdsByCommandId'
    | 'providerUserItemProviderIdsByClientId'
    | 'replacementCommandProviderIdsByCommandId';

type DirectIndexName =
    | 'turnProviderIdByKey'
    | 'itemProviderIdByKey'
    | 'commandProviderIdByCommandId';

class ProjectionIndexBuilder {
    private readonly groupChanges = new Map<GroupIndexName, Map<string, Set<string>>>();
    private readonly directChanges = new Map<DirectIndexName, Map<string, string | null>>();

    constructor(private readonly current: CodexV4ProjectionIndexes) {}

    getGroup(name: GroupIndexName, key: string): readonly string[] {
        return [...(this.groupChanges.get(name)?.get(key) ?? this.current[name][key] ?? [])];
    }

    addGroup(name: GroupIndexName, key: string, providerId: string): void {
        this.mutableGroup(name, key).add(providerId);
    }

    removeGroup(name: GroupIndexName, key: string, providerId: string): void {
        this.mutableGroup(name, key).delete(providerId);
    }

    getDirect(name: DirectIndexName, key: string): string | undefined {
        const changed = this.directChanges.get(name)?.get(key);
        return changed === null ? undefined : changed ?? this.current[name][key];
    }

    setDirect(name: DirectIndexName, key: string, providerId: string | null): void {
        let changes = this.directChanges.get(name);
        if (!changes) {
            changes = new Map();
            this.directChanges.set(name, changes);
        }
        changes.set(key, providerId);
    }

    finish(): CodexV4ProjectionIndexes {
        if (this.groupChanges.size === 0 && this.directChanges.size === 0) return this.current;
        const next = { ...this.current };
        for (const [name, changes] of this.groupChanges) {
            const index = { ...this.current[name] };
            for (const [key, values] of changes) {
                if (values.size === 0) delete index[key];
                else index[key] = [...values].sort();
            }
            next[name] = index;
        }
        for (const [name, changes] of this.directChanges) {
            const index = { ...this.current[name] };
            for (const [key, value] of changes) {
                if (value === null) delete index[key];
                else index[key] = value;
            }
            next[name] = index;
        }
        return next;
    }

    private mutableGroup(name: GroupIndexName, key: string): Set<string> {
        let changes = this.groupChanges.get(name);
        if (!changes) {
            changes = new Map();
            this.groupChanges.set(name, changes);
        }
        let values = changes.get(key);
        if (!values) {
            values = new Set(this.current[name][key] ?? []);
            changes.set(key, values);
        }
        return values;
    }
}

interface AffectedMessageOwners {
    items: Set<string>;
    requests: Set<string>;
    commands: Set<string>;
    commandResults: Set<string>;
}

function createAffectedOwners(): AffectedMessageOwners {
    return {
        items: new Set(),
        requests: new Set(),
        commands: new Set(),
        commandResults: new Set(),
    };
}

function entityAffectsSelectedThread(
    entity: CodexEntityV4,
    selectedThreadId: string | null,
): boolean {
    if (selectedThreadId === null) return true;
    switch (entity.entityType) {
        case 'codex.thread':
        case 'codex.runtime':
        case 'codex.turn':
        case 'codex.item':
        case 'codex.part':
        case 'codex.request':
            return entity.threadId === selectedThreadId;
        case 'codex.command':
        case 'codex.commandResult':
            return entity.threadId === null || entity.threadId === selectedThreadId;
        case 'codex.relation':
            return entity.parentThreadId === selectedThreadId;
        default:
            return assertNever(entity);
    }
}

function collectAffectedOwners(
    entity: CodexEntityV4,
    indexes: ProjectionIndexBuilder,
    affected: AffectedMessageOwners,
): void {
    switch (entity.entityType) {
        case 'codex.turn':
            for (const providerId of indexes.getGroup(
                'itemProviderIdsByTurn',
                turnKey(entity.threadId, entity.turnId),
            )) affected.items.add(providerId);
            return;
        case 'codex.item': {
            affected.items.add(entity.providerId);
            if (isPlanOrDiffItem(entity)) {
                for (const providerId of indexes.getGroup(
                    'itemProviderIdsByTurn',
                    turnKey(entity.threadId, entity.turnId),
                )) affected.items.add(providerId);
            }
            for (const providerId of indexes.getGroup(
                'requestProviderIdsByItem',
                itemKey(entity.threadId, entity.turnId, entity.itemId),
            )) affected.requests.add(providerId);
            if (entity.itemType.toLowerCase() === 'usermessage' && entity.clientId) {
                for (const providerId of indexes.getGroup(
                    'commandProviderIdsByClientId',
                    entity.clientId,
                )) affected.commands.add(providerId);
            }
            return;
        }
        case 'codex.part': {
            const providerId = indexes.getDirect(
                'itemProviderIdByKey',
                itemKey(entity.threadId, entity.turnId, entity.itemId),
            );
            if (providerId) affected.items.add(providerId);
            return;
        }
        case 'codex.request': {
            affected.requests.add(entity.providerId);
            if (entity.turnId !== null && entity.itemId !== null) {
                const parentItemProviderId = indexes.getDirect(
                    'itemProviderIdByKey',
                    itemKey(entity.threadId, entity.turnId, entity.itemId),
                );
                if (parentItemProviderId) affected.items.add(parentItemProviderId);
            }
            return;
        }
        case 'codex.command':
            affected.commands.add(entity.providerId);
            for (const providerId of indexes.getGroup(
                'commandResultProviderIdsByCommandId',
                entity.commandId,
            )) affected.commandResults.add(providerId);
            if (entity.replacesCommandId) {
                const replaced = indexes.getDirect('commandProviderIdByCommandId', entity.replacesCommandId);
                if (replaced) affected.commands.add(replaced);
            }
            return;
        case 'codex.commandResult':
            affected.commandResults.add(entity.providerId);
            {
                const commandProviderId = indexes.getDirect(
                    'commandProviderIdByCommandId',
                    entity.commandId,
                );
                if (commandProviderId) affected.commands.add(commandProviderId);
            }
            return;
        case 'codex.relation': {
            if (entity.parentTurnId === null || entity.delegationItemId === null) return;
            const providerId = indexes.getDirect(
                'itemProviderIdByKey',
                itemKey(entity.parentThreadId, entity.parentTurnId, entity.delegationItemId),
            );
            if (providerId) affected.items.add(providerId);
            return;
        }
        case 'codex.thread':
        case 'codex.runtime':
            return;
        default:
            return assertNever(entity);
    }
}

function isPlanOrDiffItem(item: CodexItemEntityV4): boolean {
    const itemType = item.itemType.toLowerCase();
    return item.itemId === '__turn_plan__'
        || item.itemId === '__turn_diff__'
        || itemType === 'plan'
        || itemType === 'filechange'
        || itemType === 'turndiff';
}

function addEntityToIndexes(entity: CodexEntityV4, indexes: ProjectionIndexBuilder): void {
    switch (entity.entityType) {
        case 'codex.turn':
            indexes.setDirect('turnProviderIdByKey', turnKey(entity.threadId, entity.turnId), entity.providerId);
            return;
        case 'codex.item':
            indexes.setDirect(
                'itemProviderIdByKey',
                itemKey(entity.threadId, entity.turnId, entity.itemId),
                entity.providerId,
            );
            indexes.addGroup('itemProviderIdsByTurn', turnKey(entity.threadId, entity.turnId), entity.providerId);
            if (entity.itemType.toLowerCase() === 'usermessage' && entity.clientId) {
                indexes.addGroup('providerUserItemProviderIdsByClientId', entity.clientId, entity.providerId);
            }
            return;
        case 'codex.part':
            indexes.addGroup(
                'partProviderIdsByItem',
                itemKey(entity.threadId, entity.turnId, entity.itemId),
                entity.providerId,
            );
            return;
        case 'codex.request':
            if (entity.turnId !== null && entity.itemId !== null) {
                indexes.addGroup(
                    'requestProviderIdsByItem',
                    itemKey(entity.threadId, entity.turnId, entity.itemId),
                    entity.providerId,
                );
            }
            return;
        case 'codex.command':
            indexes.setDirect('commandProviderIdByCommandId', entity.commandId, entity.providerId);
            indexes.addGroup('commandProviderIdsByClientId', entity.clientUserMessageId, entity.providerId);
            if (entity.replacesCommandId) {
                indexes.addGroup(
                    'replacementCommandProviderIdsByCommandId',
                    entity.replacesCommandId,
                    entity.providerId,
                );
            }
            return;
        case 'codex.commandResult':
            indexes.addGroup(
                'commandResultProviderIdsByCommandId',
                entity.commandId,
                entity.providerId,
            );
            return;
        case 'codex.relation':
            if (entity.parentTurnId !== null && entity.delegationItemId !== null) {
                indexes.addGroup(
                    'relationProviderIdsByItem',
                    itemKey(entity.parentThreadId, entity.parentTurnId, entity.delegationItemId),
                    entity.providerId,
                );
            }
            return;
        case 'codex.thread':
        case 'codex.runtime':
            return;
        default:
            return assertNever(entity);
    }
}

function removeEntityFromIndexes(entity: CodexEntityV4, indexes: ProjectionIndexBuilder): void {
    switch (entity.entityType) {
        case 'codex.turn': {
            const key = turnKey(entity.threadId, entity.turnId);
            if (indexes.getDirect('turnProviderIdByKey', key) === entity.providerId) {
                indexes.setDirect('turnProviderIdByKey', key, null);
            }
            return;
        }
        case 'codex.item': {
            const key = itemKey(entity.threadId, entity.turnId, entity.itemId);
            if (indexes.getDirect('itemProviderIdByKey', key) === entity.providerId) {
                indexes.setDirect('itemProviderIdByKey', key, null);
            }
            indexes.removeGroup('itemProviderIdsByTurn', turnKey(entity.threadId, entity.turnId), entity.providerId);
            if (entity.itemType.toLowerCase() === 'usermessage' && entity.clientId) {
                indexes.removeGroup('providerUserItemProviderIdsByClientId', entity.clientId, entity.providerId);
            }
            return;
        }
        case 'codex.part':
            indexes.removeGroup(
                'partProviderIdsByItem',
                itemKey(entity.threadId, entity.turnId, entity.itemId),
                entity.providerId,
            );
            return;
        case 'codex.request':
            if (entity.turnId !== null && entity.itemId !== null) {
                indexes.removeGroup(
                    'requestProviderIdsByItem',
                    itemKey(entity.threadId, entity.turnId, entity.itemId),
                    entity.providerId,
                );
            }
            return;
        case 'codex.command':
            if (indexes.getDirect('commandProviderIdByCommandId', entity.commandId) === entity.providerId) {
                indexes.setDirect('commandProviderIdByCommandId', entity.commandId, null);
            }
            indexes.removeGroup('commandProviderIdsByClientId', entity.clientUserMessageId, entity.providerId);
            if (entity.replacesCommandId) {
                indexes.removeGroup(
                    'replacementCommandProviderIdsByCommandId',
                    entity.replacesCommandId,
                    entity.providerId,
                );
            }
            return;
        case 'codex.commandResult':
            indexes.removeGroup(
                'commandResultProviderIdsByCommandId',
                entity.commandId,
                entity.providerId,
            );
            return;
        case 'codex.relation':
            if (entity.parentTurnId !== null && entity.delegationItemId !== null) {
                indexes.removeGroup(
                    'relationProviderIdsByItem',
                    itemKey(entity.parentThreadId, entity.parentTurnId, entity.delegationItemId),
                    entity.providerId,
                );
            }
            return;
        case 'codex.thread':
        case 'codex.runtime':
            return;
        default:
            return assertNever(entity);
    }
}

function hasSameIndexMembership(previous: CodexEntityV4 | null, next: CodexEntityV4 | null): boolean {
    if (!previous || !next || previous.entityType !== next.entityType) return false;
    const previousMembership = indexMembership(previous);
    const nextMembership = indexMembership(next);
    return previousMembership.length === nextMembership.length
        && previousMembership.every((entry, index) => entry === nextMembership[index]);
}

function indexMembership(entity: CodexEntityV4): string[] {
    switch (entity.entityType) {
        case 'codex.turn':
            return [turnKey(entity.threadId, entity.turnId)];
        case 'codex.item':
            return [
                itemKey(entity.threadId, entity.turnId, entity.itemId),
                turnKey(entity.threadId, entity.turnId),
                entity.itemType.toLowerCase() === 'usermessage' ? entity.clientId ?? '' : '',
            ];
        case 'codex.part':
            return [itemKey(entity.threadId, entity.turnId, entity.itemId)];
        case 'codex.request':
            return [entity.turnId !== null && entity.itemId !== null
                ? itemKey(entity.threadId, entity.turnId, entity.itemId)
                : ''];
        case 'codex.command':
            return [entity.commandId, entity.clientUserMessageId, entity.replacesCommandId ?? ''];
        case 'codex.commandResult':
            return [entity.commandId];
        case 'codex.relation':
            return [entity.parentTurnId !== null && entity.delegationItemId !== null
                ? itemKey(entity.parentThreadId, entity.parentTurnId, entity.delegationItemId)
                : ''];
        case 'codex.thread':
        case 'codex.runtime':
            return [];
        default:
            return assertNever(entity);
    }
}

function projectAffectedMessages(
    current: Message[],
    entities: CodexV4EntityBuckets,
    indexes: CodexV4ProjectionIndexes,
    affected: AffectedMessageOwners,
    selectedThreadId: string | null,
): Message[] {
    const affectedMessageIds = new Set<string>();
    const projected: Message[] = [];

    for (const providerId of affected.items) {
        affectedMessageIds.add(itemMessageId(providerId));
        const item = entities['codex.item'][providerId];
        if (!item) continue;
        if (!entityAffectsSelectedThread(item, selectedThreadId)) continue;
        const key = itemKey(item.threadId, item.turnId, item.itemId);
        const parts = (indexes.partProviderIdsByItem[key] ?? [])
            .map((id) => entities['codex.part'][id])
            .filter((part): part is CodexPartEntityV4 => Boolean(part))
            .sort(compareParts);
        const turnProviderId = indexes.turnProviderIdByKey[turnKey(item.threadId, item.turnId)];
        const relation = newestEntity(
            (indexes.relationProviderIdsByItem[key] ?? [])
                .map((id) => entities['codex.relation'][id])
                .filter((entry): entry is CodexRelationEntityV4 => Boolean(entry)),
        );
        const requests = (indexes.requestProviderIdsByItem[key] ?? [])
            .map((id) => entities['codex.request'][id])
            .filter((request): request is CodexRequestEntityV4 => Boolean(request));
        if (shouldSuppressSyntheticItem(item, entities, indexes)) continue;
        const message = projectItem(
            item,
            parts,
            turnProviderId ? entities['codex.turn'][turnProviderId] : undefined,
            relation ?? undefined,
            requests,
        );
        if (message) projected.push(message);
    }

    for (const providerId of affected.requests) {
        affectedMessageIds.add(requestMessageId(providerId));
        const request = entities['codex.request'][providerId];
        if (request && entityAffectsSelectedThread(request, selectedThreadId)) {
            const parentItemProviderId = request.turnId !== null && request.itemId !== null
                ? indexes.itemProviderIdByKey[itemKey(request.threadId, request.turnId, request.itemId)]
                : undefined;
            const parentItem = parentItemProviderId
                ? entities['codex.item'][parentItemProviderId]
                : undefined;
            if (!parentItem || request.requestType === 'toolUserInput') {
                projected.push(projectRequestMessage(request, parentItem));
            }
        }
    }

    for (const providerId of affected.commands) {
        affectedMessageIds.add(commandMessageId(providerId));
        const command = entities['codex.command'][providerId];
        if (!command) continue;
        if (!entityAffectsSelectedThread(command, selectedThreadId)) continue;
        const hasProviderItem = (indexes.providerUserItemProviderIdsByClientId[
            command.clientUserMessageId
        ]?.length ?? 0) > 0;
        const isReplaced = (indexes.replacementCommandProviderIdsByCommandId[
            command.commandId
        ]?.length ?? 0) > 0;
        const commandResult = newestEntity(
            (indexes.commandResultProviderIdsByCommandId[command.commandId] ?? [])
                .map((id) => entities['codex.commandResult'][id])
                .filter((entry): entry is CodexCommandResultEntityV4 => Boolean(entry)),
        );
        const message = projectCommand(command, commandResult ?? undefined, hasProviderItem || isReplaced);
        if (message) projected.push(message);
    }

    for (const providerId of affected.commandResults) {
        affectedMessageIds.add(commandResultMessageId(providerId));
        const result = entities['codex.commandResult'][providerId];
        if (!result) continue;
        if (!entityAffectsSelectedThread(result, selectedThreadId)) continue;
        const commandProviderId = indexes.commandProviderIdByCommandId[result.commandId];
        const command = commandProviderId ? entities['codex.command'][commandProviderId] : undefined;
        if (!shouldProjectCommandResult(result, command)) continue;
        projected.push(projectCommandResult(result, command));
    }

    if (affectedMessageIds.size === 0) return current;
    const unaffected = current.filter((message) => !affectedMessageIds.has(message.id));
    projected.sort(compareMessages);
    return mergeSortedMessages(unaffected, projected);
}

function projectAllMessages(
    entities: CodexV4EntityBuckets,
    indexes: CodexV4ProjectionIndexes,
    selectedThreadId: string | null,
): Message[] {
    return projectAffectedMessages(
        [],
        entities,
        indexes,
        {
            items: new Set(Object.keys(entities['codex.item'])),
            requests: new Set(Object.keys(entities['codex.request'])),
            commands: new Set(Object.keys(entities['codex.command'])),
            commandResults: new Set(Object.keys(entities['codex.commandResult'])),
        },
        selectedThreadId,
    );
}

function projectCommand(
    command: CodexCommandEntityV4,
    result: CodexCommandResultEntityV4 | undefined,
    hidden: boolean,
): Message | null {
    if (hidden || command.command === 'turn.queue') return null;
    const displayText = jsonObject(command.payload).displayText;
    if (typeof displayText !== 'string' || displayText.length === 0) return null;
    const threadId = result?.threadId ?? command.threadId;
    const turnId = result?.turnId ?? command.expectedTurnId;
    const initialTurnOrder = command.command === 'turn.start' && threadId && turnId
        ? {
            codexThreadId: threadId,
            codexTurnId: turnId,
            codexEventSequence: 0,
        }
        : {};
    return {
        kind: 'user-text',
        id: commandMessageId(command.providerId),
        localId: command.clientUserMessageId,
        createdAt: command.createdAt,
        text: displayText,
        ...initialTurnOrder,
    };
}

function compareMessages(left: Message, right: Message): number {
    if (
        left.codexThreadId !== undefined
        && left.codexThreadId === right.codexThreadId
        && left.codexTurnId !== undefined
        && left.codexTurnId === right.codexTurnId
        && left.codexEventSequence !== undefined
        && right.codexEventSequence !== undefined
    ) {
        const eventOrder = right.codexEventSequence - left.codexEventSequence;
        if (eventOrder !== 0) return eventOrder;
    }
    return right.createdAt - left.createdAt || right.id.localeCompare(left.id);
}

function mergeSortedMessages(left: Message[], right: Message[]): Message[] {
    const merged: Message[] = [];
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < left.length || rightIndex < right.length) {
        if (rightIndex >= right.length) {
            merged.push(left[leftIndex++]);
        } else if (leftIndex >= left.length || compareMessages(right[rightIndex], left[leftIndex]) < 0) {
            merged.push(right[rightIndex++]);
        } else {
            merged.push(left[leftIndex++]);
        }
    }
    return merged;
}

function itemKey(threadId: string, turnId: string, itemId: string): string {
    return JSON.stringify([threadId, turnId, itemId]);
}

function turnKey(threadId: string, turnId: string): string {
    return JSON.stringify([threadId, turnId]);
}

function itemMessageId(providerId: string): string {
    return `codex-v4:item:${providerId}`;
}

function requestMessageId(providerId: string): string {
    return `codex-v4:request:${providerId}`;
}

function commandMessageId(providerId: string): string {
    return `codex-v4:command:${providerId}`;
}

function commandResultMessageId(providerId: string): string {
    return `codex-v4:command-result:${providerId}`;
}

function projectCommandResult(
    result: CodexCommandResultEntityV4,
    command: CodexCommandEntityV4 | undefined,
): ToolCallMessage {
    const failed = isCommandFailure(result.status);
    const completed = result.status === 'succeeded' || failed;
    return {
        kind: 'tool-call',
        id: commandResultMessageId(result.providerId),
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

const QUERY_COMMANDS = new Set(['skills.list', 'mcp.status.list', 'model.list']);

function shouldProjectCommandResult(
    result: CodexCommandResultEntityV4,
    command: CodexCommandEntityV4 | undefined,
): boolean {
    if (command?.command === 'turn.queue') {
        const status = commandResultStatus(result);
        return status === 'failed'
            || status === 'notReplayed'
            || (status === 'cancelled'
                && commandResultReason(result) !== 'commandReplaced'
                && commandResultReason(result) !== 'queueCancelled');
    }
    if (command?.command === 'turn.queue.cancel') return false;
    return isCommandFailure(result.status)
        || Boolean(command && QUERY_COMMANDS.has(command.command));
}

function commandQueueEntryId(command: CodexCommandEntityV4): string | null {
    const value = (command as CodexCommandEntityV4 & {
        queueEntryId?: string | null;
    }).queueEntryId;
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function commandQueuedAt(command: CodexCommandEntityV4): number {
    const value = (command as CodexCommandEntityV4 & { queuedAt?: number }).queuedAt;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : command.createdAt;
}

function commandResultStatus(result: CodexCommandResultEntityV4): string {
    return result.status as string;
}

function commandResultReason(result: CodexCommandResultEntityV4): string | null {
    return (result as CodexCommandResultEntityV4 & { reason?: string | null }).reason ?? null;
}

function isCommandFailure(status: CodexCommandResultEntityV4['status']): boolean {
    return status === 'failed'
        || status === 'resultUnknown'
        || status === 'notReplayed'
        || (status as string) === 'cancelled';
}

function projectItem(
    item: CodexItemEntityV4,
    parts: CodexPartEntityV4[],
    turn: CodexTurnEntityV4 | undefined,
    relation: CodexRelationEntityV4 | undefined,
    requests: CodexRequestEntityV4[],
): Message | null {
    const itemType = item.itemType.toLowerCase();
    const createdAt = item.startedAt ?? item.createdAt;
    const text = contentForKinds(parts, ['text', 'userInput']);
    const order = projectItemOrder(item);

    // Older snapshots may still contain startup telemetry produced before R12.
    // It is a thread-runtime concern, not a model tool call, so keep the cached
    // entity for sync integrity while excluding it from the chat projection.
    if (itemType === 'mcpstartup') return null;

    const isTimelineEvent = itemType === 'contextcompaction'
        || itemType === 'enteredreviewmode'
        || itemType === 'exitedreviewmode';
    if (isTimelineEvent && toolState(item, turn) !== 'error') {
        return {
            kind: 'timeline-event',
            id: itemMessageId(item.providerId),
            createdAt,
            event: itemType === 'contextcompaction'
                ? 'context-compaction'
                : itemType === 'enteredreviewmode'
                    ? 'review-started'
                    : 'review-finished',
            ...order,
        };
    }

    if (itemType === 'usermessage') {
        if (!text) return null;
        return {
            kind: 'user-text',
            id: itemMessageId(item.providerId),
            localId: item.clientId,
            createdAt,
            text,
            codexItemId: item.itemId,
            ...order,
        };
    }

    if (itemType === 'agentmessage') {
        if (!text) return null;
        return {
            kind: 'agent-text',
            id: itemMessageId(item.providerId),
            localId: null,
            createdAt,
            text,
            ...order,
        };
    }

    if (itemType === 'subagentactivity') return null;

    const linkedRequests = requests.filter((request) => request.requestType !== 'toolUserInput');
    const pendingRequest = oldestPendingRequest(linkedRequests);
    if (pendingRequest) {
        return projectRequestMessage(
            pendingRequest,
            item,
            itemMessageId(item.providerId),
            linkedRequests.filter((request) => request.status === 'pending').length,
        );
    }
    const latestRequest = newestEntity(linkedRequests);
    if (latestRequest && isRejectedRequest(latestRequest)) {
        return projectRequestMessage(latestRequest, item, itemMessageId(item.providerId));
    }

    const tool = projectTool(item, parts, turn, relation);
    return tool ? {
        kind: 'tool-call',
        id: itemMessageId(item.providerId),
        localId: null,
        createdAt,
        tool,
        children: [],
        ...order,
    } : null;
}

function projectItemOrder(item: CodexItemEntityV4) {
    return {
        codexThreadId: item.threadId,
        codexTurnId: item.turnId,
        ...(item.eventSequence === undefined ? {} : { codexEventSequence: item.eventSequence }),
    };
}

function projectTool(
    item: CodexItemEntityV4,
    parts: CodexPartEntityV4[],
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
    const base = {
        state,
        createdAt,
        startedAt: item.startedAt,
        completedAt,
        description: null,
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
    if (itemType === 'plan') {
        return {
            ...base,
            name: 'CodexPlan',
            input: {},
            result: content || undefined,
        };
    }
    if (itemType === 'turndiff') {
        return {
            ...base,
            name: 'CodexPatch',
            input: { changes: content },
            result: state === 'error' ? content : undefined,
        };
    }
    if (itemType === 'websearch') {
        const parsed = parseJsonContent(content);
        return {
            ...base,
            name: 'WebSearch',
            input: parsed ?? item.arguments ?? {},
            result: (parsed ?? content) || undefined,
        };
    }
    return {
        ...base,
        name: 'CodexActivity',
        input: { type: item.itemType, arguments: item.arguments ?? {} },
        result: (parseJsonContent(content) ?? content) || undefined,
        description: item.tool ?? item.itemType,
    };
}

function oldestPendingRequest(requests: CodexRequestEntityV4[]): CodexRequestEntityV4 | null {
    let oldest: CodexRequestEntityV4 | null = null;
    for (const request of requests) {
        if (request.status !== 'pending') continue;
        if (
            !oldest
            || request.createdAt < oldest.createdAt
            || (request.createdAt === oldest.createdAt && request.providerId < oldest.providerId)
        ) oldest = request;
    }
    return oldest;
}

function isRejectedRequest(request: CodexRequestEntityV4): boolean {
    return request.status === 'declined'
        || request.status === 'cancelled'
        || request.status === 'error';
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

function projectRequestMessage(
    request: CodexRequestEntityV4,
    parentItem: CodexItemEntityV4 | undefined,
    messageId: string = requestMessageId(request.providerId),
    pendingRequestCount: number = 1,
): ToolCallMessage {
    const isUserInput = request.requestType === 'toolUserInput';
    const name = isUserInput
        ? 'AskUserQuestion'
        : 'CodexApproval';
    const messageCreatedAt = parentItem?.startedAt ?? parentItem?.createdAt ?? request.createdAt;
    return {
        kind: 'tool-call',
        id: messageId,
        localId: null,
        createdAt: messageCreatedAt,
        children: [],
        tool: {
            name,
            state: request.status === 'pending' ? 'running' : request.status === 'error' ? 'error' : 'completed',
            input: isUserInput
                ? request.options ?? { questions: request.prompt ? [{ question: request.prompt }] : [] }
                : {
                    requestType: request.requestType,
                    title: request.title,
                    prompt: request.prompt,
                    options: request.options,
                    pendingRequestCount,
                },
            result: request.response ?? undefined,
            createdAt: request.createdAt,
            startedAt: request.createdAt,
            completedAt: request.status === 'pending'
                ? null
                : request.resolvedAt ?? request.updatedAt,
            description: request.title,
            permission: projectPermission(request),
        },
        ...(parentItem ? projectItemOrder(parentItem) : {}),
    };
}

function shouldSuppressSyntheticItem(
    item: CodexItemEntityV4,
    entities: CodexV4EntityBuckets,
    indexes: CodexV4ProjectionIndexes,
): boolean {
    if (item.itemId !== '__turn_plan__' && item.itemId !== '__turn_diff__') return false;
    const canonicalType = item.itemId === '__turn_plan__' ? 'plan' : 'filechange';
    return (indexes.itemProviderIdsByTurn[turnKey(item.threadId, item.turnId)] ?? []).some((providerId) => {
        const candidate = entities['codex.item'][providerId];
        return candidate
            && candidate.providerId !== item.providerId
            && candidate.itemId !== item.itemId
            && candidate.itemType.toLowerCase() === canonicalType;
    });
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

function assertNever(value: never): never {
    throw new Error(`Unhandled Codex v4 entity: ${String(value)}`);
}
