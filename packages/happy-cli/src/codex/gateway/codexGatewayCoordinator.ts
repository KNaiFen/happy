import { createHash } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import type {
    CodexAppServerClient,
    CodexConnectionEvent,
    CodexManagedServerResponse,
    CodexServerRequest,
} from '../codexAppServerClient';
import { CodexV4CommandCancelledError } from '../codexV4CommandProcessor';
import type { ServerNotification, Thread } from '../protocol';
import { CodexGatewayArchivedSessionError } from './codexGatewayPresence';

const MAX_PENDING_NOTIFICATIONS_PER_THREAD = 1_000;
const MAX_PENDING_NOTIFICATIONS_TOTAL = 10_000;
const OWNERSHIP_WAIT_MS = 5_000;
const CROSS_SOURCE_NOTIFICATION_DEDUP_TTL_MS = 15_000;
const MAX_RECENT_CROSS_SOURCE_NOTIFICATIONS = 4_096;

type CodexGatewayNotificationSource = 'bridge' | 'terminal';

interface PendingGatewayNotification {
    notification: ServerNotification;
    source: CodexGatewayNotificationSource;
}

interface RecentGatewayNotification {
    source: CodexGatewayNotificationSource;
    observedAt: number;
}

interface NotificationBarrierBatch {
    failure: { error: unknown } | null;
}

export type CodexGatewayBindingRole = 'current' | 'draining' | 'inactive' | 'recovering';

export type CodexGatewayRootBindingPhase =
    | 'lease'
    | 'runtime'
    | 'providerSnapshot'
    | 'runtimeProjection'
    | 'pendingNotifications'
    | 'sourceBinding'
    | 'targetBinding'
    | 'reservationRelease'
    | 'descriptor';

export class CodexGatewayRootBindingError extends Error {
    readonly name = 'CodexGatewayRootBindingError';

    constructor(
        readonly phase: CodexGatewayRootBindingPhase,
        readonly diagnosticCause: unknown,
        readonly recoveryRequired = diagnosticRecoveryRequired(diagnosticCause),
        readonly rollbackCause: unknown = null,
    ) {
        super(`Codex Gateway root binding failed during ${phase}`);
    }
}

export interface CodexGatewayRuntimeBinding {
    role: CodexGatewayBindingRole;
    generation: number;
    previousSessionId: string | null;
    nextSessionId: string | null;
    changedAt: number;
}

export interface CodexGatewayRuntimeBindingUpdateOptions {
    force?: boolean;
}

export interface CodexGatewayRootActivationOptions {
    deferCommandRecovery?: boolean;
}

export interface CodexGatewayRootRuntime {
    readonly sessionId: string | null;
    handleNotification(notification: ServerNotification): Promise<void>;
    handleRequest(request: CodexServerRequest): Promise<CodexManagedServerResponse | null>;
    setConnection(event: CodexConnectionEvent): void;
    activate(snapshot: Thread, options?: CodexGatewayRootActivationOptions): Promise<void>;
    reconcile(snapshot: Thread): Promise<void>;
    resumeCommandRecovery(): Promise<void>;
    updateBinding(
        binding: CodexGatewayRuntimeBinding,
        options?: CodexGatewayRuntimeBindingUpdateOptions,
    ): Promise<void>;
    setGatewayLifecycle(state: 'starting' | 'running' | 'recovering' | 'stopping' | 'stopped'): Promise<void>;
    setTerminalState(
        state: 'attached' | 'pendingDetach' | 'detached' | 'headless',
        detachedAt: number | null,
    ): Promise<void>;
    ownsThread(threadId: string): boolean;
    isDrained(): Promise<boolean>;
    flush(): Promise<void>;
    close(): Promise<void>;
}

export interface CodexGatewayRootRuntimeFactoryOptions {
    threadId: string;
    generation: number;
    previousSessionId: string | null;
    registerThreadOwnership(threadId: string): void;
    assertCurrentGeneration(bindingGeneration: number | undefined): void;
}

interface CodexGatewayThreadLeaseRegistryContract {
    acquire(threadId: string, gatewayId: string): Promise<void>;
    release(threadId: string, gatewayId: string): Promise<boolean>;
}

interface ManagedRoot {
    threadId: string;
    generation: number;
    role: CodexGatewayBindingRole;
    subscriptionPending: boolean;
    previousSessionId: string | null;
    nextSessionId: string | null;
    title: string | null;
    rootActiveTurnId: string | null;
    lifecycleRecoveryRequired: boolean;
    runtime: CodexGatewayRootRuntime;
}

export interface CodexGatewayCoordinatorOptions {
    gatewayId: string;
    client: CodexAppServerClient;
    leases: CodexGatewayThreadLeaseRegistryContract;
    initialGeneration?: number;
    createRuntime(options: CodexGatewayRootRuntimeFactoryOptions): Promise<CodexGatewayRootRuntime>;
    now?: () => number;
    onError?: (error: unknown) => void;
    ownershipWaitMs?: number;
}

export interface CodexGatewayCoordinatorBindingSnapshot {
    threadId: string;
    sessionId: string | null;
    generation: number;
    role: CodexGatewayBindingRole;
    title: string | null;
}

export interface CodexGatewayRecoveredBinding {
    threadId: string;
    sessionId: string | null;
    generation: number;
    role: 'current' | 'draining';
}

export interface CodexGatewayBindRootOptions {
    subscription?: 'resume' | 'bridgeStartedNewThread' | 'deferredNewThread' | 'terminalRootResponse';
    providerSnapshot?: Thread;
}

export class CodexGatewayCoordinator {
    private readonly bindingLock = new AsyncLock();
    private readonly roots = new Map<string, ManagedRoot>();
    private readonly ownerByThread = new Map<string, ManagedRoot>();
    private readonly pendingNotifications = new Map<string, PendingGatewayNotification[]>();
    private readonly recentNotificationSources = new Map<string, RecentGatewayNotification>();
    private readonly ownershipWaiters = new Map<string, Set<() => void>>();
    private notificationBarrierBatch: NotificationBarrierBatch = { failure: null };
    private notificationPipeline: Promise<void> = Promise.resolve();
    private current: ManagedRoot | null = null;
    private generation: number;
    private handlersInstalled = false;
    private connected = false;
    private stopped = false;

    constructor(private readonly options: CodexGatewayCoordinatorOptions) {
        this.generation = Math.max(0, Math.trunc(options.initialGeneration ?? 0));
    }

    get currentThreadId(): string | null {
        return this.current?.threadId ?? null;
    }

    get currentGeneration(): number {
        return this.generation;
    }

    get currentSessionId(): string | null {
        return this.current?.runtime.sessionId ?? null;
    }

    bindingSnapshot(): CodexGatewayCoordinatorBindingSnapshot[] {
        return this.orderedRoots().map((root) => ({
            threadId: root.threadId,
            sessionId: root.runtime.sessionId,
            generation: root.generation,
            role: root.role,
            title: root.title,
        }));
    }

    pendingSubscriptionThreadIds(): string[] {
        return this.orderedRoots()
            .filter((root) => root.subscriptionPending)
            .map((root) => root.threadId);
    }

    // The terminal owns a separate official app-server connection. Its stable-v2
    // notifications may arrive before the bridge can resume a newly-live thread.
    // They are projection input only; bridge lifecycle remains the subscription proof.
    observeTerminalNotification(notification: ServerNotification): void {
        this.enqueueNotification(notification, 'terminal');
    }

    async awaitNotificationBarrier(): Promise<void> {
        const prefix = this.notificationPipeline;
        const batch = this.notificationBarrierBatch;
        this.notificationBarrierBatch = { failure: null };
        let pipelineFailure: { error: unknown } | null = null;
        try {
            await prefix;
        } catch (error) {
            pipelineFailure = { error };
        }
        if (batch.failure) throw batch.failure.error;
        if (pipelineFailure) throw pipelineFailure.error;
    }

    async connect(recovered = false): Promise<void> {
        if (this.stopped) throw new Error('Codex Gateway coordinator is stopped');
        this.installClientHandlers();
        if (recovered) await this.options.client.reconnectExternalTransportPreservingThreads();
        else if (!this.connected) await this.options.client.connect();
        this.connected = true;

        if (recovered) {
            await this.bindingLock.inLock(async () => {
                for (const root of this.orderedRoots()) {
                    const recoveredSnapshot = await rootBindingStep(
                        'providerSnapshot',
                        () => this.acquireRecoverableSnapshot(root.threadId),
                    );
                    root.subscriptionPending = recoveredSnapshot.subscriptionPending;
                    root.title = safeThreadTitle(recoveredSnapshot.thread);
                    root.rootActiveTurnId = activeTurnIdFromSnapshot(recoveredSnapshot.thread);
                    await rootBindingStep(
                        'runtimeProjection',
                        () => root.runtime.reconcile(recoveredSnapshot.thread),
                    );
                    await rootBindingStep(
                        'pendingNotifications',
                        () => this.drainPending(root.threadId, root),
                    );
                }
            });
            await this.notificationPipeline;
            await this.retireEligibleDrainingRoots();
        }
    }

    async bindRoot(
        threadId: string,
        options: CodexGatewayBindRootOptions = {},
    ): Promise<{
        sessionId: string | null;
        generation: number;
        changed: boolean;
    }> {
        return await this.bindRootAttempt(threadId, options, null);
    }

    private async bindRootAttempt(
        threadId: string,
        options: CodexGatewayBindRootOptions,
        expectedRecoveryRuntime: CodexGatewayRootRuntime | null,
    ): Promise<{
        sessionId: string | null;
        generation: number;
        changed: boolean;
    }> {
        validateThreadId(threadId);
        if (this.stopped) throw new Error('Codex Gateway coordinator is stopped');
        const subscription = options.subscription ?? 'resume';
        if (options.providerSnapshot && options.providerSnapshot.id !== threadId) {
            throw new CodexGatewayRootBindingError(
                'providerSnapshot',
                new Error('Codex Gateway root response thread ID does not match its binding'),
            );
        }
        return await this.bindingLock.inLock(async () => {
            if (this.stopped) throw new Error('Codex Gateway coordinator is stopped');
            if (expectedRecoveryRuntime) {
                const expectedTarget = this.roots.get(threadId);
                if (
                    !expectedTarget
                    || expectedTarget === this.current
                    || expectedTarget.role !== 'recovering'
                    || expectedTarget.runtime !== expectedRecoveryRuntime
                    || expectedTarget.generation !== this.generation + 1
                    || expectedTarget.previousSessionId !== (this.current?.runtime.sessionId ?? null)
                ) {
                    return {
                        sessionId: null,
                        generation: this.generation,
                        changed: false,
                    };
                }
            } else {
                const pendingRecovery = this.orderedRoots().find((root) => (
                    root !== this.current && root.role === 'recovering'
                ));
                if (
                    pendingRecovery
                    && threadId !== pendingRecovery.threadId
                    && threadId !== this.current?.threadId
                ) {
                    throw new CodexGatewayRootBindingError(
                        'targetBinding',
                        new Error('A prior Codex Gateway root binding still requires recovery'),
                        true,
                    );
                }
            }
            if (this.current?.threadId === threadId) {
                if (subscription === 'terminalRootResponse' && options.providerSnapshot) {
                    this.current.title = safeThreadTitle(options.providerSnapshot);
                    this.current.rootActiveTurnId = activeTurnIdFromSnapshot(options.providerSnapshot);
                    await rootBindingStep(
                        'runtimeProjection',
                        () => this.current!.runtime.reconcile(options.providerSnapshot!),
                    );
                    this.options.client.adoptThreadSnapshot(options.providerSnapshot);
                }
                if (subscription === 'resume' && this.current.subscriptionPending) {
                    await this.subscribeMaterializedRootLocked(this.current);
                } else if (subscription === 'bridgeStartedNewThread') {
                    this.current.subscriptionPending = false;
                }
                await rootBindingStep(
                    'pendingNotifications',
                    () => this.drainPending(threadId, this.current!),
                );
                return {
                    sessionId: this.current.runtime.sessionId,
                    generation: this.current.generation,
                    changed: false,
                };
            }

            const previous = this.current;
            const nextGeneration = this.generation + 1;
            let target = this.roots.get(threadId) ?? null;
            let created = false;
            if (!target) {
                await rootBindingStep(
                    'lease',
                    () => this.options.leases.acquire(threadId, this.options.gatewayId),
                );
                let managed: ManagedRoot | null = null;
                const earlyOwnedThreads = new Set<string>();
                try {
                    const runtime = await rootBindingStep('runtime', () => this.options.createRuntime({
                        threadId,
                        generation: nextGeneration,
                        previousSessionId: previous?.runtime.sessionId ?? null,
                        registerThreadOwnership: (ownedThreadId) => {
                            if (!managed) {
                                earlyOwnedThreads.add(ownedThreadId);
                                return;
                            }
                            this.registerOwnership(ownedThreadId, managed);
                        },
                        assertCurrentGeneration: (bindingGeneration) => {
                            if (
                                !managed
                                || this.current !== managed
                                || managed.role !== 'current'
                                || bindingGeneration !== managed.generation
                            ) {
                                throw new CodexV4CommandCancelledError(
                                    'bindingSuperseded',
                                    'The Codex Gateway binding changed before this command reached the provider',
                                );
                            }
                        },
                    }));
                    managed = {
                        threadId,
                        generation: nextGeneration,
                        role: 'recovering',
                        subscriptionPending: false,
                        previousSessionId: previous?.runtime.sessionId ?? null,
                        nextSessionId: null,
                        title: null,
                        rootActiveTurnId: null,
                        lifecycleRecoveryRequired: false,
                        runtime,
                    };
                    target = managed;
                    this.roots.set(threadId, managed);
                    this.registerOwnership(threadId, managed);
                    for (const ownedThreadId of earlyOwnedThreads) {
                        this.registerOwnership(ownedThreadId, managed);
                    }
                    created = true;
                } catch (error) {
                    await this.options.leases.release(threadId, this.options.gatewayId).catch(() => false);
                    throw error;
                }
            }

            let previousMarkedDraining = false;
            target.subscriptionPending = subscription === 'deferredNewThread'
                || subscription === 'terminalRootResponse';
            try {
                const providerSnapshot = await rootBindingStep('providerSnapshot', async () => {
                    if (options.providerSnapshot) {
                        return options.providerSnapshot;
                    }
                    return subscription === 'resume'
                        ? (await this.options.client.subscribeThread(threadId)).thread
                        : (await this.options.client.readThread({
                            threadId,
                            includeTurns: false,
                            emitSnapshot: false,
                        })).thread;
                });
                target.title = safeThreadTitle(providerSnapshot);
                target.rootActiveTurnId = activeTurnIdFromSnapshot(providerSnapshot);
                await rootBindingStep(
                    'runtimeProjection',
                    () => created
                        ? target.runtime.activate(providerSnapshot)
                        : target.runtime.reconcile(providerSnapshot),
                );
                await rootBindingStep(
                    'pendingNotifications',
                    () => this.drainPending(threadId, target),
                );

                const changedAt = this.now();
                if (previous) {
                    previous.nextSessionId = target.runtime.sessionId;
                    await rootBindingStep('sourceBinding', () => previous.runtime.updateBinding({
                        role: 'draining',
                        generation: previous.generation,
                        previousSessionId: previous.previousSessionId,
                        nextSessionId: previous.nextSessionId,
                        changedAt,
                    }, { force: previous.role !== 'current' }));
                    previous.role = 'draining';
                    previousMarkedDraining = true;
                }
                target.previousSessionId = previous?.runtime.sessionId ?? null;
                target.nextSessionId = null;
                if (target.lifecycleRecoveryRequired) {
                    await rootBindingStep(
                        'targetBinding',
                        () => target.runtime.setGatewayLifecycle('running'),
                    );
                }
                await rootBindingStep('targetBinding', () => target.runtime.updateBinding({
                    role: 'current',
                    generation: nextGeneration,
                    previousSessionId: target.previousSessionId,
                    nextSessionId: null,
                    changedAt,
                }));
                target.role = 'current';
                target.generation = nextGeneration;
                target.lifecycleRecoveryRequired = false;
                if (subscription === 'terminalRootResponse' && options.providerSnapshot) {
                    this.options.client.adoptThreadSnapshot(options.providerSnapshot);
                }
                this.current = target;
                this.generation = nextGeneration;
            } catch (error) {
                const bindingError = error instanceof CodexGatewayRootBindingError
                    ? error
                    : new CodexGatewayRootBindingError('targetBinding', error);
                let sourceRollbackError: unknown = null;
                if (previousMarkedDraining && previous) {
                    try {
                        await previous.runtime.updateBinding({
                            role: 'current',
                            generation: previous.generation,
                            previousSessionId: previous.previousSessionId,
                            nextSessionId: null,
                            changedAt: this.now(),
                        });
                        previous.role = 'current';
                        previous.nextSessionId = null;
                    } catch (rollbackError) {
                        sourceRollbackError = rollbackError;
                        this.options.onError?.(rollbackError);
                    }
                }
                if (
                    bindingError.phase === 'sourceBinding'
                    && bindingError.recoveryRequired
                    && previous
                ) {
                    previous.role = 'draining';
                    previous.nextSessionId = target.runtime.sessionId;
                }
                const retainTargetForRecovery = bindingError.recoveryRequired
                    || sourceRollbackError !== null
                    || target.lifecycleRecoveryRequired;
                if (retainTargetForRecovery) {
                    if (previous) {
                        previous.role = 'draining';
                        previous.nextSessionId = target.runtime.sessionId;
                    }
                    target.lifecycleRecoveryRequired = true;
                    await target.runtime.setGatewayLifecycle('recovering')
                        .catch((recoveryError) => this.options.onError?.(recoveryError));
                } else if (created) {
                    this.removeRoot(target);
                    await target.runtime.close().catch(() => undefined);
                    await this.options.leases.release(threadId, this.options.gatewayId).catch(() => false);
                }
                if (sourceRollbackError !== null) {
                    throw new CodexGatewayRootBindingError(
                        'sourceBinding',
                        sourceRollbackError,
                        true,
                        bindingError,
                    );
                }
                throw bindingError;
            }

            if (previous) {
                await this.maybeRetireLocked(previous).catch((error) => this.options.onError?.(error));
            }
            return {
                sessionId: target.runtime.sessionId,
                generation: nextGeneration,
                changed: true,
            };
        });
    }

    async recoverPendingBinding(): Promise<boolean> {
        if (this.stopped) return false;
        const target = this.orderedRoots()
            .filter((root) => root !== this.current && root.role === 'recovering')
            .sort((left, right) => left.generation - right.generation)[0];
        if (!target) return false;
        const result = await this.bindRootAttempt(
            target.threadId,
            { subscription: 'resume' },
            target.runtime,
        );
        return result.changed;
    }

    async subscribeMaterializedRoot(threadId: string): Promise<boolean> {
        validateThreadId(threadId);
        if (this.stopped) return false;
        return await this.bindingLock.inLock(async () => {
            const root = this.roots.get(threadId);
            if (!root) return false;
            return await this.subscribeMaterializedRootLocked(root);
        });
    }

    async reconcilePendingRootSnapshot(threadId: string): Promise<boolean> {
        validateThreadId(threadId);
        if (this.stopped) return false;
        return await this.bindingLock.inLock(async () => {
            const root = this.roots.get(threadId);
            if (!root?.subscriptionPending) return false;
            const providerSnapshot = await rootBindingStep(
                'providerSnapshot',
                async () => (
                    await this.options.client.readThreadComplete({
                        threadId,
                        emitSnapshot: false,
                    })
                ).thread,
            );
            root.title = safeThreadTitle(providerSnapshot);
            root.rootActiveTurnId = activeTurnIdFromSnapshot(providerSnapshot);
            await rootBindingStep(
                'runtimeProjection',
                () => root.runtime.reconcile(providerSnapshot),
            );
            await rootBindingStep(
                'pendingNotifications',
                () => this.drainPending(threadId, root),
            );
            return true;
        });
    }

    async restoreBindings(bindings: readonly CodexGatewayRecoveredBinding[]): Promise<void> {
        if (bindings.length === 0) return;
        validateRecoveredBindings(bindings);
        if (this.stopped) throw new Error('Codex Gateway coordinator is stopped');
        const restored = await this.bindingLock.inLock(async (): Promise<ManagedRoot[]> => {
            if (this.roots.size > 0 || this.current) {
                throw new Error('Codex Gateway bindings can only be restored into an empty coordinator');
            }
            const ordered = [...bindings].sort((left, right) => left.generation - right.generation);
            const restored: ManagedRoot[] = [];
            const acquiredThreadIds: string[] = [];
            this.generation = Math.max(this.generation, ...ordered.map((binding) => binding.generation));
            try {
                for (const binding of ordered) {
                    await this.options.leases.acquire(binding.threadId, this.options.gatewayId);
                    acquiredThreadIds.push(binding.threadId);
                    let managed: ManagedRoot | null = null;
                    const earlyOwnedThreads = new Set<string>();
                    const previousSessionId = restored.at(-1)?.runtime.sessionId ?? null;
                    let runtime: CodexGatewayRootRuntime;
                    try {
                        runtime = await this.options.createRuntime({
                            threadId: binding.threadId,
                            generation: binding.generation,
                            previousSessionId,
                            registerThreadOwnership: (ownedThreadId) => {
                                if (!managed) earlyOwnedThreads.add(ownedThreadId);
                                else this.registerOwnership(ownedThreadId, managed);
                            },
                            assertCurrentGeneration: (bindingGeneration) => {
                                if (
                                    !managed
                                    || this.current !== managed
                                    || managed.role !== 'current'
                                    || bindingGeneration !== managed.generation
                                ) {
                                    throw new CodexV4CommandCancelledError(
                                        'bindingSuperseded',
                                        'The Codex Gateway binding changed before this command reached the provider',
                                    );
                                }
                            },
                        });
                    } catch (error) {
                        if (!(error instanceof CodexGatewayArchivedSessionError)) throw error;
                        await this.options.leases.release(binding.threadId, this.options.gatewayId);
                        acquiredThreadIds.pop();
                        continue;
                    }
                    managed = {
                        threadId: binding.threadId,
                        generation: binding.generation,
                        role: binding.role,
                        subscriptionPending: false,
                        previousSessionId,
                        nextSessionId: null,
                        title: null,
                        rootActiveTurnId: null,
                        lifecycleRecoveryRequired: false,
                        runtime,
                    };
                    this.roots.set(binding.threadId, managed);
                    this.registerOwnership(binding.threadId, managed);
                    for (const ownedThreadId of earlyOwnedThreads) {
                        this.registerOwnership(ownedThreadId, managed);
                    }
                    if (binding.role === 'current') this.current = managed;
                    restored.push(managed);

                    const recoveredSnapshot = await rootBindingStep(
                        'providerSnapshot',
                        () => this.acquireRecoverableSnapshot(binding.threadId),
                    );
                    managed.subscriptionPending = recoveredSnapshot.subscriptionPending;
                    managed.title = safeThreadTitle(recoveredSnapshot.thread);
                    managed.rootActiveTurnId = activeTurnIdFromSnapshot(recoveredSnapshot.thread);
                    await rootBindingStep(
                        'runtimeProjection',
                        () => runtime.activate(recoveredSnapshot.thread, {
                            deferCommandRecovery: true,
                        }),
                    );
                    await this.drainPending(binding.threadId, managed);
                }
                const current = this.current;
                if (!current) {
                    for (const root of restored) this.removeRoot(root);
                    await Promise.allSettled([
                        ...restored.map((root) => root.runtime.close()),
                        ...restored.map((root) => (
                            this.options.leases.release(root.threadId, this.options.gatewayId)
                        )),
                    ]);
                    return [];
                }
                const changedAt = this.now();
                for (const root of restored) {
                    root.previousSessionId ??= nearestPriorSessionId(this.roots, root);
                    root.nextSessionId = root.role === 'draining' ? current.runtime.sessionId : null;
                    await root.runtime.updateBinding({
                        role: root.role,
                        generation: root.generation,
                        previousSessionId: root.previousSessionId,
                        nextSessionId: root.nextSessionId,
                        changedAt,
                    }, { force: true });
                }
                return restored;
            } catch (error) {
                this.current = null;
                for (const root of restored) this.removeRoot(root);
                await Promise.allSettled([
                    ...restored.map((root) => root.runtime.close()),
                    ...acquiredThreadIds.map((threadId) => (
                        this.options.leases.release(threadId, this.options.gatewayId)
                    )),
                ]);
                throw error;
            }
        });
        for (const root of restored) {
            await root.runtime.resumeCommandRecovery();
        }
    }

    async stop(options: { force?: boolean } = {}): Promise<void> {
        if (this.stopped) return;
        if (!options.force) await this.deactivateRootsForGracefulStop();
        await this.finalizeStop();
    }

    async relinquishSession(sessionId: string): Promise<boolean> {
        if (this.stopped) return false;
        return await this.bindingLock.inLock(async () => {
            const root = [...this.roots.values()].find(
                (candidate) => candidate.runtime.sessionId === sessionId,
            );
            if (!root) return false;
            await this.relinquishRootLocked(root);
            return true;
        });
    }

    async relinquishThread(threadId: string): Promise<boolean> {
        if (this.stopped) return false;
        return await this.bindingLock.inLock(async () => {
            const root = this.roots.get(threadId);
            if (!root) return false;
            await this.relinquishRootLocked(root);
            return true;
        });
    }

    private async relinquishRootLocked(root: ManagedRoot): Promise<void> {
        this.removeRoot(root);
        root.role = 'inactive';
        await root.runtime.close().catch((error) => this.options.onError?.(error));
        await this.options.leases.release(root.threadId, this.options.gatewayId)
            .catch((error) => {
                this.options.onError?.(error);
                return false;
            });
    }

    private async deactivateRootsForGracefulStop(): Promise<void> {
        await this.notificationPipeline;
        await this.bindingLock.inLock(async () => {
            for (const root of this.orderedRoots()) {
                if (root.role === 'inactive') continue;
                await root.runtime.flush();
                await root.runtime.updateBinding({
                    role: 'inactive',
                    generation: root.generation,
                    previousSessionId: null,
                    nextSessionId: null,
                    changedAt: this.now(),
                });
                root.role = 'inactive';
            }
        });
    }

    private async finalizeStop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.options.client.setStableNotificationHandler(null);
        this.options.client.setServerRequestHandler(null);
        this.options.client.setConnectionHandler(null);
        await this.notificationPipeline.catch(() => undefined);
        await this.bindingLock.inLock(async () => {
            const roots = [...this.roots.values()];
            this.current = null;
            await Promise.all(roots.map(async (root) => {
                await root.runtime.close().catch((error) => this.options.onError?.(error));
                await this.options.leases.release(root.threadId, this.options.gatewayId)
                    .catch((error) => {
                        this.options.onError?.(error);
                        return false;
                    });
            }));
            this.roots.clear();
            this.ownerByThread.clear();
            this.pendingNotifications.clear();
            this.recentNotificationSources.clear();
        });
        await this.options.client.disconnect();
        this.connected = false;
        this.resolveAllOwnershipWaiters();
    }

    async flush(): Promise<void> {
        await this.notificationPipeline;
        await Promise.all([...this.roots.values()].map((root) => root.runtime.flush()));
    }

    async setGatewayLifecycle(
        state: 'starting' | 'running' | 'recovering' | 'stopping' | 'stopped',
    ): Promise<void> {
        await this.bindingLock.inLock(async () => {
            await Promise.all([...this.roots.values()].map((root) => (
                root.runtime.setGatewayLifecycle(state)
            )));
        });
    }

    async setTerminalState(
        state: 'attached' | 'pendingDetach' | 'detached' | 'headless',
        detachedAt: number | null,
    ): Promise<void> {
        await this.bindingLock.inLock(async () => {
            await Promise.all([...this.roots.values()].map((root) => (
                root.runtime.setTerminalState(state, detachedAt)
            )));
        });
    }

    async retireDrainingRoots(): Promise<void> {
        await this.retireEligibleDrainingRoots();
    }

    async refreshBindingLinks(): Promise<void> {
        await this.bindingLock.inLock(async () => {
            const current = this.current;
            if (!current) return;
            const currentPreviousSessionId = current.previousSessionId
                ?? nearestPriorSessionId(this.roots, current);
            const drainingUpdates = [...this.roots.values()]
                .filter((root) => root.role === 'draining')
                .map((root) => ({
                    root,
                    nextSessionId: root.nextSessionId ?? current.runtime.sessionId,
                }))
                .filter(({ root, nextSessionId }) => root.nextSessionId !== nextSessionId);
            const currentChanged = current.previousSessionId !== currentPreviousSessionId
                || current.nextSessionId !== null;
            if (!currentChanged && drainingUpdates.length === 0) return;

            const changedAt = this.now();
            if (currentChanged) {
                await current.runtime.updateBinding({
                    role: 'current',
                    generation: current.generation,
                    previousSessionId: currentPreviousSessionId,
                    nextSessionId: null,
                    changedAt,
                });
                current.previousSessionId = currentPreviousSessionId;
                current.nextSessionId = null;
            }
            for (const { root, nextSessionId } of drainingUpdates) {
                await root.runtime.updateBinding({
                    role: 'draining',
                    generation: root.generation,
                    previousSessionId: root.previousSessionId,
                    nextSessionId,
                    changedAt,
                });
                root.nextSessionId = nextSessionId;
            }
        });
    }

    private async acquireRecoverableSnapshot(threadId: string): Promise<{
        thread: Thread;
        subscriptionPending: boolean;
    }> {
        const resumed = await this.options.client.subscribeThreadIfMaterialized(threadId);
        if (resumed) {
            return { thread: resumed.thread, subscriptionPending: false };
        }
        const live = await this.options.client.readThread({
            threadId,
            includeTurns: false,
            emitSnapshot: false,
        });
        return { thread: live.thread, subscriptionPending: true };
    }

    private async subscribeMaterializedRootLocked(root: ManagedRoot): Promise<boolean> {
        if (!root.subscriptionPending) return true;
        const resumed = await rootBindingStep(
            'providerSnapshot',
            () => this.options.client.subscribeThreadIfMaterialized(root.threadId),
        );
        if (!resumed) return false;
        root.title = safeThreadTitle(resumed.thread);
        root.rootActiveTurnId = activeTurnIdFromSnapshot(resumed.thread);
        await rootBindingStep(
            'runtimeProjection',
            () => root.runtime.reconcile(resumed.thread),
        );
        await rootBindingStep(
            'pendingNotifications',
            () => this.drainPending(root.threadId, root),
        );
        root.subscriptionPending = false;
        return true;
    }

    private installClientHandlers(): void {
        if (this.handlersInstalled) return;
        this.handlersInstalled = true;
        this.options.client.setStableNotificationHandler((notification) => {
            this.enqueueNotification(notification, 'bridge');
        });
        this.options.client.setServerRequestHandler(async (request) => {
            await this.notificationPipeline;
            const owner = await this.resolveRequestOwner(request);
            return await owner.runtime.handleRequest(request);
        });
        this.options.client.setConnectionHandler((event) => {
            for (const root of this.roots.values()) root.runtime.setConnection(event);
            if (event.connection === 'disconnected' || event.connection === 'error') {
                this.connected = false;
            } else if (event.connection === 'connected') {
                this.connected = true;
            }
        });
    }

    private enqueueNotification(
        notification: ServerNotification,
        source: CodexGatewayNotificationSource,
    ): void {
        const barrierBatch = this.notificationBarrierBatch;
        const routed = this.notificationPipeline.then(() => this.routeNotification(notification, source));
        this.notificationPipeline = routed.catch((error) => {
            barrierBatch.failure ??= { error };
            this.options.onError?.(error);
        });
    }

    private async routeNotification(
        notification: ServerNotification,
        source: CodexGatewayNotificationSource,
    ): Promise<void> {
        if (this.stopped) return;
        const threadId = notificationThreadId(notification);
        if (!threadId) return;
        let owner = this.ownerByThread.get(threadId) ?? this.findRuntimeOwner(threadId);
        if (!owner) owner = await this.resolveOwnerFromSnapshot(notification, threadId);
        if (!owner) {
            this.bufferNotification(threadId, notification, source);
            return;
        }
        const handled = await this.applyOwnedNotification(owner, notification, source);
        if (handled && owner.role === 'draining') {
            await this.bindingLock.inLock(() => this.maybeRetireLocked(owner!));
        }
    }

    private async applyOwnedNotification(
        owner: ManagedRoot,
        notification: ServerNotification,
        source: CodexGatewayNotificationSource,
    ): Promise<boolean> {
        // Receiving stable lifecycle on the bridge proves this connection is already
        // subscribed. Re-resuming here could import a snapshot containing the same
        // delta and then apply that delta twice.
        if (
            source === 'bridge'
            && owner.subscriptionPending
            && this.roots.get(owner.threadId) === owner
        ) {
            owner.subscriptionPending = false;
        }
        if (this.isCrossSourceDuplicate(notification, source)) return false;
        const threadId = notificationThreadId(notification);
        if (!threadId) return false;
        this.registerOwnership(threadId, owner);
        trackRootActivity(owner, notification);
        trackRootTitle(owner, notification);
        await owner.runtime.handleNotification(notification);
        await this.drainNewlyOwnedPending(owner);
        return true;
    }

    private async resolveRequestOwner(request: CodexServerRequest): Promise<ManagedRoot> {
        const threadId = requestThreadId(request);
        if (!threadId) {
            if (this.current) return this.current;
            throw new Error('Codex provider request has no Gateway thread binding');
        }
        let owner = this.ownerByThread.get(threadId) ?? this.findRuntimeOwner(threadId);
        if (!owner) {
            owner = await this.resolveOwnerFromThread(threadId);
        }
        if (owner) return owner;
        await this.waitForOwnership(threadId);
        owner = this.ownerByThread.get(threadId) ?? this.findRuntimeOwner(threadId);
        if (!owner) throw new Error('Codex provider request thread is not owned by this Gateway');
        return owner;
    }

    private async resolveOwnerFromSnapshot(
        notification: ServerNotification,
        threadId: string,
    ): Promise<ManagedRoot | null> {
        const snapshot = notification.method === 'thread/started'
            ? notification.params.thread
            : null;
        return await this.resolveOwnerFromThread(threadId, snapshot);
    }

    private async resolveOwnerFromThread(
        threadId: string,
        initialSnapshot?: Thread | null,
    ): Promise<ManagedRoot | null> {
        let snapshot = initialSnapshot ?? null;
        const visited = new Set<string>();
        let candidate = threadId;
        for (let depth = 0; depth < 64; depth += 1) {
            if (visited.has(candidate)) throw new Error('Codex Gateway thread lineage contains a cycle');
            visited.add(candidate);
            const known = this.ownerByThread.get(candidate) ?? this.findRuntimeOwner(candidate);
            if (known) return known;
            if (!snapshot || snapshot.id !== candidate) {
                try {
                    snapshot = (await this.options.client.readThreadComplete({
                        threadId: candidate,
                        emitSnapshot: false,
                    })).thread;
                } catch {
                    return null;
                }
            }
            if (!snapshot.parentThreadId) return null;
            candidate = snapshot.parentThreadId;
            snapshot = null;
        }
        throw new Error('Codex Gateway thread lineage exceeded the maximum depth');
    }

    private registerOwnership(threadId: string, owner: ManagedRoot): void {
        const current = this.ownerByThread.get(threadId);
        if (current && current !== owner) {
            throw new Error('Codex thread was assigned to two Gateway root runtimes');
        }
        this.ownerByThread.set(threadId, owner);
        const waiters = this.ownershipWaiters.get(threadId);
        if (waiters) {
            this.ownershipWaiters.delete(threadId);
            for (const resolve of waiters) resolve();
        }
    }

    private findRuntimeOwner(threadId: string): ManagedRoot | null {
        for (const root of this.roots.values()) {
            if (root.runtime.ownsThread(threadId)) return root;
        }
        return null;
    }

    private async drainPending(threadId: string, owner: ManagedRoot): Promise<void> {
        const pending = this.pendingNotifications.get(threadId);
        if (!pending) return;
        this.pendingNotifications.delete(threadId);
        for (const entry of pending) {
            await this.applyOwnedNotification(owner, entry.notification, entry.source);
        }
    }

    private async drainNewlyOwnedPending(owner: ManagedRoot): Promise<void> {
        for (const [threadId] of this.pendingNotifications) {
            if (this.ownerByThread.get(threadId) === owner || owner.runtime.ownsThread(threadId)) {
                this.registerOwnership(threadId, owner);
                await this.drainPending(threadId, owner);
            }
        }
    }

    private isCrossSourceDuplicate(
        notification: ServerNotification,
        source: CodexGatewayNotificationSource,
    ): boolean {
        const fingerprint = notificationFingerprint(notification);
        if (!fingerprint) return false;
        const observedAt = this.now();
        this.pruneRecentNotificationSources(observedAt);
        const previous = this.recentNotificationSources.get(fingerprint);
        if (previous && previous.source !== source) return true;
        this.recentNotificationSources.delete(fingerprint);
        this.recentNotificationSources.set(fingerprint, { source, observedAt });
        while (this.recentNotificationSources.size > MAX_RECENT_CROSS_SOURCE_NOTIFICATIONS) {
            const oldest = this.recentNotificationSources.keys().next().value as string | undefined;
            if (!oldest) break;
            this.recentNotificationSources.delete(oldest);
        }
        return false;
    }

    private pruneRecentNotificationSources(observedAt: number): void {
        for (const [fingerprint, entry] of this.recentNotificationSources) {
            if (observedAt - entry.observedAt < CROSS_SOURCE_NOTIFICATION_DEDUP_TTL_MS) break;
            this.recentNotificationSources.delete(fingerprint);
        }
    }

    private bufferNotification(
        threadId: string,
        notification: ServerNotification,
        source: CodexGatewayNotificationSource,
    ): void {
        const current = this.pendingNotifications.get(threadId) ?? [];
        current.push({ notification, source });
        if (current.length > MAX_PENDING_NOTIFICATIONS_PER_THREAD) current.shift();
        this.pendingNotifications.set(threadId, current);
        while (this.pendingNotificationCount() > MAX_PENDING_NOTIFICATIONS_TOTAL) {
            const oldest = this.pendingNotifications.keys().next().value as string | undefined;
            if (!oldest) break;
            this.pendingNotifications.delete(oldest);
        }
    }

    private pendingNotificationCount(): number {
        let count = 0;
        for (const entries of this.pendingNotifications.values()) count += entries.length;
        return count;
    }

    private async retireEligibleDrainingRoots(): Promise<void> {
        await this.bindingLock.inLock(async () => {
            for (const root of [...this.roots.values()]) {
                await this.maybeRetireLocked(root);
            }
        });
    }

    private async maybeRetireLocked(root: ManagedRoot): Promise<void> {
        if (root.role !== 'draining' || root.subscriptionPending || root.rootActiveTurnId) return;
        if (!await root.runtime.isDrained()) return;
        await root.runtime.flush();
        if (!await root.runtime.isDrained()) return;
        await root.runtime.updateBinding({
            role: 'inactive',
            generation: root.generation,
            previousSessionId: null,
            nextSessionId: null,
            changedAt: this.now(),
        });
        root.role = 'inactive';
        this.removeRoot(root);
        let closeError: unknown = null;
        try {
            await root.runtime.close();
        } catch (error) {
            closeError = error;
        }
        await this.options.leases.release(root.threadId, this.options.gatewayId);
        if (closeError !== null) throw closeError;
    }

    private removeRoot(root: ManagedRoot): void {
        if (this.roots.get(root.threadId) === root) this.roots.delete(root.threadId);
        for (const [threadId, owner] of this.ownerByThread) {
            if (owner === root) this.ownerByThread.delete(threadId);
        }
        if (this.current === root) this.current = null;
    }

    private orderedRoots(): ManagedRoot[] {
        return [...this.roots.values()].sort((left, right) => {
            if (left === this.current) return -1;
            if (right === this.current) return 1;
            return left.generation - right.generation;
        });
    }

    private async waitForOwnership(threadId: string): Promise<void> {
        const timeoutMs = this.options.ownershipWaitMs ?? OWNERSHIP_WAIT_MS;
        await new Promise<void>((resolve, reject) => {
            const waiters = this.ownershipWaiters.get(threadId) ?? new Set<() => void>();
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                waiters.delete(finish);
                if (waiters.size === 0) this.ownershipWaiters.delete(threadId);
                resolve();
            };
            waiters.add(finish);
            this.ownershipWaiters.set(threadId, waiters);
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                waiters.delete(finish);
                if (waiters.size === 0) this.ownershipWaiters.delete(threadId);
                reject(new Error('Timed out waiting for Codex Gateway thread ownership'));
            }, timeoutMs);
        });
    }

    private resolveAllOwnershipWaiters(): void {
        for (const waiters of this.ownershipWaiters.values()) {
            for (const resolve of waiters) resolve();
        }
        this.ownershipWaiters.clear();
    }

    private now(): number {
        return Math.max(0, Math.trunc(this.options.now?.() ?? Date.now()));
    }
}

function validateThreadId(threadId: string): void {
    if (threadId.length === 0 || threadId.length > 512) throw new Error('Invalid Codex thread ID');
}

function validateRecoveredBindings(bindings: readonly CodexGatewayRecoveredBinding[]): void {
    if (bindings.length > 1_024) throw new Error('Too many recovered Codex Gateway bindings');
    if (bindings.filter((binding) => binding.role === 'current').length !== 1) {
        throw new Error('Recovered Codex Gateway bindings require exactly one current root');
    }
    const currentGeneration = bindings.find((binding) => binding.role === 'current')!.generation;
    if (bindings.some((binding) => binding.generation > currentGeneration)) {
        throw new Error('Recovered Codex Gateway current binding must have the newest generation');
    }
    const threadIds = new Set<string>();
    const generations = new Set<number>();
    for (const binding of bindings) {
        validateThreadId(binding.threadId);
        if (!Number.isSafeInteger(binding.generation) || binding.generation < 1) {
            throw new Error('Invalid recovered Codex Gateway generation');
        }
        if (threadIds.has(binding.threadId) || generations.has(binding.generation)) {
            throw new Error('Recovered Codex Gateway bindings must be unique');
        }
        threadIds.add(binding.threadId);
        generations.add(binding.generation);
    }
}

function nearestPriorSessionId(
    roots: Map<string, ManagedRoot>,
    current: ManagedRoot,
): string | null {
    return [...roots.values()]
        .filter((root) => root.generation < current.generation && root.runtime.sessionId !== null)
        .sort((left, right) => right.generation - left.generation)[0]
        ?.runtime.sessionId ?? null;
}

async function rootBindingStep<T>(
    phase: CodexGatewayRootBindingPhase,
    operation: () => Promise<T>,
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof CodexGatewayRootBindingError) throw error;
        throw new CodexGatewayRootBindingError(phase, error);
    }
}

function notificationThreadId(notification: ServerNotification): string | null {
    if (notification.method === 'thread/started') return notification.params.thread.id;
    const params = notification.params as unknown as Record<string, unknown>;
    return typeof params.threadId === 'string' && params.threadId.length > 0
        ? params.threadId
        : null;
}

function notificationFingerprint(notification: ServerNotification): string | null {
    try {
        return createHash('sha256')
            .update(JSON.stringify(notification))
            .digest('base64url');
    } catch {
        return null;
    }
}

function requestThreadId(request: CodexServerRequest): string | null {
    if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) return null;
    const threadId = (request.params as Record<string, unknown>).threadId;
    return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
}

function diagnosticRecoveryRequired(value: unknown): boolean {
    return typeof value === 'object'
        && value !== null
        && 'recoveryRequired' in value
        && value.recoveryRequired === true;
}

function activeTurnIdFromSnapshot(thread: Thread): string | null {
    if (thread.status.type !== 'active') return null;
    for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
        const turn = thread.turns[index];
        if (turn?.status === 'inProgress') return turn.id;
    }
    return '__active_without_turn_id__';
}

function trackRootActivity(root: ManagedRoot, notification: ServerNotification): void {
    const threadId = notificationThreadId(notification);
    if (threadId !== root.threadId) return;
    if (notification.method === 'turn/started') {
        root.rootActiveTurnId = notification.params.turn.id;
        return;
    }
    if (notification.method === 'turn/completed') {
        if (
            root.rootActiveTurnId === notification.params.turn.id
            || root.rootActiveTurnId === '__active_without_turn_id__'
        ) {
            root.rootActiveTurnId = null;
        }
        return;
    }
    if (notification.method === 'thread/status/changed') {
        root.rootActiveTurnId = notification.params.status.type === 'active'
            ? root.rootActiveTurnId ?? '__active_without_turn_id__'
            : null;
        return;
    }
    if (
        notification.method === 'thread/archived'
        || notification.method === 'thread/closed'
        || notification.method === 'thread/deleted'
    ) {
        root.rootActiveTurnId = null;
    }
}

function trackRootTitle(root: ManagedRoot, notification: ServerNotification): void {
    if (notification.method === 'thread/started' && notification.params.thread.id === root.threadId) {
        root.title = safeThreadTitle(notification.params.thread);
        return;
    }
    if (notification.method === 'thread/name/updated' && notification.params.threadId === root.threadId) {
        root.title = safeTitle(notification.params.threadName);
    }
}

function safeThreadTitle(thread: Thread): string | null {
    return safeTitle(thread.name?.trim() || thread.preview?.trim());
}

function safeTitle(title: string | null | undefined): string | null {
    if (!title) return null;
    return [...title].slice(0, 200).join('');
}
