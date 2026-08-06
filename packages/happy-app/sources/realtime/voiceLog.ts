const VOICE_LOG_EVENTS = [
    'context.dispatch',
    'prompt.dispatch',
    'hooks.started',
    'hooks.stopped',
    'session.unavailable',
    'session.start.requested',
    'session.start.succeeded',
    'session.start.failed',
    'session.stop.failed',
    'session.replaced',
    'credentials.received',
    'credentials.blocked',
    'paywall.shown',
    'paywall.completed',
    'provider.connected',
    'provider.disconnected',
    'provider.message.received',
    'provider.error',
    'provider.status.changed',
    'provider.mode.changed',
    'provider.debug',
    'provider.registered',
    'provider.registration.failed',
    'provider.microphone.denied',
    'provider.send.failed',
    'microphone.permission.denied',
    'microphone.permission.request.failed',
    'microphone.permission.check.failed',
    'tool.parameters.invalid',
    'tool.message.sent',
    'tool.permission.missing',
    'tool.permission.resolved',
    'tool.permission.failed',
    'event.rejected',
] as const;

export type VoiceLogEvent = typeof VOICE_LOG_EVENTS[number];
export type VoiceLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface VoiceLogFields {
    source?: 'managed' | 'byo';
    outcome?: 'success' | 'blocked' | 'failed';
    reason?: 'voice_hard_limit_reached' | 'subscription_required' | 'voice_conversation_limit_reached';
    mode?: 'speaking' | 'listening' | 'other';
    tool?: 'message' | 'permission';
    decision?: 'allow' | 'deny';
    hasPayload?: boolean;
    purchased?: boolean;
}

const eventAllowlist = new Set<string>(VOICE_LOG_EVENTS);
const fieldAllowlist = {
    source: new Set(['managed', 'byo']),
    outcome: new Set(['success', 'blocked', 'failed']),
    reason: new Set([
        'voice_hard_limit_reached',
        'subscription_required',
        'voice_conversation_limit_reached',
    ]),
    mode: new Set(['speaking', 'listening', 'other']),
    tool: new Set(['message', 'permission']),
    decision: new Set(['allow', 'deny']),
} as const;

function sanitizeVoiceLogFields(fields: unknown): Record<string, string | boolean> {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
    const input = fields as Record<string, unknown>;
    const safe: Record<string, string | boolean> = {};

    for (const key of Object.keys(fieldAllowlist) as Array<keyof typeof fieldAllowlist>) {
        const value = input[key];
        if (typeof value === 'string' && fieldAllowlist[key].has(value as never)) {
            safe[key] = value;
        }
    }
    for (const key of ['hasPayload', 'purchased'] as const) {
        if (typeof input[key] === 'boolean') safe[key] = input[key];
    }
    return safe;
}

export function voiceLog(
    event: VoiceLogEvent,
    fields?: VoiceLogFields,
    level: VoiceLogLevel = 'debug',
): void {
    const safeEvent = eventAllowlist.has(event) ? event : 'event.rejected';
    const safeFields = sanitizeVoiceLogFields(fields);
    if (Object.keys(safeFields).length > 0) {
        console[level]('[Voice] ' + safeEvent, safeFields);
        return;
    }
    console[level]('[Voice] ' + safeEvent);
}
