import { z } from "zod";
import * as crypto from "crypto";
import { VoiceConversationResponseSchema, VoiceUsageResponseSchema } from "@slopus/happy-wire";
import { type Fastify } from "../types";
import {
    armVoiceCredentialAdmission,
    beginVoiceCredentialAdmission,
    sendActiveAccountResponse,
    sendVoiceCredentialForAdmission,
    settleVoiceCredentialAdmission,
    VoiceCredentialResponseOutcomeUnknownError,
} from "@/app/account/voiceCredentialAdmission";
import {
    voiceConversationBucket,
    voiceServerLog,
    voiceStatusClass,
    voiceUsageBucket,
} from "./voiceLog";

const VOICE_FREE_LIMIT_SECONDS = 1200;  // 20 minutes free tier per 30 days (~$0.76 cost)
const VOICE_HARD_LIMIT_SECONDS = 18000; // 5 hours absolute cap per 30 days (even with subscription)
const VOICE_MAX_CONVERSATIONS = 100;    // Max conversations trackable per 30 days (ElevenLabs page_size limit)
const VOICE_EXTRA_LIMIT_SECONDS = 5 * 60 * 60;
const VOICE_CREDENTIAL_MAX_LIFETIME_MS = 60 * 60 * 1000;
const VOICE_EXTRA_LIMIT_PUBLIC_IDS = new Set([
    "cmp66x5u018d9wz0unf56tp07",
]);
const ELEVEN_LABS_API = "https://api.elevenlabs.io/v1/convai";

type VoiceUsageResult =
    | { ok: true; usedSeconds: number; conversationCount: number }
    | { ok: false };

function parseConversationCredential(conversationToken: string): {
    conversationId: string;
    expiresAt: Date;
} | null {
    try {
        const payload = JSON.parse(
            Buffer.from(conversationToken.split('.')[1], 'base64url').toString(),
        ) as { exp?: unknown; video?: { room?: unknown } };
        const conversationId = typeof payload.video?.room === 'string'
            ? payload.video.room.match(/(conv_[a-zA-Z0-9]+)/)?.[0]
            : undefined;
        const expiresAt = typeof payload.exp === 'number'
            ? new Date(payload.exp * 1000)
            : null;
        const now = Date.now();
        if (
            !conversationId
            || !expiresAt
            || !Number.isFinite(expiresAt.getTime())
            || expiresAt.getTime() <= now
            || expiresAt.getTime() > now + VOICE_CREDENTIAL_MAX_LIFETIME_MS
        ) return null;
        return { conversationId, expiresAt };
    } catch {
        return null;
    }
}

function getVoiceHardLimitSeconds(userId: string): number {
    if (VOICE_EXTRA_LIMIT_PUBLIC_IDS.has(userId)) {
        return VOICE_HARD_LIMIT_SECONDS + VOICE_EXTRA_LIMIT_SECONDS;
    }
    return VOICE_HARD_LIMIT_SECONDS;
}

function deriveElevenUserId(happyUserId: string): string {
    const hmac = crypto.createHmac("sha256", process.env.HANDY_MASTER_SECRET!);
    hmac.update(happyUserId);
    const digest = hmac.digest();
    const base64url = digest
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `u_${base64url}`;
}

/**
 * Get a user's voice usage in seconds over the last 30 days.
 * Queries ElevenLabs directly by user_id (set via participant_name on token mint).
 * ElevenLabs is the source of truth — no local DB needed.
 *
 * Returns { usedSeconds, conversationCount }.
 */
async function getVoiceUsage(
    elevenLabsApiKey: string,
    elevenUserId: string,
): Promise<VoiceUsageResult> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    try {
        // Query across all agents — usage is per-user, not per-agent
        const res = await fetch(
            `${ELEVEN_LABS_API}/conversations?user_id=${elevenUserId}&created_after=${thirtyDaysAgo}&page_size=100`,
            { headers: { "xi-api-key": elevenLabsApiKey } }
        );

        if (!res.ok) {
            voiceServerLog("provider.usage.failed", {
                outcome: "failed",
                reason: "provider-error",
                statusClass: voiceStatusClass(res.status),
            });
            return { ok: false };
        }

        const data = (await res.json()) as {
            conversations?: Array<{ call_duration_secs: number }>;
        };

        const conversations = data.conversations || [];
        let usedSeconds = 0;
        for (const c of conversations) {
            usedSeconds += c.call_duration_secs ?? 0;
        }
        return { ok: true, usedSeconds, conversationCount: conversations.length };
    } catch {
        voiceServerLog("provider.usage.failed", {
            outcome: "failed",
            reason: "provider-error",
        });
        return { ok: false };
    }
}

async function hasActiveSubscription(userId: string): Promise<boolean> {
    const revenueCatApiKey = process.env.REVENUECAT_API_KEY;
    if (!revenueCatApiKey) return false;

    try {
        const response = await fetch(
            `https://api.revenuecat.com/v2/projects/proj493735ad/customers/${userId}/active_entitlements`,
            {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${revenueCatApiKey}`,
                },
            }
        );
        if (!response.ok) {
            voiceServerLog("provider.subscription.failed", {
                outcome: "failed",
                reason: "provider-error",
                statusClass: voiceStatusClass(response.status),
            });
            return false;
        }
        const data = (await response.json()) as { items?: Array<{ entitlement_id: string }> };
        return (data.items?.length ?? 0) > 0;
    } catch {
        voiceServerLog("provider.subscription.failed", {
            outcome: "failed",
            reason: "provider-error",
        });
        return false;
    }
}

export function voiceRoutes(app: Fastify) {
    app.post('/v1/voice/conversations', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                agentId: z.string(),
            }),
            response: {
                200: VoiceConversationResponseSchema,
                410: z.object({ error: z.literal('Account deletion in progress') }),
                500: z.object({ error: z.string() }),
                502: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { agentId } = request.body;

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return reply.code(500).send({ error: 'ELEVENLABS_API_KEY not configured' });
        }
        if (!process.env.REVENUECAT_API_KEY) {
            return reply.code(500).send({ error: 'REVENUECAT_API_KEY not configured' });
        }

        // Keep a durable admission across every provider query, not only the
        // final token mint. Otherwise deletion could commit after a short
        // account check and before ElevenLabs/RevenueCat is queried.
        const admission = await beginVoiceCredentialAdmission(userId);
        if (!admission) {
            return reply.code(410).send({ error: 'Account deletion in progress' });
        }
        let credentialMayHaveEscaped = false;
        const sendAccountResponse = async (payload: z.infer<typeof VoiceConversationResponseSchema>) => {
            const sent = await sendActiveAccountResponse(userId, () => {
                reply.send(payload);
            });
            return sent
                ? reply
                : reply.code(410).send({ error: 'Account deletion in progress' });
        };

        try {
            voiceServerLog("credentials.requested");
            const elevenUserId = deriveElevenUserId(userId);
            const hardLimitSeconds = getVoiceHardLimitSeconds(userId);

            // Check usage from ElevenLabs directly while the durable admission
            // keeps deletion from completing underneath this request.
            const usage = await getVoiceUsage(elevenLabsApiKey, elevenUserId);
            if (!usage.ok) {
                return reply.code(502).send({ error: 'Failed to get voice usage' });
            }
            const { usedSeconds, conversationCount } = usage;
            voiceServerLog("credentials.evaluated", {
                usageBucket: voiceUsageBucket(usedSeconds, VOICE_FREE_LIMIT_SECONDS, hardLimitSeconds),
                conversationBucket: voiceConversationBucket(conversationCount),
            });

            // Conversation count cap — we can only track 100 per query (ElevenLabs page_size limit)
            if (conversationCount >= VOICE_MAX_CONVERSATIONS) {
                voiceServerLog("credentials.blocked", {
                    outcome: "blocked",
                    reason: "conversation-limit",
                });
                return sendAccountResponse({
                    allowed: false as const,
                    reason: 'voice_conversation_limit_reached' as const,
                    usedSeconds,
                    limitSeconds: hardLimitSeconds,
                    agentId,
                });
            }

            // Hard cap — normally 5 hours, with account-specific credits applied.
            if (usedSeconds >= hardLimitSeconds) {
                voiceServerLog("credentials.blocked", {
                    outcome: "blocked",
                    reason: "hard-limit",
                });
                return sendAccountResponse({
                    allowed: false as const,
                    reason: 'voice_hard_limit_reached' as const,
                    usedSeconds,
                    limitSeconds: hardLimitSeconds,
                    agentId,
                });
            }

            // Free tier — 1 hour, then need subscription
            if (usedSeconds >= VOICE_FREE_LIMIT_SECONDS) {
                const subscribed = await hasActiveSubscription(userId);
                voiceServerLog("subscription.checked", { subscribed });
                if (!subscribed) {
                    voiceServerLog("credentials.blocked", {
                        outcome: "blocked",
                        reason: "subscription-required",
                    });
                    return sendAccountResponse({
                        allowed: false as const,
                        reason: 'subscription_required' as const,
                        usedSeconds,
                        limitSeconds: VOICE_FREE_LIMIT_SECONDS,
                        agentId,
                    });
                }
            }

            // Get conversation token (JWT for WebRTC) with user identity
            const tokenRes = await fetch(
                `${ELEVEN_LABS_API}/conversation/token?agent_id=${agentId}&participant_name=${elevenUserId}`,
                { headers: { 'xi-api-key': elevenLabsApiKey } }
            );

            if (!tokenRes.ok) {
                voiceServerLog("provider.token.failed", {
                    outcome: "failed",
                    reason: "provider-error",
                    statusClass: voiceStatusClass(tokenRes.status),
                });
                return reply.code(500).send({ error: 'Failed to get voice credentials' });
            }

            const { token: conversationToken } = (await tokenRes.json()) as { token: string };

            const credential = parseConversationCredential(conversationToken);
            if (!credential || credential.expiresAt <= new Date()) {
                voiceServerLog("provider.token.invalid", {
                    outcome: "failed",
                    reason: "provider-error",
                });
                return reply.code(500).send({ error: 'Failed to get conversation ID' });
            }

            if (!(await armVoiceCredentialAdmission(admission, credential.expiresAt))) {
                return reply.code(410).send({ error: 'Account deletion in progress' });
            }

            const payload = {
                allowed: true as const,
                conversationToken,
                conversationId: credential.conversationId,
                agentId,
                elevenUserId,
                usedSeconds,
                limitSeconds: usedSeconds >= VOICE_FREE_LIMIT_SECONDS ? hardLimitSeconds : VOICE_FREE_LIMIT_SECONDS,
            };
            const sent = await sendVoiceCredentialForAdmission(admission, () => {
                credentialMayHaveEscaped = true;
                reply.send(payload);
            });
            if (!sent) {
                return reply.code(410).send({ error: 'Account deletion in progress' });
            }
            voiceServerLog("credentials.issued", { outcome: "success" });
            return reply;
        } catch (error) {
            if (error instanceof VoiceCredentialResponseOutcomeUnknownError) return reply;
            voiceServerLog("credentials.request.failed", {
                outcome: "failed",
                reason: "provider-error",
            });
            return reply.code(500).send({ error: 'Failed to get voice credentials' });
        } finally {
            if (!credentialMayHaveEscaped) {
                await settleVoiceCredentialAdmission(admission).catch(() => undefined);
            }
        }
    });

    /**
     * Returns voice usage for the authenticated user over the last 30 days.
     * Queries ElevenLabs directly — no local DB needed.
     */
    app.get('/v1/voice/usage', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: VoiceUsageResponseSchema,
                410: z.object({ error: z.literal('Account deletion in progress') }),
                500: z.object({ error: z.string() }),
                502: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return reply.code(500).send({ error: 'ELEVENLABS_API_KEY not configured' });
        }

        const admission = await beginVoiceCredentialAdmission(userId);
        if (!admission) {
            return reply.code(410).send({ error: 'Account deletion in progress' });
        }

        try {
            const elevenUserId = deriveElevenUserId(userId);
            const hardLimitSeconds = getVoiceHardLimitSeconds(userId);

            const [usage, subscribed] = await Promise.all([
                getVoiceUsage(elevenLabsApiKey, elevenUserId),
                hasActiveSubscription(userId),
            ]);
            if (!usage.ok) {
                return reply.code(502).send({ error: 'Failed to get voice usage' });
            }
            const { usedSeconds, conversationCount } = usage;
            const payload = {
                usedSeconds,
                limitSeconds: subscribed ? hardLimitSeconds : VOICE_FREE_LIMIT_SECONDS,
                conversationCount,
                conversationLimit: VOICE_MAX_CONVERSATIONS,
                elevenUserId,
            };
            const sent = await sendActiveAccountResponse(userId, () => {
                reply.send(payload);
            });
            return sent
                ? reply
                : reply.code(410).send({ error: 'Account deletion in progress' });
        } catch {
            voiceServerLog("usage.request.failed", {
                outcome: "failed",
                reason: "provider-error",
            });
            return reply.code(500).send({ error: 'Failed to get voice usage' });
        } finally {
            await settleVoiceCredentialAdmission(admission).catch(() => undefined);
        }
    });
}
