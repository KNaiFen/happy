import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { ClientToServerEvents, Metadata, ServerToClientEvents, Session, Update } from './types'
import { decodeBase64, decryptBlob, decrypt, encodeBase64, encrypt } from './encryption';
import { backoff } from '@/utils/time';
import { configuration } from '@/configuration';
import { AsyncLock } from '@/utils/lock';
import { deriveKey } from '@/utils/deriveKey';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { shouldReconnect } from '@/utils/lidState';
import {
    classifySyncV4DiagnosticError,
    SyncInvalidationV4Schema,
    type SyncV4DiagnosticSink,
} from '@slopus/happy-wire';
import axios from 'axios';
import { SyncV4Client, type SyncV4AppliedEntity } from './syncV4Client';

function socketUpdateDiagnostics(data: unknown): {
    updateType: 'update-session' | 'update-machine' | 'unknown';
    updateSeq?: number;
    metadataVersion?: number;
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
        const updateType = rawType === 'update-session'
            || rawType === 'update-machine'
            ? rawType
            : 'unknown';
        const updateSeq = update.seq;
        const metadataVersion = readVersion(body.metadata);
        return {
            updateType,
            ...(Number.isSafeInteger(updateSeq) && (updateSeq as number) >= 0
                ? { updateSeq: updateSeq as number }
                : {}),
            ...(metadataVersion !== undefined
                ? { metadataVersion }
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

export class ApiSessionClient extends EventEmitter {
    readonly isOffline: boolean = false;
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private blobKey: Uint8Array | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private reconnectInterval: NodeJS.Timeout | null = null;
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
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;

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

                if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
                        this.metadataVersion = data.body.metadata.version;
                    }
                } else if (data.body.t === 'update-machine') {
                    // Session clients shouldn't receive machine updates - log warning
                    logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`);
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
                    onSessionArchived: () => this.emit('archived'),
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
     * Returns the latest session metadata known to the client.
     */
    getMetadata(): Metadata | null {
        return this.metadata;
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    updateMetadata(handler: (metadata: Metadata) => Metadata) {
        void this.updateMetadataAndWait(handler).catch((error) => {
            logger.debug('[API] Deferred metadata update failed', {
                errorKind: classifySyncV4DiagnosticError(error),
            });
        });
    }

    async updateMetadataAndWait(handler: (metadata: Metadata) => Metadata): Promise<void> {
        await this.metadataLock.inLock(async () => {
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

    async close() {
        logger.debug('[API] socket.close() called');
        if (!this.closed) {
            this.closed = true;
            this.syncV4LifecycleGeneration += 1;
        }
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
        if (this.closed || this.reconnectInterval) return;

        this.reconnectInterval = setInterval(() => {
            if (this.closed) {
                clearInterval(this.reconnectInterval!);
                this.reconnectInterval = null;
                return;
            }
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
            setTimeout(() => {
                if (!this.closed && !this.socket.connected) this.socket.connect();
            }, 1000);
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
