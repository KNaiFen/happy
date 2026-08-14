import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react-native';
import {
    isCurrentVoiceProviderGeneration,
    isRegisteredVoiceSession,
    registerVoiceSession,
    unregisterVoiceSession,
} from './RealtimeSession';
import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { getElevenLabsCodeFromPreference } from '@/constants/Languages';
import type { VoiceSession, VoiceSessionConfig } from './types';
import { voiceLog } from './voiceLog';

// Static reference to the conversation hook instance
let conversationInstance: ReturnType<typeof useConversation> | null = null;

// VAD state for user speech detection
const VAD_THRESHOLD = 0.5;
const VAD_SILENCE_MS = 300;
let vadSilenceTimer: ReturnType<typeof setTimeout> | null = null;
let agentIsSpeaking = false;

// Global voice session implementation
class RealtimeVoiceSessionImpl implements VoiceSession {
    constructor(private readonly conversation: ReturnType<typeof useConversation>) {}

    
    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        if (!this.conversation) {
            voiceLog('session.unavailable', undefined, 'warn');
            throw new Error('Realtime voice session not initialized');
        }

        try {
            storage.getState().setRealtimeStatus('connecting');
            
            // Get user's preferred language for voice assistant
            const userLanguagePreference = storage.getState().settings.voiceAssistantLanguage;
            const elevenLabsLanguage = getElevenLabsCodeFromPreference(userLanguagePreference);
            
            if (!config.conversationToken && !config.agentId) {
                throw new Error('No conversationToken or agentId provided');
            }

            const sessionConfig: any = {
                // conversationToken (WebRTC JWT from server) or agentId (bypass mode)
                ...(config.conversationToken
                    ? { conversationToken: config.conversationToken }
                    : { agentId: config.agentId }),
                userId: config.userId,
                dynamicVariables: {
                    sessionId: config.sessionId,
                    initialConversationContext: config.initialContext || ''
                },
                overrides: {
                    agent: {
                        ...(config.systemPrompt ? { prompt: { prompt: config.systemPrompt } } : {}),
                        ...(config.firstMessage ? { firstMessage: config.firstMessage } : {}),
                        language: elevenLabsLanguage
                    }
                },
            };
            
            await this.conversation.startSession(sessionConfig);
            return this.conversation.getId?.() ?? null;
        } catch (error) {
            voiceLog('provider.error', { outcome: 'failed' }, 'error');
            storage.getState().setRealtimeStatus('error');
            throw error;
        }
    }

    async endSession(): Promise<void> {
        if (!this.conversation) {
            storage.getState().setRealtimeStatus('disconnected');
            return;
        }

        try {
            await this.conversation.endSession();
        } catch {
            voiceLog('provider.error', { outcome: 'failed' }, 'error');
        } finally {
            if (isRegisteredVoiceSession(this)) {
                storage.getState().setRealtimeStatus('disconnected');
            }
        }
    }

    sendTextMessage(message: string): void {
        if (!this.conversation) {
            voiceLog('session.unavailable', undefined, 'warn');
            return;
        }

        try {
            this.conversation.sendUserMessage(message);
        } catch {
            voiceLog('provider.send.failed', { outcome: 'failed' }, 'error');
        }
    }

    sendContextualUpdate(update: string): void {
        if (!this.conversation) {
            voiceLog('session.unavailable', undefined, 'warn');
            return;
        }

        try {
            this.conversation.sendContextualUpdate(update);
        } catch {
            voiceLog('provider.send.failed', { outcome: 'failed' }, 'error');
        }
    }
}

export const RealtimeVoiceSession: React.FC = () => {
    const providerGenerationRef = useRef<number | null>(null);
    const conversation = useConversation({
        clientTools: realtimeClientTools,
        onConnect: () => {
            if (providerGenerationRef.current === null || !isCurrentVoiceProviderGeneration(providerGenerationRef.current)) return;
            voiceLog('provider.connected', { outcome: 'success' }, 'info');
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle');
        },
        onDisconnect: () => {
            if (providerGenerationRef.current === null || !isCurrentVoiceProviderGeneration(providerGenerationRef.current)) return;
            voiceLog('provider.disconnected', undefined, 'info');
            // Bump generation only when an active session ends — skipping the
            // initial 'disconnected' state avoids remounting on cold launch
            // (which previously caused a phantom keyboard).
            const prev = storage.getState().realtimeStatus;
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true);
            storage.getState().clearRealtimeModeDebounce();
            if (prev === 'connected' || prev === 'connecting') {
                storage.getState().incrementVoiceSessionGeneration();
            }
        },
        onMessage: () => {
            voiceLog('provider.message.received');
        },
        onError: () => {
            // Log but don't block app - voice features will be unavailable
            // This prevents initialization errors from showing "Terminals error" on startup
            voiceLog('provider.error', { outcome: 'failed' }, 'warn');
            // Don't set error status during initialization - just set disconnected
            // This allows the app to continue working without voice features.
            // Don't bump generation here — onError can fire on transient/recoverable
            // errors (LiveKit retries internally). onDisconnect is where we know
            // the session is truly dead and a fresh provider is required.
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true); // immediate mode change
        },
        onStatusChange: () => {
            voiceLog('provider.status.changed');
        },
        onModeChange: (data) => {
            const mode = data.mode as string;
            voiceLog('provider.mode.changed', {
                mode: mode === 'speaking' || mode === 'listening' ? mode : 'other',
            });
            agentIsSpeaking = mode === 'speaking';

            // Use centralized debounce logic from storage
            if (agentIsSpeaking) {
                storage.getState().setRealtimeMode('agent-speaking');
            } else {
                // Agent stopped speaking — defer to VAD for user-speaking, otherwise idle
                storage.getState().setRealtimeMode('idle');
            }
        },
        onVadScore: (data) => {
            const { vadScore } = data;
            if (agentIsSpeaking) return; // Agent speaking takes priority

            if (vadScore > VAD_THRESHOLD) {
                if (vadSilenceTimer) {
                    clearTimeout(vadSilenceTimer);
                    vadSilenceTimer = null;
                }
                storage.getState().setRealtimeMode('user-speaking', true);
            } else {
                if (!vadSilenceTimer) {
                    vadSilenceTimer = setTimeout(() => {
                        vadSilenceTimer = null;
                        if (!agentIsSpeaking) {
                            storage.getState().setRealtimeMode('idle');
                        }
                    }, VAD_SILENCE_MS);
                }
            }
        },
        onDebug: () => {
            voiceLog('provider.debug');
        }
    });

    const hasRegistered = useRef(false);
    const voiceSessionRef = useRef<RealtimeVoiceSessionImpl | null>(null);

    useEffect(() => {
        // Store the conversation instance globally
        conversationInstance = conversation;

        // Register the voice session once
        if (!hasRegistered.current) {
            try {
                const registeredSession = new RealtimeVoiceSessionImpl(conversation);
                voiceSessionRef.current = registeredSession;
                providerGenerationRef.current = registerVoiceSession(registeredSession);
                hasRegistered.current = true;
            } catch {
                voiceLog('provider.registration.failed', { outcome: 'failed' }, 'error');
            }
        }

        return () => {
            // Clean up on unmount
            conversationInstance = null;
            providerGenerationRef.current = null;
            unregisterVoiceSession(voiceSessionRef.current ?? undefined);
            voiceSessionRef.current = null;
            hasRegistered.current = false;
        };
    }, [conversation]);

    // This component doesn't render anything visible
    return null;
};
