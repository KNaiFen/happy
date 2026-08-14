import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
    settings: { voiceBypassToken: 'bypass-token', voiceCustomAgentId: 'agent-1' },
    setRealtimeStatus: vi.fn(),
};

vi.mock('@/sync/storage', () => ({
    storage: { getState: () => state },
}));
vi.mock('@/utils/microphonePermissions', () => ({
    requestMicrophonePermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
    showMicrophonePermissionDeniedAlert: vi.fn(),
}));
vi.mock('@/sync/apiVoice', () => ({ fetchVoiceCredentials: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: { presentPaywall: vi.fn() } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: vi.fn((key: string) => key) }));
vi.mock('./voiceSystemPrompt', () => ({
    buildVoiceFirstMessage: vi.fn(() => ''),
    buildVoiceSystemPrompt: vi.fn(() => ''),
}));
vi.mock('./voiceExperiment', () => ({ getVoiceUpsellVariant: vi.fn(() => 'none') }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: vi.fn() } }));
vi.mock('@/sync/persistence', () => ({
    getVoiceMessageCount: vi.fn(() => 0),
    getVoiceOnboardingPromptLoadCount: vi.fn(() => 0),
    getVoiceSoftPaywallShownCount: vi.fn(() => 0),
    incrementVoiceOnboardingPromptLoadCount: vi.fn(),
    incrementVoiceSoftPaywallShown: vi.fn(),
}));
vi.mock('./voiceLog', () => ({ voiceLog: vi.fn() }));

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function provider(endSession: () => Promise<void>) {
    return {
        startSession: vi.fn(async () => 'conversation-1'),
        endSession: vi.fn(endSession),
        sendTextMessage: vi.fn(),
        sendContextualUpdate: vi.fn(),
    };
}

describe('RealtimeSession provider lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.setRealtimeStatus.mockClear();
    });

    it('blocks a new start while the previous provider stop is unresolved', async () => {
        const stop = deferred<void>();
        const oldProvider = provider(() => stop.promise);
        const { registerVoiceSession, startRealtimeSession, stopRealtimeSession } = await import('./RealtimeSession');
        registerVoiceSession(oldProvider);

        const stopping = stopRealtimeSession();
        await Promise.resolve();
        expect(oldProvider.endSession).toHaveBeenCalledTimes(1);

        await expect(startRealtimeSession('session-1')).resolves.toBeNull();
        expect(oldProvider.startSession).not.toHaveBeenCalled();

        stop.resolve();
        await stopping;
        await expect(startRealtimeSession('session-1')).resolves.toBe('conversation-1');
        expect(oldProvider.startSession).toHaveBeenCalledTimes(1);
    });

    it('does not let a stale provider stop completion overwrite a replacement provider', async () => {
        const stop = deferred<void>();
        const oldProvider = provider(() => stop.promise);
        const newProvider = provider(async () => undefined);
        const { registerVoiceSession, startRealtimeSession, stopRealtimeSession } = await import('./RealtimeSession');
        registerVoiceSession(oldProvider);
        const stopping = stopRealtimeSession();
        registerVoiceSession(newProvider);

        await expect(startRealtimeSession('session-2')).resolves.toBe('conversation-1');
        state.setRealtimeStatus.mockClear();
        stop.resolve();
        await stopping;

        expect(state.setRealtimeStatus).not.toHaveBeenCalledWith('disconnected');
    });
});
