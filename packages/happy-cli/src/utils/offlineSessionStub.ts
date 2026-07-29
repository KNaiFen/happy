import { EventEmitter } from 'node:events';
import type { AgentState, Metadata } from '@/api/types';
import type { ApiSessionClientContract } from '@/api/apiSession';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { logger } from '@/ui/logger';

type PendingOutboundOperation = (
    target: ApiSessionClientContract,
) => void | Promise<void>;

export type OfflineApiSessionClientController = ApiSessionClientContract & {
    attach(target: ApiSessionClientContract): Promise<void>;
    detach(target: ApiSessionClientContract): void;
};

class OfflineApiSessionClient
    extends EventEmitter
    implements ApiSessionClientContract {
    private static readonly MAX_PENDING_OUTBOUND = 100_000;

    readonly isOffline = true;
    readonly sessionId: string;
    readonly rpcHandlerManager: RpcHandlerManager;
    private metadata: Metadata | null;
    private agentState: AgentState | null;
    private target: ApiSessionClientContract | null = null;
    private userMessageCallback:
        Parameters<ApiSessionClientContract['onUserMessage']>[0] | null = null;
    private fileEventCallback:
        Parameters<ApiSessionClientContract['onFileEvent']>[0] | null = null;
    private pendingDownloads: Array<
        Promise<{ data: Uint8Array; mimeType: string; name: string } | null>
    > = [];
    private pendingOutbound: PendingOutboundOperation[] = [];
    private pendingOutboundHead = 0;
    private outboundDrain: Promise<void> | null = null;
    private eventForwarders = new Map<
        string | symbol,
        (...args: unknown[]) => void
    >();

    constructor(sessionTag: string, metadata: Metadata, agentState: AgentState) {
        super();
        this.sessionId = `offline-${sessionTag}`;
        this.metadata = metadata;
        this.agentState = agentState;
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'dataKey',
            logger: () => undefined,
        });
    }

    async attach(target: ApiSessionClientContract): Promise<void> {
        if (this.target && this.target !== target) {
            throw new Error('Offline session is already attached to another relay session');
        }
        this.target = target;
        try {
            if (this.userMessageCallback) target.onUserMessage(this.userMessageCallback);
            if (this.fileEventCallback) target.onFileEvent(this.fileEventCallback);
            for (const promise of this.pendingDownloads) {
                target.trackAttachmentDownload(promise);
            }
            this.rpcHandlerManager.copyHandlersTo(target.rpcHandlerManager);
            for (const eventName of this.eventNames()) {
                if (eventName === 'newListener' || eventName === 'removeListener') continue;
                const forward = (...args: unknown[]) => {
                    this.emit(eventName, ...args);
                };
                this.eventForwarders.set(eventName, forward);
                target.on(eventName, forward);
            }
            await this.drainOutbound();
        } catch (error) {
            this.detach(target);
            throw error;
        }
    }

    detach(target: ApiSessionClientContract): void {
        if (this.target !== target) return;
        for (const [eventName, forward] of this.eventForwarders) {
            target.off(eventName, forward);
        }
        this.eventForwarders.clear();
        this.target = null;
    }

    get syncV4SessionKey(): Uint8Array {
        if (this.target) return this.target.syncV4SessionKey;
        throw new Error('Sync v4 is unavailable while the Happy relay is offline');
    }

    readonly onUserMessage: ApiSessionClientContract['onUserMessage'] = (callback) => {
        this.userMessageCallback = callback;
        this.target?.onUserMessage(callback);
    };

    readonly onFileEvent: ApiSessionClientContract['onFileEvent'] = (callback) => {
        this.fileEventCallback = callback;
        this.target?.onFileEvent(callback);
    };

    readonly enableSyncV4: ApiSessionClientContract['enableSyncV4'] = async (
        createEntityHandler,
        diagnostics,
    ) => {
        if (this.target) {
            return await this.target.enableSyncV4(createEntityHandler, diagnostics);
        }
        throw new Error('Sync v4 is unavailable while the Happy relay is offline');
    };

    readonly getBlobKey: ApiSessionClientContract['getBlobKey'] = async () => {
        if (this.target) return await this.target.getBlobKey();
        throw new Error('Attachment encryption is unavailable while the Happy relay is offline');
    };

    readonly uploadLocalImageAttachmentEnvelope:
        ApiSessionClientContract['uploadLocalImageAttachmentEnvelope'] = async (
            attachment,
            options,
        ) => {
            if (this.target) {
                return await this.target.uploadLocalImageAttachmentEnvelope(
                    attachment,
                    options,
                );
            }
            throw new Error('Attachment upload is unavailable while the Happy relay is offline');
        };

    readonly downloadAttachment: ApiSessionClientContract['downloadAttachment'] = async (ref) => {
        if (this.target) return await this.target.downloadAttachment(ref);
        throw new Error('Attachment download is unavailable while the Happy relay is offline');
    };

    readonly downloadAndDecryptAttachment:
        ApiSessionClientContract['downloadAndDecryptAttachment'] = async (ref) => (
            this.target
                ? await this.target.downloadAndDecryptAttachment(ref)
                : null
        );

    readonly trackAttachmentDownload:
        ApiSessionClientContract['trackAttachmentDownload'] = (promise) => {
            if (this.target) {
                this.target.trackAttachmentDownload(promise);
                return;
            }
            this.pendingDownloads.push(promise);
        };

    readonly drainAttachmentsForUserMessage:
        ApiSessionClientContract['drainAttachmentsForUserMessage'] = async () => {
            if (this.target) {
                const results = await this.target.drainAttachmentsForUserMessage();
                this.pendingDownloads = [];
                return results;
            }
            const downloads = this.pendingDownloads;
            this.pendingDownloads = [];
            const results = await Promise.all(downloads);
            return results.filter(
                (result): result is { data: Uint8Array; mimeType: string; name: string } => (
                    result !== null
                ),
            );
        };

    readonly sendClaudeSessionMessage:
        ApiSessionClientContract['sendClaudeSessionMessage'] = (body) => {
            this.queueOutbound((target) => target.sendClaudeSessionMessage(body));
        };

    readonly sendClaudeSessionMessageFromLocalTranscript:
        ApiSessionClientContract['sendClaudeSessionMessageFromLocalTranscript'] = async (body) => {
            this.queueOutbound((target) => (
                target.sendClaudeSessionMessageFromLocalTranscript(body)
            ));
        };

    readonly closeClaudeSessionTurn:
        ApiSessionClientContract['closeClaudeSessionTurn'] = (status) => {
            this.queueOutbound((target) => target.closeClaudeSessionTurn(status));
        };

    readonly sendCodexMessage:
        ApiSessionClientContract['sendCodexMessage'] = (body) => {
            this.queueOutbound((target) => target.sendCodexMessage(body));
        };

    readonly sendSessionProtocolMessage:
        ApiSessionClientContract['sendSessionProtocolMessage'] = (envelope) => {
            this.queueOutbound((target) => target.sendSessionProtocolMessage(envelope));
        };

    readonly sendAgentMessage:
        ApiSessionClientContract['sendAgentMessage'] = (provider, body) => {
            this.queueOutbound((target) => target.sendAgentMessage(provider, body));
        };

    readonly sendSessionEvent:
        ApiSessionClientContract['sendSessionEvent'] = (event, id) => {
            this.queueOutbound((target) => target.sendSessionEvent(event, id));
        };

    readonly keepAlive:
        ApiSessionClientContract['keepAlive'] = (thinking, mode) => {
            this.target?.keepAlive(thinking, mode);
        };

    readonly sendSessionDeath:
        ApiSessionClientContract['sendSessionDeath'] = () => {
            this.queueOutbound((target) => target.sendSessionDeath());
        };

    readonly sendUsageData:
        ApiSessionClientContract['sendUsageData'] = (usage, model) => {
            this.queueOutbound((target) => target.sendUsageData(usage, model));
        };

    readonly getMetadata: ApiSessionClientContract['getMetadata'] = () => (
        this.target?.getMetadata() ?? this.metadata
    );

    readonly getAgentState: ApiSessionClientContract['getAgentState'] = () => (
        this.target?.getAgentState() ?? this.agentState
    );

    readonly suppressNextArchiveSignal:
        ApiSessionClientContract['suppressNextArchiveSignal'] = () => {
            this.target?.suppressNextArchiveSignal();
        };

    readonly skipExistingMessages:
        ApiSessionClientContract['skipExistingMessages'] = () => {
            this.target?.skipExistingMessages();
        };

    readonly updateMetadata: ApiSessionClientContract['updateMetadata'] = (handler) => {
        if (this.target) {
            this.target.updateMetadata(handler);
            return;
        }
        if (this.metadata) this.metadata = handler(this.metadata);
    };

    readonly updateAgentState: ApiSessionClientContract['updateAgentState'] = (handler) => {
        if (this.target) {
            this.target.updateAgentState(handler);
            return;
        }
        this.agentState = handler(this.agentState ?? {});
    };

    readonly flush: ApiSessionClientContract['flush'] = async () => {
        await this.drainOutbound();
        await this.target?.flush();
    };

    readonly close: ApiSessionClientContract['close'] = async () => {
        await this.drainOutbound();
        const target = this.target;
        await target?.close();
        if (target) this.detach(target);
        this.pendingDownloads = [];
        this.pendingOutbound = [];
        this.pendingOutboundHead = 0;
        this.rpcHandlerManager.clearHandlers();
        this.removeAllListeners();
    };

    private queueOutbound(operation: PendingOutboundOperation): void {
        const pendingCount = this.pendingOutbound.length - this.pendingOutboundHead;
        if (pendingCount >= OfflineApiSessionClient.MAX_PENDING_OUTBOUND) {
            throw new Error('Offline session outbound buffer is full');
        }
        this.pendingOutbound.push(operation);
        if (this.target) {
            // Void send methods cannot surface an asynchronous transport failure.
            // The drain keeps the failed head so flush or a later attach can retry it.
            void this.drainOutbound().catch(() => undefined);
        }
    }

    private async drainOutbound(): Promise<void> {
        if (this.outboundDrain) return await this.outboundDrain;
        const drain = (async () => {
            while (
                this.target
                && this.pendingOutboundHead < this.pendingOutbound.length
            ) {
                const target = this.target;
                const operation = this.pendingOutbound[this.pendingOutboundHead];
                try {
                    await operation(target);
                    this.pendingOutboundHead += 1;
                } catch (error) {
                    logger.debug('[OFFLINE SESSION] Deferred outbound replay failed', {
                        errorKind: error instanceof Error ? error.name : typeof error,
                    });
                    throw new Error('Deferred offline session output could not be replayed');
                }
            }
        })();
        this.outboundDrain = drain;
        try {
            await drain;
        } finally {
            if (this.outboundDrain === drain) this.outboundDrain = null;
            this.compactPendingOutbound();
        }
    }

    private compactPendingOutbound(): void {
        if (this.pendingOutboundHead === 0) return;
        if (this.pendingOutboundHead === this.pendingOutbound.length) {
            this.pendingOutbound = [];
            this.pendingOutboundHead = 0;
            return;
        }
        if (
            this.pendingOutboundHead >= 1_024
            || this.pendingOutboundHead * 2 >= this.pendingOutbound.length
        ) {
            this.pendingOutbound = this.pendingOutbound.slice(this.pendingOutboundHead);
            this.pendingOutboundHead = 0;
        }
    }
}

export function createOfflineSessionStub(
    sessionTag: string,
    metadata: Metadata,
    agentState: AgentState,
): OfflineApiSessionClientController {
    return new OfflineApiSessionClient(sessionTag, metadata, agentState);
}
