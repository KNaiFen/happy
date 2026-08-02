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

export interface CodexGatewayRuntimeBinding {
    role: CodexGatewayBindingRole;
    generation: number;
    previousSessionId: string | null;
    nextSessionId: string | null;
    changedAt: number;
}

export interface CodexGatewayRootRuntime {
    readonly sessionId: string;
    handleNotification(notification: ServerNotification): Promise<void>;
    handleRequest(request: CodexServerRequest): Promise<CodexManagedServerResponse>;
    setConnection(event: CodexConnectionEvent): void;
    activate(snapshot: Thread): Promise<void>;
    reconcile(snapshot: Thread): Promise<void>;
    updateBinding(binding: CodexGatewayRuntimeBinding): Promise<void>;
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

    async connect(recovered = false): Promise<void> {
        if (this.stopped) throw new Error('Codex Gateway coordinator is stopped');
        this.installClientHandlers();
        if (recovered) await this.options.client.reconnectExternalTransportPreservingThreads();
        else if (!this.connected) await this.options.client.connect();
        this.connected = true;

        if (recovered) {
            for (const root of this.orderedRoots()) {
                const resumed = await this.options.client.resumeThread({
                    threadId: root.threadId,
                    emitSnapshot: false,
                    selectThread: false,
                });
                root.rootActiveTurnId = activeTurnIdFromSnapshot(resumed.thread);
                await root.runtime.reconcile(resumed.thread);
                await this.drainPending(root.threadId, root);
            }
            await this.notificationPipeline;
            await this.retireEligibleDrainingRoots();
        }
    }

    async bindRoot(threadId: string): Promise<{
        sessionId: string;
        generation: number;
        changed: boolean;
    }> {
        validateThreadId(threadId);
        if (this.stopped) throw new Error('Codex Gateway coordinator is stopped');
        return await this.bindingLock.inLock(async () => {
            if (this.current?.threadId === threadId) {
                await this.drainPending(threadId, this.current);
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
                await this.options.leases.acquire(threadId, this.options.gatewayId);
                let managed: ManagedRoot | null = null;
                const earlyOwnedThreads = new Set<string>();
                try {
                    const runtime = await this.options.createRuntime({
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
                    });
                    managed = {
                        threadId,
                        generation: nextGeneration,
                        role: 'recovering',
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
                const resumed = await this.options.client.resumeThread({
                    threadId,
                    emitSnapshot: false,
                    selectThread: false,
                });
                target.rootActiveTurnId = activeTurnIdFromSnapshot(resumed.thread);
                if (created) await target.runtime.activate(resumed.thread);
                else await target.runtime.reconcile(resumed.thread);
                await this.drainPending(threadId, target);

                const changedAt = this.now();
                if (previous) {
                    await previous.runtime.updateBinding({
                        role: 'draining',
                        generation: previous.generation,
                        previousSessionId: null,
                        nextSessionId: target.runtime.sessionId,
                        changedAt,
                    });
                    previous.role = 'draining';
                    previousMarkedDraining = true;
                }
                await target.runtime.updateBinding({
                    role: 'current',
                    generation: nextGeneration,
                    previousSessionId: previous?.runtime.sessionId ?? null,
                    nextSessionId: null,
                    changedAt,
                });
                target.role = 'current';
                target.generation = nextGeneration;
                this.current = target;
                this.generation = nextGeneration;
            } catch (error) {
                if (previousMarkedDraining && previous) {
                    previous.role = 'current';
                    await previous.runtime.updateBinding({
                        role: 'current',
                        generation: previous.generation,
                        previousSessionId: null,
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

    async stop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.options.client.setStableNotificationHandler(null);
        this.options.client.setServerRequestHandler(null);
        this.options.client.setConnectionHandler(null);
        await this.notificationPipeline.catch(() => undefined);
        await this.bindingLock.inLock(async () => {
            const roots = [...this.roots.values()];
            this.current = null;
            for (const root of roots) {
                root.role = 'inactive';
                await root.runtime.updateBinding({
                    role: 'inactive',
                    generation: root.generation,
                    previousSessionId: null,
                    nextSessionId: null,
                    changedAt: this.now(),
                }).catch((error) => this.options.onError?.(error));
            }
            await Promise.all(roots.map(async (root) => {
                await root.runtime.flush().catch((error) => this.options.onError?.(error));
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
        this.registerOwnership(threadId, owner);
        trackRootActivity(owner, notification);
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
        if (root.role !== 'draining' || root.rootActiveTurnId) return;
        await root.runtime.flush();
        if (!await root.runtime.isDrained()) return;
        root.role = 'inactive';
        await root.runtime.updateBinding({
            role: 'inactive',
            generation: root.generation,
            previousSessionId: null,
            nextSessionId: null,
            changedAt: this.now(),
        });
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
