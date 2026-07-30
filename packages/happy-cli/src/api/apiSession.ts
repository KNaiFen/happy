import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, FileEventMessage, FileEventMessageSchema, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { decodeBase64, decryptBlob, decrypt, encodeBase64, encrypt, encryptBlob } from './encryption';
import { backoff, delay } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { deriveKey } from '@/utils/deriveKey';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { calculateCost } from '@/utils/pricing';
import { shouldReconnect } from '@/utils/lidState';
import {
    classifySyncV4DiagnosticError,
    createEnvelope,
    SyncInvalidationV4Schema,
    type CreateEnvelopeOptions,
    type SessionEnvelope,
    type SessionTurnEndStatus,
    type SyncV4DiagnosticSink,
} from '@slopus/happy-wire';
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
    type ClaudeSessionProtocolState,
} from '@/claude/utils/sessionProtocolMapper';
import { InvalidateSync } from '@/utils/sync';
import axios from 'axios';
import { SyncV4Client, type SyncV4AppliedEntity } from './syncV4Client';
import { syncV4DiagnosticHash } from './syncV4Diagnostics';

function socketUpdateDiagnostics(data: unknown): {
    updateType: 'new-message' | 'update-session' | 'update-machine' | 'unknown';
    updateSeq?: number;
    messageSeq?: number;
    metadataVersion?: number;
    agentStateVersion?: number;
} {
    try {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return { updateType: 'unknown' };
        }
        const update = data as Record<string, unknown>;
        const body = update.body && typeof update.body === 'object' && !Array.isArray(update.body)
            ? update.body as Record<string, unknown>
            : {};
        const rawType = body.t;
        const updateType = rawType === 'new-message'
            || rawType === 'update-session'
            || rawType === 'update-machine'
            ? rawType
            : 'unknown';
        const message = body.message && typeof body.message === 'object' && !Array.isArray(body.message)
            ? body.message as Record<string, unknown>
            : {};
        const updateSeq = update.seq;
        const messageSeq = message.seq;
        const metadataVersion = readVersion(body.metadata);
        const agentStateVersion = readVersion(body.agentState);
        return {
            updateType,
            ...(Number.isSafeInteger(updateSeq) && (updateSeq as number) >= 0
                ? { updateSeq: updateSeq as number }
                : {}),
            ...(Number.isSafeInteger(messageSeq) && (messageSeq as number) >= 0
                ? { messageSeq: messageSeq as number }
                : {}),
            ...(metadataVersion !== undefined
                ? { metadataVersion }
                : {}),
            ...(agentStateVersion !== undefined
                ? { agentStateVersion }
                : {}),
        };
    } catch {
        return { updateType: 'unknown' };
    }
}

function readVersion(value: unknown): number | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    try {
        const version = (value as Record<string, unknown>).version;
        return Number.isSafeInteger(version) && (version as number) >= 0
            ? version as number
            : undefined;
    } catch {
        return undefined;
    }
}

function parseSyncV4Invalidation(value: unknown): {
    sessionId: string;
    highWatermark: number;
} | null {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const event = value as Record<string, unknown>;
        if (event.type !== 'sync-v4-invalidate') return null;
        const parsed = SyncInvalidationV4Schema.safeParse({
            sessionId: event.sessionId,
            highWatermark: event.highWatermark,
        });
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function agentStateDiagnostics(state: unknown): {
    hasState: boolean;
    pendingRequests?: number;
    completedRequests?: number;
    controlledByUser?: boolean;
} {
    try {
        if (!state || typeof state !== 'object' || Array.isArray(state)) {
            return { hasState: false };
        }
        const record = state as Record<string, unknown>;
        const controlledByUser = record.controlledByUser;
        const pendingRequests = boundedRecordSize(record.requests);
        const completedRequests = boundedRecordSize(record.completedRequests);
        return {
            hasState: true,
            ...(typeof controlledByUser === 'boolean'
                ? { controlledByUser }
                : {}),
            ...(pendingRequests !== undefined
                ? { pendingRequests }
                : {}),
            ...(completedRequests !== undefined
                ? { completedRequests }
                : {}),
        };
    } catch {
        return { hasState: true };
    }
}

function boundedRecordSize(value: unknown, limit = 10_000): number | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        let count = 0;
        for (const key in value as Record<string, unknown>) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            count += 1;
            if (count >= limit) return limit;
        }
        return count;
    } catch {
        return undefined;
    }
}

/**
 * ACP (Agent Communication Protocol) message data types.
 * This is the unified format for all agent messages - CLI adapts each provider's format to ACP.
 */
export type ACPMessageData =
    // Core message types
    | { type: 'message'; message: string }
    | { type: 'reasoning'; message: string }
    | { type: 'thinking'; text: string }
    // Tool interactions
    | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string }
    | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean }
    // File operations
    | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
    // Terminal/command output
    | { type: 'terminal-output'; data: string; callId: string }
    // Task lifecycle events
    | { type: 'task_started'; id: string }
    | { type: 'task_complete'; id: string }
    | { type: 'turn_aborted'; id: string }
    // Permissions
    | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
    // Usage/metrics
    | { type: 'token_count';[key: string]: unknown };

export type ACPProvider = 'gemini' | 'codex' | 'claude' | 'opencode';

type V3SessionMessage = {
    id: string;
    seq: number;
    content: { t: 'encrypted'; c: string };
    localId: string | null;
    createdAt: number;
    updatedAt: number;
};

type V3GetSessionMessagesResponse = {
    messages: V3SessionMessage[];
    hasMore: boolean;
};

type V3PostSessionMessagesResponse = {
    messages: Array<{
        id: string;
        seq: number;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }>;
};

type AttachmentUploadResult = {
    ref: string;
    uploadUrl: string;
    method?: 'PUT' | 'POST';
    formFields?: Record<string, string>;
};

export type LocalImageAttachment = {
    data: Uint8Array;
    mimeType: string;
    name: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function extensionForImageMime(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case 'image/jpeg':
        case 'image/jpg':
            return 'jpg';
        case 'image/gif':
            return 'gif';
        case 'image/webp':
            return 'webp';
        case 'image/png':
        default:
            return 'png';
    }
}

function extractLocalTranscriptImageAttachments(body: RawJSONLines): LocalImageAttachment[] {
    if (body.type !== 'user' || body.isMeta || body.isSidechain) {
        return [];
    }

    const content = (body as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) {
        return [];
    }

    // Tool results are user-role messages from Claude's protocol, but they
    // represent agent tool lifecycle, not human multimodal input.
    if (content.some((block) => isRecord(block) && block.type === 'tool_result')) {
        return [];
    }

    const attachments: LocalImageAttachment[] = [];
    for (const block of content) {
        if (!isRecord(block) || block.type !== 'image') {
            continue;
        }
        const source = block.source;
        if (!isRecord(source) || source.type !== 'base64' || typeof source.data !== 'string') {
            continue;
        }

        const data = decodeBase64(source.data);
        if (data.length === 0) {
            continue;
        }

        const mimeType = typeof source.media_type === 'string' && source.media_type.startsWith('image/')
            ? source.media_type
            : 'image/png';
        const index = attachments.length + 1;
        attachments.push({
            data,
            mimeType,
            name: `claude-image-${index}.${extensionForImageMime(mimeType)}`,
        });
    }

    return attachments;
}

function escapeMultipartValue(value: string): string {
    return value.replaceAll('\r', '').replaceAll('\n', '').replaceAll('"', '%22');
}

function buildMultipartUploadBody(
    fields: Record<string, string> | undefined,
    data: Uint8Array,
): { body: Buffer; boundary: string } {
    const boundary = `----happy-cli-${randomUUID()}`;
    const chunks: Buffer[] = [];

    for (const [key, value] of Object.entries(fields ?? {})) {
        chunks.push(Buffer.from(
            `--${boundary}\r\n`
            + `Content-Disposition: form-data; name="${escapeMultipartValue(key)}"\r\n\r\n`
            + `${value}\r\n`,
            'utf8',
        ));
    }

    chunks.push(Buffer.from(
        `--${boundary}\r\n`
        + 'Content-Disposition: form-data; name="file"; filename="blob"\r\n'
        + 'Content-Type: application/octet-stream\r\n\r\n',
        'utf8',
    ));
    chunks.push(Buffer.from(data));
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

    return {
        body: Buffer.concat(chunks),
        boundary,
    };
}

export class ApiSessionClient extends EventEmitter {
    readonly isOffline: boolean = false;
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    private pendingFileEvents: FileEventMessage[] = [];
    private pendingFileEventCallback: ((data: FileEventMessage) => void) | null = null;
    private blobKey: Uint8Array | null = null;
    /**
     * In-flight attachment download promises that belong to the *current*
     * (not-yet-drained) batch. Each promise resolves to the decoded blob (or
     * null on failure), so per-message ownership is intrinsic — there is no
     * shared push-array between batches that a late download could leak into.
     */
    private pendingDownloads: Promise<{ data: Uint8Array; mimeType: string; name: string } | null>[] = [];
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private reconnectInterval: NodeJS.Timeout | null = null;
    private ignoreArchiveSignal = false;
    private skipInitialMessages = false;
    private claudeSessionProtocolState: ClaudeSessionProtocolState = {
        currentTurnId: null,
        uuidToProviderSubagent: new Map<string, string>(),
        taskPromptToSubagents: new Map<string, string[]>(),
        providerSubagentToSessionSubagent: new Map<string, string>(),
        subagentTitles: new Map<string, string>(),
        bufferedSubagentMessages: new Map<string, RawJSONLines[]>(),
        hiddenParentToolCalls: new Set<string>(),
        startedSubagents: new Set<string>(),
        activeSubagents: new Set<string>(),
    };
    private lastSeq = 0;
    private pendingOutbox: Array<{ content: string; localId: string }> = [];
    private readonly sendSync: InvalidateSync;
    private readonly receiveSync: InvalidateSync;
    private syncV4Client: SyncV4Client | null = null;
    private syncV4InitializingClient: SyncV4Client | null = null;
    private syncV4EnablePromise: Promise<SyncV4Client> | null = null;
    private syncV4LifecycleGeneration = 0;
    private closed = false;

    constructor(token: string, session: Session) {
        super()
        this.token = token;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;
        this.sendSync = new InvalidateSync(() => this.flushOutbox());
        this.receiveSync = new InvalidateSync(() => this.fetchMessages());

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            logger: (_message, data) => logger.debug('[RPC] Session handler event', {
                hasData: data !== undefined,
            })
        });
        registerCommonHandlers(this.rpcHandlerManager, this.metadata.path);

        //
        // Create socket
        //

        this.socket = io(configuration.serverUrl, {
            auth: {
                token: this.token,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId,
                machineId: this.metadata.machineId,
                happyClient: `cli-coding-session/${configuration.currentCliVersion}`
            },
            path: '/v1/updates',
            reconnection: false,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false
        });

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully');
            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }
            this.rpcHandlerManager.onSocketConnect(this.socket);
            this.receiveSync.invalidate();
            this.syncV4Client?.invalidate();
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug(`[API] Socket disconnected: ${reason}`);
            this.rpcHandlerManager.onSocketDisconnect();
            this.startSmartReconnect();
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error', {
                errorKind: classifySyncV4DiagnosticError(error),
            });
            this.rpcHandlerManager.onSocketDisconnect();
            this.startSmartReconnect();
        })

        // Server events
        this.socket.on('update', (data: Update) => {
            try {
                logger.debug('[SOCKET] Update received', socketUpdateDiagnostics(data));

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (data.body.t === 'new-message') {
                    const messageSeq = data.body.message?.seq;
                    if (typeof messageSeq !== 'number' || messageSeq !== this.lastSeq + 1 || data.body.message.content.t !== 'encrypted') {
                        this.receiveSync.invalidate();
                        return;
                    }
                    const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.message.content.c));
                    logger.debug('[SOCKET] [UPDATE] Message decrypted');
                    this.routeIncomingMessage(body);
                    this.lastSeq = messageSeq;
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
                        this.metadataVersion = data.body.metadata.version;
                        // Check if session was archived from web/mobile
                        const meta = this.metadata as any;
                        if (meta?.lifecycleState === 'archiveRequested' || meta?.lifecycleState === 'archived') {
                            if (this.ignoreArchiveSignal) {
                                logger.debug(`[SOCKET] Session archived (${meta.lifecycleState}) but suppressed for reconnect`);
                                this.ignoreArchiveSignal = false;
                            } else {
                                logger.debug(`[SOCKET] Session archived (${meta.lifecycleState}), exiting...`);
                                this.emit('archived');
                            }
                        }
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        this.agentState = data.body.agentState.value ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.agentState.value)) : null;
                        this.agentStateVersion = data.body.agentState.version;
                    }
                } else if (data.body.t === 'update-machine') {
                    // Session clients shouldn't receive machine updates - log warning
                    logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`);
                } else {
                    // If not a user message, it might be a permission response or other message type
                    this.emit('message', data.body);
                }
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', {
                    errorKind: classifySyncV4DiagnosticError(error),
                });
            }
        });

        this.socket.on('ephemeral', (data) => {
            const invalidation = parseSyncV4Invalidation(data);
            if (invalidation?.sessionId === this.sessionId) {
                this.syncV4Client?.invalidate(invalidation.highWatermark);
            }
        });

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error', {
                errorKind: classifySyncV4DiagnosticError(error),
            });
        });

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect();
    }

    get syncV4SessionKey(): Uint8Array {
        return new Uint8Array(this.encryptionKey);
    }

    onUserMessage(callback: (data: UserMessage) => void) {
        this.pendingMessageCallback = callback;
        while (this.pendingMessages.length > 0) {
            callback(this.pendingMessages.shift()!);
        }
    }

    onFileEvent(callback: (data: FileEventMessage) => void) {
        this.pendingFileEventCallback = callback;
        while (this.pendingFileEvents.length > 0) {
            callback(this.pendingFileEvents.shift()!);
        }
    }

    async enableSyncV4(
        createEntityHandler: (client: SyncV4Client) => (event: SyncV4AppliedEntity) => Promise<void>,
        diagnostics?: SyncV4DiagnosticSink,
    ): Promise<SyncV4Client> {
        if (this.closed) throw new Error('API session has been closed');
        if (this.syncV4Client) return this.syncV4Client;
        if (this.syncV4EnablePromise) return await this.syncV4EnablePromise;
        const generation = this.syncV4LifecycleGeneration;
        const initialization = (async (): Promise<SyncV4Client> => {
            let client: SyncV4Client | null = null;
            let onEntity: ((event: SyncV4AppliedEntity) => Promise<void>) | null = null;
            const assertCurrent = (): void => {
                if (this.closed || generation !== this.syncV4LifecycleGeneration) {
                    throw new Error('API session has been closed');
                }
            };
            try {
                const machineId = this.metadata?.machineId;
                if (!machineId) {
                    throw new Error('Codex Sync v4 requires a machine identity');
                }
                client = await SyncV4Client.create({
                    sessionId: this.sessionId,
                    sessionKey: this.encryptionKey,
                    token: this.token,
                    machineId,
                    diagnostics,
                    onEntity: async (event) => {
                        assertCurrent();
                        if (!onEntity) throw new Error('Sync v4 entity handler was not initialized');
                        await onEntity(event);
                    },
                });
                assertCurrent();
                this.syncV4InitializingClient = client;
                onEntity = createEntityHandler(client);
                assertCurrent();
                await client.start();
                assertCurrent();
                this.syncV4InitializingClient = null;
                this.syncV4Client = client;
                return client;
            } catch (error) {
                if (client) await client.close();
                if (this.syncV4InitializingClient === client) this.syncV4InitializingClient = null;
                if (this.syncV4Client === client) this.syncV4Client = null;
                throw error;
            }
        })();
        this.syncV4EnablePromise = initialization;
        try {
            return await initialization;
        } finally {
            if (this.syncV4EnablePromise === initialization) this.syncV4EnablePromise = null;
        }
    }

    /**
     * Derive (and cache) the blob decryption key for this session.
     * Legacy sessions use deriveKey(masterSecret, 'Happy Blobs', ['master']).
     * DataKey sessions use deriveKey(dataKey, 'Happy Blobs', ['session']).
     */
    async getBlobKey(): Promise<Uint8Array> {
        if (!this.blobKey) {
            const path = this.encryptionVariant === 'dataKey' ? ['session'] : ['master'];
            this.blobKey = await deriveKey(this.encryptionKey, 'Happy Blobs', path);
        }
        return this.blobKey;
    }

    private async requestAttachmentUpload(filename: string, size: number): Promise<AttachmentUploadResult> {
        const response = await axios.post<AttachmentUploadResult>(
            `${configuration.serverUrl}/v1/sessions/${encodeURIComponent(this.sessionId)}/attachments/request-upload`,
            { filename, size },
            {
                headers: this.authHeaders(),
                timeout: 30000,
            },
        );

        const upload = response.data;
        if (
            !upload
            || typeof upload.ref !== 'string'
            || typeof upload.uploadUrl !== 'string'
            || (upload.method !== undefined && upload.method !== 'PUT' && upload.method !== 'POST')
        ) {
            throw new Error('request-upload returned an invalid response');
        }

        return {
            ...upload,
            method: upload.method ?? 'PUT',
        };
    }

    private async uploadEncryptedAttachmentBlob(upload: AttachmentUploadResult, encrypted: Uint8Array): Promise<void> {
        if (upload.method === 'POST') {
            const { body, boundary } = buildMultipartUploadBody(upload.formFields, encrypted);
            await axios.post(upload.uploadUrl, body, {
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                },
                timeout: 60000,
                maxBodyLength: 10 * 1024 * 1024,
            });
            return;
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/octet-stream',
        };
        if (hasSameOrigin(upload.uploadUrl, configuration.serverUrl)) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        await axios.put(upload.uploadUrl, Buffer.from(encrypted), {
            headers,
            timeout: 60000,
            maxBodyLength: 10 * 1024 * 1024,
        });
    }

    async uploadLocalImageAttachmentEnvelope(
        attachment: LocalImageAttachment,
        opts: Pick<CreateEnvelopeOptions, 'id' | 'time' | 'claudeUuid' | 'codexItemId'> = {},
    ): Promise<SessionEnvelope> {
        const blobKey = await this.getBlobKey();
        const encrypted = encryptBlob(attachment.data, blobKey);
        const upload = await this.requestAttachmentUpload(attachment.name, encrypted.length);
        await this.uploadEncryptedAttachmentBlob(upload, encrypted);

        return createEnvelope('user', {
            t: 'file',
            ref: upload.ref,
            name: attachment.name,
            size: attachment.data.length,
            mimeType: attachment.mimeType,
        }, opts);
    }

    /**
     * Download an encrypted attachment blob via the request-download flow:
     * POST /request-download → { downloadUrl } → GET downloadUrl. Local mode
     * downloadUrl points back at our server (Bearer required); S3 mode is a
     * presigned URL that does not accept extra headers.
     */
    async downloadAttachment(ref: string): Promise<Uint8Array> {
        const requestUrl = `${configuration.serverUrl}/v1/sessions/${this.sessionId}/attachments/request-download`;
        const requestRes = await axios.post(
            requestUrl,
            { ref },
            {
                headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
                timeout: 30000,
            },
        );
        const downloadUrl = requestRes.data?.downloadUrl;
        if (typeof downloadUrl !== 'string') {
            throw new Error('request-download returned no downloadUrl');
        }

        const isServerUrl = hasSameOrigin(downloadUrl, configuration.serverUrl);
        const headers: Record<string, string> = {};
        if (isServerUrl) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        const response = await axios.get(downloadUrl, {
            headers,
            responseType: 'arraybuffer',
            timeout: 60000,
            maxRedirects: 5,
            maxContentLength: 10 * 1024 * 1024,
        });
        return new Uint8Array(response.data);
    }

    /**
     * Download and decrypt an attachment blob.
     * Returns the decrypted binary data or null if decryption fails.
     */
    async downloadAndDecryptAttachment(ref: string): Promise<Uint8Array | null> {
        const encrypted = await this.downloadAttachment(ref);
        const key = await this.getBlobKey();
        const decrypted = decryptBlob(encrypted, key);
        return decrypted;
    }

    /**
     * Track an attachment download whose promise resolves to the decoded blob
     * (or null on failure). The download stays in the current batch until the
     * next drainAttachmentsForUserMessage call swaps the bucket out — file
     * events that arrive after the swap go into a fresh bucket bound to the
     * next user-text message.
     */
    trackAttachmentDownload(promise: Promise<{ data: Uint8Array; mimeType: string; name: string } | null>): void {
        this.pendingDownloads.push(promise);
    }

    /**
     * Atomically claim every download started before this call, wait for them
     * to resolve, and return the successful ones. The swap-then-await order
     * guarantees that a late-arriving file event cannot leak into this batch.
     */
    async drainAttachmentsForUserMessage(): Promise<Array<{ data: Uint8Array; mimeType: string; name: string }>> {
        const downloads = this.pendingDownloads;
        this.pendingDownloads = [];
        if (downloads.length === 0) return [];
        const results = await Promise.all(downloads);
        return results.filter((x): x is { data: Uint8Array; mimeType: string; name: string } => x !== null);
    }

    private authHeaders() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
        };
    }

    private routeIncomingMessage(message: unknown) {
        const userResult = UserMessageSchema.safeParse(message);
        if (userResult.success) {
            if (this.pendingMessageCallback) {
                this.pendingMessageCallback(userResult.data);
            } else {
                this.pendingMessages.push(userResult.data);
            }
            return;
        }

        // Check for file events (image attachments from app)
        const fileResult = FileEventMessageSchema.safeParse(message);
        if (fileResult.success) {
            const ev = fileResult.data.content.data.ev;
            logger.debug('[API] Received file event', {
                size: ev.size,
                hasMimeType: Boolean(ev.mimeType),
            });
            if (this.pendingFileEventCallback) {
                this.pendingFileEventCallback(fileResult.data);
            } else {
                this.pendingFileEvents.push(fileResult.data);
            }
            return;
        }

        this.emit('message', message);
    }

    private async fetchMessages() {
        // On reconnect, skip processing existing messages — just advance lastSeq
        const skipRouting = this.skipInitialMessages;
        if (skipRouting) {
            this.skipInitialMessages = false;
            logger.debug('[API] Reconnect mode: skipping existing messages, advancing lastSeq');
        }

        let afterSeq = this.lastSeq;
        while (true) {
            const response = await axios.get<V3GetSessionMessagesResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    params: {
                        after_seq: afterSeq,
                        limit: 100
                    },
                    headers: this.authHeaders(),
                    timeout: 60000
                }
            );

            const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
            let maxSeq = afterSeq;

            for (const message of messages) {
                if (message.seq > maxSeq) {
                    maxSeq = message.seq;
                }

                if (skipRouting) continue;

                if (message.content?.t !== 'encrypted') {
                    continue;
                }

                try {
                    const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(message.content.c));
                    this.routeIncomingMessage(body);
                } catch (error) {
                    logger.debug('[API] Failed to decrypt fetched message', {
                        seq: message.seq,
                        errorKind: classifySyncV4DiagnosticError(error),
                    });
                }
            }

            this.lastSeq = Math.max(this.lastSeq, maxSeq);
            const hasMore = !!response.data.hasMore;
            if (hasMore && maxSeq === afterSeq) {
                logger.debug('[API] fetchMessages pagination stalled, stopping to avoid infinite loop', {
                    sessionHash: syncV4DiagnosticHash(this.sessionId),
                    afterSeq
                });
                break;
            }
            afterSeq = maxSeq;
            if (!hasMore) {
                break;
            }
        }
    }

    private static readonly MAX_OUTBOX_BATCH_SIZE = 50;

    private async flushOutbox() {
        // Send latest messages first so the user sees recent activity immediately,
        // then backfill older messages in subsequent batches.
        while (this.pendingOutbox.length > 0) {
            const batchSize = Math.min(this.pendingOutbox.length, ApiSessionClient.MAX_OUTBOX_BATCH_SIZE);
            const batchStart = this.pendingOutbox.length - batchSize;
            const batch = this.pendingOutbox.slice(batchStart);

            const response = await axios.post<V3PostSessionMessagesResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    messages: batch
                },
                {
                    headers: this.authHeaders(),
                    timeout: 60000
                }
            );

            const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
            const maxSeq = messages.reduce((acc, message) => (
                message.seq > acc ? message.seq : acc
            ), this.lastSeq);
            this.lastSeq = maxSeq;
            this.pendingOutbox.splice(batchStart, batch.length);
        }
    }

    private enqueueMessage(content: unknown, invalidate: boolean = true) {
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.pendingOutbox.push({
            content: encrypted,
            localId: randomUUID()
        });
        if (invalidate) {
            this.sendSync.invalidate();
        }
    }

    private enqueueSessionProtocolEnvelopes(envelopes: SessionEnvelope[], invalidate: boolean = true) {
        for (let i = 0; i < envelopes.length; i += 1) {
            this.enqueueSessionProtocolEnvelope(envelopes[i], invalidate && i === envelopes.length - 1);
        }
    }

    private applyClaudeSessionMessageSideEffects(body: RawJSONLines) {
        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage, body.message.model);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data', {
                    errorKind: classifySyncV4DiagnosticError(error),
                });
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }));
        }
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
        const mapped = mapClaudeLogMessageToSessionEnvelopes(body, this.claudeSessionProtocolState);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(mapped.envelopes);
        this.applyClaudeSessionMessageSideEffects(body);
    }

    async sendClaudeSessionMessageFromLocalTranscript(body: RawJSONLines): Promise<void> {
        const attachments = extractLocalTranscriptImageAttachments(body);
        if (attachments.length === 0) {
            this.sendClaudeSessionMessage(body);
            return;
        }

        const closeMapped = closeClaudeTurnWithStatus(this.claudeSessionProtocolState, 'completed');
        this.claudeSessionProtocolState.currentTurnId = closeMapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(closeMapped.envelopes, false);

        const claudeUuid = typeof (body as { uuid?: unknown }).uuid === 'string'
            ? (body as { uuid: string }).uuid
            : undefined;
        for (const attachment of attachments) {
            try {
                const envelope = await this.uploadLocalImageAttachmentEnvelope(attachment, { claudeUuid });
                this.enqueueSessionProtocolEnvelope(envelope, false);
            } catch (error) {
                logger.debug('[API] Failed to upload local Claude transcript image attachment', {
                    byteLength: attachment.data.length,
                    errorKind: classifySyncV4DiagnosticError(error),
                });
            }
        }

        const mapped = mapClaudeLogMessageToSessionEnvelopes(body, this.claudeSessionProtocolState);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(mapped.envelopes, mapped.envelopes.length > 0);
        if (mapped.envelopes.length === 0) {
            this.sendSync.invalidate();
        }
        this.applyClaudeSessionMessageSideEffects(body);
    }

    closeClaudeSessionTurn(status: SessionTurnEndStatus = 'completed') {
        const mapped = closeClaudeTurnWithStatus(this.claudeSessionProtocolState, status);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(mapped.envelopes);
    }

    sendCodexMessage(body: any) {
        let content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body  // This wraps the entire Claude message
            },
            meta: {
                sentFrom: 'cli'
            }
        };
        this.enqueueMessage(content);
    }

    private enqueueSessionProtocolEnvelope(envelope: SessionEnvelope, invalidate: boolean = true) {
        const content = {
            role: 'session',
            content: envelope,
            meta: {
                sentFrom: 'cli'
            }
        };

        this.enqueueMessage(content, invalidate);
    }

    sendSessionProtocolMessage(envelope: SessionEnvelope) {
        if (envelope.role !== 'user') {
            this.enqueueSessionProtocolEnvelope(envelope);
            return;
        }

        if (envelope.ev.t !== 'text') {
            this.enqueueSessionProtocolEnvelope(envelope);
            return;
        }

        this.enqueueSessionProtocolEnvelope(envelope);
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(provider: 'gemini' | 'codex' | 'claude' | 'opencode' | 'openclaw', body: ACPMessageData) {
        let content = {
            role: 'agent',
            content: {
                type: 'acp',
                provider,
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        };

        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: body.type, hasMessage: 'message' in body });

        this.enqueueMessage(content);
    }

    sendSessionEvent(event: {
        type: 'switch', mode: 'local' | 'remote'
    } | {
        type: 'message', message: string
    } | {
        type: 'permission-mode-changed', mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    } | {
        type: 'ready'
    }, id?: string) {
        let content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };
        this.enqueueMessage(content);
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        });
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage, model?: string) {
        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        const costs = calculateCost(usage, model);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                total: costs.total,
                input: costs.input,
                output: costs.output
            }
        }
        logger.debug('[SOCKET] Sending usage data', {
            totalTokens,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
        });
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Returns the latest session metadata known to the client.
     */
    getMetadata(): Metadata | null {
        return this.metadata;
    }

    getAgentState(): AgentState | null {
        return this.agentState;
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    suppressNextArchiveSignal() {
        this.ignoreArchiveSignal = true;
    }

    skipExistingMessages() {
        this.skipInitialMessages = true;
    }

    updateMetadata(handler: (metadata: Metadata) => Metadata) {
        this.metadataLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.metadata!); // Weird state if metadata is null - should never happen but here we are
                const answer = await this.socket.emitWithAck('update-metadata', { sid: this.sessionId, expectedVersion: this.metadataVersion, metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) });
                if (answer.result === 'success') {
                    this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    }
                    throw new Error('Metadata version mismatch');
                } else if (answer.result === 'error') {
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState) {
        logger.debug('Updating agent state', {
            version: this.agentStateVersion,
            ...agentStateDiagnostics(this.agentState),
        });
        this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.agentState || {});
                const answer = await this.socket.emitWithAck('update-state', { sid: this.sessionId, expectedVersion: this.agentStateVersion, agentState: updated ? encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) : null });
                if (answer.result === 'success') {
                    this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    this.agentStateVersion = answer.version;
                    logger.debug('Agent state updated', {
                        version: this.agentStateVersion,
                        ...agentStateDiagnostics(this.agentState),
                    });
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        this.agentStateVersion = answer.version;
                        this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    }
                    throw new Error('Agent state version mismatch');
                } else if (answer.result === 'error') {
                    // console.error('Agent state update error', answer);
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        await Promise.race([
            this.sendSync.invalidateAndAwait(),
            delay(10000)
        ]);
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            this.socket.emit('ping', () => {
                resolve();
            });
            setTimeout(() => {
                resolve();
            }, 10000);
        });
    }

    async close() {
        logger.debug('[API] socket.close() called');
        if (!this.closed) {
            this.closed = true;
            this.syncV4LifecycleGeneration += 1;
        }
        this.sendSync.stop();
        this.receiveSync.stop();
        const syncClients = new Set(
            [this.syncV4Client, this.syncV4InitializingClient]
                .filter((client): client is SyncV4Client => client !== null),
        );
        this.syncV4Client = null;
        this.syncV4InitializingClient = null;
        await Promise.all([...syncClients].map((client) => client.close()));
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        this.socket.close();
    }

    private startSmartReconnect() {
        if (this.reconnectInterval) return;

        this.reconnectInterval = setInterval(() => {
            if (this.socket.connected) {
                clearInterval(this.reconnectInterval!);
                this.reconnectInterval = null;
                return;
            }
            if (!shouldReconnect()) {
                logger.debug('[API] Still not ready to reconnect');
                return;
            }
            logger.debug('[API] Attempting reconnect');
            this.socket.connect();
        }, 3000);

        if (shouldReconnect()) {
            logger.debug('[API] Network up + lid open — reconnecting in 1s');
            setTimeout(() => { if (!this.socket.connected) this.socket.connect() }, 1000);
        }
    }
}

export type ApiSessionClientContract = Omit<ApiSessionClient, keyof EventEmitter> & EventEmitter;

function hasSameOrigin(candidateUrl: string, serverUrl: string): boolean {
    try {
        return new URL(candidateUrl).origin === new URL(serverUrl).origin;
    } catch {
        return false;
    }
}
