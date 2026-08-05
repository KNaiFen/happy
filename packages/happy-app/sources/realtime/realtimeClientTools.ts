import { z } from 'zod';
import { sync } from '@/sync/sync';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { trackVoicePermissionResponse } from '@/track';
import { getVoiceSession, isVoiceSessionStarted } from './RealtimeSession';
import {
    getVoiceMessageCount,
    incrementVoiceMessageCount,
} from '@/sync/persistence';
import { voiceLog } from './voiceLog';

/**
 * Static client tools for the realtime voice interface.
 * These tools allow the voice assistant to interact with supported coding sessions.
 */
export const realtimeClientTools = {
    /**
     * Send a message to a specific coding session
     */
    sendMessageToSession: async (parameters: unknown) => {
        const schema = z.object({
            sessionId: z.string().min(1),
            message: z.string().min(1)
        });
        const parsed = schema.safeParse(parameters);

        if (!parsed.success) {
            voiceLog('tool.parameters.invalid', { tool: 'message' }, 'error');
            return "error (invalid parameters)";
        }

        const { sessionId, message } = parsed.data;
        await sync.sendMessage(sessionId, message, { source: 'voice' });
        voiceLog('tool.message.sent', { tool: 'message', outcome: 'success' });
        incrementVoiceMessageCount();
        const voiceMessageCount = getVoiceMessageCount();
        if (isVoiceSessionStarted()) {
            getVoiceSession()?.sendContextualUpdate([
                '# Runtime counters updated',
                `- voice_message_count: ${voiceMessageCount}`,
            ].join('\n'));
        }
        return "sent [DO NOT say anything else, simply say 'sent']";
    },

    /**
     * Respond to a permission request from a coding session
     */
    processPermissionRequest: async (parameters: unknown) => {
        const schema = z.object({
            requestId: z.string().min(1),
            decision: z.enum(['allow', 'deny'])
        });
        const parsed = schema.safeParse(parameters);

        if (!parsed.success) {
            voiceLog('tool.parameters.invalid', { tool: 'permission' }, 'error');
            return "error (invalid parameters)";
        }

        const { requestId, decision } = parsed.data;

        // Find which session owns this request
        const sessions = storage.getState().sessions;
        let sessionId: string | null = null;
        for (const [id, session] of Object.entries(sessions)) {
            if (session?.agentState?.requests?.[requestId]) {
                sessionId = id;
                break;
            }
        }

        if (!sessionId) {
            voiceLog('tool.permission.missing', { tool: 'permission', outcome: 'blocked' }, 'warn');
            return "error (permission request not found)";
        }

        try {
            if (decision === 'allow') {
                await sessionAllow(sessionId, requestId);
                trackVoicePermissionResponse(true);
            } else {
                await sessionDeny(sessionId, requestId);
                trackVoicePermissionResponse(false);
            }
            voiceLog('tool.permission.resolved', {
                tool: 'permission',
                decision,
                outcome: 'success',
            });
            return "done [DO NOT say anything else, simply say 'done']";
        } catch {
            voiceLog('tool.permission.failed', {
                tool: 'permission',
                decision,
                outcome: 'failed',
            }, 'error');
            return `error (failed to ${decision} permission)`;
        }
    }
};
