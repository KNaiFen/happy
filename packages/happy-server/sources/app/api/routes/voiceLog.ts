import { log } from "@/utils/log";

const VOICE_LOG_EVENTS = [
    "credentials.requested",
    "credentials.evaluated",
    "credentials.blocked",
    "credentials.issued",
    "credentials.request.failed",
    "provider.usage.failed",
    "provider.subscription.failed",
    "provider.token.failed",
    "provider.token.invalid",
    "subscription.checked",
    "usage.request.failed",
    "event.rejected",
] as const;

export type VoiceServerLogEvent = typeof VOICE_LOG_EVENTS[number];

export interface VoiceServerLogFields {
    outcome?: "success" | "blocked" | "failed";
    reason?: "conversation-limit" | "hard-limit" | "subscription-required" | "provider-error";
    usageBucket?: "under-free" | "subscription" | "hard-limit";
    conversationBucket?: "none" | "few" | "many" | "limit";
    statusClass?: "4xx" | "5xx" | "other";
    subscribed?: boolean;
}

const eventAllowlist = new Set<string>(VOICE_LOG_EVENTS);
const fieldAllowlist = {
    outcome: new Set(["success", "blocked", "failed"]),
    reason: new Set(["conversation-limit", "hard-limit", "subscription-required", "provider-error"]),
    usageBucket: new Set(["under-free", "subscription", "hard-limit"]),
    conversationBucket: new Set(["none", "few", "many", "limit"]),
    statusClass: new Set(["4xx", "5xx", "other"]),
} as const;

function sanitizeFields(fields: unknown): Record<string, string | boolean> {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
    const input = fields as Record<string, unknown>;
    const safe: Record<string, string | boolean> = {};
    for (const key of Object.keys(fieldAllowlist) as Array<keyof typeof fieldAllowlist>) {
        const value = input[key];
        if (typeof value === "string" && fieldAllowlist[key].has(value as never)) {
            safe[key] = value;
        }
    }
    if (typeof input.subscribed === "boolean") safe.subscribed = input.subscribed;
    return safe;
}

export function voiceServerLog(event: VoiceServerLogEvent, fields?: VoiceServerLogFields): void {
    const safeEvent = eventAllowlist.has(event) ? event : "event.rejected";
    log({
        module: "voice",
        event: safeEvent,
        ...sanitizeFields(fields),
    });
}

export function voiceUsageBucket(
    usedSeconds: number,
    freeLimitSeconds: number,
    hardLimitSeconds: number,
): VoiceServerLogFields["usageBucket"] {
    if (usedSeconds >= hardLimitSeconds) return "hard-limit";
    if (usedSeconds >= freeLimitSeconds) return "subscription";
    return "under-free";
}

export function voiceConversationBucket(count: number): VoiceServerLogFields["conversationBucket"] {
    if (count >= 100) return "limit";
    if (count >= 10) return "many";
    if (count > 0) return "few";
    return "none";
}

export function voiceStatusClass(status: number): VoiceServerLogFields["statusClass"] {
    if (status >= 400 && status < 500) return "4xx";
    if (status >= 500 && status < 600) return "5xx";
    return "other";
}
