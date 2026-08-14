import type { VoiceSession } from './types';
import { fetchVoiceCredentials } from '@/sync/apiVoice';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/tokenStorage';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { storage } from '@/sync/storage';
import {
    getVoiceMessageCount,
    getVoiceOnboardingPromptLoadCount,
    getVoiceSoftPaywallShownCount,
    incrementVoiceOnboardingPromptLoadCount,
    incrementVoiceSoftPaywallShown,
} from '@/sync/persistence';
import { buildVoiceFirstMessage, buildVoiceSystemPrompt } from './voiceSystemPrompt';
import { getVoiceUpsellVariant } from './voiceExperiment';
import { voiceLog } from './voiceLog';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;
let currentVoiceConversationId: string | null = null;
let currentVoiceSessionStartedAt: number | null = null;
let voiceLifecycleGeneration = 0;
let voiceProviderGeneration = 0;
const pendingProviderStops = new Map<VoiceSession, Promise<void>>();

function clearVoiceState(): void {
    currentSessionId = null;
    currentVoiceConversationId = null;
    currentVoiceSessionStartedAt = null;
    voiceSessionStarted = false;
}

function isVoiceStartCurrent(generation: number, provider: VoiceSession): boolean {
    return generation === voiceLifecycleGeneration && voiceSession === provider;
}

/**
 * Start a voice session. Returns the ElevenLabs conversation ID if started, null otherwise.
 */
export async function startRealtimeSession(sessionId: string, initialContext?: string): Promise<string | null> {
    const generation = ++voiceLifecycleGeneration;
    currentVoiceConversationId = null;
    currentVoiceSessionStartedAt = null;

    const provider = voiceSession;
    if (!provider) {
        voiceLog('session.unavailable', undefined, 'warn');
        return null;
    }
    // A provider instance must not be reused while its previous end operation
    // is unresolved. Native SDKs may deliver a late disconnect from that stop;
    // allowing a new start here would let the stale callback corrupt it.
    if (pendingProviderStops.has(provider)) {
        voiceLog('session.start.failed', { outcome: 'failed' }, 'warn');
        storage.getState().setRealtimeStatus('disconnected');
        return null;
    }

    // Show connecting state immediately so the user sees feedback
    storage.getState().setRealtimeStatus('connecting');

    // Request microphone permission before starting voice session
    // Critical for iOS/Android - first session will fail without this
    const permissionResult = await requestMicrophonePermission();
    if (!isVoiceStartCurrent(generation, provider)) return null;
    if (!permissionResult.granted) {
        storage.getState().setRealtimeStatus('disconnected');
        showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
        return null;
    }

    try {
        // Bypass Happy server token — only when user has their own custom agent
        const { voiceBypassToken, voiceCustomAgentId } = storage.getState().settings;
        if (voiceBypassToken && voiceCustomAgentId) {
            voiceLog('session.start.requested', { source: 'byo' }, 'info');
            currentSessionId = sessionId;
            const conversationId = await provider.startSession({
                sessionId,
                initialContext,
                agentId: voiceCustomAgentId,
            });
            if (!isVoiceStartCurrent(generation, provider)) {
                await provider.endSession().catch(() => undefined);
                return null;
            }
            currentVoiceConversationId = conversationId;
            currentVoiceSessionStartedAt = Date.now();
            voiceSessionStarted = true;
            voiceLog('session.start.succeeded', { source: 'byo', outcome: 'success' }, 'info');
            return conversationId;
        }

        const credentials = await TokenStorage.getCredentials();
        if (!isVoiceStartCurrent(generation, provider)) return null;
        if (!credentials) {
            storage.getState().setRealtimeStatus('disconnected');
            Modal.alert(t('common.error'), t('errors.authenticationFailed'));
            return null;
        }

        voiceLog('session.start.requested', { source: 'managed' }, 'info');
        const response = await fetchVoiceCredentials(credentials, sessionId);
        if (!isVoiceStartCurrent(generation, provider)) return null;
        voiceLog('credentials.received', { source: 'managed', outcome: 'success' });

        if (!response.allowed) {
            storage.getState().setRealtimeStatus('disconnected');

            if (response.reason === 'voice_conversation_limit_reached') {
                Modal.alert(
                    t('errors.voiceLimitReachedTitle'),
                    t('errors.voiceConversationLimitReached'),
                );
                return null;
            }

            // Server hard-declined — must pay to continue
            voiceLog('credentials.blocked', {
                source: 'managed',
                outcome: 'blocked',
                reason: response.reason,
            }, 'info');
            const result = await sync.presentPaywall('voice_must_pay');
            if (!isVoiceStartCurrent(generation, provider)) return null;
            voiceLog('paywall.completed', { purchased: result.purchased });
            if (result.purchased) {
                return startRealtimeSession(sessionId, initialContext);
            }
            return null;
        }

        const hasPro = storage.getState().purchases.entitlements['pro'] ?? false;
        const { voiceUpsellOverride, devModeEnabled } = storage.getState().localSettings;
        const voiceUpsellVariant = getVoiceUpsellVariant({
            override: voiceUpsellOverride,
            overrideEnabled: __DEV__ || devModeEnabled,
        });

        if (
            !hasPro &&
            voiceUpsellVariant === 'show-paywall-before-first-voice-chat' &&
            getVoiceSoftPaywallShownCount() < 1
        ) {
            voiceLog('paywall.shown');
            incrementVoiceSoftPaywallShown();
            const result = await sync.presentPaywall('voice_trial_eligible');
            if (!isVoiceStartCurrent(generation, provider)) return null;
            voiceLog('paywall.completed', { purchased: result.purchased });
            // Dismissed or error — continue anyway, they can still use free tier.
        }

        currentSessionId = sessionId;
        const onboardingPromptLoadCount = getVoiceOnboardingPromptLoadCount();
        const voiceMessageCount = getVoiceMessageCount();
        const systemPrompt = buildVoiceSystemPrompt({
            initialContext,
            onboardingPromptLoadCount,
            voiceMessageCount,
            includePaidVoiceOnboarding: !hasPro && voiceUpsellVariant === 'voice-onboarding-and-upsell',
        });
        const firstMessage = buildVoiceFirstMessage({
            hasPro,
            onboardingPromptLoadCount,
            includePaidVoiceOnboarding: voiceUpsellVariant === 'voice-onboarding-and-upsell',
        });

        const startedConversationId = await provider.startSession({
            sessionId,
            initialContext,
            systemPrompt,
            firstMessage,
            conversationToken: response.conversationToken,
            agentId: response.agentId,
            userId: response.elevenUserId,
        });
        if (!isVoiceStartCurrent(generation, provider)) {
            await provider.endSession().catch(() => undefined);
            return null;
        }
        if (!hasPro && voiceUpsellVariant === 'voice-onboarding-and-upsell') {
            incrementVoiceOnboardingPromptLoadCount();
        }
        currentVoiceConversationId = response.conversationId ?? startedConversationId;
        currentVoiceSessionStartedAt = Date.now();
        voiceSessionStarted = true;
        voiceLog('session.start.succeeded', { source: 'managed', outcome: 'success' }, 'info');
        return currentVoiceConversationId;
    } catch {
        if (!isVoiceStartCurrent(generation, provider)) return null;
        voiceLog('session.start.failed', { outcome: 'failed' }, 'error');
        storage.getState().setRealtimeStatus('disconnected');
        currentSessionId = null;
        currentVoiceConversationId = null;
        currentVoiceSessionStartedAt = null;
        voiceSessionStarted = false;
        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
        return null;
    }
}

export async function stopRealtimeSession() {
    ++voiceLifecycleGeneration;
    const provider = voiceSession;
    // Local logout must not retain an active voice state while a provider is
    // slow or stuck. Provider shutdown remains best-effort below.
    clearVoiceState();
    if (!provider) {
        return;
    }

    const existingStop = pendingProviderStops.get(provider) ?? null;
    const stopPromise = existingStop ?? (async () => {
        try {
            await provider.endSession();
        } catch {
            voiceLog('session.stop.failed', { outcome: 'failed' }, 'error');
        }
    })();
    if (!existingStop) pendingProviderStops.set(provider, stopPromise);
    try {
        await stopPromise;
    } finally {
        if (pendingProviderStops.get(provider) === stopPromise) pendingProviderStops.delete(provider);
    }
}

export function registerVoiceSession(session: VoiceSession): number {
    voiceProviderGeneration += 1;
    if (voiceSession) {
        voiceLog('session.replaced', undefined, 'warn');
    }
    voiceSession = session;
    return voiceProviderGeneration;
}

/** Unregister a provider that is being unmounted; stale starts then fail closed. */
export function unregisterVoiceSession(session?: VoiceSession): void {
    if (session && voiceSession !== session) return;
    voiceLifecycleGeneration += 1;
    voiceProviderGeneration += 1;
    voiceSession = null;
    clearVoiceState();
}

export function isVoiceSessionStarted(): boolean {
    return voiceSessionStarted;
}

export function getVoiceSession(): VoiceSession | null {
    return voiceSession;
}

/** True only while a provider is still the registered lifecycle owner. */
export function isRegisteredVoiceSession(provider: VoiceSession): boolean {
    return voiceSession === provider;
}

export function isCurrentVoiceProviderGeneration(generation: number): boolean {
    return generation === voiceProviderGeneration;
}

export function getCurrentRealtimeSessionId(): string | null {
    return currentSessionId;
}

export function getCurrentVoiceConversationId(): string | null {
    return currentVoiceConversationId;
}

export function getCurrentVoiceSessionDurationSeconds(): number | undefined {
    if (currentVoiceSessionStartedAt === null) {
        return undefined;
    }
    return Math.max(0, Math.round((Date.now() - currentVoiceSessionStartedAt) / 1000));
}

export function setCurrentRealtimeSessionId(sessionId: string) {
    currentSessionId = sessionId;
}
