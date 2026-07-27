/** Routes every Codex stable-v2 thread to one isolated Happy Sync v4 session. */

import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    type CodexRelationEntityV4,
} from '@slopus/happy-wire';
import type { SyncV4Client } from '@/api/syncV4Client';
import type {
    CodexConnectionEvent,
    CodexServerRequest,
} from './codexAppServerClient';
import type { CodexSyncV4Mapper } from './codexSyncV4Mapper';
import type { CodexV4CommandProcessor } from './codexV4CommandProcessor';
import type { CodexV4RequestBroker } from './codexV4RequestBroker';
import type { CodexV4ChildThreadRoute, CodexV4MigrationSink } from './codexV4Migration';
import { childThreadReferences } from './codexV4Migration';
import type { ServerNotification, Thread, ThreadGoal, ThreadStatus } from './protocol';

export interface CodexV4SessionBinding {
    sessionId: string;
    sessionKey: Uint8Array;
    mapper: CodexSyncV4Mapper;
    syncClient: SyncV4Client;
    commandProcessor: CodexV4CommandProcessor;
    requestBroker: CodexV4RequestBroker;
    close(): Promise<void>;
}

interface ThreadRouterOptions {
    rootBinding: CodexV4SessionBinding;
    readThread: (threadId: string) => Promise<Thread>;
    readGoal?: (threadId: string) => Promise<ThreadGoal | null>;
    createChildBinding: (
        route: CodexV4ChildThreadRoute,
        parentBinding: CodexV4SessionBinding,
    ) => Promise<CodexV4SessionBinding>;
    now?: () => number;
    onError?: (error: unknown) => void;
}

interface RelationLineage {
    parentThreadId: string;
    parentTurnId: string | null;
    delegationItemId: string | null;
    depth: number;
}

export class CodexV4ThreadRouter {
    private readonly bindingsByThread = new Map<string, CodexV4SessionBinding>();
    private readonly bindingPromisesByThread = new Map<string, Promise<CodexV4SessionBinding>>();
    private readonly lineagesByChild = new Map<string, RelationLineage>();
    private readonly relationsByChild = new Map<string, CodexRelationEntityV4>();
    private pipeline: Promise<void> = Promise.resolve();
    private rootThreadId: string | null = null;
    private closed = false;

    constructor(private readonly options: ThreadRouterOptions) {}

    registerRootThread(threadId: string): void {
        if (this.rootThreadId && this.rootThreadId !== threadId) {
            throw new Error('Codex root thread cannot change after Sync v4 routing starts');
        }
        this.rootThreadId = threadId;
        this.bindingsByThread.set(threadId, this.options.rootBinding);
    }

    handleNotification(notification: ServerNotification): void {
        if (this.closed) return;
        this.pipeline = this.pipeline
            .then(() => this.routeNotification(notification))
            .catch((error) => { this.options.onError?.(error); });
    }

    async handleRequest(request: CodexServerRequest): Promise<unknown> {
        if (this.closed) throw new Error('Codex v4 thread router is closed');
        const threadId = requestThreadId(request);
        const binding = await this.bindingForThread(threadId);
        return await binding.requestBroker.handle(request);
    }

    setConnection(event: CodexConnectionEvent): void {
        for (const binding of new Set(this.bindingsByThread.values())) {
            void binding.mapper.setConnection(event.connection, {
                statusUnknown: event.statusUnknown,
                error: event.error,
            }).catch((error) => this.options.onError?.(error));
        }
    }

    migrationSinkForRoot(): CodexV4MigrationSink {
        return migrationSink(this.options.rootBinding);
    }

    async migrationSinkForChild(route: CodexV4ChildThreadRoute): Promise<CodexV4MigrationSink> {
        const binding = await this.ensureChildBinding(route.thread, {
            parentThreadId: route.parentThreadId,
            parentTurnId: route.parentTurnId,
            delegationItemId: route.delegationItemId,
            depth: route.depth,
        }, false);
        return migrationSink(binding);
    }

    async flush(): Promise<void> {
        await this.pipeline;
        for (const binding of new Set(this.bindingsByThread.values())) {
            await binding.mapper.flush();
        }
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.flush();
        await Promise.allSettled(this.bindingPromisesByThread.values());
        const bindings = new Set(this.bindingsByThread.values());
        bindings.delete(this.options.rootBinding);
        await Promise.allSettled([...bindings].map((binding) => binding.close()));
        this.bindingsByThread.clear();
    }

    private async routeNotification(notification: ServerNotification): Promise<void> {
        const threadId = notificationThreadId(notification);
        if (!threadId) return;

        let binding = this.bindingsByThread.get(threadId);
        const snapshot = notification.method === 'thread/started' ? notification.params.thread : null;
        if (!binding && snapshot) {
            binding = await this.bindingForSnapshot(snapshot);
        } else if (!binding) {
            const hydrated = await this.options.readThread(threadId);
            binding = await this.bindingForSnapshot(hydrated);
            if (binding === this.options.rootBinding) {
                binding.mapper.importThread(hydrated);
                binding.mapper.importGoal(
                    threadId,
                    this.options.readGoal ? await this.options.readGoal(threadId) : null,
                );
            }
        }

        binding.mapper.handleNotification(notification);
        if (snapshot) await this.discoverChildren(snapshot);
        await this.discoverChildrenFromNotification(notification);
        await this.updateChildRelation(threadId, notification);
    }

    private async bindingForSnapshot(thread: Thread): Promise<CodexV4SessionBinding> {
        const existing = this.bindingsByThread.get(thread.id);
        if (existing) return existing;
        if (thread.id === this.rootThreadId || (!this.rootThreadId && !thread.parentThreadId)) {
            this.registerRootThread(thread.id);
            return this.options.rootBinding;
        }

        const lineage = this.lineagesByChild.get(thread.id) ?? {
            parentThreadId: requiredParentThreadId(thread),
            parentTurnId: null,
            delegationItemId: null,
            depth: await this.depthForParent(requiredParentThreadId(thread)) + 1,
        };
        return await this.ensureChildBinding(thread, lineage);
    }

    private async ensureChildBinding(
        thread: Thread,
        lineage: RelationLineage,
        activate = true,
    ): Promise<CodexV4SessionBinding> {
        const existing = this.bindingsByThread.get(thread.id);
        if (existing) return existing;
        const pending = this.bindingPromisesByThread.get(thread.id);
        if (pending) return await pending;
        if (this.closed) throw new Error('Codex v4 thread router is closed');

        const creation = this.createChildBinding(thread, lineage, activate);
        this.bindingPromisesByThread.set(thread.id, creation);
        try {
            return await creation;
        } finally {
            if (this.bindingPromisesByThread.get(thread.id) === creation) {
                this.bindingPromisesByThread.delete(thread.id);
            }
        }
    }

    private async createChildBinding(
        thread: Thread,
        lineage: RelationLineage,
        activate: boolean,
    ): Promise<CodexV4SessionBinding> {
        if (!this.bindingsByThread.has(lineage.parentThreadId)) {
            const parent = await this.options.readThread(lineage.parentThreadId);
            await this.bindingForSnapshot(parent);
        }

        await this.recordLineage(thread.id, lineage);
        const resolvedLineage = this.lineagesByChild.get(thread.id)!;
        const route: CodexV4ChildThreadRoute = {
            thread,
            parentThreadId: resolvedLineage.parentThreadId,
            parentTurnId: resolvedLineage.parentTurnId,
            delegationItemId: resolvedLineage.delegationItemId,
            depth: resolvedLineage.depth,
        };
        const parentBinding = this.bindingsByThread.get(resolvedLineage.parentThreadId);
        if (!parentBinding) throw new Error('Codex child relation has no parent session binding');
        const binding = await this.options.createChildBinding(route, parentBinding);
        this.bindingsByThread.set(thread.id, binding);
        const finalLineage = this.lineagesByChild.get(thread.id) ?? resolvedLineage;
        await this.publishRelation(thread, binding, finalLineage);
        if (activate) {
            const goal = this.options.readGoal ? await this.options.readGoal(thread.id) : null;
            await activateChildBinding(binding, thread, goal);
        }
        return binding;
    }

    private async bindingForThread(threadId: string): Promise<CodexV4SessionBinding> {
        const existing = this.bindingsByThread.get(threadId);
        if (existing) return existing;
        const snapshot = await this.options.readThread(threadId);
        const binding = await this.bindingForSnapshot(snapshot);
        if (binding === this.options.rootBinding) binding.mapper.importThread(snapshot);
        await binding.mapper.flush();
        return binding;
    }

    private async discoverChildren(thread: Thread): Promise<void> {
        const parentDepth = thread.id === this.rootThreadId
            ? 0
            : this.lineagesByChild.get(thread.id)?.depth ?? 0;
        for (const child of childThreadReferences(thread)) {
            await this.recordLineage(child.childThreadId, {
                parentThreadId: thread.id,
                parentTurnId: child.parentTurnId,
                delegationItemId: child.delegationItemId,
                depth: parentDepth + 1,
            });
        }
    }

    private async discoverChildrenFromNotification(notification: ServerNotification): Promise<void> {
        if (notification.method !== 'item/started' && notification.method !== 'item/completed') return;
        const item = notification.params.item;
        const childThreadIds = item.type === 'collabAgentToolCall'
            ? item.receiverThreadIds
            : item.type === 'subAgentActivity' ? [item.agentThreadId] : [];
        const parentDepth = notification.params.threadId === this.rootThreadId
            ? 0
            : this.lineagesByChild.get(notification.params.threadId)?.depth ?? 0;
        for (const childThreadId of childThreadIds) {
            if (!childThreadId || childThreadId === notification.params.threadId) continue;
            await this.recordLineage(childThreadId, {
                parentThreadId: notification.params.threadId,
                parentTurnId: notification.params.turnId,
                delegationItemId: item.id,
                depth: parentDepth + 1,
            });
        }
    }

    private async recordLineage(childThreadId: string, incoming: RelationLineage): Promise<void> {
        const current = this.lineagesByChild.get(childThreadId);
        if (current && current.parentThreadId !== incoming.parentThreadId) {
            throw new Error('Codex child thread reported conflicting parents');
        }
        const next: RelationLineage = current ? {
            parentThreadId: current.parentThreadId,
            parentTurnId: current.parentTurnId ?? incoming.parentTurnId,
            delegationItemId: current.delegationItemId ?? incoming.delegationItemId,
            depth: Math.min(current.depth, incoming.depth),
        } : incoming;
        this.lineagesByChild.set(childThreadId, next);

        const relation = this.relationsByChild.get(childThreadId);
        if (
            !relation
            || (
                relation.parentTurnId === next.parentTurnId
                && relation.delegationItemId === next.delegationItemId
                && relation.depth === next.depth
            )
        ) {
            return;
        }
        const updated = {
            ...relation,
            parentTurnId: next.parentTurnId,
            delegationItemId: next.delegationItemId,
            depth: next.depth,
            updatedAt: this.now(),
        };
        this.relationsByChild.set(childThreadId, updated);
        const parentBinding = this.bindingsByThread.get(updated.parentThreadId);
        if (parentBinding) await parentBinding.mapper.upsertRelation(updated);
    }

    private async publishRelation(
        thread: Thread,
        childBinding: CodexV4SessionBinding,
        lineage: RelationLineage,
    ): Promise<void> {
        const parentBinding = this.bindingsByThread.get(lineage.parentThreadId);
        if (!parentBinding) throw new Error('Codex child relation has no parent session binding');
        const now = this.now();
        const relation: CodexRelationEntityV4 = {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.relation',
            providerId: `${lineage.parentThreadId}\0relation\0${thread.id}`,
            createdAt: toEpochMs(thread.createdAt, now),
            updatedAt: now,
            parentThreadId: lineage.parentThreadId,
            childThreadId: thread.id,
            parentTurnId: lineage.parentTurnId,
            delegationItemId: lineage.delegationItemId,
            parentSessionId: parentBinding.sessionId,
            childSessionId: childBinding.sessionId,
            depth: lineage.depth,
            status: relationStatus(thread.status),
        };
        this.relationsByChild.set(thread.id, relation);
        await parentBinding.mapper.upsertRelation(relation);
    }

    private async updateChildRelation(threadId: string, notification: ServerNotification): Promise<void> {
        const relation = this.relationsByChild.get(threadId);
        if (!relation) return;
        const status = notification.method === 'turn/started'
            ? 'active'
            : notification.method === 'turn/completed'
                ? turnRelationStatus(notification.params.turn.status)
                : notification.method === 'thread/status/changed'
                    ? relationStatus(notification.params.status)
                    : relation.status;
        if (status === relation.status) return;
        const next = { ...relation, status, updatedAt: this.now() };
        this.relationsByChild.set(threadId, next);
        const parentBinding = this.bindingsByThread.get(next.parentThreadId);
        if (parentBinding) await parentBinding.mapper.upsertRelation(next);
    }

    private async depthForParent(parentThreadId: string): Promise<number> {
        if (parentThreadId === this.rootThreadId) return 0;
        const known = this.lineagesByChild.get(parentThreadId);
        if (known) return known.depth;
        const parent = await this.options.readThread(parentThreadId);
        await this.bindingForSnapshot(parent);
        return this.lineagesByChild.get(parentThreadId)?.depth ?? 0;
    }

    private now(): number {
        return Math.max(0, Math.trunc(this.options.now?.() ?? Date.now()));
    }
}

function migrationSink(binding: CodexV4SessionBinding): CodexV4MigrationSink {
    return {
        prepareMigration: (threadId) => binding.mapper.prepareMigration(threadId),
        importThread: (thread) => binding.mapper.importThread(thread),
        importGoal: (threadId, goal) => binding.mapper.importGoal(threadId, goal),
        setSyncState: (state) => binding.mapper.setSyncState(state),
        flush: () => binding.mapper.flush(),
        flushOutboundOnce: () => binding.syncClient.flushOutboundOnce(),
    };
}

async function activateChildBinding(
    binding: CodexV4SessionBinding,
    thread: Thread,
    goal: ThreadGoal | null,
): Promise<void> {
    const sink = migrationSink(binding);
    await sink.prepareMigration(thread.id);
    await sink.flush();
    await sink.flushOutboundOnce();
    await sink.setSyncState('importing');
    await sink.flush();
    await sink.flushOutboundOnce();
    sink.importThread(thread);
    sink.importGoal(thread.id, goal);
    await sink.flush();
    await sink.flushOutboundOnce();
    await sink.setSyncState('ready');
    await sink.flush();
    await sink.flushOutboundOnce();
}

function notificationThreadId(notification: ServerNotification): string | null {
    const params = notification.params as unknown as Record<string, unknown>;
    if (typeof params.threadId === 'string' && params.threadId.length > 0) return params.threadId;
    const thread = params.thread;
    return thread && typeof thread === 'object' && typeof (thread as { id?: unknown }).id === 'string'
        ? (thread as { id: string }).id
        : null;
}

function requestThreadId(request: CodexServerRequest): string {
    const params = request.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new Error('Codex server request has no threadId');
    }
    const threadId = (params as Record<string, unknown>).threadId;
    if (typeof threadId !== 'string' || threadId.length === 0) {
        throw new Error('Codex server request has no threadId');
    }
    return threadId;
}

function requiredParentThreadId(thread: Thread): string {
    if (!thread.parentThreadId) throw new Error('Unknown Codex thread has no parentThreadId');
    return thread.parentThreadId;
}

function relationStatus(status: ThreadStatus): CodexRelationEntityV4['status'] {
    if (status.type === 'active') return 'active';
    if (status.type === 'systemError') return 'failed';
    if (status.type === 'notLoaded') return 'starting';
    return 'completed';
}

function turnRelationStatus(status: string): CodexRelationEntityV4['status'] {
    if (status === 'failed') return 'failed';
    if (status === 'interrupted') return 'interrupted';
    return status === 'inProgress' ? 'active' : 'completed';
}

function toEpochMs(value: number, fallback: number): number {
    if (!Number.isFinite(value) || value < 0) return fallback;
    return Math.trunc(value < 10_000_000_000 ? value * 1_000 : value);
}
