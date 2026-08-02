import type { ApiSessionClientContract } from '@/api/apiSession';
import type { Metadata } from '@/api/types';
import type {
    CodexConnectionEvent,
    CodexManagedServerResponse,
    CodexServerRequest,
} from '../codexAppServerClient';
import type {
    CodexGatewayRuntimeProjection,
    CodexTerminalRuntimeProjection,
} from '../codexSyncV4Mapper';
import type { CodexV4SessionBinding, CodexV4ThreadRouter } from '../codexV4ThreadRouter';
import type { ServerNotification, Thread } from '../protocol';
import type {
    CodexGatewayBindingRole,
    CodexGatewayRootRuntime,
    CodexGatewayRuntimeBinding,
} from './codexGatewayCoordinator';

export type CodexGatewayLifecycleState = CodexGatewayRuntimeProjection['state'];
export type CodexGatewayTerminalState = CodexTerminalRuntimeProjection['state'];

export interface CodexGatewaySyncRuntimeOptions {
    gatewayId: string;
    origin: 'terminal' | 'app';
    rootThreadId: string;
    initialBinding: CodexGatewayRuntimeBinding;
    initialGatewayState: CodexGatewayLifecycleState;
    initialTerminalState: CodexGatewayTerminalState;
    initialTerminalDetachedAt?: number | null;
    session: ApiSessionClientContract;
    rootBinding: CodexV4SessionBinding;
    router: CodexV4ThreadRouter;
    archiveSession(sessionId: string): Promise<boolean>;
    now?: () => number;
}

export class CodexGatewaySyncRuntime implements CodexGatewayRootRuntime {
    readonly sessionId: string;
    private binding: CodexGatewayRuntimeBinding;
    private gatewayState: CodexGatewayLifecycleState;
    private terminalState: CodexGatewayTerminalState;
    private terminalDetachedAt: number | null;
    private closed = false;
    private closePromise: Promise<void> | null = null;

    constructor(private readonly options: CodexGatewaySyncRuntimeOptions) {
        this.sessionId = options.session.sessionId;
        this.binding = { ...options.initialBinding };
        this.gatewayState = options.initialGatewayState;
        this.terminalState = options.initialTerminalState;
        this.terminalDetachedAt = options.initialTerminalDetachedAt ?? null;
    }

    async handleNotification(notification: ServerNotification): Promise<void> {
        this.assertOpen();
        await this.options.router.handleNotificationAsync(notification);
    }

    async handleRequest(request: CodexServerRequest): Promise<CodexManagedServerResponse> {
        this.assertOpen();
        return await this.options.router.handleRequest(request);
    }

    setConnection(event: CodexConnectionEvent): void {
        if (this.closed) return;
        this.options.router.setConnection(event);
    }

    async activate(snapshot: Thread): Promise<void> {
        this.assertOpen();
        await this.options.router.registerRootThread(this.options.rootThreadId);
        await this.options.router.migrateRootSnapshot(this.options.rootThreadId, snapshot);
        await this.options.rootBinding.recover();
        await this.options.router.recoverPendingNotifications();
        await this.options.router.recoverActiveThreads();
        await this.updateThreadMetadata(snapshot);
    }

    async reconcile(snapshot: Thread): Promise<void> {
        this.assertOpen();
        await this.options.router.registerRootThread(this.options.rootThreadId);
        await this.options.router.migrateRootSnapshot(this.options.rootThreadId, snapshot);
        await this.options.rootBinding.recover();
        await this.options.router.recoverPendingNotifications();
        await this.options.router.recoverActiveThreads();
        await this.updateThreadMetadata(snapshot);
    }

    async updateBinding(binding: CodexGatewayRuntimeBinding): Promise<void> {
        this.assertOpen();
        const next = { ...binding };
        await this.options.session.updateMetadataAndWait((metadata) => this.bindingMetadata(metadata, next));
        await this.options.rootBinding.mapper.setGatewayState({
            gateway: this.gatewayProjection(next),
            terminal: this.terminalProjection(),
        });
        await this.options.rootBinding.mapper.flush();
        await this.options.rootBinding.syncClient.flushOutboundOnce();
        if (next.role === 'inactive') {
            const archived = await this.options.archiveSession(this.sessionId);
            if (!archived) throw new Error('Codex Gateway session archive is pending relay recovery');
        }
        this.binding = next;
    }

    async setGatewayLifecycle(state: CodexGatewayLifecycleState): Promise<void> {
        this.assertOpen();
        await this.options.rootBinding.mapper.setGatewayState({
            gateway: this.gatewayProjection(this.binding, state),
        });
        await this.options.rootBinding.mapper.flush();
        await this.options.rootBinding.syncClient.flushOutboundOnce();
        this.gatewayState = state;
    }

    async setTerminalState(
        state: CodexGatewayTerminalState,
        detachedAt: number | null,
    ): Promise<void> {
        this.assertOpen();
        const previousState = this.terminalState;
        const previousDetachedAt = this.terminalDetachedAt;
        this.terminalState = state;
        this.terminalDetachedAt = detachedAt;
        try {
            await this.options.session.updateMetadataAndWait((metadata) => (
                this.bindingMetadata(metadata, this.binding)
            ));
            await this.options.rootBinding.mapper.setGatewayState({
                terminal: this.terminalProjection(),
            });
            await this.options.rootBinding.mapper.flush();
            await this.options.rootBinding.syncClient.flushOutboundOnce();
        } catch (error) {
            this.terminalState = previousState;
            this.terminalDetachedAt = previousDetachedAt;
            throw error;
        }
    }

    ownsThread(threadId: string): boolean {
        return threadId === this.options.rootThreadId || this.options.router.ownsThread(threadId);
    }

    async isDrained(): Promise<boolean> {
        if (this.options.router.hasActiveChildWork()) return false;
        if (this.options.rootBinding.commandProcessor.hasPendingWork()) return false;
        if (this.options.rootBinding.requestBroker.pendingCount() > 0) return false;
        if (this.options.rootBinding.syncClient.hasPendingOutbound()) return false;
        return this.options.rootBinding.syncClient.getPendingProviderRequests().length === 0;
    }

    async flush(): Promise<void> {
        if (this.closed) return;
        await this.options.rootBinding.commandProcessor.flush();
        await this.options.router.flush();
        await this.options.rootBinding.mapper.flush();
        await this.options.rootBinding.syncClient.flushOutboundOnce();
    }

    close(): Promise<void> {
        if (!this.closePromise) this.closePromise = this.closeOnce();
        return this.closePromise;
    }

    private async closeOnce(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        let firstError: unknown = null;
        try {
            await this.options.router.close();
        } catch (error) {
            firstError = error;
        }
        try {
            await this.options.rootBinding.close();
        } catch (error) {
            if (firstError === null) firstError = error;
        }
        if (firstError !== null) throw firstError;
    }

    private async updateThreadMetadata(snapshot: Thread): Promise<void> {
        const title = safeThreadTitle(snapshot);
        await this.options.session.updateMetadataAndWait((metadata) => ({
            ...metadata,
            path: snapshot.cwd || metadata.path,
            codexThreadId: this.options.rootThreadId,
            ...(title ? { name: title } : {}),
        }));
    }

    private bindingMetadata(
        metadata: Metadata,
        binding: CodexGatewayRuntimeBinding,
    ): Metadata {
        return {
            ...metadata,
            codexThreadId: this.options.rootThreadId,
            codexSyncVersion: 4,
            codexGatewayBinding: {
                gatewayId: this.options.gatewayId,
                generation: binding.generation,
                origin: this.options.origin,
                role: binding.role,
                terminal: this.terminalState === 'attached' ? 'attached' : 'unattached',
                ...(binding.previousSessionId
                    ? { previousSessionId: binding.previousSessionId }
                    : {}),
                ...(binding.nextSessionId ? { nextSessionId: binding.nextSessionId } : {}),
                changedAt: binding.changedAt,
            },
        };
    }

    private gatewayProjection(
        binding: CodexGatewayRuntimeBinding,
        state = this.gatewayState,
    ): CodexGatewayRuntimeProjection {
        return {
            gatewayId: this.options.gatewayId,
            generation: binding.generation,
            origin: this.options.origin,
            role: binding.role,
            state: binding.role === 'inactive' ? 'stopped' : state,
        };
    }

    private terminalProjection(): CodexTerminalRuntimeProjection {
        return {
            state: this.terminalState,
            detachedAt: this.terminalState === 'detached' ? this.terminalDetachedAt : null,
        };
    }

    private assertOpen(): void {
        if (this.closed) throw new Error('Codex Gateway Sync runtime is closed');
    }
}

function safeThreadTitle(thread: Thread): string | null {
    const title = thread.name?.trim() || thread.preview?.trim();
    if (!title) return null;
    return [...title].slice(0, 200).join('');
}
