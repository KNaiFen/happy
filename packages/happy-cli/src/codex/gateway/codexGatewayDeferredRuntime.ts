import { AsyncLock } from '@/utils/lock';
import type {
    CodexAppServerClient,
    CodexConnectionEvent,
    CodexManagedServerResponse,
    CodexServerRequest,
} from '../codexAppServerClient';
import type { ServerNotification, Thread } from '../protocol';
import type {
    CodexGatewayRootRuntime,
    CodexGatewayRuntimeBinding,
} from './codexGatewayCoordinator';
import type { CodexGatewayJournal } from './codexGatewayJournal';

interface PendingRequest {
    request: CodexServerRequest;
    resolve(value: CodexManagedServerResponse | null): void;
    reject(error: unknown): void;
}

/** Holds a provider root without inventing a Happy session while the relay is offline. */
export class CodexGatewayDeferredRuntime implements CodexGatewayRootRuntime {
    private readonly operationLock = new AsyncLock();
    private readonly pendingRequests = new Map<string, PendingRequest[]>();
    private inner: CodexGatewayRootRuntime | null = null;
    private latestSnapshot: Thread | null = null;
    private binding: CodexGatewayRuntimeBinding;
    private connection: CodexConnectionEvent = {
        connection: 'disconnected',
        statusUnknown: true,
        error: null,
    };
    private gatewayLifecycle: 'starting' | 'running' | 'recovering' | 'stopping' | 'stopped';
    private terminalState: 'attached' | 'pendingDetach' | 'detached' | 'headless';
    private terminalDetachedAt: number | null;
    private closed = false;

    constructor(private readonly options: {
        threadId: string;
        journal: CodexGatewayJournal;
        initialBinding: CodexGatewayRuntimeBinding;
        initialGatewayLifecycle: 'starting' | 'running' | 'recovering' | 'stopping' | 'stopped';
        initialTerminalState: 'attached' | 'pendingDetach' | 'detached' | 'headless';
        initialTerminalDetachedAt: number | null;
        readSnapshot(): Promise<Thread>;
    }) {
        this.binding = options.initialBinding;
        this.gatewayLifecycle = options.initialGatewayLifecycle;
        this.terminalState = options.initialTerminalState;
        this.terminalDetachedAt = options.initialTerminalDetachedAt;
    }

    get sessionId(): string | null {
        return this.inner?.sessionId ?? null;
    }

    get isMaterialized(): boolean {
        return this.inner !== null;
    }

    async materialize(runtime: CodexGatewayRootRuntime): Promise<void> {
        await this.operationLock.inLock(async () => {
            if (this.closed) {
                await runtime.close().catch(() => undefined);
                throw new Error('Codex Gateway deferred runtime is closed');
            }
            if (this.inner) {
                await runtime.close();
                return;
            }
            this.inner = runtime;
            try {
                runtime.setConnection(this.connection);
                await runtime.setGatewayLifecycle(this.gatewayLifecycle);
                await runtime.setTerminalState(this.terminalState, this.terminalDetachedAt);
                const snapshot = this.latestSnapshot ?? await this.options.readSnapshot();
                await runtime.activate(snapshot);
                await runtime.updateBinding(this.binding);
                await this.replayLocked(runtime);
            } catch (error) {
                this.inner = null;
                await runtime.close().catch(() => undefined);
                throw error;
            }
        });
        this.releasePendingRequests();
    }

    async replayDeferred(): Promise<void> {
        await this.operationLock.inLock(async () => {
            if (this.inner) await this.replayLocked(this.inner);
        });
    }

    async handleNotification(notification: ServerNotification): Promise<void> {
        await this.operationLock.inLock(async () => {
            if (this.closed) return;
            if (this.inner) {
                await this.inner.handleNotification(notification);
            } else {
                await this.options.journal.enqueueNotification(this.options.threadId, notification);
            }
            if (notification.method === 'serverRequest/resolved') {
                this.resolvePendingRequest(String(notification.params.requestId));
            }
        });
    }

    async handleRequest(request: CodexServerRequest): Promise<CodexManagedServerResponse | null> {
        const route = await this.operationLock.inLock(async (): Promise<
            | { type: 'closed' }
            | { type: 'materialized'; runtime: CodexGatewayRootRuntime }
            | { type: 'deferred'; response: Promise<CodexManagedServerResponse | null> }
        > => {
            if (this.closed) return { type: 'closed' };
            if (this.inner) return { type: 'materialized', runtime: this.inner };
            const response = new Promise<CodexManagedServerResponse | null>((resolve, reject) => {
                const pending = this.pendingRequests.get(request.requestId) ?? [];
                pending.push({ request, resolve, reject });
                this.pendingRequests.set(request.requestId, pending);
            });
            return { type: 'deferred', response };
        });
        if (route.type === 'closed') return null;
        if (route.type === 'materialized') return await route.runtime.handleRequest(request);
        return await route.response;
    }

    setConnection(event: CodexConnectionEvent): void {
        this.connection = event;
        this.inner?.setConnection(event);
    }

    async activate(snapshot: Thread): Promise<void> {
        await this.operationLock.inLock(async () => {
            this.latestSnapshot = snapshot;
            if (this.inner) await this.inner.activate(snapshot);
            else await this.options.journal.enqueueSnapshotRequired(this.options.threadId);
        });
    }

    async reconcile(snapshot: Thread): Promise<void> {
        await this.operationLock.inLock(async () => {
            this.latestSnapshot = snapshot;
            if (this.inner) await this.inner.reconcile(snapshot);
            else await this.options.journal.enqueueSnapshotRequired(this.options.threadId);
        });
    }

    async updateBinding(binding: CodexGatewayRuntimeBinding): Promise<void> {
        await this.operationLock.inLock(async () => {
            this.binding = binding;
            await this.inner?.updateBinding(binding);
        });
    }

    async setGatewayLifecycle(
        state: 'starting' | 'running' | 'recovering' | 'stopping' | 'stopped',
    ): Promise<void> {
        await this.operationLock.inLock(async () => {
            this.gatewayLifecycle = state;
            await this.inner?.setGatewayLifecycle(state);
        });
    }

    async setTerminalState(
        state: 'attached' | 'pendingDetach' | 'detached' | 'headless',
        detachedAt: number | null,
    ): Promise<void> {
        await this.operationLock.inLock(async () => {
            this.terminalState = state;
            this.terminalDetachedAt = detachedAt;
            await this.inner?.setTerminalState(state, detachedAt);
        });
    }

    ownsThread(threadId: string): boolean {
        return threadId === this.options.threadId || this.inner?.ownsThread(threadId) === true;
    }

    async isDrained(): Promise<boolean> {
        return this.inner ? await this.inner.isDrained() : false;
    }

    async flush(): Promise<void> {
        await this.operationLock.inLock(async () => {
            if (this.inner) {
                await this.replayLocked(this.inner);
                await this.inner.flush();
            }
        });
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.operationLock.inLock(async () => {
            await this.inner?.close();
            this.inner = null;
        });
        for (const pending of this.pendingRequests.values()) {
            for (const request of pending) request.resolve(null);
        }
        this.pendingRequests.clear();
    }

    private async replayLocked(runtime: CodexGatewayRootRuntime): Promise<void> {
        for (const entry of this.options.journal.pendingEntries(this.options.threadId)) {
            if (entry.kind === 'notification') {
                await runtime.handleNotification(entry.notification);
            } else {
                const snapshot = await this.options.readSnapshot();
                this.latestSnapshot = snapshot;
                await runtime.reconcile(snapshot);
            }
            await this.options.journal.completeEntry(entry.id);
        }
    }

    private releasePendingRequests(): void {
        const inner = this.inner;
        if (!inner) return;
        for (const pending of this.pendingRequests.values()) {
            for (const request of pending) {
                void inner.handleRequest(request.request).then(request.resolve, request.reject);
            }
        }
        this.pendingRequests.clear();
    }

    private resolvePendingRequest(requestId: string): void {
        const pending = this.pendingRequests.get(requestId);
        if (!pending) return;
        this.pendingRequests.delete(requestId);
        for (const request of pending) request.resolve(null);
    }

}
