import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const storageState = {
        artifacts: {} as Record<string, unknown>,
        settings: {} as Record<string, unknown>,
        settingsVersion: 0,
        deleteArtifact: vi.fn((artifactId: string) => {
            delete storageState.artifacts[artifactId];
        }),
        applyArtifactSnapshot: vi.fn(),
        resetForAccountSwitch: vi.fn(),
    };
    return {
        deleteArtifactRequest: vi.fn(),
        fetchArtifacts: vi.fn(),
        decryptHeader: vi.fn(async () => ({ title: 'artifact' })),
        applySettings: vi.fn((_settings: unknown, patch: unknown) => patch),
        settingsToSyncPayload: vi.fn((settings: unknown) => settings),
        queueStop: vi.fn(),
        v4StopAll: vi.fn(),
        gitStatusShutdown: vi.fn(),
        apiSocketReset: vi.fn(),
        storageState,
    };
});

class InvalidateSyncMock {
    constructor(_command: () => Promise<void>) {}
    invalidate(): void {}
    invalidateAndAwait(): Promise<void> { return Promise.resolve(); }
    awaitQueue(): Promise<void> { return Promise.resolve(); }
    stop(): void { mocks.queueStop(); }
}

class CodexV4ClientRegistryMock {
    reconcile(): void {}
    invalidateAll(): void {}
    invalidate(): void {}
    stop(): void {}
    stopAll(options?: unknown): void { mocks.v4StopAll(options); }
    withClient(): Promise<void> { return Promise.resolve(); }
}

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'operation-id' }));
vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    AppState: {
        currentState: 'active',
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
}));
vi.mock('@/utils/sync', () => ({ InvalidateSync: InvalidateSyncMock }));
vi.mock('./reducer/activityUpdateAccumulator', () => ({
    ActivityUpdateAccumulator: class {
        reset(): void {}
    },
    shouldApplySessionActivity: vi.fn(() => true),
}));
vi.mock('./encryption/encryptionCache', () => ({
    EncryptionCache: class { clearAll(): void {} },
}));
vi.mock('./codexV4ClientRegistry', () => ({
    CodexV4ClientRegistry: CodexV4ClientRegistryMock,
    codexV4PollIntervalMsForLifecycle: vi.fn(() => null),
    isCodexV4SyncActive: vi.fn(() => false),
    isCodexV4SyncEligible: vi.fn(() => false),
}));
vi.mock('./apiArtifacts', () => ({
    createArtifact: vi.fn(),
    deleteArtifact: mocks.deleteArtifactRequest,
    fetchArtifact: vi.fn(),
    fetchArtifacts: mocks.fetchArtifacts,
    updateArtifact: vi.fn(),
}));
vi.mock('./encryption/artifactEncryption', () => ({
    ArtifactEncryption: class {
        decryptHeader = mocks.decryptHeader;
        dispose(): void {}
    },
}));
vi.mock('./storage', () => ({ storage: { getState: () => mocks.storageState } }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://happy.example' }));
vi.mock('./persistence', () => ({
    loadPendingSettings: () => ({}),
    savePendingSettings: vi.fn(),
}));
vi.mock('@/sync/apiSocket', () => ({
    apiSocket: {
        sendAppState: vi.fn(),
        reset: mocks.apiSocketReset,
        onStatusChange: vi.fn(() => vi.fn()),
    },
    getCurrentAppState: () => 'active',
    getHappyClientId: () => 'test-client',
}));
vi.mock('@/sync/webTabTitle', () => ({ notifyUnreadMessage: vi.fn() }));
vi.mock('@/auth/tokenStorage', () => ({}));
vi.mock('@/sync/encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('@/encryption/base64', () => ({ decodeBase64: vi.fn(), encodeBase64: vi.fn() }));
vi.mock('./attachmentSupport', () => ({ getImageAttachmentSendPlan: vi.fn() }));
vi.mock('./attachmentDiagnostics', () => ({
    errorMessageFromUnknown: vi.fn(),
    formatAttachmentDiagnosticForLog: vi.fn(),
    getAttachmentDiagnostic: vi.fn(),
}));
vi.mock('./apiTypes', () => ({ ApiEphemeralUpdateSchema: {}, ApiUpdateContainerSchema: {} }));
vi.mock('./settings', () => ({
    applySettings: mocks.applySettings,
    settingsDefaults: {},
    settingsParse: vi.fn(),
    settingsToSyncPayload: mocks.settingsToSyncPayload,
    SUPPORTED_SCHEMA_VERSION: 1,
}));
vi.mock('./profile', () => ({ applyProfile: vi.fn(), profileParse: vi.fn() }));
vi.mock('./pushRegistration', () => ({ syncCurrentPushToken: vi.fn() }));
vi.mock('@/track', () => ({
    initializeTracking: vi.fn(),
    trackGitHubConnected: vi.fn(),
    trackMessageSent: vi.fn(),
    tracking: {},
    trackPaywallCancelled: vi.fn(),
    trackPaywallError: vi.fn(),
    trackPaywallPresented: vi.fn(),
    trackPaywallPurchased: vi.fn(),
    trackPaywallRestored: vi.fn(),
}));
vi.mock('@/utils/parseToken', () => ({ parseToken: vi.fn() }));
vi.mock('./revenueCat', () => ({ RevenueCat: {}, LogLevel: {}, PaywallResult: {} }));
vi.mock('@/config', () => ({ config: {} }));
vi.mock('@/log', () => ({ log: { log: vi.fn() } }));
vi.mock('./gitStatusSync', () => ({
    gitStatusSync: { getSync: vi.fn(() => ({ invalidate: vi.fn() })), shutdown: mocks.gitStatusShutdown },
}));
vi.mock('@/realtime/hooks/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onVoiceStopped: vi.fn(),
    },
}));
vi.mock('./prompt/systemPrompt', () => ({ systemPrompt: '' }));
vi.mock('./apiFriends', () => ({ getFriendsList: vi.fn(), getUserProfile: vi.fn() }));
vi.mock('./apiFeed', () => ({ fetchFeed: vi.fn() }));
vi.mock('./messageMeta', () => ({ resolveMessageModeMeta: vi.fn() }));
vi.mock('./apiAttachments', () => ({ requestAttachmentUpload: vi.fn(), uploadEncryptedBlob: vi.fn() }));
vi.mock('@/encryption/blob', () => ({ encryptBlob: vi.fn() }));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/text', () => ({ t: vi.fn() }));
vi.mock('./sessionFlavor', () => ({ assertSupportedExistingSession: vi.fn() }));
vi.mock('./syncV4Client', () => ({ AppSyncV4Client: { create: vi.fn() } }));
vi.mock('./syncV4Entropy', () => ({ nativeSyncV4Entropy: {} }));
vi.mock('./syncV4Persistence.mmkv', () => ({
    syncV4Persistence: { clearAll: vi.fn() },
}));
vi.mock('./syncV4Transport', () => ({ HttpAppSyncV4Transport: class {} }));
vi.mock('./syncV4Diagnostics.mmkv', () => ({
    appSyncV4Diagnostics: { clear: vi.fn(), stats: vi.fn(() => ({})) },
}));
vi.mock('./codexV4Commands', () => ({
    commandForCodexV4Input: vi.fn(),
    createCodexV4Command: vi.fn(),
    parseCodexV4Input: vi.fn(),
}));
vi.mock('./codexV4Projection', () => ({ createCodexV4Projection: vi.fn() }));
vi.mock('./codexCommandDraftRecovery.mmkv', () => ({
    codexCommandDraftRecovery: { clear: vi.fn(), reconcileSession: vi.fn(), record: vi.fn() },
}));
vi.mock('./codexV4Capabilities', () => ({
    assertCodexV4CommandPublishAllowed: vi.fn(),
    resolveCodexV4SessionCapabilities: vi.fn(),
}));
vi.mock('./sessionMachineAccess', () => ({ isSessionMachineDeleted: vi.fn(() => false) }));
vi.mock('./sessionLifecycle', () => ({ normalizeFetchedSessionLifecycle: vi.fn((value) => value) }));
vi.mock('@/realtime/RealtimeSession', () => ({ stopRealtimeSession: vi.fn(async () => undefined) }));

const credentials = { token: 'old-token', secret: 'old-secret' };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function loadSync() {
    vi.resetModules();
    return import('./sync');
}

function authenticate(sync: unknown): void {
    (sync as { credentials: typeof credentials }).credentials = credentials;
}

describe('artifact account-generation fencing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.storageState.artifacts = {};
        mocks.deleteArtifactRequest.mockReset();
        mocks.fetchArtifacts.mockReset();
        mocks.decryptHeader.mockResolvedValue({ title: 'artifact' });
    });

    it('does not delete a new-account artifact when an old delete resolves after quarantine', async () => {
        const pendingDelete = deferred<{ success: true; updateSeq: number }>();
        mocks.deleteArtifactRequest.mockReturnValueOnce(pendingDelete.promise);
        const { sync, syncQuarantine } = await loadSync();
        authenticate(sync);

        const deletion = sync.deleteArtifact('shared-artifact-id');
        expect(mocks.deleteArtifactRequest).toHaveBeenCalledWith(credentials, 'shared-artifact-id');

        syncQuarantine();
        const newAccountArtifact = { id: 'shared-artifact-id', owner: 'new-account' };
        mocks.storageState.artifacts = { 'shared-artifact-id': newAccountArtifact };
        pendingDelete.resolve({ success: true, updateSeq: 42 });
        await expect(deletion).resolves.toBeUndefined();

        expect(mocks.storageState.deleteArtifact).not.toHaveBeenCalled();
        expect(mocks.storageState.artifacts['shared-artifact-id']).toBe(newAccountArtifact);
    });

    it('zeroes every candidate key when quarantine interrupts snapshot decryption', async () => {
        const firstKey = new Uint8Array([1, 2, 3]);
        const secondKey = new Uint8Array([4, 5, 6]);
        const pendingSecondKey = deferred<Uint8Array>();
        const secondDecryptStarted = deferred<void>();
        const { sync, syncQuarantine } = await loadSync();
        authenticate(sync);
        sync.encryption = {
            decryptEncryptionKey: vi.fn()
                .mockResolvedValueOnce(firstKey)
                .mockImplementationOnce(() => {
                    secondDecryptStarted.resolve();
                    return pendingSecondKey.promise;
                }),
        } as never;
        mocks.fetchArtifacts.mockResolvedValueOnce({
            highWatermark: 10,
            artifacts: [
                { id: 'artifact-1', header: 'one', headerVersion: 1, dataEncryptionKey: 'key-1', seq: 0, updateSeq: 1, createdAt: 1, updatedAt: 1 },
                { id: 'artifact-2', header: 'two', headerVersion: 1, dataEncryptionKey: 'key-2', seq: 0, updateSeq: 2, createdAt: 1, updatedAt: 1 },
            ],
        });

        const fetching = sync.fetchArtifactsList();
        await secondDecryptStarted.promise;
        syncQuarantine();
        pendingSecondKey.resolve(secondKey);
        await expect(fetching).resolves.toBeUndefined();

        expect([...firstKey]).toEqual([0, 0, 0]);
        expect([...secondKey]).toEqual([0, 0, 0]);
        expect(mocks.storageState.applyArtifactSnapshot).not.toHaveBeenCalled();
    });
});

describe('Sync quarantine outbound fencing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.storageState.settings = {};
        mocks.storageState.settingsVersion = 0;
    });

    it('does not post settings when quarantine happens while encryption is pending', async () => {
        const encryptedSettings = deferred<string>();
        const encryptionStarted = deferred<void>();
        const originalFetch = globalThis.fetch;
        const fetchMock = vi.fn<typeof fetch>();
        globalThis.fetch = fetchMock;
        try {
            const { sync, syncQuarantine } = await loadSync();
            authenticate(sync);
            const { beginAccountOutboundLifecycle } = await import('./accountOutboundFence');
            beginAccountOutboundLifecycle(credentials.token);
            sync.encryption = {
                encryptRaw: vi.fn(() => {
                    encryptionStarted.resolve();
                    return encryptedSettings.promise;
                }),
            } as never;
            (sync as unknown as { pendingSettings: Record<string, unknown> }).pendingSettings = {
                analyticsOptOut: true,
            };

            const syncing = (sync as unknown as { syncSettings: () => Promise<void> }).syncSettings();
            await encryptionStarted.promise;
            syncQuarantine();
            encryptedSettings.resolve('encrypted-settings');
            await expect(syncing).resolves.toBeUndefined();

            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('synchronously stops every outbound subsystem', async () => {
        const { sync, syncQuarantine } = await loadSync();
        authenticate(sync);

        syncQuarantine({ silent: true });

        expect(mocks.queueStop).toHaveBeenCalledTimes(11);
        expect(mocks.v4StopAll).toHaveBeenCalledOnce();
        expect(mocks.v4StopAll).toHaveBeenCalledWith({ silent: true });
        expect(mocks.gitStatusShutdown).toHaveBeenCalledOnce();
        expect(mocks.apiSocketReset).toHaveBeenCalledOnce();
    });
});
