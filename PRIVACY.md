# Privacy Policy for Happy Coder

**Last Updated: August 12, 2026**

## Overview

Happy Coder is committed to protecting your privacy. This policy explains how we handle data in our zero-knowledge encrypted synchronization features and in the optional voice feature, which has a separate data flow described below.

## What We Collect

### Encrypted Data
- **Messages and Code**: Your coding-agent conversations and code snippets are end-to-end encrypted on your device before transmission. We store this encrypted data but have no ability to decrypt or read it.
- **Encryption Keys**: When you pair devices, encryption keys are transmitted between your devices in encrypted form. We cannot access or decrypt these keys.

### Metadata (Not Encrypted)
- **Message IDs**: Unique identifiers for message ordering and synchronization
- **Timestamps**: When messages were created and synced
- **Device IDs**: Anonymous identifiers for device pairing
- **Session IDs**: Opaque identifiers for your Happy and Codex sessions
- **Push Notification Tokens**: Device tokens for sending push notifications via Expo's push notification service
- **Push Notification Copy**: For session-event notifications, the CLI sends notification title, body, and routing data to Happy's server so it can suppress delivery for active clients before forwarding to Expo. Other CLI notification paths, including `happy notify` and session notifications without a session ID, send directly to Expo.

### Analytics (PostHog)
- **Pseudonymous Events**: We collect basic app usage events through PostHog to improve the app experience
- **Stable Identifier**: Analytics uses a stable pseudonymous ID. It can correlate events from the same installation/account context but is separate from plaintext message content
- **Event Metadata**: Events can include feature state and opaque identifiers such as Happy session IDs or ElevenLabs conversation IDs; they do not intentionally include message or code content
- **Default and Opt-Out**: Analytics is enabled by default. You can disable it at any time in the app settings

### Subscription Management (Revenue Cat)
- **Account ID**: Revenue Cat uses your account ID to manage subscriptions and enable premium features
- **Backend Integration**: This ID allows us to provide additional features from our backend while maintaining end-to-end encryption for your content
- **Data Separation**: Purchase analytics sent to PostHog use the anonymized ID instead - we cannot match Revenue Cat data with PostHog analytics

### Voice (Optional)
When you turn on voice, your device connects to ElevenLabs to provide the voice agent. Native apps use the ElevenLabs SDK with a LiveKit/WebRTC media connection; the web client uses the ElevenLabs web SDK over WebSocket.

- **Voice Audio**: ElevenLabs receives audio from your microphone during a voice session.
- **Voice Context**: The Happy app sends text to the voice agent so it can assist you. This can include active-session IDs and summaries; the current session's ID, project path, summary, message history, and new messages; session focus or readiness events; and pending permission requests, including the tool name and arguments. It may also include agent tool-call details configured for the voice session.
- **Encryption Boundary**: Voice audio and context sent to the voice agent are not covered by Happy's end-to-end encryption or zero-knowledge architecture. Happy's server does not proxy this audio or context. For Happy-managed voice, it authenticates your Happy account, checks subscription and usage limits, and obtains a voice-session token. It processes account, agent, conversation, and voice-usage metadata for that purpose.
- **Pseudonymous Voice Identifier**: For Happy-managed voice, Happy gives ElevenLabs a stable pseudonymous identifier derived from your Happy account ID using HMAC-SHA-256. This lets ElevenLabs apply per-user voice limits without using your raw Happy account ID as the voice user ID. The identifier can still link your voice sessions to one another.
- **Direct Connection**: If you configure your own ElevenLabs agent and choose to bypass Happy's token flow, Happy bypasses its managed token and usage-limit flow. The selected ElevenLabs agent still receives the voice audio and context described above.
- **Diagnostic Logs**: App and Server voice diagnostics use fixed event and field allowlists. They do not log voice context, provider or conversation identifiers, voice tokens, raw SDK data, or raw error objects.

## What We Don't Collect
- Your actual code or conversation content sent through Happy's encrypted synchronization service (we can't decrypt it). This does not include voice audio or context you choose to send directly to ElevenLabs during an active voice session.
- Personal information contained in encrypted messages, because we cannot decrypt those messages. If you use voice, ElevenLabs may receive personal information that you include in voice audio or context.
- Device information beyond anonymous IDs
- Location data

## How We Use Data

### Encrypted Data
- Stored on our servers solely for synchronization between your devices
- Transmitted to your paired devices when requested
- Retained until you delete it through the app

### Metadata
- Message IDs and timestamps are used to maintain proper message ordering
- Device IDs enable secure pairing between your devices
- Session IDs track Happy and Codex sessions for synchronization
- Push notification tokens are stored to enable notifications through Expo's service

### Push Notifications
For session-event notifications, the CLI sends notification title, body, and
routing data to Happy's server. The server checks whether that user has any
active non-machine client, then forwards the payload to Expo for mobile
delivery. Other CLI notification paths, including `happy notify` and session
notifications without a session ID, send directly to Expo and bypass Happy's
server. Notification
copy is not part of Happy's end-to-end encrypted synchronization payload, so
depending on the delivery path Happy's server and/or Expo may receive it in
transit. Push notification tokens remain stored as metadata to enable delivery.

## Data Security

- **End-to-End Encryption**: Happy uses versioned authenticated client-side encryption schemes for synchronization data; current and legacy records may use different algorithms
- **Zero-Knowledge**: We cannot decrypt encrypted synchronization data even if compelled
- **Secure Key Exchange**: Encryption keys are transmitted between your devices only in encrypted form that we cannot access
- **Open Source**: Our encryption implementation is publicly auditable
- **No Backdoors**: The architecture makes it impossible for us to access encrypted synchronization content

The optional voice feature is an exception to the encrypted synchronization model: ElevenLabs must receive the audio and text context it processes to provide the voice agent. See "Voice (Optional)" above.

## Data Retention

- Encrypted session records are retained until the corresponding session is deleted
- Metadata is retained as needed for system functionality
- You can permanently delete a Happy account from the app's account settings. Confirmation immediately blocks new Server access and admissions for that account; a durable Server deletion process removes account records, encrypted sessions and Sync journals, devices, credentials, integration tokens, artifacts, social/KV/voice records, attachments, and profile objects. A download stream or external notification/RPC admitted before confirmation may finish and cannot be atomically recalled from a device or third-party provider. There is no export, cancellation, recovery, or restoration path.
- Current Server versions proxy attachment and profile-object access instead of issuing new direct object-storage capabilities. For an S3 deployment upgraded from an older Server, the operator first records when every old direct-upload issuer has drained; deletion is then held until at least 16 minutes after that time before its final object sweep. Object-storage failures keep the account locked and are retried rather than reported as complete.
- For the Happy-hosted service, the operating retention target for backups and operational logs that can contain account data is no more than three days. This repository cannot itself prove or configure the hosted backup and log systems; the archived deletion plan records the implementation and maintainer acceptance boundary.
- Happy operational logging is designed to exclude message payloads, raw account/session/artifact/provider identifiers, credentials, encryption keys, and third-party error text or stacks. Where correlation is necessary, the service records a diagnostic hash plus fixed event categories, status classes, and counts.
- Self-hosted deployments are operated by their deployer. The application removes its primary database and configured object-store records, but the deployer is responsible for database snapshots, object versioning/delete markers, provider logs, container logs, Redis, and any external-service copies or retention rules.
- Voice audio, voice-session context, and voice-usage records processed or retained by ElevenLabs are subject to ElevenLabs' own practices and privacy policy; they are not stored as Happy encrypted synchronization data.

## Your Rights

You have the right to:
- Delete individual sessions through the app
- Delete registered push tokens through the app's account settings
- Permanently delete the entire Happy account from account settings, without an export or withdrawal period
- Audit our open-source code
- Disable product analytics in app settings

Account deletion applies to Happy-controlled primary data. It does not erase
data retained by independent providers such as Expo, PostHog, RevenueCat, or
ElevenLabs, which remain subject to their own privacy and retention practices.

## Data Sharing

We share data with service providers only as needed to provide the features described in this policy:

- **Expo**: push notification delivery
- **PostHog**: the anonymous analytics described above
- **RevenueCat**: subscription management
- **ElevenLabs**: the optional voice-agent service and voice-usage measurement. On native apps, voice media uses ElevenLabs' LiveKit/WebRTC transport; the web client uses ElevenLabs' WebSocket-based SDK.

We do not send encrypted synchronization content to these providers as part of ordinary synchronization. Voice audio and context are the exception described in "Voice (Optional)" above.

## Changes to This Policy

We will notify users of any material changes to this privacy policy through the app. Continued use of the service after changes constitutes acceptance.

## Contact

For privacy concerns or questions:
- GitHub Issues: https://github.com/slopus/happy/issues

## Compliance

Happy Coder is designed around data minimization, client-side encryption,
session deletion, and analytics opt-out controls. This policy does not claim a legal
certification; rights and obligations can vary by jurisdiction.

---

**Remember**: Your encryption keys are only shared between your own devices in encrypted form. We cannot read code or conversations transmitted through Happy's encrypted synchronization service. Content you choose to send through voice is processed by ElevenLabs as described in "Voice (Optional)" above.
