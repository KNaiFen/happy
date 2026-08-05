# Paid Voice — Rate Limiting & Auth

## Flow

```
User taps mic
│
├─ Bypass mode? (custom agent ID)
│   └─ connect directly to ElevenLabs, skip everything
│
├─ POST /v1/voice/conversations { agentId }
│   │
│   ├─ GET /v1/convai/conversations?agent_id=X&user_id=Y&created_after=<30d>&page_size=100
│   │   └─ Sum call_duration_secs → usedSeconds (~108ms)
│   │
│   ├─ conversations == 100?          → { allowed: false, reason: "voice_conversation_limit_reached" }
│   ├─ usedSeconds >= 5h?             → { allowed: false, reason: "voice_hard_limit_reached" }
│   ├─ usedSeconds >= 20min + no sub? → { allowed: false, reason: "subscription_required" }
│   │
│   ├─ GET /v1/convai/conversation/token?agent_id=X&participant_name=ELEVEN_USER_ID
│   │   └─ Decode JWT → extract conv_id from video.room
│   │
│   └─ Return { conversationToken, conversationId, agentId, elevenUserId, usedSeconds, limitSeconds }
│
├─ allowed: false?
│   ├─ "voice_conversation_limit_reached" → alert (file issue on GitHub)
│   └─ other → paywall flow="voice_must_pay"
│
└─ allowed: true
    ├─ feature flag voice-upsell == "show-paywall-before-first-voice-chat"?
    │   └─ first free voice start only → soft paywall flow="voice_trial_eligible"
    ├─ feature flag voice-upsell == "voice-onboarding-and-upsell"?
    │   └─ inject onboarding + upsell guidance into voice prompt
    └─ otherwise
        └─ control → no soft paywall and no onboarding experiment
        then startSession({ conversationToken }) → WebRTC via LiveKit
```

## Limits

| Tier | Happy-managed limit | Window | What happens |
|------|---------------------|--------|--------------|
| Free | 20 min | 30 days | Paywall |
| Subscribed | 5 hours by default; explicit operational exceptions may differ | 30 days | Hard block → offer BYO agent |
| BYO Agent | Subject to the user's ElevenLabs plan | ElevenLabs policy | Uses the user's own ElevenLabs account |
| Any Happy-managed tier | 100 conversations | 30 days | Hard block → file issue |

Provider pricing and measured cost are operational inputs, not protocol
constants. Verify them outside this document before making a pricing decision.

## Tracking

ElevenLabs is the source of truth. No local DB.

- `participant_name` on token mint → sets `user_id` on conversation record
- Usage: `GET /conversations?user_id=Y&created_after=<30d>&page_size=100` → sum durations
- `user_id` = HMAC-SHA256 of Happy user ID (deterministic, one-way)
- Max page_size is 100 → at 100 conversations we block (can't track more without pagination)

**TODO:** Remove `VoiceConversation` model from Prisma schema (no longer used, DB table can be dropped).

## Paywall Flows (RevenueCat)

Single paywall template, rules driven by custom variable `flow`:

| Flow | When | Behavior |
|------|------|----------|
| `voice_trial_eligible` | Feature flag variant `show-paywall-before-first-voice-chat`, first free voice use | Soft — dismissable, voice starts anyway |
| `voice_must_pay` | Server returns `allowed: false` | Hard — must purchase |
| `voluntary_support` | Settings | User-initiated |

## Security

- JWT signed by ElevenLabs, single-use, can't be forged
- Agent set to "authorized only" — needs server-minted token
- Agent ID in public repo is harmless
- App 与 Server 的语音诊断日志只输出白名单事件和安全字段；不得输出 token、context、
  标识符、原始 SDK 数据或错误对象。见
  [Voice 敏感日志收敛计划](plans/voice-sensitive-logging-hardening.md)。
