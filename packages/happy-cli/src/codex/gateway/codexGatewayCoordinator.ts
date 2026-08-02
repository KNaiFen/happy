import { AsyncLock } from '@/utils/lock';
import type {
    CodexAppServerClient,
    CodexConnectionEvent,
    CodexManagedServerResponse,
    CodexServerRequest,
} from '../codexAppServerClient';
import { CodexV4CommandCancelledError } from '../codexV4CommandProcessor';
import type { ServerNotification, Thread } from '../protocol';

const MAX_PENDING_NOTIFICATIONS_PER_THREAD = 1_000;
const MAX_PENDING_NOTIFICATIONS_TOTAL = 10_000;
const OWNERSHIP_WAIT_MS = 5_000;

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

export interface CodexGatewayRootRuntime {
    readonly sessionId: string | null;
    handleNotification(notification: ServerNotification): Promise<void>;
    handleRequest(request: CodexServerRequest): Promise<CodexManagedServerResponse | null>;
    setConnection(event: CodexConnectionEvent): void;
    activate(snapshot: Thread): Promise<void>;
    reconcile(snapshot: Thread): Promise<void>;
    updateBinding(binding: CodexGatewayRuntimeBinding): Promise<void>;
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
    subscription?: 'resume' | 'bridgeStartedNewThread' | 'deferredNewThread';
}

export class CodexGatewayCoordinator {
    private readonly bindingLock = new AsyncLock();
    private readonly roots = new Map<string, ManagedRoot>();
    private readonly ownerByThread = new Map<string, ManagedRoot>();
    private readonly pendingNotifications = new Map<string, ServerNotification[]>();
    private readonly ownershipWaiters = new Map<string, Set<() => void>>();
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
        validateThreadId(threadId);
        if (this.stopped) throw new Error('Codex Gateway coordinator is stopped');
        const subscription = options.subscription ?? 'resume';
        return await this.bindingLock.inLock(async () => {
            if (this.current?.threadId === threadId) {
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
            try {
                const providerSnapshot = await rootBindingStep(
                    'providerSnapshot',
                    async () => subscription === 'resume'
                        ? (await this.options.client.subscribeThread(threadId)).thread
                        : (await this.options.client.readThread({
                            threadId,
                            includeTurns: false,
                            emitSnapshot: false,
                        })).thread,
                );
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
                    }));
                    previous.role = 'draining';
                    previousMarkedDraining = true;
                }
                target.previousSessionId = previous?.runtime.sessionId ?? null;
                target.nextSessionId = null;
                await rootBindingStep('targetBinding', () => target.runtime.updateBinding({
                    role: 'current',
                    generation: nextGeneration,
                    previousSessionId: target.previousSessionId,
                    nextSessionId: null,
                    changedAt,
                }));
                target.role = 'current';
                target.generation = nextGeneration;
                target.subscriptionPending = subscription === 'deferredNewThread';
                this.current = target;
                this.generation = nextGeneration;
            } catch (error) {
                if (previousMarkedDraining && previous) {
                    previous.role = 'current';
                    previous.nextSessionId = null;
                    await previous.runtime.updateBinding({
                        role: 'current',
                        generation: previous.generation,
                        previousSessionId: previous.previousSessionId,
                        nextSessionId: null,
                        changedAt: this.now(),
                    }).catch((rollbackError) => this.options.onError?.(rollbackError));
                }
                if (created) {
                    this.removeRoot(target);
                    await target.runtime.close().catch(() => undefined);
                    await this.options.leases.release(threadId, this.options.gatewayId).catch(() => false);
                }
                throw error;
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

    async subscribeMaterializedRoot(threadId: string): Promise<boolean> {
        validateThreadId(threadId);
        if (this.stopped) return false;
        return await this.bindingLock.inLock(async () => {
            const root = this.roots.get(threadId);
            if (!root) return false;
            return await this.subscribeMaterializedRootLocked(root);
        });
    }

    async restoreBindings(bindings: readonly CodexGatewayRecoveredBinding[]): Promise<void> {
        if (bindings.length === 0) return;
        validateRecoveredBindings(bindings);
        if (this.stopped) throw new Error('Codex Gateway coordinator is stopped');
        await this.bindingLock.inLock(async () => {
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
                    const previousSessionId = [...ordered]
                        .filter((candidate) => candidate.generation < binding.generation)
                        .sort((left, right) => right.generation - left.generation)[0]
                        ?.sessionId ?? null;
                    const runtime = await this.options.createRuntime({
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
                    managed = {
                        threadId: binding.threadId,
                        generation: binding.generation,
                        role: binding.role,
                        subscriptionPending: false,
                        previousSessionId,
                        nextSessionId: null,
                        title: null,
                        rootActiveTurnId: null,
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
                        () => runtime.activate(recoveredSnapshot.thread),
                    );
                    await this.drainPending(binding.threadId, managed);
                }
                const current = this.current!;
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
                    });
                }
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
    }

    async stop(options: { force?: boolean } = {}): Promise<void> {
        if (this.stopped) return;
        if (!options.force) await this.deactivateRootsForGracefulStop();
        await this.finalizeStop();
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
            const changedAt = this.now();
            current.previousSessionId ??= nearestPriorSessionId(this.roots, current);
            await current.runtime.updateBinding({
                role: 'current',
                generation: current.generation,
                previousSessionId: current.previousSessionId,
                nextSessionId: null,
                changedAt,
            });
            await Promise.all([...this.roots.values()]
                .filter((root) => root.role === 'draining')
                .map((root) => {
                    root.nextSessionId ??= current.runtime.sessionId;
                    return root.runtime.updateBinding({
                        role: 'draining',
                        generation: root.generation,
                        previousSessionId: root.previousSessionId,
                        nextSessionId: root.nextSessionId,
                        changedAt,
                    });
            }));
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
            const routed = this.notificationPipeline.then(() => this.routeNotification(notification));
            this.notificationPipeline = routed.catch((error) => {
                this.options.onError?.(error);
            });
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

    private async routeNotification(notification: ServerNotification): Promise<void> {
        if (this.stopped) return;
        const threadId = notificationThreadId(notification);
        if (!threadId) return;
        let owner = this.ownerByThread.get(threadId) ?? this.findRuntimeOwner(threadId);
        if (!owner) owner = await this.resolveOwnerFromSnapshot(notification, threadId);
        if (!owner) {
            this.bufferNotification(threadId, notification);
            return;
        }
        // Receiving stable lifecycle on the bridge proves this connection is already
        // subscribed. Re-resuming here could import a snapshot containing the same
        // delta and then apply that delta twice.
        if (owner.subscriptionPending) {
            await this.bindingLock.inLock(async () => {
                if (this.roots.get(owner!.threadId) === owner) {
                    owner!.subscriptionPending = false;
                }
            });
        }
        this.registerOwnership(threadId, owner);
        trackRootActivity(owner, notification);
        trackRootTitle(owner, notification);
        await owner.runtime.handleNotification(notification);
        await this.drainNewlyOwnedPending(owner);
        if (owner.role === 'draining') {
            await this.bindingLock.inLock(() => this.maybeRetireLocked(owner!));
        }
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
        for (const notification of pending) {
            trackRootActivity(owner, notification);
            await owner.runtime.handleNotification(notification);
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

    private bufferNotification(threadId: string, notification: ServerNotification): void {
        const current = this.pendingNotifications.get(threadId) ?? [];
        current.push(notification);
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
        await root.runtime.close();
        await this.options.leases.release(root.threadId, this.options.gatewayId);
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

function requestThreadId(request: CodexServerRequest): string | null {
    if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) return null;
    const threadId = (request.params as Record<string, unknown>).threadId;
    return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
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
