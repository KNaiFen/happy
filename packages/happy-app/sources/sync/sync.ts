import Constants from 'expo-constants';
import {
    apiSocket,
    getCurrentAppState,
    getHappyClientId,
    type ApiSocketLifecyclePermit,
} from '@/sync/apiSocket';
import { notifyUnreadMessage } from '@/sync/webTabTitle';
import { AuthCredentials } from '@/auth/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { storage, type SessionUpdate } from './storage';
import { getImageAttachmentSendPlan } from './attachmentSupport';
import {
    errorMessageFromUnknown,
    formatAttachmentDiagnosticForLog,
    getAttachmentDiagnostic,
} from './attachmentDiagnostics';
import { ApiEphemeralUpdateSchema, ApiUpdateContainerSchema } from './apiTypes';
import type { ApiEphemeralActivityUpdate } from './apiTypes';
import { Session, Machine } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { ActivityUpdateAccumulator, shouldApplySessionActivity } from './reducer/activityUpdateAccumulator';
import { isSessionArchivePending } from './sessionArchiveState';
import { randomUUID } from 'expo-crypto';
import { syncCurrentPushToken } from './pushRegistration';
import { Platform, AppState, type AppStateStatus } from 'react-native';
import { applySettings, Settings, settingsDefaults, settingsParse, settingsToSyncPayload, SUPPORTED_SCHEMA_VERSION } from './settings';
import { Profile, profileParse } from './profile';
import { loadPendingSettings, savePendingSettings } from './persistence';
import {
    initializeTracking,
    trackGitHubConnected,
    trackMessageSent,
    tracking,
    trackPaywallCancelled,
    trackPaywallError,
    trackPaywallPresented,
    trackPaywallPurchased,
    trackPaywallRestored,
} from '@/track';
import type { MessageSentSource } from '@/track';
import { parseToken } from '@/utils/parseToken';
import { RevenueCat, LogLevel, PaywallResult } from './revenueCat';
import { getServerUrl } from './serverConfig';
import { config } from '@/config';
import { log } from '@/log';
import { gitStatusSync } from './gitStatusSync';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { EncryptionCache } from './encryption/encryptionCache';
import { systemPrompt } from './prompt/systemPrompt';
import { fetchArtifact, fetchArtifacts, createArtifact, deleteArtifact as deleteArtifactRequest, updateArtifact } from './apiArtifacts';
import { DecryptedArtifact, Artifact, ArtifactCreateRequest, ArtifactUpdateRequest } from './artifactTypes';
import { ArtifactEncryption } from './encryption/artifactEncryption';
import { getFriendsList, getUserProfile } from './apiFriends';
import { fetchFeed } from './apiFeed';
import { FeedItem } from './feedTypes';
import { UserProfile } from './friendTypes';
import { resolveMessageModeMeta } from './messageMeta';
import type { AttachmentPreview, UploadedAttachment } from './attachmentTypes';
import { requestAttachmentUpload, uploadEncryptedBlob } from './apiAttachments';
import { encryptBlob } from '@/encryption/blob';
import { readFileBytes } from '@/utils/readFileBytes';
import { Modal } from '@/modal';
import { t } from '@/text';
import { assertSupportedExistingSession } from './sessionFlavor';
import { AppSyncV4Client, type AppSyncV4AppliedEntity } from './syncV4Client';
import {
    nativeSyncV4Entropy,
} from './syncV4Entropy';
import { syncV4Persistence } from './syncV4Persistence.mmkv';
import { HttpAppSyncV4Transport } from './syncV4Transport';
import { appSyncV4Diagnostics } from './syncV4Diagnostics.mmkv';
import {
    CodexV4ClientRegistry,
    codexV4PollIntervalMsForLifecycle,
    isCodexV4SyncActive,
    isCodexV4SyncEligible,
} from './codexV4ClientRegistry';
import {
    commandForCodexV4Input,
    createCodexV4Command,
    parseCodexV4Input,
    type CodexV4CommandDraft,
} from './codexV4Commands';
import { createCodexV4Projection } from './codexV4Projection';
import { codexCommandDraftRecovery } from './codexCommandDraftRecovery.mmkv';
import {
    assertCodexV4CommandPublishAllowed,
    resolveCodexV4SessionCapabilities,
} from './codexV4Capabilities';
import { isSessionMachineDeleted } from './sessionMachineAccess';
import { normalizeFetchedSessionLifecycle } from './sessionLifecycle';
import { stopRealtimeSession } from '@/realtime/RealtimeSession';
import { replaceOwnedBuffer } from './ownedBuffer';
import { ArtifactLifecycleFence } from './artifactLifecycleFence';
import {
    beginAccountOutboundLifecycle,
    createAccountFetch,
    endAccountOutboundLifecycle,
} from './accountOutboundFence';

type SendMessageOptions = {
    displayText?: string;
    source?: MessageSentSource;
    /** Optional image attachments to send before the text message. */
    attachments?: AttachmentPreview[];
    /** Choose whether an active Codex turn queues or immediately receives this follow-up. */
    followUpMode?: 'queue' | 'steer';
    /** Stable identity shared by the App send and CLI queue item. */
    localKey?: string;
};

export class SyncLifecycleCancelledError extends Error {
    constructor() {
        super('Sync lifecycle changed before the operation completed');
        this.name = 'SyncLifecycleCancelledError';
    }
}

class Sync {
    generateOperationId(): string {
        return randomUUID();
    }

    encryption!: Encryption;
    serverID!: string;
    anonID!: string;
    private credentials: AuthCredentials | null = null;
    public encryptionCache = new EncryptionCache();
    private sessionsSync: InvalidateSync;
    private readonly codexV4Clients: CodexV4ClientRegistry<AppSyncV4Client, AppSyncV4AppliedEntity>;
    private sessionDataKeys = new Map<string, Uint8Array>(); // Store session data encryption keys internally
    private machineDataKeys = new Map<string, Uint8Array>(); // Store machine data encryption keys internally
    private artifactDataKeys = new Map<string, Uint8Array>(); // Store artifact data encryption keys internally
    private readonly artifactLifecycle = new ArtifactLifecycleFence();
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private purchasesSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private pushTokenSync: InvalidateSync;
    private nativeUpdateSync: InvalidateSync;
    private artifactsSync: InvalidateSync;
    private friendsSync: InvalidateSync;
    private friendRequestsSync: InvalidateSync;
    private feedSync: InvalidateSync;
    private activityAccumulator: ActivityUpdateAccumulator;
    private appStateSubscription: { remove: () => void } | null = null;
    private webListenerCleanup: (() => void) | null = null;
    private unsubscribeSocketUpdate: (() => unknown) | null = null;
    private unsubscribeSocketEphemeral: (() => unknown) | null = null;
    private unsubscribeSocketReconnected: (() => unknown) | null = null;
    private unsubscribeSocketStatus: (() => unknown) | null = null;
    private shutDown = false;
    private shutdownCompleted = false;
    private lifecycleGeneration = 0;
    private apiSocketPermit: ApiSocketLifecyclePermit | null = null;
    private pendingSettings: Partial<Settings> = loadPendingSettings();
    private appState: AppStateStatus = AppState.currentState;
    revenueCatInitialized = false;

    // Generic locking mechanism
    private recalculationLockCount = 0;
    private lastRecalculationTime = 0;

    constructor() {
        const appVersion = Constants.expoConfig?.version || '0.0.0';
        const syncV4TransportSecurity = new URL(getServerUrl()).protocol === 'http:'
            ? 'insecureHttp' as const
            : 'https' as const;
        this.codexV4Clients = new CodexV4ClientRegistry({
            createClient: ({
                sessionId,
                sessionKey,
                machineId,
                pollIntervalMs,
                onEntity,
                onEntities,
                onSnapshotReset,
                onSnapshotReplace,
            }) => AppSyncV4Client.create({
                sessionId,
                sessionKey,
                appVersion,
                pollIntervalMs,
                persistence: syncV4Persistence,
                transport: new HttpAppSyncV4Transport(machineId),
                diagnostics: appSyncV4Diagnostics,
                diagnosticStats: () => appSyncV4Diagnostics.stats(),
                transportSecurity: syncV4TransportSecurity,
                ...nativeSyncV4Entropy,
                canSendOutbound: () => {
                    if (this.shutDown) return false;
                    const state = storage.getState();
                    const session = state.sessions[sessionId];
                    return Boolean(
                        session
                        && !isSessionMachineDeleted(
                            session,
                            state.machines,
                            state.machinesLoaded,
                        )
                    );
                },
                onEntity,
                onEntities,
                onSnapshotReset,
                onSnapshotReplace,
            }),
            isEligible: (sessionId) => !this.shutDown && isCodexV4SyncEligible(
                storage.getState().sessions[sessionId]?.metadata,
            ),
            onEntity: async (sessionId, event) => {
                if (this.shutDown) return;
                storage.getState().applyCodexV4Entity(sessionId, event);
                codexCommandDraftRecovery.reconcileSession(sessionId);
            },
            onEntities: async (sessionId, events) => {
                if (this.shutDown) return;
                storage.getState().applyCodexV4Entities(sessionId, events);
                codexCommandDraftRecovery.reconcileSession(sessionId);
            },
            onSnapshotReset: async (sessionId) => {
                if (this.shutDown) return;
                storage.getState().resetCodexV4Projection(sessionId);
            },
            onSnapshotReplace: async (sessionId, events) => {
                if (this.shutDown) return;
                storage.getState().replaceCodexV4Entities(sessionId, events);
                codexCommandDraftRecovery.reconcileSession(sessionId);
            },
            onSyncState: (sessionId, state) => {
                if (this.shutDown) return;
                storage.getState().applyCodexV4SyncState(sessionId, state);
            },
            diagnostics: appSyncV4Diagnostics,
            diagnosticStats: () => appSyncV4Diagnostics.stats(),
            softwareVersion: appVersion,
            transportSecurity: syncV4TransportSecurity,
            onStartError: () => {
                log.log('Codex Sync v4 client start failed');
            },
        });
        this.sessionsSync = new InvalidateSync(this.fetchSessions);
        this.settingsSync = new InvalidateSync(this.syncSettings);
        this.profileSync = new InvalidateSync(this.fetchProfile);
        this.purchasesSync = new InvalidateSync(this.syncPurchases);
        this.machinesSync = new InvalidateSync(this.fetchMachines);
        this.nativeUpdateSync = new InvalidateSync(this.fetchNativeUpdate);
        this.artifactsSync = new InvalidateSync(this.fetchArtifactsList);
        this.friendsSync = new InvalidateSync(this.fetchFriends);
        this.friendRequestsSync = new InvalidateSync(this.fetchFriendRequests);
        this.feedSync = new InvalidateSync(this.fetchFeed);

        const registerPushToken = async () => {
            await this.registerPushToken();
        }
        this.pushTokenSync = new InvalidateSync(registerPushToken);
        this.activityAccumulator = new ActivityUpdateAccumulator(this.flushActivityUpdates.bind(this), 2000);

        // Listen for app state changes to refresh purchases
        this.appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
            if (this.shutDown) return;
            this.appState = nextAppState;

            // Notify server of focus state for push notification routing.
            // Mobile: AppState.currentState reflects fg/bg directly.
            // Web/desktop: visibilitychange/focus listeners below drive this same path
            // by updating this.appState too — re-derive via getCurrentAppState() so
            // the wire value matches what the server uses for suppression.
            this.sendAppState();

            if (nextAppState === 'active') {
                log.log('📱 App became active');
                this.purchasesSync.invalidate();
                this.profileSync.invalidate();
                this.machinesSync.invalidate();
                this.pushTokenSync.invalidate();
                this.sessionsSync.invalidate();
                this.invalidateCodexV4Clients();
                this.nativeUpdateSync.invalidate();
                log.log('📱 App became active: Invalidating artifacts sync');
                this.artifactsSync.invalidate();
                this.friendsSync.invalidate();
                this.friendRequestsSync.invalidate();
                this.feedSync.invalidate();
            } else {
                log.log(`📱 App state changed to: ${nextAppState}`);
            }
        });

        // Web/desktop: AppState alone doesn't capture tab focus/visibility.
        // Notify server when the tab becomes hidden, regains visibility,
        // or window focus changes — so push routing can suppress only when
        // the user is actually looking at this client.
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
            const broadcast = () => {
                if (this.shutDown) return;
                this.sendAppState();
            };
            document.addEventListener('visibilitychange', broadcast);
            window.addEventListener('focus', broadcast);
            window.addEventListener('blur', broadcast);
            this.webListenerCleanup = () => {
                document.removeEventListener('visibilitychange', broadcast);
                window.removeEventListener('focus', broadcast);
                window.removeEventListener('blur', broadcast);
            };
        }
    }

    async create(credentials: AuthCredentials, encryption: Encryption) {
        if (this.shutDown) return;
        this.lifecycleGeneration += 1;
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();

        // Await settings sync to have fresh settings
        await this.settingsSync.awaitQueue();

        // Await profile sync to have fresh profile
        await this.profileSync.awaitQueue();

        // Await purchases sync to have fresh purchases
        await this.purchasesSync.awaitQueue();
    }

    async restore(credentials: AuthCredentials, encryption: Encryption) {
        if (this.shutDown) return;
        this.lifecycleGeneration += 1;
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        // Purchases sync is invalidated in #init() and will complete asynchronously
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();
    }

    async #init() {

        // Subscribe to updates
        this.subscribeToUpdates();

        // Sync initial PostHog opt-out state with stored settings
        if (tracking) {
            const currentSettings = storage.getState().settings;
            if (currentSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }

        // Invalidate sync
        log.log('🔄 #init: Invalidating all syncs');
        this.sessionsSync.invalidate();
        this.settingsSync.invalidate();
        this.profileSync.invalidate();
        this.purchasesSync.invalidate();
        this.machinesSync.invalidate();
        this.pushTokenSync.invalidate();
        this.nativeUpdateSync.invalidate();
        this.friendsSync.invalidate();
        this.friendRequestsSync.invalidate();
        this.artifactsSync.invalidate();
        this.feedSync.invalidate();
        log.log('🔄 #init: All syncs invalidated, including artifacts');

        // Mark UI ready as soon as sessions load. Machines sync may hang
        // when encryption keys are unavailable (e.g. V1 auth fallback) —
        // let it resolve in the background instead of blocking the UI.
        const generation = this.lifecycleGeneration;
        this.sessionsSync.awaitQueue().then(() => {
            if (!this.isGenerationCurrent(generation)) return;
            storage.getState().applyReady();
        }).catch((error) => {
            console.error('Failed to load sessions');
            // Still mark ready so the UI doesn't stay on a blank screen forever
            if (!this.isGenerationCurrent(generation)) return;
            storage.getState().applyReady();
        });
    }

    isShutdown(): boolean {
        return this.shutDown;
    }

    private isGenerationCurrent(generation: number): boolean {
        return !this.shutDown && this.lifecycleGeneration === generation;
    }

    private storeArtifactDataKey(artifactId: string, key: Uint8Array): void {
        const previous = this.artifactDataKeys.get(artifactId);
        if (previous && previous !== key) previous.fill(0);
        this.artifactDataKeys.set(artifactId, key);
    }

    private clearArtifactDataKey(artifactId: string, expectedKey?: Uint8Array): void {
        const key = this.artifactDataKeys.get(artifactId);
        if (!key || (expectedKey && key !== expectedKey)) return;
        key.fill(0);
        this.artifactDataKeys.delete(artifactId);
    }

    private clearAllArtifactDataKeys(): void {
        for (const key of this.artifactDataKeys.values()) key.fill(0);
        this.artifactDataKeys.clear();
    }

    private storeMachineDataKey(machineId: string, key: Uint8Array): Uint8Array {
        return replaceOwnedBuffer(this.machineDataKeys, machineId, key);
    }

    private clearMachineDataKey(machineId: string, expectedKey?: Uint8Array): void {
        const key = this.machineDataKeys.get(machineId);
        if (!key || (expectedKey && key !== expectedKey)) return;
        key.fill(0);
        this.machineDataKeys.delete(machineId);
    }

    private clearAllMachineDataKeys(): void {
        for (const key of this.machineDataKeys.values()) key.fill(0);
        this.machineDataKeys.clear();
    }


    onSessionVisible = (sessionId: string) => {
        this.codexV4Clients.invalidate(sessionId);

        // Also invalidate git status sync for this session
        gitStatusSync.getSync(sessionId).invalidate();

        // Notify voice assistant about session visibility
        const session = storage.getState().sessions[sessionId];
        if (session) {
            voiceHooks.onSessionFocus(sessionId, session.metadata || undefined);
        }
    }

    isCodexV4Activated(sessionId: string): boolean {
        const state = storage.getState();
        return isCodexV4SyncActive(
            state.sessions[sessionId]?.metadata,
            state.codexV4Sessions[sessionId],
        );
    }

    isCodexV4Eligible(sessionId: string): boolean {
        return isCodexV4SyncEligible(
            storage.getState().sessions[sessionId]?.metadata,
        );
    }

    async publishCodexV4Command(
        sessionId: string,
        draft: CodexV4CommandDraft,
        commandId: string = randomUUID(),
        draftReceiptText?: string,
    ) {
        if (!this.isCodexV4Eligible(sessionId)) {
            throw new Error('Codex Sync v4 is not enabled for this session');
        }
        const command = createCodexV4Command(draft, { commandId });
        const assertCurrentSessionAllowsCommand = () => {
            const state = storage.getState();
            const session = state.sessions[sessionId];
            if (!session || !isCodexV4SyncEligible(session.metadata)) {
                throw new Error('Codex Sync v4 is no longer enabled for this session');
            }
            if (
                isSessionMachineDeleted(session, state.machines, state.machinesLoaded)
            ) {
                throw new Error('The source machine was deleted; this session is read-only');
            }
            assertCodexV4CommandPublishAllowed({
                command,
                metadata: session?.metadata,
                projection: state.codexV4Sessions[sessionId],
            });
        };
        assertCurrentSessionAllowsCommand();
        await this.codexV4Clients.withClient(sessionId, async (client) => {
            assertCurrentSessionAllowsCommand();
            if (draftReceiptText !== undefined) {
                codexCommandDraftRecovery.record({
                    commandId,
                    sourceSessionId: sessionId,
                    text: draftReceiptText,
                });
            }
            await client.publishEntity(command);
        });
        return command;
    }

    /**
     * Upload image attachments for a session: read bytes → encrypt → upload to server.
     * Returns UploadedAttachment records to embed as file events before the text message.
     * Failures are logged and skipped rather than aborting the whole message send.
     */
    private async uploadAttachmentsForSession(
        sessionId: string,
        attachments: AttachmentPreview[],
    ): Promise<{ uploaded: UploadedAttachment[]; failed: number }> {
        if (!this.credentials) return { uploaded: [], failed: attachments.length };

        const blobKey = this.encryption.getSessionBlobKey(sessionId);
        if (!blobKey) {
            console.error('[attachments] No blob key for session');
            return { uploaded: [], failed: attachments.length };
        }

        const uploaded: UploadedAttachment[] = [];
        let failed = 0;

        for (const attachment of attachments) {
            try {
                const bytes = await readFileBytes(attachment.uri);
                const encrypted = encryptBlob(bytes, blobKey);

                const upload = await requestAttachmentUpload(
                    this.credentials,
                    sessionId,
                    attachment.name,
                    encrypted.length,
                );

                await uploadEncryptedBlob(upload, encrypted, this.credentials);
                const { ref } = upload;

                uploaded.push({
                    ref,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    size: attachment.size,
                    width: attachment.width,
                    height: attachment.height,
                    thumbhash: attachment.thumbhash,
                });
            } catch (err) {
                const diagnostic = getAttachmentDiagnostic(err);
                if (diagnostic) {
                    console.error('[attachments] Failed to upload image attachment:', formatAttachmentDiagnosticForLog(diagnostic, {
                        platform: Platform.OS,
                        client: getHappyClientId(),
                    }));
                } else {
                    const message = errorMessageFromUnknown(err);
                    console.error('[attachments] Failed to upload image attachment:', {
                        leg: 'blob-upload',
                        message,
                        platform: Platform.OS,
                        client: getHappyClientId(),
                    });
                }
                failed++;
                // Skip this attachment; do not abort the whole message send.
            }
        }

        return { uploaded, failed };
    }

    async sendMessage(sessionId: string, text: string, options?: SendMessageOptions) {
        // Get session data from storage
        let session = storage.getState().sessions[sessionId];
        if (!session) {
            await this.sessionsSync.awaitQueue();
            session = storage.getState().sessions[sessionId];
            if (!session) {
                console.error('Session not found in storage after sync');
                return;
            }
        }
        const currentState = storage.getState();
        if (isSessionMachineDeleted(
            session,
            currentState.machines,
            currentState.machinesLoaded,
        )) {
            throw new Error('The source machine was deleted; this session is read-only');
        }
        assertSupportedExistingSession(session.metadata);

        const modeMeta = resolveMessageModeMeta(session, {
            agentDefaultOverrides: storage.getState().localSettings.agentDefaultOverrides,
        });
        const { source = 'chat', attachments, followUpMode } = options ?? {};
        const localId = options?.localKey ?? randomUUID();

        const flavor = session.metadata?.flavor;
        const useCodexV4 = this.isCodexV4Eligible(sessionId);
        if (!useCodexV4) {
            throw new Error('Only Codex Sync V4 sessions can send messages');
        }
        const codexV4Capabilities = useCodexV4
            ? resolveCodexV4SessionCapabilities(
                session.metadata,
                storage.getState().codexV4Sessions[sessionId],
                {
                    machineDeleted: isSessionMachineDeleted(
                        session,
                        storage.getState().machines,
                        storage.getState().machinesLoaded,
                    ),
                },
            )
            : null;
        if (codexV4Capabilities?.readOnly) {
            throw new Error('Provider-created Codex child sessions are read-only');
        }
        const parsedCodexV4Input = parseCodexV4Input(text, session.metadata?.skills ?? []);
        const attachmentPlan = getImageAttachmentSendPlan({
            flavor,
            text,
            attachmentCount: attachments?.length ?? 0,
        });
        const effectiveAttachments = attachmentPlan.shouldUseAttachments
            ? attachments
            : undefined;

        if (attachmentPlan.shouldShowUnsupportedAlert) {
            Modal.alert(
                t('imageUpload.notSupportedTitle'),
                t('imageUpload.notSupportedMessage'),
                [{ text: t('common.ok'), style: 'cancel' }],
            );
            if (!attachmentPlan.shouldSendText || (!text.trim() && (effectiveAttachments?.length ?? 0) === 0)) {
                return;
            }
        }

        // Upload attachments and queue file events before the text message.
        let uploadedAttachments: UploadedAttachment[] = [];
        if (effectiveAttachments && effectiveAttachments.length > 0) {
            const { uploaded, failed } = await this.uploadAttachmentsForSession(sessionId, effectiveAttachments);
            uploadedAttachments = uploaded;

            if (failed > 0) {
                Modal.alert(
                    t('imageUpload.uploadFailedTitle'),
                    t('imageUpload.uploadFailedMessage', { count: failed }),
                    [{ text: t('common.ok'), style: 'cancel' }],
                );
            }

        }

        const codexV4Projection = useCodexV4
            ? storage.getState().codexV4Sessions[sessionId]
                ?? createCodexV4Projection(codexV4Capabilities?.ownedThreadId ?? null)
            : null;
        if (!codexV4Projection) {
            throw new Error('Codex Sync V4 projection is not ready');
        }
        const draft = commandForCodexV4Input({
            parsed: parsedCodexV4Input,
            projection: codexV4Projection,
            threadId: codexV4Capabilities?.ownedThreadId,
            mode: {
                ...(modeMeta.model !== undefined ? { model: modeMeta.model } : {}),
                ...(modeMeta.effort !== undefined ? { effort: modeMeta.effort } : {}),
                ...(modeMeta.permissionMode !== undefined ? { permissionMode: modeMeta.permissionMode } : {}),
                appendSystemPrompt: systemPrompt,
            },
            attachments: uploadedAttachments.map((attachment) => ({
                ref: attachment.ref,
                name: attachment.name,
                mimeType: attachment.mimeType,
            })),
            followUpMode,
        });
        await this.publishCodexV4Command(sessionId, draft, localId, text);
        trackMessageSent(source, session.metadata);
        storage.getState().markSessionMessageSent(sessionId);
    }

    /** Server sent us settings — merge any pending local changes on top, then apply as one update. */
    private applyServerSettings = (serverSettings: Settings, version: number) => {
        const merged = Object.keys(this.pendingSettings).length > 0
            ? applySettings(serverSettings, this.pendingSettings)
            : serverSettings;
        storage.getState().applySettings(merged, version);
    }

    applySettings = (delta: Partial<Settings>) => {
        storage.getState().applySettingsLocal(delta);

        // Save pending settings
        this.pendingSettings = { ...this.pendingSettings, ...delta };
        savePendingSettings(this.pendingSettings);

        // Sync PostHog opt-out state if it was changed
        if (tracking && 'analyticsOptOut' in delta) {
            const currentSettings = storage.getState().settings;
            if (currentSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }

        // Invalidate settings sync
        this.settingsSync.invalidate();
    }

    refreshPurchases = () => {
        this.purchasesSync.invalidate();
    }

    refreshProfile = async () => {
        await this.profileSync.invalidateAndAwait();
    }

    purchaseProduct = async (productId: string): Promise<{ success: boolean; error?: string }> => {
        const generation = this.lifecycleGeneration;
        try {
            // Check if RevenueCat is initialized
            if (!this.revenueCatInitialized) {
                return { success: false, error: 'RevenueCat not initialized' };
            }

            // Fetch the product
            const products = await RevenueCat.getProducts([productId]);
            if (!this.isGenerationCurrent(generation)) {
                return { success: false, error: 'Account lifecycle changed' };
            }
            if (products.length === 0) {
                return { success: false, error: `Product '${productId}' not found` };
            }

            // Purchase the product
            const product = products[0];
            const { customerInfo } = await RevenueCat.purchaseStoreProduct(product);
            if (!this.isGenerationCurrent(generation)) {
                return { success: false, error: 'Account lifecycle changed' };
            }

            // Update local purchases data
            storage.getState().applyPurchases(customerInfo);

            return { success: true };
        } catch (error: any) {
            // Check if user cancelled
            if (error.userCancelled) {
                return { success: false, error: 'Purchase cancelled' };
            }

            // Return the error message
            return { success: false, error: error.message || 'Purchase failed' };
        }
    }

    getOfferings = async (): Promise<{ success: boolean; offerings?: any; error?: string }> => {
        try {
            // Check if RevenueCat is initialized
            if (!this.revenueCatInitialized) {
                return { success: false, error: 'RevenueCat not initialized' };
            }

            // Fetch offerings
            const offerings = await RevenueCat.getOfferings();

            // Return the offerings data
            return {
                success: true,
                offerings: {
                    current: offerings.current,
                    all: offerings.all
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message || 'Failed to fetch offerings' };
        }
    }

    presentPaywall = async (flow?: string): Promise<{ success: boolean; purchased?: boolean; error?: string }> => {
        try {
            // Check if RevenueCat is initialized
            if (!this.revenueCatInitialized) {
                const error = 'RevenueCat not initialized';
                trackPaywallError(error, flow);
                return { success: false, error };
            }

            // Track paywall presentation
            trackPaywallPresented(flow);

            // Present the paywall (with flow custom variable if specified)
            const result = await RevenueCat.presentPaywall(
                flow ? { customVariables: { flow } } : undefined
            );

            // Handle the result
            switch (result) {
                case PaywallResult.PURCHASED:
                    trackPaywallPurchased(flow);
                    // Refresh customer info after purchase
                    await this.syncPurchases();
                    return { success: true, purchased: true };
                case PaywallResult.RESTORED:
                    trackPaywallRestored(flow);
                    // Refresh customer info after restore
                    await this.syncPurchases();
                    return { success: true, purchased: true };
                case PaywallResult.CANCELLED:
                    trackPaywallCancelled(flow);
                    return { success: true, purchased: false };
                case PaywallResult.NOT_PRESENTED:
                    trackPaywallError('Paywall not presented', flow);
                    return { success: false, error: 'Paywall not available on this platform' };
                case PaywallResult.ERROR:
                default:
                    const errorMsg = 'Failed to present paywall';
                    trackPaywallError(errorMsg, flow);
                    return { success: false, error: errorMsg };
            }
        } catch (error: any) {
            const errorMessage = error.message || 'Failed to present paywall';
            trackPaywallError(errorMessage, flow);
            return { success: false, error: errorMessage };
        }
    }

    async assumeUsers(userIds: string[]): Promise<void> {
        const generation = this.lifecycleGeneration;
        const credentials = this.credentials;
        if (!credentials || userIds.length === 0) return;
        
        const state = storage.getState();
        // Filter out users we already have in cache (including null for 404s)
        const missingIds = userIds.filter(id => !(id in state.users));
        
        if (missingIds.length === 0) return;
        
        log.log(`👤 Fetching ${missingIds.length} missing users...`);
        
        // Fetch missing users in parallel
        const results = await Promise.all(
            missingIds.map(async (id) => {
                try {
                    const profile = await getUserProfile(credentials, id);
                    return { id, profile };  // profile is null if 404
                } catch (error) {
                    console.error('Failed to fetch user');
                    return { id, profile: null };  // Treat errors as 404
                }
            })
        );
        if (!this.isGenerationCurrent(generation)) return;
        
        // Convert to Record<string, UserProfile | null>
        const usersMap: Record<string, UserProfile | null> = {};
        results.forEach(({ id, profile }) => {
            usersMap[id] = profile;
        });
        
        storage.getState().applyUsers(usersMap);
        log.log(`👤 Applied ${results.length} users to cache (${results.filter(r => r.profile).length} found, ${results.filter(r => !r.profile).length} not found)`);
    }

    //
    // Private
    //

    private fetchSessions = async () => {
        const generation = this.lifecycleGeneration;
        const credentials = this.credentials;
        if (!credentials) return;

        const API_ENDPOINT = getServerUrl();
        const accountFetch = createAccountFetch(credentials.token);
        const response = await accountFetch(`${API_ENDPOINT}/v1/sessions`, {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch sessions: ${response.status}`);
        }

        const data = await response.json();
        if (!this.isGenerationCurrent(generation)) return;
        const sessions = data.sessions as Array<{
            id: string;
            tag: string;
            seq: number;
            metadata: string;
            metadataVersion: number;
            agentState: string | null;
            agentStateVersion: number;
            dataEncryptionKey: string | null;
            active: boolean;
            activeAt: number;
            archivedAt?: number | null;
            createdAt: number;
            updatedAt: number;
            originMachineId: string | null;
            machineDeletedAt: number | null;
        }>;

        // Initialize all session encryptions first
        const sessionKeys = new Map<string, Uint8Array | null>();
        for (const session of sessions) {
            if (this.encryption.isSessionRemoved(session.id)) {
                continue;
            }
            if (session.dataEncryptionKey) {
                let decrypted = await this.encryption.decryptEncryptionKey(session.dataEncryptionKey);
                if (!this.isGenerationCurrent(generation)) {
                    decrypted?.fill(0);
                    for (const key of sessionKeys.values()) key?.fill(0);
                    sessionKeys.clear();
                    return;
                }
                if (!decrypted) {
                    console.error('Failed to decrypt data encryption key for session');
                    continue;
                }
                sessionKeys.set(session.id, decrypted);
            } else {
                sessionKeys.set(session.id, null);
            }
        }
        try {
            await this.encryption.initializeSessions(sessionKeys);
        } finally {
            // Encryption keeps private copies for initialized contexts; the
            // fetch-local decrypted buffers are never retained by Sync.
            for (const key of sessionKeys.values()) key?.fill(0);
            sessionKeys.clear();
        }
        if (!this.isGenerationCurrent(generation)) return;

        // Decrypt sessions
        let decryptedSessions: SessionUpdate[] = [];
        for (const session of sessions) {
            if (this.encryption.isSessionRemoved(session.id)) {
                continue;
            }
            // Get session encryption (should always exist after initialization)
            const sessionEncryption = this.encryption.getSessionEncryption(session.id);
            if (!sessionEncryption) {
                console.error('Session encryption not found after session sync');
                continue;
            }

            // Decrypt metadata using session-specific encryption
            let metadata = await sessionEncryption.decryptMetadata(session.metadataVersion, session.metadata);

            // Decrypt agent state using session-specific encryption
            let agentState = await sessionEncryption.decryptAgentState(session.agentStateVersion, session.agentState);
            if (!this.isGenerationCurrent(generation)) return;
            if (this.encryption.isSessionRemoved(session.id)) continue;

            // Put it all together
            const processedSession: SessionUpdate = {
                ...session,
                ...normalizeFetchedSessionLifecycle(session),
                thinking: false,
                thinkingAt: 0,
                metadata,
                agentState
            };
            decryptedSessions.push(processedSession);
        }

        // Apply to storage
        if (!this.isGenerationCurrent(generation)) return;
        decryptedSessions = decryptedSessions.filter((session) => !this.encryption.isSessionRemoved(session.id));
        this.applySessions(decryptedSessions);
        this.reconcileCodexV4Clients(decryptedSessions);
        log.log(`📥 fetchSessions completed - processed ${decryptedSessions.length} sessions`);

    }

    public refreshMachines = async () => {
        return this.fetchMachines();
    }

    public refreshSessions = async () => {
        return this.sessionsSync.invalidateAndAwait();
    }

    public hydrateSessionFromHistory = (session: SessionUpdate): void => {
        this.applySessions([session]);
        this.reconcileCodexV4Clients(Object.values(storage.getState().sessions));
    }

    public getCredentials() {
        return this.credentials;
    }

    // Artifact methods
    public fetchArtifactsList = async (): Promise<void> => {
        const generation = this.lifecycleGeneration;
        const credentials = this.credentials;
        log.log('📦 fetchArtifactsList: Starting artifact sync');
        if (!credentials) {
            log.log('📦 fetchArtifactsList: No credentials, skipping');
            return;
        }
        const candidateKeys = new Map<string, Uint8Array>();
        const clearCandidateKeys = () => {
            for (const candidateKey of candidateKeys.values()) candidateKey.fill(0);
            candidateKeys.clear();
        };

        try {
            log.log('📦 fetchArtifactsList: Fetching artifacts from server');
            const snapshot = await fetchArtifacts(credentials);
            if (!this.isGenerationCurrent(generation)) return;
            log.log(`📦 fetchArtifactsList: Received ${snapshot.artifacts.length} artifacts from server`);
            const decryptedArtifacts: DecryptedArtifact[] = [];

            for (const artifact of snapshot.artifacts) {
                if (!this.artifactLifecycle.canApplySnapshot(artifact.id, snapshot.highWatermark)) continue;
                let artifactEncryption: ArtifactEncryption | null = null;
                let decryptedKey: Uint8Array | null = null;
                try {
                    // Decrypt the data encryption key
                    decryptedKey = await this.encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
                    if (!this.isGenerationCurrent(generation)) {
                        decryptedKey?.fill(0);
                        return;
                    }
                    if (!this.artifactLifecycle.canApplySnapshot(artifact.id, snapshot.highWatermark)) {
                        decryptedKey?.fill(0);
                        continue;
                    }
                    if (!decryptedKey) {
                        console.error('Failed to decrypt key for artifact');
                        decryptedArtifacts.push({
                            id: artifact.id,
                            title: null,
                            body: undefined,
                            headerVersion: artifact.headerVersion,
                            seq: artifact.seq,
                            updateSeq: artifact.updateSeq,
                            createdAt: artifact.createdAt,
                            updatedAt: artifact.updatedAt,
                            isDecrypted: false,
                        });
                        continue;
                    }

                    // Create artifact encryption instance
                    artifactEncryption = new ArtifactEncryption(decryptedKey);

                    // Decrypt header
                    const header = await artifactEncryption.decryptHeader(artifact.header);
                    if (!this.isGenerationCurrent(generation)) {
                        decryptedKey?.fill(0);
                        return;
                    }
                    if (!this.artifactLifecycle.canApplySnapshot(artifact.id, snapshot.highWatermark)) {
                        decryptedKey.fill(0);
                        continue;
                    }
                    
                    candidateKeys.set(artifact.id, decryptedKey);
                    decryptedKey = null;
                    decryptedArtifacts.push({
                        id: artifact.id,
                        title: header?.title || null,
                        sessions: header?.sessions,  // Include sessions from header
                        draft: header?.draft,        // Include draft flag from header
                        body: undefined, // Body not loaded in list
                        headerVersion: artifact.headerVersion,
                        bodyVersion: artifact.bodyVersion,
                        seq: artifact.seq,
                        updateSeq: artifact.updateSeq,
                        createdAt: artifact.createdAt,
                        updatedAt: artifact.updatedAt,
                        isDecrypted: !!header,
                    });
                } catch (err) {
                    console.error('Failed to decrypt artifact');
                    decryptedKey?.fill(0);
                    // Add with decryption failed flag
                    if (this.artifactLifecycle.canApplySnapshot(artifact.id, snapshot.highWatermark)) decryptedArtifacts.push({
                        id: artifact.id,
                        title: null,
                        body: undefined,
                        headerVersion: artifact.headerVersion,
                        seq: artifact.seq,
                        updateSeq: artifact.updateSeq,
                        createdAt: artifact.createdAt,
                        updatedAt: artifact.updatedAt,
                        isDecrypted: false,
                    });
                } finally {
                    artifactEncryption?.dispose();
                    if (!this.isGenerationCurrent(generation)) {
                        decryptedKey?.fill(0);
                    }
                }
            }

            log.log(`📦 fetchArtifactsList: Successfully decrypted ${decryptedArtifacts.length} artifacts`);
            if (!this.isGenerationCurrent(generation)) return;
            const reconciliation = this.artifactLifecycle.reconcileSnapshot(
                snapshot.artifacts,
                [
                    ...Object.keys(storage.getState().artifacts),
                    ...this.artifactDataKeys.keys(),
                ],
                snapshot.highWatermark,
            );
            const currentArtifacts = decryptedArtifacts.filter((artifact) => {
                if (!reconciliation.acceptedPresentIds.has(artifact.id)) {
                    candidateKeys.get(artifact.id)?.fill(0);
                    candidateKeys.delete(artifact.id);
                    return false;
                }
                const candidateKey = candidateKeys.get(artifact.id);
                if (candidateKey) {
                    this.storeArtifactDataKey(artifact.id, candidateKey);
                } else {
                    this.clearArtifactDataKey(artifact.id);
                }
                candidateKeys.delete(artifact.id);
                return true;
            });
            for (const artifactId of reconciliation.deletedArtifactIds) {
                this.clearArtifactDataKey(artifactId);
            }
            storage.getState().applyArtifactSnapshot(currentArtifacts, reconciliation.deletedArtifactIds);
            log.log('📦 fetchArtifactsList: Artifacts applied to storage');
        } catch (error) {
            log.log('fetchArtifactsList failed');
            console.error('Failed to fetch artifacts');
            throw error;
        } finally {
            clearCandidateKeys();
        }
    }

    public async fetchArtifactWithBody(artifactId: string): Promise<DecryptedArtifact | null> {
        const generation = this.lifecycleGeneration;
        const fetchRevision = this.artifactLifecycle.capture();
        const credentials = this.credentials;
        if (!credentials || !this.artifactLifecycle.canApplyFetch(artifactId, fetchRevision)) return null;
        let storedKey: Uint8Array | null = null;
        let retainKey = false;
        let artifactEncryption: ArtifactEncryption | null = null;

        try {
            const artifact = await fetchArtifact(credentials, artifactId);
            if (!this.isGenerationCurrent(generation)) return null;
            if (!this.artifactLifecycle.canApplyFetch(artifactId, fetchRevision)) return null;

            // Decrypt the data encryption key
            const decryptedKey = await this.encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
            if (!this.isGenerationCurrent(generation)) {
                decryptedKey?.fill(0);
                return null;
            }
            if (!this.artifactLifecycle.canApplyFetch(artifactId, fetchRevision)) {
                decryptedKey?.fill(0);
                return null;
            }
            if (!decryptedKey) {
                console.error('Failed to decrypt key for artifact');
                return null;
            }

            // Store the decrypted key in memory
            storedKey = decryptedKey;
            this.storeArtifactDataKey(artifact.id, storedKey);

            // Create artifact encryption instance
            artifactEncryption = new ArtifactEncryption(decryptedKey);

            // Decrypt header and body
            const header = await artifactEncryption.decryptHeader(artifact.header);
            if (!this.isGenerationCurrent(generation)) return null;
            if (!this.artifactLifecycle.canApplyFetch(artifactId, fetchRevision)) return null;
            const body = artifact.body ? await artifactEncryption.decryptBody(artifact.body) : null;
            if (!this.isGenerationCurrent(generation)) return null;
            if (!this.artifactLifecycle.canApplyFetch(artifactId, fetchRevision)) return null;

            const result = {
                id: artifact.id,
                title: header?.title || null,
                sessions: header?.sessions,  // Include sessions from header
                draft: header?.draft,        // Include draft flag from header
                body: body?.body || null,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                updateSeq: artifact.updateSeq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: !!header,
            };
            if (this.artifactLifecycle.commitFetch(
                artifactId,
                fetchRevision,
                artifact.updateSeq,
                () => storage.getState().updateArtifact(result),
            ) === null) return null;
            retainKey = true;
            return result;
        } catch (error) {
            console.error('Failed to fetch artifact');
            return null;
        } finally {
            artifactEncryption?.dispose();
            if (storedKey && !retainKey) {
                this.clearArtifactDataKey(artifactId, storedKey);
            }
        }
    }

    public async createArtifact(
        title: string | null, 
        body: string | null,
        sessions?: string[],
        draft?: boolean
    ): Promise<string> {
        const generation = this.lifecycleGeneration;
        const credentials = this.credentials;
        if (!credentials) {
            throw new Error('Not authenticated');
        }
        const artifactId = this.encryption.generateId();
        let dataEncryptionKey: Uint8Array | null = null;
        let artifactEncryption: ArtifactEncryption | null = null;
        let committed = false;

        try {
            // Generate data encryption key
            dataEncryptionKey = ArtifactEncryption.generateDataEncryptionKey();
            
            // Store the decrypted key in memory
            this.storeArtifactDataKey(artifactId, dataEncryptionKey);
            
            // Encrypt the data encryption key with user's key
            const encryptedKey = await this.encryption.encryptEncryptionKey(dataEncryptionKey);
            if (!this.isGenerationCurrent(generation)) throw new SyncLifecycleCancelledError();
            
            // Create artifact encryption instance
            artifactEncryption = new ArtifactEncryption(dataEncryptionKey);
            
            // Encrypt header and body
            const encryptedHeader = await artifactEncryption.encryptHeader({ title, sessions, draft });
            const encryptedBody = await artifactEncryption.encryptBody({ body });
            if (!this.isGenerationCurrent(generation)) throw new SyncLifecycleCancelledError();
            
            // Create the request
            const request: ArtifactCreateRequest = {
                id: artifactId,
                header: encryptedHeader,
                body: encryptedBody,
                dataEncryptionKey: encodeBase64(encryptedKey, 'base64'),
            };
            
            // Send to server
            const artifact = await createArtifact(credentials, request);
            if (!this.isGenerationCurrent(generation)) throw new SyncLifecycleCancelledError();
            const accepted = this.artifactLifecycle.recordNew(artifactId, artifact.updateSeq);
            if (!accepted) {
                if (this.artifactLifecycle.isDeleted(artifactId)) {
                    throw new Error('Artifact not found');
                }
                return artifactId;
            }
            
            // Add to local storage
            const decryptedArtifact: DecryptedArtifact = {
                id: artifact.id,
                title,
                sessions,
                draft,
                body,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                updateSeq: artifact.updateSeq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: true,
            };
            
            storage.getState().addArtifact(decryptedArtifact);
            committed = true;
            
            return artifactId;
        } catch (error) {
            console.error('Failed to create artifact');
            throw error;
        } finally {
            artifactEncryption?.dispose();
            if (!committed && dataEncryptionKey) {
                dataEncryptionKey.fill(0);
                this.clearArtifactDataKey(artifactId, dataEncryptionKey);
            }
        }
    }

    public async updateArtifact(
        artifactId: string, 
        title: string | null, 
        body: string | null,
        sessions?: string[],
        draft?: boolean
    ): Promise<void> {
        const generation = this.lifecycleGeneration;
        const operationRevision = this.artifactLifecycle.capture();
        const credentials = this.credentials;
        if (!credentials) {
            throw new Error('Not authenticated');
        }
        if (!this.artifactLifecycle.canApplyFetch(artifactId, operationRevision)) {
            throw new Error('Artifact not found');
        }
        let artifactEncryption: ArtifactEncryption | null = null;
        let storedDataEncryptionKey: Uint8Array | null = null;
        let retainStoredDataEncryptionKey = false;

        try {
            // Get current artifact to get versions and encryption key
            const currentArtifact = storage.getState().artifacts[artifactId];
            if (!currentArtifact) {
                throw new Error('Artifact not found');
            }

            // Get the data encryption key from memory or fetch it
            let dataEncryptionKey = this.artifactDataKeys.get(artifactId);
            
            // Fetch full artifact if we don't have version info or encryption key
            let headerVersion = currentArtifact.headerVersion;
            let bodyVersion = currentArtifact.bodyVersion;
            
            if (headerVersion === undefined || bodyVersion === undefined || !dataEncryptionKey) {
                const fullArtifact = await fetchArtifact(credentials, artifactId);
                if (!this.isGenerationCurrent(generation)) return;
                if (!this.artifactLifecycle.canApplyFetch(artifactId, operationRevision)) throw new Error('Artifact not found');
                headerVersion = fullArtifact.headerVersion;
                bodyVersion = fullArtifact.bodyVersion;
                
                // Decrypt and store the data encryption key if we don't have it
                if (!dataEncryptionKey) {
                    const decryptedKey = await this.encryption.decryptEncryptionKey(fullArtifact.dataEncryptionKey);
                    if (!this.isGenerationCurrent(generation)) {
                        decryptedKey?.fill(0);
                        return;
                    }
                    if (!this.artifactLifecycle.canApplyFetch(artifactId, operationRevision)) {
                        decryptedKey?.fill(0);
                        throw new Error('Artifact not found');
                    }
                    if (!decryptedKey) {
                        throw new Error('Failed to decrypt encryption key');
                    }
                    this.storeArtifactDataKey(artifactId, decryptedKey);
                    storedDataEncryptionKey = decryptedKey;
                    dataEncryptionKey = decryptedKey;
                }
            }

            // Create artifact encryption instance
            artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

            // Prepare update request
            const updateRequest: ArtifactUpdateRequest = {};
            
            // Check if header needs updating (title, sessions, or draft changed)
            if (title !== currentArtifact.title || 
                JSON.stringify(sessions) !== JSON.stringify(currentArtifact.sessions) ||
                draft !== currentArtifact.draft) {
                const encryptedHeader = await artifactEncryption.encryptHeader({ 
                    title, 
                    sessions, 
                    draft 
                });
                if (!this.isGenerationCurrent(generation)) return;
                if (!this.artifactLifecycle.canApplyFetch(artifactId, operationRevision)) throw new Error('Artifact not found');
                updateRequest.header = encryptedHeader;
                updateRequest.expectedHeaderVersion = headerVersion;
            }

            // Only update body if it changed
            if (body !== currentArtifact.body) {
                const encryptedBody = await artifactEncryption.encryptBody({ body });
                if (!this.isGenerationCurrent(generation)) return;
                if (!this.artifactLifecycle.canApplyFetch(artifactId, operationRevision)) throw new Error('Artifact not found');
                updateRequest.body = encryptedBody;
                updateRequest.expectedBodyVersion = bodyVersion;
            }

            // Skip if no changes
            if (Object.keys(updateRequest).length === 0) {
                retainStoredDataEncryptionKey = true;
                return;
            }

            // Send update to server
            const response = await updateArtifact(credentials, artifactId, updateRequest);
            if (!this.isGenerationCurrent(generation)) return;
            
            if (!response.success) {
                // Handle version mismatch
                if (response.error === 'version-mismatch') {
                    throw new Error('Artifact was modified by another client. Please refresh and try again.');
                }
                throw new Error('Failed to update artifact');
            }
            if (!this.artifactLifecycle.recordUpdate(artifactId, response.updateSeq)) {
                retainStoredDataEncryptionKey = !this.artifactLifecycle.isDeleted(artifactId);
                return;
            }

            // Update local storage
            const updatedArtifact: DecryptedArtifact = {
                ...currentArtifact,
                title,
                sessions,
                draft,
                body,
                headerVersion: response.headerVersion !== undefined ? response.headerVersion : headerVersion,
                bodyVersion: response.bodyVersion !== undefined ? response.bodyVersion : bodyVersion,
                updateSeq: response.updateSeq,
                updatedAt: Date.now(),
            };
            
            if (this.isGenerationCurrent(generation)) storage.getState().updateArtifact(updatedArtifact);
            retainStoredDataEncryptionKey = true;
        } catch (error) {
            console.error('Failed to update artifact');
            throw error;
        } finally {
            artifactEncryption?.dispose();
            if (storedDataEncryptionKey && !retainStoredDataEncryptionKey) {
                this.clearArtifactDataKey(artifactId, storedDataEncryptionKey);
            }
        }
    }

    public async deleteArtifact(artifactId: string): Promise<void> {
        const generation = this.lifecycleGeneration;
        const credentials = this.credentials;
        if (!credentials) throw new Error('Not authenticated');
        const response = await deleteArtifactRequest(credentials, artifactId);
        if (!this.isGenerationCurrent(generation)) return;
        if (!this.artifactLifecycle.recordDelete(artifactId, response.updateSeq)) return;
        storage.getState().deleteArtifact(artifactId);
        this.clearArtifactDataKey(artifactId);
    }

    private fetchMachines = async () => {
        const generation = this.lifecycleGeneration;
        const credentials = this.credentials;
        if (!credentials) return;

        console.log('📊 Sync: Fetching machines...');
        const API_ENDPOINT = getServerUrl();
        const accountFetch = createAccountFetch(credentials.token);
        const response = await accountFetch(`${API_ENDPOINT}/v1/machines`, {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch machines: HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!this.isGenerationCurrent(generation)) return;
        console.log(`📊 Sync: Fetched ${Array.isArray(data) ? data.length : 0} machines from server`);
        const machines = data as Array<{
            id: string;
            metadata: string;
            metadataVersion: number;
            daemonState?: string | null;
            daemonStateVersion?: number;
            dataEncryptionKey?: string | null; // Add support for per-machine encryption keys
            seq: number;
            active: boolean;
            activeAt: number;  // Changed from lastActiveAt
            createdAt: number;
            updatedAt: number;
        }>;

        // First, collect and decrypt encryption keys for all machines.
        //
        // Resilience: a single machine whose data key cannot be decrypted
        // (legacy/foreign key format, contentKeyPair mismatch, malformed
        // base64) must NOT abort the whole sync. Previously a throw here
        // rejected fetchMachines entirely — backoff() only console.warn's and
        // retries forever, so applyMachines was never reached and EVERY
        // machine silently vanished from the store (empty /new, no
        // console.error). On failure we fall back to a null key: the machine
        // still gets a (legacy) encryptor and stays visible/selectable, just
        // with undecryptable metadata.
        const machineKeysMap = new Map<string, Uint8Array | null>();
        const storedMachineKeys = new Map<string, Uint8Array>();
        for (const machine of machines) {
            if (this.encryption.isMachineRemoved(machine.id)) {
                continue;
            }
            if (machine.dataEncryptionKey) {
                let decryptedKey: Uint8Array | null = null;
                try {
                    decryptedKey = await this.encryption.decryptEncryptionKey(machine.dataEncryptionKey);
                    if (!this.isGenerationCurrent(generation)) {
                        if (decryptedKey) {
                            decryptedKey.fill(0);
                        }
                        for (const [machineId, storedKey] of storedMachineKeys) {
                            this.clearMachineDataKey(machineId, storedKey);
                        }
                        machineKeysMap.clear();
                        storedMachineKeys.clear();
                        return;
                    }
                    if (this.encryption.isMachineRemoved(machine.id)) {
                        decryptedKey?.fill(0);
                        continue;
                    }
                } catch (error) {
                    console.error('Failed to decrypt data encryption key for machine');
                }
                if (decryptedKey) {
                    machineKeysMap.set(machine.id, decryptedKey);
                    storedMachineKeys.set(machine.id, this.storeMachineDataKey(machine.id, decryptedKey));
                } else {
                    console.error('Failed to decrypt data encryption key for machine');
                    machineKeysMap.set(machine.id, null);
                }
            } else {
                machineKeysMap.set(machine.id, null);
            }
        }

        // Initialize machine encryptions. Guard so an init failure cannot
        // reject the whole sync and wipe the machine list.
        try {
            await this.encryption.initializeMachines(machineKeysMap);
            if (!this.isGenerationCurrent(generation)) {
                for (const [machineId, storedKey] of storedMachineKeys) {
                    this.clearMachineDataKey(machineId, storedKey);
                }
                return;
            }
        } catch (error) {
            console.error('Failed to initialize machine encryptions');
            for (const [machineId, storedKey] of storedMachineKeys) {
                this.clearMachineDataKey(machineId, storedKey);
            }
        } finally {
            // Encryption contexts keep private key copies. The fetch-local
            // decrypted buffers are disposable once initialization returns.
            for (const key of machineKeysMap.values()) key?.fill(0);
            machineKeysMap.clear();
            storedMachineKeys.clear();
        }

        // Process all machines first, then update state once. Every machine is
        // pushed exactly once — decryption failures degrade to null metadata
        // instead of dropping the machine, so a machine never disappears from
        // the picker just because its metadata could not be read.
        const decryptedMachines: Machine[] = [];

        for (const machine of machines) {
            if (this.encryption.isMachineRemoved(machine.id)) {
                continue;
            }
            try {
                const machineEncryption = this.encryption.getMachineEncryption(machine.id);

                // Use machine-specific encryption (which handles fallback internally)
                const metadata = machineEncryption && machine.metadata
                    ? await machineEncryption.decryptMetadata(machine.metadataVersion, machine.metadata)
                    : null;

                const daemonState = machineEncryption && machine.daemonState
                    ? await machineEncryption.decryptDaemonState(machine.daemonStateVersion || 0, machine.daemonState)
                    : null;
                if (this.encryption.isMachineRemoved(machine.id)) continue;

                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    metadata,
                    metadataVersion: machine.metadataVersion,
                    daemonState,
                    daemonStateVersion: machine.daemonStateVersion || 0
                });
            } catch (error) {
                console.error('Failed to decrypt machine');
                if (this.encryption.isMachineRemoved(machine.id)) continue;
                // Still add the machine with null metadata so it stays visible.
                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    metadata: null,
                    metadataVersion: machine.metadataVersion,
                    daemonState: null,
                    daemonStateVersion: 0
                });
            }
        }

        // A successful response is authoritative, including an empty list.
        // Keeping a stale local Machine after a valid empty response revives
        // devices that the user already deleted.
        if (!this.isGenerationCurrent(generation)) return;
        storage.getState().applyMachines(
            decryptedMachines.filter((machine) => !this.encryption.isMachineRemoved(machine.id)),
            true,
        );
        log.log(`🖥️ fetchMachines completed - processed ${decryptedMachines.length} machines`);
    }

    private fetchFriends = async () => {
        const generation = this.lifecycleGeneration;
        const credentials = this.credentials;
        if (!credentials) return;
        
        try {
            log.log('👥 Fetching friends list...');
            const friendsList = await getFriendsList(credentials);
            if (!this.isGenerationCurrent(generation)) return;
            storage.getState().applyFriends(friendsList);
            log.log(`👥 fetchFriends completed - processed ${friendsList.length} friends`);
        } catch (error) {
            console.error('Failed to fetch friends');
            // Silently handle error - UI will show appropriate state
        }
    }

    private fetchFriendRequests = async () => {
        // Friend requests are now included in the friends list with status='pending'
        // This method is kept for backward compatibility but does nothing
        log.log('👥 fetchFriendRequests called - now handled by fetchFriends');
    }

    private fetchFeed = async () => {
        const generation = this.lifecycleGeneration;
        const credentials = this.credentials;
        if (!credentials) return;

        try {
            log.log('📰 Fetching feed...');
            const state = storage.getState();
            const existingItems = state.feedItems;
            const head = state.feedHead;
            
            // Load feed items - if we have a head, load newer items
            let allItems: FeedItem[] = [];
            let hasMore = true;
            let cursor = head ? { after: head } : undefined;
            let loadedCount = 0;
            const maxItems = 500;
            
            // Keep loading until we reach known items or hit max limit
            while (hasMore && loadedCount < maxItems) {
                const response = await fetchFeed(credentials, {
                    limit: 100,
                    ...cursor
                });
                if (!this.isGenerationCurrent(generation)) return;
                
                // Check if we reached known items
                const foundKnown = response.items.some(item => 
                    existingItems.some(existing => existing.id === item.id)
                );
                
                allItems.push(...response.items);
                loadedCount += response.items.length;
                hasMore = response.hasMore && !foundKnown;
                
                // Update cursor for next page
                if (response.items.length > 0) {
                    const lastItem = response.items[response.items.length - 1];
                    cursor = { after: lastItem.cursor };
                }
            }
            
            // If this is initial load (no head), also load older items
            if (!head && allItems.length < 100) {
                const response = await fetchFeed(credentials, {
                    limit: 100
                });
                if (!this.isGenerationCurrent(generation)) return;
                allItems.push(...response.items);
            }
            
            // Collect user IDs from friend-related feed items
            const userIds = new Set<string>();
            allItems.forEach(item => {
                if (item.body && (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted')) {
                    userIds.add(item.body.uid);
                }
            });
            
            // Fetch missing users
            if (userIds.size > 0) {
                await this.assumeUsers(Array.from(userIds));
                if (!this.isGenerationCurrent(generation)) return;
            }
            
            // Filter out items where user is not found (404)
            const users = storage.getState().users;
            const compatibleItems = allItems.filter(item => {
                // Keep text items
                if (item.body.kind === 'text') return true;
                
                // For friend-related items, check if user exists and is not null (404)
                if (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted') {
                    const userProfile = users[item.body.uid];
                    // Keep item only if user exists and is not null
                    return userProfile !== null && userProfile !== undefined;
                }
                
                return true;
            });
            
            // Apply only compatible items to storage
            if (!this.isGenerationCurrent(generation)) return;
            storage.getState().applyFeedItems(compatibleItems);
            log.log(`📰 fetchFeed completed - loaded ${compatibleItems.length} compatible items (${allItems.length - compatibleItems.length} filtered)`);
        } catch (error) {
            console.error('Failed to fetch feed');
        }
    }

    private syncSettings = async () => {
        const generation = this.lifecycleGeneration;
        const credentials = this.credentials;
        if (!credentials) return;

        const API_ENDPOINT = getServerUrl();
        const accountFetch = createAccountFetch(credentials.token);
        const maxRetries = 3;
        let retryCount = 0;

        // Apply pending settings
        if (Object.keys(this.pendingSettings).length > 0) {

            while (retryCount < maxRetries) {
                // Snapshot what we're about to send so we can detect concurrent changes
                const sentPending = { ...this.pendingSettings };
                let version = storage.getState().settingsVersion;
                let settings = applySettings(storage.getState().settings, this.pendingSettings);
                const encryptedSettings = await this.encryption.encryptRaw(settingsToSyncPayload(settings));
                if (!this.isGenerationCurrent(generation)) return;
                const response = await accountFetch(`${API_ENDPOINT}/v1/account/settings`, {
                    method: 'POST',
                    body: JSON.stringify({
                        settings: encryptedSettings,
                        expectedVersion: version ?? 0
                    }),
                    headers: {
                        'Authorization': `Bearer ${credentials.token}`,
                        'Content-Type': 'application/json',
                        'X-Happy-Client': getHappyClientId(),
                    }
                });
                const data = await response.json() as {
                    success: false,
                    error: string,
                    currentVersion: number,
                    currentSettings: string | null
                } | {
                    success: true
                };
                if (!this.isGenerationCurrent(generation)) return;
                if (data.success) {
                    // Only clear keys we actually sent — preserve any settings
                    // added by applySettings() calls during the POST roundtrip
                    const newPending: Partial<Settings> = {};
                    for (const key of Object.keys(this.pendingSettings) as (keyof Settings)[]) {
                        if (!(key in sentPending) || this.pendingSettings[key] !== sentPending[key]) {
                            (newPending as any)[key] = this.pendingSettings[key];
                        }
                    }
                    this.pendingSettings = newPending;
                    savePendingSettings(this.pendingSettings);
                    break;
                }
                if (data.error === 'version-mismatch') {
                    // Parse server settings
                    const serverSettings = data.currentSettings
                        ? settingsParse(await this.encryption.decryptRaw(data.currentSettings))
                        : { ...settingsDefaults };
                    if (!this.isGenerationCurrent(generation)) return;

                    // Merge: server base + our pending changes (our changes win)
                    const mergedSettings = applySettings(serverSettings, this.pendingSettings);

                    // Update local storage with merged result at server's version
                    this.applyServerSettings(mergedSettings, data.currentVersion);

                    // Sync tracking state with merged settings
                    if (tracking) {
                        mergedSettings.analyticsOptOut ? tracking.optOut() : tracking.optIn();
                    }

                    // Log and retry
                    console.log('settings version-mismatch, retrying');
                    retryCount++;
                    continue;
                } else {
                    throw new Error(`Failed to sync settings: ${data.error}`);
                }
            }
        }

        // If exhausted retries, throw to trigger outer backoff delay
        if (retryCount >= maxRetries) {
            throw new Error(`Settings sync failed after ${maxRetries} retries due to version conflicts`);
        }

        // Run request
        if (!this.isGenerationCurrent(generation)) return;
        const response = await accountFetch(`${API_ENDPOINT}/v1/account/settings`, {
            headers: {
            'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch settings: ${response.status}`);
        }
        const data = await response.json() as {
            settings: string | null,
            settingsVersion: number
        };
        if (!this.isGenerationCurrent(generation)) return;

        // Parse response
        let parsedSettings: Settings;
        if (data.settings) {
            parsedSettings = settingsParse(await this.encryption.decryptRaw(data.settings));
            if (!this.isGenerationCurrent(generation)) return;
        } else {
            parsedSettings = { ...settingsDefaults };
        }

        // Settings may contain provider credentials and local paths; keep logs
        // limited to a non-sensitive lifecycle marker.
        console.log('settings synchronized');

        // Apply settings to storage, re-layering any pending local changes on top
        if (!this.isGenerationCurrent(generation)) return;
        this.applyServerSettings(parsedSettings, data.settingsVersion);

        // Sync PostHog opt-out state with settings
        if (tracking) {
            if (parsedSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }
    }

    private fetchProfile = async () => {
        const generation = this.lifecycleGeneration;
        const credentials = this.credentials;
        if (!credentials) return;

        const API_ENDPOINT = getServerUrl();
        const accountFetch = createAccountFetch(credentials.token);
        const response = await accountFetch(`${API_ENDPOINT}/v1/account/profile`, {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch profile: ${response.status}`);
        }

        const data = await response.json();
        if (!this.isGenerationCurrent(generation)) return;
        const parsedProfile = profileParse(data);

        console.log('profile synchronized');

        // Apply profile to storage
        if (!this.isGenerationCurrent(generation)) return;
        storage.getState().applyProfile(parsedProfile);
    }

    private fetchNativeUpdate = async () => {
        const generation = this.lifecycleGeneration;
        try {
            // Skip in development
            if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !Constants.expoConfig?.version) {
                return;
            }
            if (Platform.OS === 'ios' && !Constants.expoConfig?.ios?.bundleIdentifier) {
                return;
            }
            if (Platform.OS === 'android' && !Constants.expoConfig?.android?.package) {
                return;
            }

            const serverUrl = getServerUrl();

            // Get platform and app identifiers
            const platform = Platform.OS;
            const version = Constants.expoConfig?.version!;
            const appId = (Platform.OS === 'ios' ? Constants.expoConfig?.ios?.bundleIdentifier! : Constants.expoConfig?.android?.package!);

            const response = await fetch(`${serverUrl}/v1/version`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Happy-Client': getHappyClientId(),
                },
                body: JSON.stringify({
                    platform,
                    version,
                    app_id: appId,
                }),
            });
            if (!this.isGenerationCurrent(generation)) return;

            if (!response.ok) {
                console.log('[fetchNativeUpdate] Request failed');
                return;
            }

            const data = await response.json();
            if (!this.isGenerationCurrent(generation)) return;
            console.log('[fetchNativeUpdate] Response received');

            // Apply update status to storage
            if (data.update_required && data.update_url) {
                storage.getState().applyNativeUpdateStatus({
                    available: true,
                    updateUrl: data.update_url
                });
            } else {
                storage.getState().applyNativeUpdateStatus({
                    available: false
                });
            }
        } catch {
            console.log('[fetchNativeUpdate] Request failed');
            if (!this.isGenerationCurrent(generation)) return;
            storage.getState().applyNativeUpdateStatus(null);
        }
    }

    private syncPurchases = async () => {
        const generation = this.lifecycleGeneration;
        try {
            // Initialize RevenueCat if not already done
            if (!this.revenueCatInitialized) {
                // Get the appropriate API key based on platform
                let apiKey: string | undefined;

                if (Platform.OS === 'ios') {
                    apiKey = config.revenueCatAppleKey;
                } else if (Platform.OS === 'android') {
                    apiKey = config.revenueCatGoogleKey;
                } else if (Platform.OS === 'web') {
                    apiKey = config.revenueCatStripeKey;
                }

                if (!apiKey) {
                    console.log(`RevenueCat: No API key found for platform ${Platform.OS}`);
                    return;
                }

                // Configure RevenueCat
                if (__DEV__) {
                    RevenueCat.setLogLevel(LogLevel.DEBUG);
                }

                // Initialize with the public ID as user ID
                RevenueCat.configure({
                    apiKey,
                    appUserID: this.serverID, // In server this is a CUID, which we can assume is globaly unique even between servers
                    useAmazon: false,
                });

                this.revenueCatInitialized = true;
                console.log('RevenueCat initialized successfully');
            }

            // Sync purchases
            await RevenueCat.syncPurchases();
            if (!this.isGenerationCurrent(generation)) return;

            // Fetch customer info
            const customerInfo = await RevenueCat.getCustomerInfo();
            if (!this.isGenerationCurrent(generation)) return;

            // Apply to storage (storage handles the transformation)
            storage.getState().applyPurchases(customerInfo);

        } catch {
            console.error('Failed to sync purchases');
            // Don't throw - purchases are optional
        }
    }

    loadOlderMessages = async (_sessionId: string) => {};

    private registerPushToken = async () => {
        log.log('registerPushToken');
        try {
            const credentials = this.credentials;
            if (!credentials || this.shutDown) return;
            const result = await syncCurrentPushToken(credentials);
            log.log('Push token sync completed');
            if (!result.permission.granted) {
                console.log('Failed to get push token for push notification!');
            }
        } catch {
            log.log('Push token registration failed');
        }
    }

    private subscribeToUpdates = () => {
        // Subscribe to message updates
        this.unsubscribeSocketUpdate = apiSocket.onMessage('update', this.handleUpdate);
        this.unsubscribeSocketEphemeral = apiSocket.onMessage('ephemeral', this.handleEphemeralUpdate);

        // Subscribe to connection state changes
        this.unsubscribeSocketReconnected = apiSocket.onReconnected(() => {
            if (this.shutDown) return;
            log.log('🔌 Socket reconnected');

            // Send current focus state on reconnect so the server's
            // suppression rules pick up where we left off (handshake.auth.appState
            // covers the very first connect; this covers reconnects).
            this.sendAppState();

            this.sessionsSync.invalidate();
            this.machinesSync.invalidate();
            log.log('🔌 Socket reconnected: Invalidating artifacts sync');
            this.artifactsSync.invalidate();
            this.friendsSync.invalidate();
            this.friendRequestsSync.invalidate();
            this.feedSync.invalidate();
            this.invalidateCodexV4Clients();
        });
    }

    private sendAppState(): void {
        const permit = this.apiSocketPermit;
        if (!permit || this.shutDown) return;
        try {
            apiSocket.sendAppState(getCurrentAppState(), permit);
        } catch {
            // A disconnect, quarantine, or account switch invalidates the
            // permit synchronously. App-state hints are safe to drop.
        }
    }

    private handleUpdate = async (update: unknown) => {
        if (this.shutDown) return;
        const generation = this.lifecycleGeneration;
        const validatedUpdate = ApiUpdateContainerSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.error('Sync: Invalid update received');
            return;
        }
        const updateData = validatedUpdate.data;
        console.log('Sync: Validated update received');

        if (updateData.body.t === 'new-session') {
            if (this.encryption.isSessionRemoved(updateData.body.id)) {
                return;
            }
            log.log('🆕 New session update received');
            this.sessionsSync.invalidate();
        } else if (updateData.body.t === 'delete-session') {
            log.log('🗑️ Delete session update received');
            const sessionId = updateData.body.sid;

            // Remove session from storage
            storage.getState().deleteSession(sessionId);

            // Remove encryption keys from memory
            this.encryption.removeSessionEncryption(sessionId);

            // Clear any cached git status
            gitStatusSync.clearForSession(sessionId);
            this.stopCodexV4Client(sessionId);
            syncV4Persistence.clearSession(sessionId);

            log.log('Session deleted from local storage');
        } else if (updateData.body.t === 'update-session') {
            if (this.encryption.isSessionRemoved(updateData.body.id)) {
                return;
            }
            // Session + encryption may not be initialized yet if sessions are
            // still syncing on startup. Await the session queue and re-check
            // sessions sync queue and re-check before giving up — dropping here
            // silently loses the metadata update that carries the chat title
            // (#1251: every chat stuck on "New chat" after the lazy-load change).
            let session = storage.getState().sessions[updateData.body.id];
            let sessionEncryption = this.encryption.getSessionEncryption(updateData.body.id);
            if (!session || !sessionEncryption) {
                await this.sessionsSync.awaitQueue();
                if (!this.isGenerationCurrent(generation)) return;
                session = storage.getState().sessions[updateData.body.id];
                sessionEncryption = this.encryption.getSessionEncryption(updateData.body.id);
            }
            if (session) {
                if (!sessionEncryption) {
                    console.error('Session encryption not found after sync');
                    this.fetchSessions();
                    return;
                }

                const agentState = updateData.body.agentState && sessionEncryption
                    ? await sessionEncryption.decryptAgentState(updateData.body.agentState.version, updateData.body.agentState.value)
                    : session.agentState;
                if (!this.isGenerationCurrent(generation)) return;
                if (this.encryption.isSessionRemoved(updateData.body.id)) return;
                const metadata = updateData.body.metadata && sessionEncryption
                    ? await sessionEncryption.decryptMetadata(updateData.body.metadata.version, updateData.body.metadata.value)
                    : session.metadata;
                if (!this.isGenerationCurrent(generation)) return;
                if (this.encryption.isSessionRemoved(updateData.body.id)) return;

                this.applySessions([{
                    ...session,
                    agentState,
                    agentStateVersion: updateData.body.agentState
                        ? updateData.body.agentState.version
                        : session.agentStateVersion,
                    metadata,
                    metadataVersion: updateData.body.metadata
                        ? updateData.body.metadata.version
                        : session.metadataVersion,
                    updatedAt: updateData.createdAt,
                    seq: updateData.seq
                }]);
                this.reconcileCodexV4Clients(Object.values(storage.getState().sessions));

                // Invalidate git status when agent state changes (files may have been modified)
                if (updateData.body.agentState) {
                    gitStatusSync.invalidate(updateData.body.id);

                    // Check for new permission requests and notify voice assistant
                    if (agentState?.requests && Object.keys(agentState.requests).length > 0) {
                        const requestIds = Object.keys(agentState.requests);
                        const firstRequest = agentState.requests[requestIds[0]];
                        const toolName = firstRequest?.tool;
                        voiceHooks.onPermissionRequested(updateData.body.id, requestIds[0], toolName, firstRequest?.arguments);
                    }

                }
            }
        } else if (updateData.body.t === 'update-account') {
            const accountUpdate = updateData.body;
            const currentProfile = storage.getState().profile;
            const hadGitHub = !!currentProfile.github?.login;

            // Build updated profile with new data
            const updatedProfile: Profile = {
                ...currentProfile,
                firstName: accountUpdate.firstName !== undefined ? accountUpdate.firstName : currentProfile.firstName,
                lastName: accountUpdate.lastName !== undefined ? accountUpdate.lastName : currentProfile.lastName,
                avatar: accountUpdate.avatar !== undefined ? accountUpdate.avatar : currentProfile.avatar,
                github: accountUpdate.github !== undefined ? accountUpdate.github : currentProfile.github,
                timestamp: updateData.createdAt // Update timestamp to latest
            };

            // Apply the updated profile to storage
            storage.getState().applyProfile(updatedProfile);

            if (!hadGitHub && updatedProfile.github?.login) {
                trackGitHubConnected();
            }

            // Handle settings updates (new for profile sync)
            if (accountUpdate.settings?.value) {
                try {
                    const decryptedSettings = await this.encryption.decryptRaw(accountUpdate.settings.value);
                    if (!this.isGenerationCurrent(generation)) return;
                    const parsedSettings = settingsParse(decryptedSettings);

                    // Version compatibility check
                    const settingsSchemaVersion = parsedSettings.schemaVersion ?? 1;
                    if (settingsSchemaVersion > SUPPORTED_SCHEMA_VERSION) {
                        console.warn(
                            `⚠️ Received settings schema v${settingsSchemaVersion}, ` +
                            `we support v${SUPPORTED_SCHEMA_VERSION}. Update app for full functionality.`
                        );
                    }

                    this.applyServerSettings(parsedSettings, accountUpdate.settings.version);
                    log.log('Settings synced from server');
                } catch (error) {
                    console.error('Failed to process settings update');
                    // Don't crash on settings sync errors, just log
                }
            }
        } else if (updateData.body.t === 'new-machine') {
            const machineUpdate = updateData.body;
            const machineId = machineUpdate.machineId;
            if (this.encryption.isMachineRemoved(machineId)) {
                return;
            }

            // Brand-new machines (cold onboarding) are delivered via 'new-machine'
            // before any fetchMachines has seen them, so their per-machine
            // encryption isn't initialized yet. The update carries the data
            // encryption key — register it here (mirroring fetchMachines) or every
            // later decrypt for this machine fails and it never lands in storage,
            // leaving the new-session screen unable to start a session until an app
            // restart / socket reconnect triggers a full machine refetch.
            const machineKeysMap = new Map<string, Uint8Array | null>();
            let storedMachineKey: Uint8Array | null = null;
            if (machineUpdate.dataEncryptionKey) {
                const decryptedKey = await this.encryption.decryptEncryptionKey(machineUpdate.dataEncryptionKey);
                if (this.encryption.isMachineRemoved(machineId)) {
                    decryptedKey?.fill(0);
                    return;
                }
                if (decryptedKey) {
                    machineKeysMap.set(machineId, decryptedKey);
                    storedMachineKey = this.storeMachineDataKey(machineId, decryptedKey);
                } else {
                    console.error('Failed to decrypt data encryption key for new machine');
                    machineKeysMap.set(machineId, null);
                }
            } else {
                machineKeysMap.set(machineId, null);
            }
            try {
                await this.encryption.initializeMachines(machineKeysMap);
            } catch {
                if (storedMachineKey) this.clearMachineDataKey(machineId, storedMachineKey);
                console.error('Failed to initialize new machine encryption');
            } finally {
                for (const key of machineKeysMap.values()) key?.fill(0);
                machineKeysMap.clear();
            }
            if (!this.isGenerationCurrent(generation)) {
                if (storedMachineKey) this.clearMachineDataKey(machineId, storedMachineKey);
                return;
            }
            if (this.encryption.isMachineRemoved(machineId)) {
                if (storedMachineKey) this.clearMachineDataKey(machineId, storedMachineKey);
                return;
            }

            const machineEncryption = this.encryption.getMachineEncryption(machineId);
            if (!machineEncryption) {
                console.error('Machine encryption not found after init');
                return;
            }

            // Preserve an existing createdAt if we somehow already know this machine.
            const existing = storage.getState().machines[machineId];
            const newMachine: Machine = {
                id: machineId,
                seq: machineUpdate.seq,
                createdAt: existing?.createdAt ?? machineUpdate.createdAt,
                updatedAt: machineUpdate.updatedAt,
                active: machineUpdate.active,
                activeAt: machineUpdate.activeAt,
                metadata: null,
                metadataVersion: machineUpdate.metadataVersion,
                daemonState: null,
                daemonStateVersion: machineUpdate.daemonStateVersion
            };

            // Decrypt best-effort; still apply the machine on failure so it stays
            // visible/usable (matches fetchMachines' fallback behavior).
            try {
                newMachine.metadata = machineUpdate.metadata
                    ? await machineEncryption.decryptMetadata(machineUpdate.metadataVersion, machineUpdate.metadata)
                    : null;
                if (!this.isGenerationCurrent(generation)) return;
                if (this.encryption.isMachineRemoved(machineId)) return;
                newMachine.daemonState = machineUpdate.daemonState
                    ? await machineEncryption.decryptDaemonState(machineUpdate.daemonStateVersion, machineUpdate.daemonState)
                    : null;
                if (!this.isGenerationCurrent(generation)) return;
                if (this.encryption.isMachineRemoved(machineId)) return;
            } catch {
                console.error('Failed to decrypt new machine');
            }

            if (!this.isGenerationCurrent(generation)) {
                if (storedMachineKey) this.clearMachineDataKey(machineId, storedMachineKey);
                return;
            }
            if (this.encryption.isMachineRemoved(machineId)) return;
            storage.getState().applyMachines([newMachine]);
        } else if (updateData.body.t === 'update-machine') {
            const machineUpdate = updateData.body;
            const machineId = machineUpdate.machineId;  // Changed from .id to .machineId
            if (this.encryption.isMachineRemoved(machineId)) {
                return;
            }
            const machine = storage.getState().machines[machineId];

            // Create or update machine with all required fields
            const updatedMachine: Machine = {
                id: machineId,
                seq: updateData.seq,
                createdAt: machine?.createdAt ?? updateData.createdAt,
                updatedAt: updateData.createdAt,
                active: machineUpdate.active ?? true,
                activeAt: machineUpdate.activeAt ?? updateData.createdAt,
                metadata: machine?.metadata ?? null,
                metadataVersion: machine?.metadataVersion ?? 0,
                daemonState: machine?.daemonState ?? null,
                daemonStateVersion: machine?.daemonStateVersion ?? 0
            };

            // Get machine-specific encryption (might not exist if machine wasn't initialized)
            const machineEncryption = this.encryption.getMachineEncryption(machineId);
            if (!machineEncryption) {
                console.error('Machine encryption not found for update');
                return;
            }

            // If metadata is provided, decrypt and update it
            const metadataUpdate = machineUpdate.metadata;
            if (metadataUpdate) {
                try {
                    const metadata = await machineEncryption.decryptMetadata(metadataUpdate.version, metadataUpdate.value);
                    if (!this.isGenerationCurrent(generation)) return;
                    if (this.encryption.isMachineRemoved(machineId)) return;
                    updatedMachine.metadata = metadata;
                    updatedMachine.metadataVersion = metadataUpdate.version;
                } catch {
                    console.error('Failed to decrypt machine metadata');
                }
            }

            // If daemonState is provided, decrypt and update it
            const daemonStateUpdate = machineUpdate.daemonState;
            if (daemonStateUpdate) {
                try {
                    const daemonState = await machineEncryption.decryptDaemonState(daemonStateUpdate.version, daemonStateUpdate.value);
                    if (!this.isGenerationCurrent(generation)) return;
                    if (this.encryption.isMachineRemoved(machineId)) return;
                    updatedMachine.daemonState = daemonState;
                    updatedMachine.daemonStateVersion = daemonStateUpdate.version;
                } catch {
                    console.error('Failed to decrypt machine state');
                }
            }

            // Update storage using applyMachines which rebuilds sessionListViewData
            if (!this.isGenerationCurrent(generation)) return;
            if (this.encryption.isMachineRemoved(machineId)) return;
            storage.getState().applyMachines([updatedMachine]);
        } else if (updateData.body.t === 'delete-machine') {
            const machineId = updateData.body.machineId;
            log.log('Delete machine update received');
            storage.getState().deleteMachine(machineId);
            this.encryption.removeMachineEncryption(machineId);
            this.clearMachineDataKey(machineId);
        } else if (updateData.body.t === 'relationship-updated') {
            log.log('👥 Received relationship-updated update');
            const relationshipUpdate = updateData.body;
            
            // Apply the relationship update to storage
            storage.getState().applyRelationshipUpdate({
                fromUserId: relationshipUpdate.fromUserId,
                toUserId: relationshipUpdate.toUserId,
                status: relationshipUpdate.status,
                action: relationshipUpdate.action,
                fromUser: relationshipUpdate.fromUser,
                toUser: relationshipUpdate.toUser,
                timestamp: relationshipUpdate.timestamp
            });
            
            // Invalidate friends data to refresh with latest changes
            this.friendsSync.invalidate();
            this.friendRequestsSync.invalidate();
            this.feedSync.invalidate();
        } else if (updateData.body.t === 'new-artifact') {
            log.log('📦 Received new-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            if (!this.artifactLifecycle.recordNew(artifactId, updateData.seq)) return;
            const artifactRevision = this.artifactLifecycle.capture();
            let decryptedKey: Uint8Array | null = null;
            let artifactEncryption: ArtifactEncryption | null = null;
            const releaseDecryptedKey = () => {
                if (!decryptedKey) return;
                if (this.artifactDataKeys.get(artifactId) === decryptedKey) {
                    this.clearArtifactDataKey(artifactId, decryptedKey);
                } else {
                    decryptedKey.fill(0);
                }
            };
            try {
                // Decrypt the data encryption key
                decryptedKey = await this.encryption.decryptEncryptionKey(artifactUpdate.dataEncryptionKey);
                if (!this.isGenerationCurrent(generation)) return;
                if (!this.artifactLifecycle.canApplyFetch(artifactId, artifactRevision)) return;
                if (!decryptedKey) {
                    console.error('Failed to decrypt key for new artifact');
                    return;
                }
                
                // Store the decrypted key in memory
                this.storeArtifactDataKey(artifactId, decryptedKey);
                
                // Create artifact encryption instance
                artifactEncryption = new ArtifactEncryption(decryptedKey);
                
                // Decrypt header
                const header = await artifactEncryption.decryptHeader(artifactUpdate.header);
                if (!this.isGenerationCurrent(generation)) return;
                if (!this.artifactLifecycle.canApplyFetch(artifactId, artifactRevision)) return;
                
                // Decrypt body if provided
                let decryptedBody: string | null | undefined = undefined;
                if (artifactUpdate.body && artifactUpdate.bodyVersion !== undefined) {
                    const body = await artifactEncryption.decryptBody(artifactUpdate.body);
                    if (!this.isGenerationCurrent(generation)) return;
                    if (!this.artifactLifecycle.canApplyFetch(artifactId, artifactRevision)) return;
                    decryptedBody = body?.body || null;
                }
                
                // Add to storage
                const decryptedArtifact: DecryptedArtifact = {
                    id: artifactId,
                    title: header?.title || null,
                    body: decryptedBody,
                    headerVersion: artifactUpdate.headerVersion,
                    bodyVersion: artifactUpdate.bodyVersion,
                    seq: artifactUpdate.seq,
                    updateSeq: updateData.seq,
                    createdAt: artifactUpdate.createdAt,
                    updatedAt: artifactUpdate.updatedAt,
                    isDecrypted: !!header,
                };
                
                if (!this.isGenerationCurrent(generation)) return;
                if (!this.artifactLifecycle.canApplyFetch(artifactId, artifactRevision)) return;
                storage.getState().addArtifact(decryptedArtifact);
                log.log('Added new artifact to storage');
            } catch {
                console.error('Failed to process new artifact');
                releaseDecryptedKey();
            } finally {
                artifactEncryption?.dispose();
                if (!this.isGenerationCurrent(generation)) {
                    releaseDecryptedKey();
                }
                if (!this.artifactLifecycle.canApplyFetch(artifactId, artifactRevision)) releaseDecryptedKey();
            }
        } else if (updateData.body.t === 'update-artifact') {
            log.log('📦 Received update-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            if (!this.artifactLifecycle.recordUpdate(artifactId, updateData.seq)) return;
            const artifactRevision = this.artifactLifecycle.capture();
            
            // Get existing artifact
            const existingArtifact = storage.getState().artifacts[artifactId];
            if (!existingArtifact) {
                console.error('Artifact not found in storage');
                // Fetch all artifacts to sync
                this.artifactsSync.invalidate();
                return;
            }
            
            let artifactEncryption: ArtifactEncryption | null = null;
            try {
                // Get the data encryption key from memory
                let dataEncryptionKey = this.artifactDataKeys.get(artifactId);
                if (!dataEncryptionKey) {
                    console.error('Encryption key not found for artifact');
                    this.artifactsSync.invalidate();
                    return;
                }
                
                // Create artifact encryption instance
                artifactEncryption = new ArtifactEncryption(dataEncryptionKey);
                
                // Update artifact with new data  
                const updatedArtifact: DecryptedArtifact = {
                    ...existingArtifact,
                    seq: artifactUpdate.seq ?? existingArtifact.seq + 1,
                    updateSeq: updateData.seq,
                    updatedAt: updateData.createdAt,
                };
                
                // Decrypt and update header if provided
                if (artifactUpdate.header) {
                    const header = await artifactEncryption.decryptHeader(artifactUpdate.header.value);
                    if (!this.isGenerationCurrent(generation)) return;
                    if (!this.artifactLifecycle.canApplyFetch(artifactId, artifactRevision)) return;
                    updatedArtifact.title = header?.title || null;
                    updatedArtifact.sessions = header?.sessions;
                    updatedArtifact.draft = header?.draft;
                    updatedArtifact.headerVersion = artifactUpdate.header.version;
                }
                
                // Decrypt and update body if provided
                if (artifactUpdate.body) {
                    const body = await artifactEncryption.decryptBody(artifactUpdate.body.value);
                    if (!this.isGenerationCurrent(generation)) return;
                    if (!this.artifactLifecycle.canApplyFetch(artifactId, artifactRevision)) return;
                    updatedArtifact.body = body?.body || null;
                    updatedArtifact.bodyVersion = artifactUpdate.body.version;
                }
                
                if (!this.isGenerationCurrent(generation)) return;
                if (!this.artifactLifecycle.canApplyFetch(artifactId, artifactRevision)) return;
                storage.getState().updateArtifact(updatedArtifact);
                log.log('Updated artifact in storage');
            } catch {
                console.error('Failed to process artifact update');
            } finally {
                artifactEncryption?.dispose();
            }
        } else if (updateData.body.t === 'delete-artifact') {
            log.log('📦 Received delete-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            
            if (!this.artifactLifecycle.recordDelete(artifactId, updateData.seq)) return;

            // Remove from storage
            storage.getState().deleteArtifact(artifactId);
            
            // Remove encryption key from memory
            this.clearArtifactDataKey(artifactId);
        } else if (updateData.body.t === 'new-feed-post') {
            log.log('📰 Received new-feed-post update');
            const feedUpdate = updateData.body;
            
            // Convert to FeedItem with counter from cursor
            const feedItem: FeedItem = {
                id: feedUpdate.id,
                body: feedUpdate.body,
                cursor: feedUpdate.cursor,
                createdAt: feedUpdate.createdAt,
                repeatKey: feedUpdate.repeatKey,
                counter: parseInt(feedUpdate.cursor.substring(2), 10)
            };
            
            // Check if we need to fetch user for friend-related items
            if (feedItem.body && (feedItem.body.kind === 'friend_request' || feedItem.body.kind === 'friend_accepted')) {
                await this.assumeUsers([feedItem.body.uid]);
                if (!this.isGenerationCurrent(generation)) return;
                
                // Check if user fetch failed (404) - don't store item if user not found
                const users = storage.getState().users;
                const userProfile = users[feedItem.body.uid];
                if (userProfile === null || userProfile === undefined) {
                    // User was not found or 404, don't store this item
                    log.log('Skipping feed item because referenced user was not found');
                    return;
                }
            }
            
            // Apply to storage (will handle repeatKey replacement)
            storage.getState().applyFeedItems([feedItem]);
        }
    }

    private flushActivityUpdates = (updates: Map<string, ApiEphemeralActivityUpdate>) => {
        if (this.shutDown) return;
        // log.log(`🔄 Flushing activity updates for ${updates.size} sessions - acquiring lock`);


        const sessions: Session[] = [];

        for (const [sessionId, update] of updates) {
            const session = storage.getState().sessions[sessionId];
            const archiveBlocksHeartbeat = update.active && isSessionArchivePending(sessionId);
            if (session && !archiveBlocksHeartbeat && shouldApplySessionActivity(session, update)) {
                const archivedAt = update.archivedAt === undefined
                    ? session.archivedAt
                    : update.archivedAt;
                sessions.push({
                    ...session,
                    active: archivedAt === null && update.active,
                    activeAt: update.activeAt,
                    archivedAt,
                    thinking: update.thinking ?? false,
                    thinkingAt: update.activeAt // Always use activeAt for consistency
                });
            }
        }

        if (sessions.length > 0) {
            // console.log('flushing activity updates ' + sessions.length);
            this.applySessions(sessions);
            this.reconcileCodexV4Clients(Object.values(storage.getState().sessions));
            // log.log(`🔄 Activity updates flushed - updated ${sessions.length} sessions`);
        }
    }

    private handleEphemeralUpdate = (update: unknown) => {
        if (this.shutDown) return;
        const validatedUpdate = ApiEphemeralUpdateSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.error('Invalid ephemeral update received');
            return;
        } else {
            // console.log('Ephemeral update received:', update);
        }
        const updateData = validatedUpdate.data;

        // Process activity updates through smart debounce accumulator
        if (updateData.type === 'activity') {
            // console.log('adding activity update ' + updateData.id);
            this.activityAccumulator.addUpdate(updateData);
        }

        // Handle machine activity updates
        if (updateData.type === 'machine-activity') {
            // Update machine's active status and lastActiveAt
            const machine = storage.getState().machines[updateData.id];
            if (machine) {
                const updatedMachine: Machine = {
                    ...machine,
                    active: updateData.active,
                    activeAt: updateData.activeAt
                };
                storage.getState().applyMachines([updatedMachine]);
            }
        }

        // Session-level lifecycle event (finished, needs permission, asks question).
        // This is the same signal that triggers the mobile push — bump browser-tab
        // unread counter on these only, ignore the noisy per-message stream.
        if (updateData.type === 'session-event') {
            notifyUnreadMessage();
        }

        if (updateData.type === 'sync-v4-invalidate') {
            this.codexV4Clients.invalidate(updateData.sessionId, updateData.highWatermark);
        }

        // daemon-status ephemeral updates are deprecated, machine status is handled via machine-activity
    }

    //
    // Apply store
    //

    private applySessions = (sessions: SessionUpdate[]) => {
        const previousState = storage.getState();
        const active = previousState.getActiveSessions();
        storage.getState().applySessions(sessions);
        codexCommandDraftRecovery.reconcileAll();
        const newActive = storage.getState().getActiveSessions();
        this.applySessionDiff(active, newActive);
    }

    private applySessionDiff = (active: Session[], newActive: Session[]) => {
        let wasActive = new Set(active.map(s => s.id));
        let isActive = new Set(newActive.map(s => s.id));
        for (let s of active) {
            if (!isActive.has(s.id)) {
                voiceHooks.onSessionOffline(s.id, s.metadata ?? undefined);
            }
        }
        for (let s of newActive) {
            if (!wasActive.has(s.id)) {
                voiceHooks.onSessionOnline(s.id, s.metadata ?? undefined);
            }
        }
    }

    private reconcileCodexV4Clients(sessions: Array<{
        id: string;
        active: boolean;
        archivedAt?: number | null;
        metadata: Session['metadata'];
        originMachineId?: string | null;
    }>): void {
        const entries = sessions.flatMap((session) => {
            if (!isCodexV4SyncEligible(session.metadata)) return [];
            const sessionKey = this.encryption.getSessionDataKey(session.id);
            return sessionKey ? [{
                sessionId: session.id,
                sessionKey,
                machineId: session.metadata?.machineId ?? session.originMachineId ?? null,
                pollIntervalMs: codexV4PollIntervalMsForLifecycle(session),
            }] : [];
        });
        try {
            this.codexV4Clients.reconcile(entries);
        } finally {
            for (const entry of entries) entry.sessionKey.fill(0);
        }
    }

    private invalidateCodexV4Clients(): void {
        this.codexV4Clients.invalidateAll();
    }

    private stopCodexV4Client(sessionId: string): void {
        this.codexV4Clients.stop(sessionId);
    }

    quarantine(options?: { silent?: boolean }): void {
        if (this.shutDown) return;
        this.lifecycleGeneration += 1;
        this.shutDown = true;
        this.credentials = null;
        this.apiSocketPermit = null;
        endAccountOutboundLifecycle();
        for (const queue of [
            this.sessionsSync,
            this.settingsSync,
            this.profileSync,
            this.purchasesSync,
            this.machinesSync,
            this.pushTokenSync,
            this.nativeUpdateSync,
            this.artifactsSync,
            this.friendsSync,
            this.friendRequestsSync,
            this.feedSync,
        ]) {
            queue.stop();
        }
        this.activityAccumulator.reset();
        this.codexV4Clients.stopAll(options);
        gitStatusSync.shutdown();
        this.appStateSubscription?.remove();
        this.appStateSubscription = null;
        this.webListenerCleanup?.();
        this.webListenerCleanup = null;
        apiSocket.reset();
    }

    async shutdown(options?: { silent?: boolean }): Promise<void> {
        this.quarantine(options);
        if (this.shutdownCompleted) return;
        this.shutdownCompleted = true;
        // Provider shutdown can hang on a native SDK. Local account teardown
        // must continue immediately; stopRealtimeSession contains its own
        // provider error handling and clears local voice state synchronously.
        void stopRealtimeSession().catch(() => undefined);
        voiceHooks.onVoiceStopped();
        this.unsubscribeSocketUpdate?.();
        this.unsubscribeSocketEphemeral?.();
        this.unsubscribeSocketReconnected?.();
        this.unsubscribeSocketStatus?.();
        this.unsubscribeSocketUpdate = null;
        this.unsubscribeSocketEphemeral = null;
        this.unsubscribeSocketReconnected = null;
        this.unsubscribeSocketStatus = null;
        syncV4Persistence.clearAll();
        appSyncV4Diagnostics.clear();
        codexCommandDraftRecovery.clear();
        for (const key of this.sessionDataKeys.values()) key.fill(0);
        this.sessionDataKeys.clear();
        this.clearAllArtifactDataKeys();
        this.artifactLifecycle.clear();
        this.clearAllMachineDataKeys();
        this.encryptionCache.clearAll();
        this.encryption?.dispose();
        this.pendingSettings = {};
        this.credentials = null;
        this.serverID = '';
        this.anonID = '';
        this.revenueCatInitialized = false;
        storage.getState().resetForAccountSwitch();
    }

    setSocketStatusSubscription(unsubscribe: () => unknown): void {
        this.unsubscribeSocketStatus = unsubscribe;
    }

    setApiSocketPermit(permit: ApiSocketLifecyclePermit): void {
        this.apiSocketPermit = permit;
    }

}

// Global singleton instance
export let sync = new Sync();

//
// Init sequence
//

let isInitialized = false;

export async function syncCreate(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    try {
        if (sync.isShutdown()) {
            await sync.shutdown();
            apiSocket.reset();
            sync = new Sync();
        }
        await syncInit(credentials, false);
    } catch (error) {
        isInitialized = false;
        throw error;
    }
}

export async function syncRestore(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    try {
        if (sync.isShutdown()) {
            await sync.shutdown();
            apiSocket.reset();
            sync = new Sync();
        }
        await syncInit(credentials, true);
    } catch (error) {
        isInitialized = false;
        throw error;
    }
}

export async function syncShutdown(options?: { silent?: boolean }): Promise<void> {
    await sync.shutdown(options);
    apiSocket.reset();
    isInitialized = false;
}

export function syncQuarantine(options?: { silent?: boolean }): void {
    sync.quarantine(options);
    isInitialized = false;
}

async function syncInit(credentials: AuthCredentials, restore: boolean) {
    const targetSync = sync;

    // Initialize sync engine
    const secretKey = decodeBase64(credentials.secret, 'base64url');
    if (secretKey.length !== 32) {
        secretKey.fill(0);
        throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
    }
    const encryption = await Encryption.create(secretKey);
    if (sync !== targetSync || targetSync.isShutdown()) {
        // Account logout may race key derivation. Dispose the result even when
        // initialization loses that race so stale credentials are not retained.
        encryption.dispose();
        return;
    }

    try {
        beginAccountOutboundLifecycle(credentials.token);
        // Initialize tracking
        initializeTracking(encryption.anonID);

        // Initialize socket connection
        const API_ENDPOINT = getServerUrl();
        targetSync.setApiSocketPermit(
            apiSocket.initialize({ endpoint: API_ENDPOINT, token: credentials.token }, encryption),
        );

        // Wire socket status to storage
        targetSync.setSocketStatusSubscription(apiSocket.onStatusChange((status) => {
            if (targetSync.isShutdown()) return;
            storage.getState().setSocketStatus(status);
        }));

        // Initialize sessions engine
        if (restore) {
            await targetSync.restore(credentials, encryption);
        } else {
            await targetSync.create(credentials, encryption);
        }
    } catch (error) {
        // Initialization is all-or-nothing. A failed socket or initial sync
        // must release every derived key and reset the singleton so a later
        // login is not blocked by a stale "already initialized" state.
        try {
            await targetSync.shutdown();
        } finally {
            apiSocket.reset();
            encryption.dispose();
        }
        throw error;
    }
}
