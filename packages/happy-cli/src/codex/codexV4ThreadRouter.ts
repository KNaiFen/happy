/** Routes every Codex stable-v2 thread to one isolated Happy Sync v4 session. */

import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    classifySyncV4DiagnosticError,
    recordSyncV4DiagnosticSafely,
    type CodexRelationEntityV4,
    type SyncV4DiagnosticInput,
    type SyncV4DiagnosticSink,
    type SyncV4DiagnosticTransportSecurity,
} from '@slopus/happy-wire';
import type { SyncV4Client } from '@/api/syncV4Client';
import type {
    SyncV4CodexNotification,
    SyncV4CodexThreadRoute,
    SyncV4CodexThreadRouteKind,
} from '@/api/syncV4Journal';
import { logger } from '@/ui/logger';
import { AsyncLock } from '@/utils/lock';
import { createHash } from 'node:crypto';
import type {
    CodexConnectionEvent,
    CodexManagedServerResponse,
    CodexServerRequest,
} from './codexAppServerClient';
import type { CodexSyncV4Mapper } from './codexSyncV4Mapper';
import type { CodexV4CommandProcessor } from './codexV4CommandProcessor';
import type { CodexV4RequestBroker } from './codexV4RequestBroker';
import type { CodexV4ChildThreadRoute, CodexV4MigrationSink } from './codexV4Migration';
import {
    childThreadReferences,
    CodexV4Migrator,
    finalizeCodexV4Activation,
} from './codexV4Migration';
import type {
    ServerNotification,
    Thread,
    ThreadGoal,
    ThreadItem,
    ThreadStatus,
    Turn,
} from './protocol';
import { redactCodexProtocolMethod } from './codexProtocolMethod';

export interface CodexV4SessionBinding {
    sessionId: string;
    sessionKey: Uint8Array;
    mapper: CodexSyncV4Mapper;
    syncClient: SyncV4Client;
    commandProcessor: CodexV4CommandProcessor;
    requestBroker: CodexV4RequestBroker;
    recover(options?: { resumeCommands?: boolean }): Promise<void>;
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
    routeRegistrationWaitMs?: number;
    diagnostics?: SyncV4DiagnosticSink;
    diagnosticSessionHash?: string;
    softwareVersion?: string;
    codexVersion?: string;
    transportSecurity?: SyncV4DiagnosticTransportSecurity;
    onRouteRegistered?: (threadId: string) => void;
}

interface RelationLineage {
    kind: Extract<SyncV4CodexThreadRouteKind, 'providerChild' | 'detachedReview'>;
    parentThreadId: string;
    parentTurnId: string | null;
    delegationItemId: string | null;
    depth: number;
}

interface RouteRegistrationWaiter {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

const ORPHAN_RETRY_BASE_MS = 250;
const ORPHAN_RETRY_MAX_MS = 30_000;
const DEFAULT_ROUTE_REGISTRATION_WAIT_MS = 5_000;

function diagnosticThreadHash(threadId: string): string {
    return createHash('sha256').update(threadId).digest('hex').slice(0, 16);
}

class CodexRouteAwaitingRegistrationError extends Error {
    constructor(readonly threadId: string) {
        super('Codex thread is awaiting authoritative Happy route registration');
        this.name = 'CodexRouteAwaitingRegistrationError';
    }
}

/**
 * Identifies whether a failed notification still has a durable recovery copy.
 * The Gateway barrier may continue past a durable orphan, but must reject when
 * the notification was not persisted and therefore cannot be recovered later.
 */
export class CodexV4NotificationRoutingError extends Error {
    readonly name = 'CodexV4NotificationRoutingError';

    constructor(
        readonly threadId: string,
        readonly durablyQueued: boolean,
        readonly diagnosticCause: unknown,
        readonly routingCause: unknown = null,
    ) {
        super(durablyQueued
            ? 'Codex notification was durably queued for recovery'
            : 'Codex notification could not be durably queued for recovery');
    }

    get orphanPersisted(): boolean {
        return this.durablyQueued;
    }
}

export function isCodexV4NotificationRoutingError(
    error: unknown,
): error is CodexV4NotificationRoutingError {
    return error instanceof CodexV4NotificationRoutingError;
}

export class CodexV4ThreadRouter {
    private readonly bindingsByThread = new Map<string, CodexV4SessionBinding>();
    private readonly bindingPromisesByThread = new Map<string, Promise<CodexV4SessionBinding>>();
    private readonly lineagesByChild = new Map<string, RelationLineage>();
    private readonly routesByThread = new Map<string, SyncV4CodexThreadRoute>();
    private readonly relationsByChild = new Map<string, CodexRelationEntityV4>();
    private readonly recoverableChildrenByParent = new Map<string, Set<string>>();
    private readonly activeTurnByThread = new Map<string, string>();
    private readonly pipelinesByThread = new Map<string, Promise<void>>();
    private readonly hydratedThreads = new Set<string>();
    private readonly threadsWithPendingOrphans = new Set<string>();
    private readonly orphanRetryAttempts = new Map<string, number>();
    private readonly orphanRetryTimers = new Map<string, NodeJS.Timeout>();
    private readonly routeRegistrationWaiters = new Map<string, Set<RouteRegistrationWaiter>>();
    private readonly provisionalRoutesByThread = new Set<string>();
    private readonly relinquishedChildThreads = new Set<string>();
    private readonly routeLock = new AsyncLock();
    private closed = false;
    private closePromise: Promise<void> | null = null;

    constructor(private readonly options: ThreadRouterOptions) {
        for (const route of options.rootBinding.syncClient.getCodexThreadRoutes().values()) {
            this.restoreRoute(route);
        }
        for (const pending of options.rootBinding.syncClient.getPendingCodexNotifications()) {
            this.threadsWithPendingOrphans.add(pending.threadId);
        }
    }

    async registerRootThread(
        threadId: string,
        coordinatedCommandId?: string,
    ): Promise<void> {
        await this.persistRoute({
            threadId,
            kind: 'root',
            parentThreadId: null,
            parentTurnId: null,
            delegationItemId: null,
            depth: 0,
            ...(coordinatedCommandId ? { coordinatedCommandId } : {}),
        });
        await this.retryPendingForThread(threadId);
    }

    async registerUserFork(
        threadId: string,
        forkedFromThreadId: string,
        coordinatedCommandId?: string,
    ): Promise<void> {
        await this.persistRoute({
            threadId,
            kind: 'userFork',
            parentThreadId: forkedFromThreadId,
            parentTurnId: null,
            delegationItemId: null,
            depth: 0,
            ...(coordinatedCommandId ? { coordinatedCommandId } : {}),
        });
        await this.retryPendingForThread(threadId);
    }

    async registerDetachedReview(
        threadId: string,
        parentThreadId: string,
        parentTurnId: string | null = null,
        coordinatedCommandId?: string,
    ): Promise<void> {
        if (threadId === parentThreadId) {
            await this.registerRootThread(parentThreadId, coordinatedCommandId);
            return;
        }
        await this.recordLineage(threadId, {
            kind: 'detachedReview',
            parentThreadId,
            parentTurnId,
            delegationItemId: null,
            depth: await this.depthForParent(parentThreadId) + 1,
        }, coordinatedCommandId);
        await this.retryPendingForThread(threadId);
    }

    async migrateRootSnapshot(threadId: string, acquiredSnapshot?: Thread): Promise<void> {
        if (acquiredSnapshot && acquiredSnapshot.id !== threadId) {
            throw new Error('Codex root snapshot did not match the requested thread');
        }
        const sink = this.migrationSinkForRoot();
        this.options.rootBinding.mapper.prepareSnapshotBarrier(threadId);
        const state = sink.getMigrationState(threadId);
        if (state === 'ready' || state === 'activating') {
            const snapshot = acquiredSnapshot ?? await this.options.readThread(threadId);
            const goal = this.options.readGoal ? await this.options.readGoal(threadId) : null;
            this.options.rootBinding.mapper.importThreadState(snapshot);
            this.options.rootBinding.mapper.importGoal(threadId, goal);
            await sink.releaseMigrationBarrier(threadId);
            await sink.flush();
            await sink.flushOutboundOnce();
            if (state === 'activating') {
                await finalizeCodexV4Activation(sink, threadId);
            } else {
                await sink.setSyncState('ready');
                await sink.flush();
                await sink.flushOutboundOnce();
            }
            return;
        }

        const migrator = new CodexV4Migrator({
            rootSink: sink,
            readThread: this.options.readThread,
            readGoal: this.options.readGoal,
            resolveChildSink: (route) => this.migrationSinkForChild(route),
        });
        await migrator.prepareRoot(threadId);
        await migrator.migrate(acquiredSnapshot ?? await this.options.readThread(threadId));
    }

    async reconcileRollbackSnapshot(threadId: string, snapshot: Thread): Promise<void> {
        if (snapshot.id !== threadId) {
            throw new Error('Codex rollback snapshot did not match the requested thread');
        }
        await this.enqueueThread(threadId, async () => {
            const binding = await this.bindingForThread(threadId);
            if (
                this.options.rootBinding.syncClient.getPendingCodexNotifications()
                    .some((entry) => entry.threadId === threadId)
            ) {
                this.threadsWithPendingOrphans.add(threadId);
                try {
                    await this.drainPendingNotifications(threadId);
                } catch (error) {
                    throw new CodexV4NotificationRoutingError(threadId, true, error);
                }
            }
            await binding.mapper.reconcileRollbackSnapshot(snapshot);
            await binding.mapper.flush();
            this.hydratedThreads.add(threadId);
        });
    }

    async recoverPendingNotifications(): Promise<void> {
        const threadIds = new Set(
            this.options.rootBinding.syncClient.getPendingCodexNotifications()
                .map((pending) => pending.threadId),
        );
        await Promise.allSettled([...threadIds].map((threadId) => this.retryPendingForThread(threadId)));
    }

    async recoverActiveThreads(): Promise<void> {
        const routes = [...this.routesByThread.values()].filter((route) => (
            (route.kind === 'providerChild' || route.kind === 'detachedReview')
            && (route.status === 'starting' || route.status === 'active')
        ));
        for (const route of routes) {
            if (this.closed || this.bindingsByThread.has(route.threadId)) continue;
            try {
                await this.enqueueThread(route.threadId, async () => {
                    const snapshot = await this.options.readThread(route.threadId);
                    const binding = await this.bindingForSnapshot(snapshot);
                    await binding.mapper.flush();
                    this.hydratedThreads.add(route.threadId);
                });
            } catch (error) {
                this.options.onError?.(error);
            }
        }
    }

    handleNotification(notification: ServerNotification): void {
        void this.handleNotificationAsync(notification).catch(() => undefined);
    }

    async handleNotificationAsync(notification: ServerNotification): Promise<void> {
        if (this.closed) return;
        const threadId = notificationThreadId(notification);
        if (!threadId) return;
        if (this.relinquishedChildThreads.has(threadId)) return;
        let orphanPersisted = false;
        const task = async () => {
            const canonical = canonicalCodexNotificationForJournal(notification);
            if (this.provisionalRoutesByThread.has(threadId)) {
                if (!canonical) return;
                try {
                    await this.persistOrphan(threadId, canonical);
                    orphanPersisted = true;
                } catch (error) {
                    throw new CodexV4NotificationRoutingError(threadId, false, error);
                }
                if (!this.provisionalRoutesByThread.has(threadId)) {
                    await this.drainPendingNotificationsAwaitingRegistration(threadId);
                }
                return;
            }
            if (
                !this.bindingsByThread.has(threadId)
                || this.threadsWithPendingOrphans.has(threadId)
            ) {
                if (!canonical) return;
                try {
                    await this.persistOrphan(threadId, canonical);
                    orphanPersisted = true;
                } catch (error) {
                    throw new CodexV4NotificationRoutingError(threadId, false, error);
                }
                if (!this.orphanRetryTimers.has(threadId)) {
                    await this.drainPendingNotificationsAwaitingRegistration(threadId);
                }
                return;
            }
            try {
                await this.routeNotification(notification, false, null);
            } catch (error) {
                if (canonical) {
                    try {
                        await this.persistOrphan(threadId, canonical);
                        orphanPersisted = true;
                    } catch (persistError) {
                        throw new CodexV4NotificationRoutingError(
                            threadId,
                            false,
                            persistError,
                            error,
                        );
                    }
                }
                throw error;
            }
        };
        try {
            await this.enqueueThread(threadId, task);
        } catch (error) {
            const routingError = isCodexV4NotificationRoutingError(error)
                ? error
                : new CodexV4NotificationRoutingError(threadId, orphanPersisted, error);
            try {
                this.options.onError?.(routingError);
            } catch {
                // Diagnostics must never replace the durable-routing outcome.
            }
            if (routingError.durablyQueued) this.scheduleOrphanRetry(threadId);
            throw routingError;
        }
    }

    ownsThread(threadId: string): boolean {
        return this.routesByThread.has(threadId) || this.bindingsByThread.has(threadId);
    }

    hasActiveChildWork(): boolean {
        for (const route of this.routesByThread.values()) {
            if (route.kind !== 'providerChild' && route.kind !== 'detachedReview') continue;
            if (route.activeTurnId || (route.status && isRecoverableRelationStatus(route.status))) {
                return true;
            }
        }
        return false;
    }

    async handleRequest(request: CodexServerRequest): Promise<CodexManagedServerResponse> {
        if (this.closed) throw new Error('Codex v4 thread router is closed');
        const threadId = requestThreadId(request);
        if (this.relinquishedChildThreads.has(threadId)) {
            throw new Error('Codex child session binding is owned by another Gateway');
        }
        let binding: CodexV4SessionBinding;
        try {
            binding = await this.bindingForThread(threadId);
        } catch (error) {
            if (!(error instanceof CodexRouteAwaitingRegistrationError)) throw error;
            await this.waitForRouteRegistration(threadId);
            binding = await this.bindingForThread(threadId);
        }
        return await binding.requestBroker.handle(request);
    }

    async relinquishChildSession(sessionId: string, expectedThreadId?: string): Promise<void> {
        const bindings = await this.routeLock.inLock(() => {
            const affectedThreadIds = new Set<string>();
            if (expectedThreadId) affectedThreadIds.add(expectedThreadId);
            for (const [threadId, binding] of this.bindingsByThread) {
                if (binding !== this.options.rootBinding && binding.sessionId === sessionId) {
                    affectedThreadIds.add(threadId);
                }
            }

            const closing = new Set<CodexV4SessionBinding>();
            for (const threadId of affectedThreadIds) {
                this.relinquishedChildThreads.add(threadId);
                const binding = this.bindingsByThread.get(threadId);
                if (binding && binding !== this.options.rootBinding) {
                    this.bindingsByThread.delete(threadId);
                    closing.add(binding);
                }
                this.hydratedThreads.delete(threadId);
                this.activeTurnByThread.delete(threadId);
                this.threadsWithPendingOrphans.delete(threadId);
                this.orphanRetryAttempts.delete(threadId);
                const retryTimer = this.orphanRetryTimers.get(threadId);
                if (retryTimer) clearTimeout(retryTimer);
                this.orphanRetryTimers.delete(threadId);
                const route = this.routesByThread.get(threadId);
                if (route && (route.kind === 'providerChild' || route.kind === 'detachedReview')) {
                    this.restoreRoute({
                        ...route,
                        status: 'completed',
                        activeTurnId: null,
                    });
                }
            }
            return closing;
        });
        const results = await Promise.allSettled([...bindings].map((binding) => binding.close()));
        const failed = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failed) throw failed.reason;
    }

    setConnection(event: CodexConnectionEvent): void {
        for (const binding of this.allBindings()) {
            void binding.mapper.setConnection(event.connection, {
                statusUnknown: event.statusUnknown,
                error: event.error,
            }).catch((error) => this.options.onError?.(error));
            if (event.connection === 'disconnected' || event.connection === 'error') {
                void binding.requestBroker.failPending('transportDisconnected')
                    .catch((error) => this.options.onError?.(error));
            }
        }
    }

    migrationSinkForRoot(): CodexV4MigrationSink {
        return migrationSink(this.options.rootBinding);
    }

    async migrationSinkForChild(route: CodexV4ChildThreadRoute): Promise<CodexV4MigrationSink> {
        const binding = await this.ensureChildBinding(route.thread, {
            kind: 'providerChild',
            parentThreadId: route.parentThreadId,
            parentTurnId: route.parentTurnId,
            delegationItemId: route.delegationItemId,
            depth: route.depth,
        }, false);
        return migrationSink(binding);
    }

    async flush(): Promise<void> {
        await Promise.all([...this.pipelinesByThread.values()]);
        for (const binding of this.allBindings()) {
            await binding.mapper.flush();
        }
    }

    close(): Promise<void> {
        if (!this.closePromise) {
            this.closePromise = this.closeOnce();
        }
        return this.closePromise;
    }

    private async closeOnce(): Promise<void> {
        this.closed = true;
        for (const timer of this.orphanRetryTimers.values()) clearTimeout(timer);
        this.orphanRetryTimers.clear();
        this.rejectRouteRegistrationWaiters(
            new Error('Codex v4 thread router closed while waiting for route registration'),
        );
        let firstError: unknown = null;
        try {
            await this.flush();
        } catch (error) {
            firstError = error;
        }

        await Promise.allSettled(this.bindingPromisesByThread.values());
        const bindingsByIdentity = new Map<CodexV4SessionBinding, string>();
        for (const [threadId, binding] of this.bindingsByThread) {
            if (binding !== this.options.rootBinding && !bindingsByIdentity.has(binding)) {
                bindingsByIdentity.set(binding, threadId);
            }
        }
        const bindings = [...bindingsByIdentity].map(([binding, threadId]) => ({
            binding,
            threadId,
        }));
        const closeResults = await Promise.allSettled(
            bindings.map(({ binding }) => binding.close()),
        );
        for (let index = 0; index < closeResults.length; index += 1) {
            const result = closeResults[index];
            if (result.status === 'fulfilled') continue;
            if (firstError === null) firstError = result.reason;
            this.recordDiagnostic({
                level: 'warn',
                event: 'relation',
                phase: 'failed',
                state: 'degraded',
                childThreadHash: diagnosticThreadHash(bindings[index].threadId),
                errorKind: classifySyncV4DiagnosticError(result.reason),
                count: bindings.length,
            });
            try {
                this.options.onError?.(result.reason);
            } catch {
                // Error reporting must not prevent the remaining shutdown cleanup.
            }
        }
        this.bindingsByThread.clear();
        this.activeTurnByThread.clear();
        this.provisionalRoutesByThread.clear();
        if (firstError !== null) throw firstError;
    }

    private async routeNotification(
        notification: ServerNotification,
        durableOrphan: boolean,
        deliveryId: string | null,
    ): Promise<void> {
        const threadId = notificationThreadId(notification);
        if (!threadId) return;

        let binding = this.bindingsByThread.get(threadId);
        const snapshot = notification.method === 'thread/started' ? notification.params.thread : null;
        if (!binding) {
            logger.debug('[Codex v4] Orphan notification recovery', {
                thread: createHash('sha256').update(threadId).digest('hex').slice(0, 16),
                method: redactCodexProtocolMethod(notification.method),
                recovery: snapshot ? 'notificationSnapshot' : 'threadRead',
            });
        }
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

        let hydratedRoot = false;
        if (
            durableOrphan
            && binding === this.options.rootBinding
            && !snapshot
            && !this.hydratedThreads.has(threadId)
        ) {
            const hydrated = await this.options.readThread(threadId);
            binding.mapper.importThread(hydrated);
            binding.mapper.importGoal(
                threadId,
                this.options.readGoal ? await this.options.readGoal(threadId) : null,
            );
            hydratedRoot = true;
        }
        if (durableOrphan && binding.mapper.isMigrationBarrierActive(threadId)) {
            throw new Error('Codex orphan is waiting for the migration barrier');
        }
        await binding.mapper.handleNotification(notification, deliveryId);
        if (notification.method === 'serverRequest/resolved') {
            await binding.requestBroker.markProviderResolved(
                notification.params.threadId,
                String(notification.params.requestId),
            );
        }
        if (snapshot) await this.discoverChildren(snapshot);
        await this.discoverChildrenFromNotification(notification);
        await this.updateChildRelation(threadId, notification);
        if (durableOrphan) await binding.mapper.flush();
        if (snapshot || hydratedRoot || binding !== this.options.rootBinding) {
            this.hydratedThreads.add(threadId);
        }
    }

    private async bindingForSnapshot(thread: Thread): Promise<CodexV4SessionBinding> {
        const existing = this.bindingsByThread.get(thread.id);
        if (existing) return existing;

        const registered = this.routesByThread.get(thread.id);
        if (registered?.kind === 'root' || registered?.kind === 'userFork') {
            this.bindingsByThread.set(thread.id, this.options.rootBinding);
            return this.options.rootBinding;
        }

        let lineage = this.lineagesByChild.get(thread.id);
        if (lineage) assertSnapshotMatchesLineage(thread, lineage);
        if (!lineage) {
            const spawn = providerSpawnLineage(thread);
            if (!spawn) {
                if (thread.forkedFromId) {
                    throw new Error('Codex user fork is awaiting explicit Happy session ownership');
                }
                if (isDetachedReviewSource(thread)) {
                    throw new CodexRouteAwaitingRegistrationError(thread.id);
                }
                throw new CodexRouteAwaitingRegistrationError(thread.id);
            }
            lineage = {
                kind: 'providerChild',
                parentThreadId: spawn.parentThreadId,
                parentTurnId: null,
                delegationItemId: null,
                depth: Math.max(
                    spawn.depth,
                    await this.depthForParent(spawn.parentThreadId) + 1,
                ),
            };
            await this.recordLineage(thread.id, lineage);
        }
        return await this.ensureChildBinding(thread, lineage);
    }

    private async ensureChildBinding(
        thread: Thread,
        lineage: RelationLineage,
        activate = true,
    ): Promise<CodexV4SessionBinding> {
        if (this.relinquishedChildThreads.has(thread.id)) {
            throw new Error('Codex child session binding is owned by another Gateway');
        }
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
        try {
            if (this.relinquishedChildThreads.has(thread.id)) {
                throw new Error('Codex child session binding is owned by another Gateway');
            }
            if (!activate) await binding.mapper.prepareMigration(thread.id);
            const finalLineage = this.lineagesByChild.get(thread.id) ?? resolvedLineage;
            await this.publishRelation(thread, binding, finalLineage);
            if (activate) {
                const goal = this.options.readGoal ? await this.options.readGoal(thread.id) : null;
                await activateChildBinding(binding, thread, goal);
            }
            this.bindingsByThread.set(thread.id, binding);
            await binding.recover();
            return binding;
        } catch (error) {
            if (this.bindingsByThread.get(thread.id) === binding) {
                this.bindingsByThread.delete(thread.id);
            }
            await binding.close().catch(() => undefined);
            throw error;
        }
    }

    private async bindingForThread(threadId: string): Promise<CodexV4SessionBinding> {
        if (this.provisionalRoutesByThread.has(threadId)) {
            throw new CodexRouteAwaitingRegistrationError(threadId);
        }
        const existing = this.bindingsByThread.get(threadId);
        if (existing) return existing;
        const snapshot = await this.options.readThread(threadId);
        const binding = await this.bindingForSnapshot(snapshot);
        if (binding === this.options.rootBinding) binding.mapper.importThread(snapshot);
        await binding.mapper.flush();
        this.hydratedThreads.add(threadId);
        return binding;
    }

    private async discoverChildren(thread: Thread): Promise<void> {
        const parentDepth = this.bindingsByThread.get(thread.id) === this.options.rootBinding
            ? 0
            : this.lineagesByChild.get(thread.id)?.depth ?? 0;
        for (const child of childThreadReferences(thread)) {
            await this.recordLineage(child.childThreadId, {
                kind: 'providerChild',
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
        const childThreadIds = item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent'
            ? item.receiverThreadIds
            : [];
        const parentDepth = this.bindingsByThread.get(notification.params.threadId) === this.options.rootBinding
            ? 0
            : this.lineagesByChild.get(notification.params.threadId)?.depth ?? 0;
        for (const childThreadId of childThreadIds) {
            if (!childThreadId || childThreadId === notification.params.threadId) continue;
            await this.recordLineage(childThreadId, {
                kind: 'providerChild',
                parentThreadId: notification.params.threadId,
                parentTurnId: notification.params.turnId,
                delegationItemId: item.id,
                depth: parentDepth + 1,
            });
        }
    }

    private async recordLineage(
        childThreadId: string,
        incoming: RelationLineage,
        coordinatedCommandId?: string,
    ): Promise<void> {
        await this.routeLock.inLock(async () => {
            const current = this.lineagesByChild.get(childThreadId);
            if (
                current
                && (
                    current.parentThreadId !== incoming.parentThreadId
                    || current.kind !== incoming.kind
                )
            ) {
                throw new Error('Codex child thread reported conflicting parents');
            }
            const candidate: RelationLineage = current ? {
                kind: current.kind,
                parentThreadId: current.parentThreadId,
                parentTurnId: current.parentTurnId ?? incoming.parentTurnId,
                delegationItemId: current.delegationItemId ?? incoming.delegationItemId,
                depth: Math.min(current.depth, incoming.depth),
            } : incoming;
            const currentRoute = this.routesByThread.get(childThreadId);
            const persisted = await this.persistRouteLocked({
                threadId: childThreadId,
                kind: candidate.kind,
                parentThreadId: candidate.parentThreadId,
                parentTurnId: candidate.parentTurnId,
                delegationItemId: candidate.delegationItemId,
                depth: candidate.depth,
                status: currentRoute?.status ?? 'starting',
                activeTurnId: currentRoute?.activeTurnId ?? null,
                ...(coordinatedCommandId ? { coordinatedCommandId } : {}),
            });
            const next = this.lineagesByChild.get(persisted.threadId);
            if (!next) throw new Error('Codex child route did not restore its lineage');

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
            const parentBinding = this.bindingsByThread.get(updated.parentThreadId);
            if (!parentBinding) return;
            await parentBinding.mapper.upsertRelation(updated);
            this.relationsByChild.set(childThreadId, updated);
        });
    }

    private async publishRelation(
        thread: Thread,
        childBinding: CodexV4SessionBinding,
        lineage: RelationLineage,
    ): Promise<void> {
        await this.routeLock.inLock(async () => {
            const resolvedLineage = this.lineagesByChild.get(thread.id) ?? lineage;
            const parentBinding = this.bindingsByThread.get(resolvedLineage.parentThreadId);
            if (!parentBinding) throw new Error('Codex child relation has no parent session binding');
            const now = this.now();
            const activeTurnId = activeTurnIdFromSnapshot(thread);
            if (activeTurnId) this.activeTurnByThread.set(thread.id, activeTurnId);
            const status = activeTurnId ? 'active' : relationStatus(thread.status);
            const route: SyncV4CodexThreadRoute = {
                threadId: thread.id,
                kind: resolvedLineage.kind,
                parentThreadId: resolvedLineage.parentThreadId,
                parentTurnId: resolvedLineage.parentTurnId,
                delegationItemId: resolvedLineage.delegationItemId,
                depth: resolvedLineage.depth,
                status,
                activeTurnId,
            };
            const relation: CodexRelationEntityV4 = {
                schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
                entityType: 'codex.relation',
                providerId: `${resolvedLineage.parentThreadId}\0relation\0${thread.id}`,
                createdAt: toEpochMs(thread.createdAt, now),
                updatedAt: now,
                parentThreadId: resolvedLineage.parentThreadId,
                childThreadId: thread.id,
                parentTurnId: resolvedLineage.parentTurnId,
                delegationItemId: resolvedLineage.delegationItemId,
                parentSessionId: parentBinding.sessionId,
                childSessionId: childBinding.sessionId,
                depth: resolvedLineage.depth,
                status,
            };
            if (isRecoverableRelationStatus(status)) {
                await this.persistRouteLocked(route);
                await parentBinding.mapper.upsertRelation(relation);
            } else {
                await parentBinding.mapper.upsertRelation(relation);
                await this.persistRouteLocked(route);
            }
            this.relationsByChild.set(thread.id, relation);
        });
    }

    private async updateChildRelation(threadId: string, notification: ServerNotification): Promise<void> {
        await this.routeLock.inLock(async () => {
            const relation = this.relationsByChild.get(threadId);
            if (!relation) return;
            let status = relation.status;
            if (notification.method === 'turn/started') {
                this.activeTurnByThread.set(threadId, notification.params.turn.id);
                status = 'active';
            } else if (notification.method === 'turn/completed') {
                const activeTurnId = this.activeTurnByThread.get(threadId);
                if (activeTurnId && activeTurnId !== notification.params.turn.id) return;
                if (activeTurnId === notification.params.turn.id) {
                    this.activeTurnByThread.delete(threadId);
                }
                status = turnRelationStatus(notification.params.turn.status);
            } else if (notification.method === 'thread/status/changed') {
                if (notification.params.status.type !== 'active') {
                    this.activeTurnByThread.delete(threadId);
                }
                status = relationStatus(notification.params.status);
            } else if (
                notification.method === 'thread/archived'
                || notification.method === 'thread/closed'
                || notification.method === 'thread/deleted'
            ) {
                this.activeTurnByThread.delete(threadId);
                status = 'completed';
            }
            const activeTurnId = this.activeTurnByThread.get(threadId) ?? null;
            const route = this.routesByThread.get(threadId);
            const nextRoute = route && (
                route.kind === 'providerChild' || route.kind === 'detachedReview'
            )
                ? {
                    ...route,
                    status,
                    activeTurnId,
                }
                : null;
            if (status === relation.status) {
                if (nextRoute) await this.persistRouteLocked(nextRoute);
                return;
            }
            const next = { ...relation, status, updatedAt: this.now() };
            const parentBinding = this.bindingsByThread.get(next.parentThreadId);
            if (!parentBinding) return;
            if (isRecoverableRelationStatus(status)) {
                if (nextRoute) await this.persistRouteLocked(nextRoute);
                await parentBinding.mapper.upsertRelation(next);
            } else {
                await parentBinding.mapper.upsertRelation(next);
                if (nextRoute) await this.persistRouteLocked(nextRoute);
            }
            this.relationsByChild.set(threadId, next);
        });
        await this.releaseTerminalBindings(threadId);
    }

    private async releaseTerminalBindings(threadId: string): Promise<void> {
        const bindings = await this.routeLock.inLock(() => {
            const releasable: Array<{
                threadId: string;
                binding: CodexV4SessionBinding;
            }> = [];
            let candidateId: string | null = threadId;
            while (candidateId) {
                const route = this.routesByThread.get(candidateId);
                if (
                    !route
                    || route.kind === 'root'
                    || route.kind === 'userFork'
                    || !route.status
                    || isRecoverableRelationStatus(route.status)
                    || this.threadsWithPendingOrphans.has(candidateId)
                    || (this.recoverableChildrenByParent.get(candidateId)?.size ?? 0) > 0
                ) {
                    break;
                }
                const binding = this.bindingsByThread.get(candidateId);
                if (binding && binding !== this.options.rootBinding) {
                    this.bindingsByThread.delete(candidateId);
                    this.hydratedThreads.delete(candidateId);
                    releasable.push({ threadId: candidateId, binding });
                }
                candidateId = requiredRouteParentThreadId(route);
            }
            return releasable;
        });
        if (bindings.length === 0) return;

        for (const entry of bindings) {
            this.recordDiagnostic({
                level: 'info',
                event: 'relation',
                phase: 'started',
                state: 'stopping',
                childThreadHash: diagnosticThreadHash(entry.threadId),
                count: this.bindingsByThread.size,
            });
        }
        const results = await Promise.allSettled(bindings.map(({ binding }) => binding.close()));
        for (let index = 0; index < results.length; index += 1) {
            const result = results[index];
            this.recordDiagnostic({
                level: result.status === 'fulfilled' ? 'info' : 'warn',
                event: 'relation',
                phase: result.status === 'fulfilled' ? 'completed' : 'failed',
                state: result.status === 'fulfilled' ? 'stopped' : 'degraded',
                childThreadHash: diagnosticThreadHash(bindings[index].threadId),
                count: this.bindingsByThread.size,
                ...(result.status === 'rejected'
                    ? { errorKind: classifySyncV4DiagnosticError(result.reason) }
                    : {}),
            });
        }
        const failed = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failed) throw failed.reason;
    }

    private recordDiagnostic(
        input: Omit<SyncV4DiagnosticInput, 'component' | 'sessionHash'>,
    ): void {
        recordSyncV4DiagnosticSafely(this.options.diagnostics, {
            component: 'cli.gateway',
            sessionHash: this.options.diagnosticSessionHash,
            softwareVersion: this.options.softwareVersion,
            codexVersion: this.options.codexVersion,
            protocolVersion: 4,
            featureEnabled: true,
            transportSecurity: this.options.transportSecurity,
            ...input,
        });
    }

    private async depthForParent(parentThreadId: string): Promise<number> {
        if (this.bindingsByThread.get(parentThreadId) === this.options.rootBinding) return 0;
        const known = this.lineagesByChild.get(parentThreadId);
        if (known) return known.depth;
        const parent = await this.options.readThread(parentThreadId);
        await this.bindingForSnapshot(parent);
        return this.lineagesByChild.get(parentThreadId)?.depth ?? 0;
    }

    private enqueueThread(threadId: string, task: () => Promise<void>): Promise<void> {
        const previous = this.pipelinesByThread.get(threadId) ?? Promise.resolve();
        const run = previous.then(task);
        let tracked!: Promise<void>;
        tracked = run
            .catch(() => undefined)
            .finally(() => {
                if (this.pipelinesByThread.get(threadId) === tracked) {
                    this.pipelinesByThread.delete(threadId);
                }
            });
        this.pipelinesByThread.set(threadId, tracked);
        return run;
    }

    private async drainPendingNotifications(threadId: string): Promise<void> {
        const pending = this.options.rootBinding.syncClient.getPendingCodexNotifications()
            .filter((entry) => entry.threadId === threadId);
        for (const entry of pending) {
            if (this.closed) return;
            await this.routeNotification(
                entry.notification as unknown as ServerNotification,
                true,
                entry.notificationId,
            );
            await this.options.rootBinding.syncClient.completeCodexOrphan(entry.notificationId);
        }
        if (
            !this.options.rootBinding.syncClient.getPendingCodexNotifications()
                .some((entry) => entry.threadId === threadId)
        ) {
            this.threadsWithPendingOrphans.delete(threadId);
            this.clearOrphanRetry(threadId);
            await this.releaseTerminalBindings(threadId);
        }
    }

    private async drainPendingNotificationsAwaitingRegistration(threadId: string): Promise<void> {
        try {
            await this.drainPendingNotifications(threadId);
        } catch (error) {
            if (error instanceof CodexRouteAwaitingRegistrationError) return;
            throw error;
        }
    }

    private async persistOrphan(
        threadId: string,
        notification: ServerNotification,
    ): Promise<void> {
        await this.options.rootBinding.syncClient.persistCodexOrphan(
            threadId,
            notification as unknown as SyncV4CodexNotification,
        );
        this.threadsWithPendingOrphans.add(threadId);
    }

    private async retryPendingForThread(threadId: string): Promise<void> {
        if (
            this.closed
            || !this.threadsWithPendingOrphans.has(threadId)
        ) {
            return;
        }
        try {
            await this.enqueueThread(threadId, () => this.drainPendingNotifications(threadId));
        } catch (error) {
            this.options.onError?.(error);
            this.scheduleOrphanRetry(threadId);
        }
    }

    private scheduleOrphanRetry(threadId: string): void {
        if (this.closed || this.orphanRetryTimers.has(threadId)) return;
        if (!this.threadsWithPendingOrphans.has(threadId)) return;
        const attempt = (this.orphanRetryAttempts.get(threadId) ?? 0) + 1;
        this.orphanRetryAttempts.set(threadId, attempt);
        const delay = Math.min(
            ORPHAN_RETRY_MAX_MS,
            ORPHAN_RETRY_BASE_MS * (2 ** Math.min(attempt - 1, 16)),
        );
        const timer = setTimeout(() => {
            this.orphanRetryTimers.delete(threadId);
            void this.retryPendingForThread(threadId);
        }, delay);
        timer.unref();
        this.orphanRetryTimers.set(threadId, timer);
    }

    private clearOrphanRetry(threadId: string): void {
        const timer = this.orphanRetryTimers.get(threadId);
        if (timer) clearTimeout(timer);
        this.orphanRetryTimers.delete(threadId);
        this.orphanRetryAttempts.delete(threadId);
    }

    private async persistRoute(route: SyncV4CodexThreadRoute): Promise<SyncV4CodexThreadRoute> {
        return await this.routeLock.inLock(() => this.persistRouteLocked(route));
    }

    private async persistRouteLocked(
        route: SyncV4CodexThreadRoute,
    ): Promise<SyncV4CodexThreadRoute> {
        const current = this.routesByThread.get(route.threadId);
        let resolved = route;
        if (current) {
            const bothRootOwned = isRootOwnedRoute(current) && isRootOwnedRoute(route);
            if (!bothRootOwned && (
                current.kind !== route.kind
                || current.parentThreadId !== route.parentThreadId
            )) {
                throw new Error('Codex thread reported conflicting route classifications');
            }
            resolved = bothRootOwned
                ? {
                    ...current,
                    ...(route.coordinatedCommandId
                        ? { coordinatedCommandId: route.coordinatedCommandId }
                        : {}),
                }
                : {
                    ...route,
                    parentTurnId: current.parentTurnId ?? route.parentTurnId,
                    delegationItemId: current.delegationItemId ?? route.delegationItemId,
                    depth: Math.min(current.depth, route.depth),
                    ...(route.status === undefined && current.status !== undefined
                        ? { status: current.status }
                        : {}),
                    ...(route.activeTurnId === undefined && current.activeTurnId !== undefined
                        ? { activeTurnId: current.activeTurnId }
                        : {}),
                    ...(route.coordinatedCommandId === undefined
                        && current.coordinatedCommandId !== undefined
                        ? { coordinatedCommandId: current.coordinatedCommandId }
                        : {}),
                };
            if (sameRoute(current, resolved)) return current;
        }
        this.restoreRoute(resolved);
        this.provisionalRoutesByThread.add(resolved.threadId);
        try {
            await this.options.rootBinding.syncClient.persistCodexThreadRoute(resolved);
        } catch (error) {
            this.removeRouteFromMemory(resolved);
            if (current) this.restoreRoute(current);
            throw error;
        } finally {
            this.provisionalRoutesByThread.delete(resolved.threadId);
        }
        this.resolveRouteRegistrationWaiters(resolved.threadId);
        try {
            this.options.onRouteRegistered?.(resolved.threadId);
        } catch (error) {
            this.options.onError?.(error);
        }
        return resolved;
    }

    private restoreRoute(route: SyncV4CodexThreadRoute): void {
        const previous = this.routesByThread.get(route.threadId);
        if (
            previous
            && previous.kind !== 'root'
            && previous.kind !== 'userFork'
            && previous.parentThreadId
        ) {
            this.removeRecoverableChild(previous.parentThreadId, previous.threadId);
        }
        this.routesByThread.set(route.threadId, route);
        if (route.activeTurnId) {
            this.activeTurnByThread.set(route.threadId, route.activeTurnId);
        } else {
            this.activeTurnByThread.delete(route.threadId);
        }
        if (isRootOwnedRoute(route)) {
            this.bindingsByThread.set(route.threadId, this.options.rootBinding);
            this.lineagesByChild.delete(route.threadId);
            return;
        }
        if (route.kind !== 'providerChild' && route.kind !== 'detachedReview') {
            throw new Error('Codex thread route has an unsupported classification');
        }
        this.lineagesByChild.set(route.threadId, {
            kind: route.kind,
            parentThreadId: requiredRouteParentThreadId(route),
            parentTurnId: route.parentTurnId,
            delegationItemId: route.delegationItemId,
            depth: route.depth,
        });
        if (!route.status || isRecoverableRelationStatus(route.status)) {
            const parentThreadId = requiredRouteParentThreadId(route);
            const children = this.recoverableChildrenByParent.get(parentThreadId) ?? new Set();
            children.add(route.threadId);
            this.recoverableChildrenByParent.set(parentThreadId, children);
        }
    }

    private removeRecoverableChild(parentThreadId: string, childThreadId: string): void {
        const children = this.recoverableChildrenByParent.get(parentThreadId);
        if (!children) return;
        children.delete(childThreadId);
        if (children.size === 0) this.recoverableChildrenByParent.delete(parentThreadId);
    }

    private removeRouteFromMemory(route: SyncV4CodexThreadRoute): void {
        if (!isRootOwnedRoute(route) && route.parentThreadId) {
            this.removeRecoverableChild(route.parentThreadId, route.threadId);
        }
        this.routesByThread.delete(route.threadId);
        this.lineagesByChild.delete(route.threadId);
        this.activeTurnByThread.delete(route.threadId);
        if (
            isRootOwnedRoute(route)
            && this.bindingsByThread.get(route.threadId) === this.options.rootBinding
        ) {
            this.bindingsByThread.delete(route.threadId);
        }
    }

    private now(): number {
        return Math.max(0, Math.trunc(this.options.now?.() ?? Date.now()));
    }

    private allBindings(): Set<CodexV4SessionBinding> {
        return new Set([
            this.options.rootBinding,
            ...this.bindingsByThread.values(),
        ]);
    }

    private async waitForRouteRegistration(threadId: string): Promise<void> {
        if (this.closed) throw new Error('Codex v4 thread router is closed');
        if (
            this.routesByThread.has(threadId)
            && !this.provisionalRoutesByThread.has(threadId)
        ) return;
        const waitMs = Math.max(
            0,
            Math.trunc(
                this.options.routeRegistrationWaitMs
                ?? DEFAULT_ROUTE_REGISTRATION_WAIT_MS,
            ),
        );
        await new Promise<void>((resolve, reject) => {
            let waiter!: RouteRegistrationWaiter;
            const timer = setTimeout(() => {
                this.removeRouteRegistrationWaiter(threadId, waiter);
                reject(new Error(
                    'Codex provider request arrived before authoritative route registration',
                ));
            }, waitMs);
            timer.unref();
            waiter = { resolve, reject, timer };
            const waiters = this.routeRegistrationWaiters.get(threadId) ?? new Set();
            waiters.add(waiter);
            this.routeRegistrationWaiters.set(threadId, waiters);
            if (
                this.routesByThread.has(threadId)
                && !this.provisionalRoutesByThread.has(threadId)
            ) {
                this.resolveRouteRegistrationWaiters(threadId);
            }
        });
    }

    private resolveRouteRegistrationWaiters(threadId: string): void {
        const waiters = this.routeRegistrationWaiters.get(threadId);
        if (!waiters) return;
        this.routeRegistrationWaiters.delete(threadId);
        for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve();
        }
    }

    private rejectRouteRegistrationWaiters(error: Error): void {
        for (const waiters of this.routeRegistrationWaiters.values()) {
            for (const waiter of waiters) {
                clearTimeout(waiter.timer);
                waiter.reject(error);
            }
        }
        this.routeRegistrationWaiters.clear();
    }

    private removeRouteRegistrationWaiter(
        threadId: string,
        waiter: RouteRegistrationWaiter,
    ): void {
        const waiters = this.routeRegistrationWaiters.get(threadId);
        if (!waiters) return;
        waiters.delete(waiter);
        if (waiters.size === 0) this.routeRegistrationWaiters.delete(threadId);
    }
}

function migrationSink(binding: CodexV4SessionBinding): CodexV4MigrationSink {
    return {
        prepareMigration: (threadId) => binding.mapper.prepareMigration(threadId),
        releaseMigrationBarrier: (threadId) => binding.mapper.releaseMigrationBarrier(threadId),
        importThread: (thread) => binding.mapper.importThread(thread),
        importGoal: (threadId, goal) => binding.mapper.importGoal(threadId, goal),
        setSyncState: (state) => binding.mapper.setSyncState(state),
        flush: () => binding.mapper.flush(),
        flushOutboundOnce: () => binding.syncClient.flushOutboundOnce(),
        getMigrationState: (threadId) => binding.syncClient.getMigrationState(threadId),
        setMigrationState: (threadId, state) => binding.syncClient.setMigrationState(threadId, state),
    };
}

async function activateChildBinding(
    binding: CodexV4SessionBinding,
    thread: Thread,
    goal: ThreadGoal | null,
): Promise<void> {
    const sink = migrationSink(binding);
    if (sink.getMigrationState(thread.id) === 'ready') {
        await sink.setSyncState('ready');
        binding.mapper.importThreadState(thread);
        sink.importGoal(thread.id, goal);
        await sink.flush();
        await sink.flushOutboundOnce();
        return;
    }
    if (sink.getMigrationState(thread.id) === 'activating') {
        await finalizeCodexV4Activation(sink, thread.id);
        binding.mapper.importThreadState(thread);
        sink.importGoal(thread.id, goal);
        await sink.flush();
        await sink.flushOutboundOnce();
        return;
    }

    try {
        await sink.prepareMigration(thread.id);
        await sink.setMigrationState(thread.id, 'pending');
        await sink.flush();
        await sink.flushOutboundOnce();
        await sink.setSyncState('importing');
        await sink.flush();
        await sink.flushOutboundOnce();
        await sink.setMigrationState(thread.id, 'importing');
        sink.importThread(thread);
        sink.importGoal(thread.id, goal);
        await sink.releaseMigrationBarrier(thread.id);
        await sink.flush();
        await sink.flushOutboundOnce();
        await finalizeCodexV4Activation(sink, thread.id);
    } catch (error) {
        await sink.releaseMigrationBarrier(thread.id).catch(() => undefined);
        await Promise.allSettled([
            sink.setSyncState('error')
                .then(() => sink.flush())
                .then(() => sink.flushOutboundOnce()),
            sink.setMigrationState(thread.id, 'error'),
        ]);
        throw error;
    }
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

function providerSpawnLineage(thread: Thread): { parentThreadId: string; depth: number } | null {
    if (
        !thread.parentThreadId
        || !thread.source
        || typeof thread.source !== 'object'
        || !('subAgent' in thread.source)
    ) {
        return null;
    }
    const subAgent = thread.source.subAgent;
    if (
        !subAgent
        || typeof subAgent !== 'object'
        || !('thread_spawn' in subAgent)
        || !subAgent.thread_spawn
        || typeof subAgent.thread_spawn !== 'object'
    ) {
        return null;
    }
    const spawn = subAgent.thread_spawn;
    if (spawn.parent_thread_id !== thread.parentThreadId) {
        throw new Error('Codex provider child source conflicts with parentThreadId');
    }
    return {
        parentThreadId: thread.parentThreadId,
        depth: Math.max(1, Math.trunc(spawn.depth)),
    };
}

function isDetachedReviewSource(thread: Thread): boolean {
    return Boolean(
        thread.source
        && typeof thread.source === 'object'
        && 'subAgent' in thread.source
        && thread.source.subAgent === 'review',
    );
}

function assertSnapshotMatchesLineage(thread: Thread, lineage: RelationLineage): void {
    if (thread.parentThreadId && thread.parentThreadId !== lineage.parentThreadId) {
        throw new Error('Codex child snapshot conflicts with its persisted parent route');
    }
    const spawn = providerSpawnLineage(thread);
    if (spawn && (
        lineage.kind !== 'providerChild'
        || spawn.parentThreadId !== lineage.parentThreadId
    )) {
        throw new Error('Codex child snapshot conflicts with its persisted route classification');
    }
    if (isDetachedReviewSource(thread) && lineage.kind !== 'detachedReview') {
        throw new Error('Codex review snapshot conflicts with its persisted route classification');
    }
}

function isRootOwnedRoute(
    route: SyncV4CodexThreadRoute,
): route is SyncV4CodexThreadRoute & { kind: 'root' | 'userFork' } {
    return route.kind === 'root' || route.kind === 'userFork';
}

function requiredRouteParentThreadId(route: SyncV4CodexThreadRoute): string {
    if (!route.parentThreadId) throw new Error('Codex child route has no parent thread');
    return route.parentThreadId;
}

function sameRoute(left: SyncV4CodexThreadRoute, right: SyncV4CodexThreadRoute): boolean {
    return left.threadId === right.threadId
        && left.kind === right.kind
        && left.parentThreadId === right.parentThreadId
        && left.parentTurnId === right.parentTurnId
        && left.delegationItemId === right.delegationItemId
        && left.depth === right.depth
        && left.status === right.status
        && left.activeTurnId === right.activeTurnId
        && left.coordinatedCommandId === right.coordinatedCommandId;
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

function isRecoverableRelationStatus(status: CodexRelationEntityV4['status']): boolean {
    return status === 'starting' || status === 'active';
}

function activeTurnIdFromSnapshot(thread: Thread): string | null {
    for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
        if (thread.turns[index].status === 'inProgress') return thread.turns[index].id;
    }
    return null;
}

function toEpochMs(value: number, fallback: number): number {
    if (!Number.isFinite(value) || value < 0) return fallback;
    return Math.trunc(value < 10_000_000_000 ? value * 1_000 : value);
}

const CANONICAL_ORPHAN_METHODS = new Set([
    'thread/started',
    'thread/status/changed',
    'thread/name/updated',
    'thread/settings/updated',
    'thread/tokenUsage/updated',
    'thread/goal/updated',
    'thread/goal/cleared',
    'turn/started',
    'turn/completed',
    'turn/plan/updated',
    'turn/diff/updated',
    'item/started',
    'item/completed',
    'item/agentMessage/delta',
    'item/plan/delta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/summaryTextDelta',
    'item/commandExecution/outputDelta',
    'item/fileChange/outputDelta',
    'item/fileChange/patchUpdated',
    'item/mcpToolCall/progress',
    'warning',
    'guardianWarning',
    'error',
    'serverRequest/resolved',
    'model/rerouted',
    'mcpServer/startupStatus/updated',
    'thread/archived',
    'thread/closed',
    'thread/deleted',
]);

const KNOWN_THREAD_ITEM_TYPES = new Set([
    'userMessage',
    'hookPrompt',
    'agentMessage',
    'plan',
    'reasoning',
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'dynamicToolCall',
    'collabAgentToolCall',
    'subAgentActivity',
    'webSearch',
    'imageView',
    'sleep',
    'imageGeneration',
    'enteredReviewMode',
    'exitedReviewMode',
    'contextCompaction',
]);

export function canonicalCodexNotificationForJournal(
    notification: ServerNotification,
): ServerNotification | null {
    if (!CANONICAL_ORPHAN_METHODS.has(notification.method)) return null;
    switch (notification.method) {
        case 'thread/started':
            return {
                ...notification,
                params: {
                    ...notification.params,
                    thread: sanitizeThreadForJournal(notification.params.thread),
                },
            };
        case 'turn/started':
        case 'turn/completed':
            return {
                ...notification,
                params: {
                    ...notification.params,
                    turn: sanitizeTurnForJournal(notification.params.turn),
                },
            } as ServerNotification;
        case 'item/started':
        case 'item/completed':
            return {
                ...notification,
                params: {
                    ...notification.params,
                    item: sanitizeItemForJournal(notification.params.item),
                },
            } as ServerNotification;
        default:
            return notification;
    }
}

function sanitizeThreadForJournal(thread: Thread): Thread {
    return {
        ...thread,
        turns: thread.turns.map(sanitizeTurnForJournal),
    };
}

function sanitizeTurnForJournal(turn: Turn): Turn {
    return {
        ...turn,
        items: turn.items.map(sanitizeItemForJournal),
    };
}

function sanitizeItemForJournal(item: ThreadItem): ThreadItem {
    const raw = item as unknown as Record<string, unknown>;
    if (
        typeof raw.type !== 'string'
        || typeof raw.id !== 'string'
        || !KNOWN_THREAD_ITEM_TYPES.has(raw.type)
    ) {
        return {
            type: typeof raw.type === 'string' ? raw.type.slice(0, 128) : '<missing>',
            id: typeof raw.id === 'string' ? raw.id.slice(0, 512) : '__unknown_item__',
        } as unknown as ThreadItem;
    }
    if (raw.type === 'reasoning') {
        return {
            type: 'reasoning',
            id: raw.id,
            summary: Array.isArray(raw.summary)
                ? raw.summary.filter((part): part is string => typeof part === 'string')
                : [],
            content: [],
        };
    }
    return item;
}
