# External Integrations

**Analysis Date:** 2026-08-15

## APIs & External Services

**Coding-agent runtime:**
- OpenAI Codex app-server - Happy CLI starts or attaches to the official Codex app-server and exchanges JSON-RPC over child-process stdio or WebSocket.
  - SDK/Client: local `codex` executable plus `ws` in `packages/happy-cli/src/codex/codexAppServerClient.ts` and `packages/happy-cli/src/codex/codexAppServerWebSocket.ts`.
  - Auth: Codex account authentication belongs to the installed official Codex CLI; endpoint selection may use `HAPPY_CODEX_APP_SERVER_PATH` in `packages/happy-cli/src/codex/codexAppServerClient.ts`.
- OpenAI Codex bundled runtime - Codium desktop packages `@openai/codex` for local agent execution.
  - SDK/Client: `@openai/codex` in `packages/codium/package.json` and Electron host code in `packages/codium/sources/boot/main/`.
  - Auth: Codex OAuth/local runtime state, mediated by `packages/codium/sources/boot/main/codex-oauth.ts`.

**GitHub:**
- GitHub App, OAuth, and webhooks - The server conditionally initializes an Octokit App and validates webhook events in `packages/happy-server/sources/modules/github.ts`; account connect routes are in `packages/happy-server/sources/app/api/routes/connectRoutes.ts`.
  - SDK/Client: `octokit` and `@octokit/webhooks`.
  - Auth: `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI`, and `GITHUB_WEBHOOK_SECRET`.
- GitHub Actions - CI, release candidates, release artifact promotion, CodeQL, docs checking, and official Codex source verification run under `.github/workflows/`.
  - SDK/Client: GitHub Actions and `gh` in workflow scripts.
  - Auth: workflow-scoped `github.token` and repository secrets; no secret values are stored in documentation.

**Notifications:**
- Expo Push Service - CLI fetches registered device tokens from Happy Server and sends notification batches through Expo in `packages/happy-cli/src/api/pushNotifications.ts`.
  - SDK/Client: `expo-server-sdk`.
  - Auth: Happy account/session token for `/v1/push-tokens`; Expo token credentials are managed by the Expo service, not by a repository environment variable in this client.

**Subscriptions and voice:**
- RevenueCat - Native and web app purchase/paywall clients are implemented in `packages/happy-app/sources/sync/revenueCat/`; server-side voice access validates customer entitlement in `packages/happy-server/sources/app/api/routes/voiceRoutes.ts`.
  - SDK/Client: `react-native-purchases`, `react-native-purchases-ui`, and `@revenuecat/purchases-js`.
  - Auth: public app keys can be supplied by `EXPO_PUBLIC_REVENUE_CAT_APPLE`, `EXPO_PUBLIC_REVENUE_CAT_GOOGLE`, and `EXPO_PUBLIC_REVENUE_CAT_STRIPE`; server entitlement checks use `REVENUECAT_API_KEY`.
- ElevenLabs Conversational AI - The server mints conversation tokens and obtains usage/history directly from the ElevenLabs ConvAI API in `packages/happy-server/sources/app/api/routes/voiceRoutes.ts`; app voice sessions use the ElevenLabs React and React Native providers in `packages/happy-app/sources/realtime/`.
  - SDK/Client: `elevenlabs`, `@elevenlabs/react`, and `@elevenlabs/react-native`.
  - Auth: `ELEVENLABS_API_KEY` on the server. User-configured custom ElevenLabs agent IDs remain application settings rather than server secrets.
- LiveKit transport - The native ElevenLabs provider uses LiveKit/WebRTC; its required React Native plugins and runtime dependencies are declared in `packages/happy-app/package.json` and wrapped by `packages/happy-app/sources/realtime/RealtimeProvider.tsx`.
  - SDK/Client: `@livekit/react-native`, `@livekit/react-native-webrtc`, and `@config-plugins/react-native-webrtc`.
  - Auth: ElevenLabs conversation token supplied by the Happy Server flow.

**Analytics:**
- PostHog - The Expo app creates a PostHog client only when analytics is enabled and a configured public key exists in `packages/happy-app/sources/track/tracking.ts`.
  - SDK/Client: `posthog-react-native`.
  - Auth: `EXPO_PUBLIC_POSTHOG_KEY`; disable analytics with `EXPO_PUBLIC_DISABLE_ANALYTICS`.

## Data Storage

**Databases:**
- PostgreSQL - Primary server mode uses Prisma's default database connection with schema/migrations in `packages/happy-server/prisma/schema.prisma` and `packages/happy-server/prisma/migrations/`.
  - Connection: `DATABASE_URL`, with `DB_PROVIDER=postgres` (the default) in `packages/happy-server/sources/storage/db.ts`.
  - Client: Prisma `@prisma/client` 6.19.2.
- PGlite - Self-host/standalone mode uses a durable embedded PostgreSQL-compatible store.
  - Connection: `DB_PROVIDER=pglite` and optional `PGLITE_DIR`.
  - Client: `@electric-sql/pglite` through `pglite-prisma-adapter` in `packages/happy-server/sources/storage/db.ts`.
- SQLite - Codium desktop keeps local state with `better-sqlite3`, declared in `packages/codium/package.json`.
  - Connection: app-local Electron storage; no network connection string is used.
  - Client: `better-sqlite3`.

**File Storage:**
- Local filesystem by default - server files are stored under `DATA_DIR/files` with POSIX ownership and no-follow safeguards in `packages/happy-server/sources/storage/files.ts`.
- S3-compatible object storage when configured - MinIO client supports S3-compatible endpoints and version-aware deletion in `packages/happy-server/sources/storage/files.ts`.
  - Connection: `S3_HOST`, optional `S3_PORT`, `S3_USE_SSL`, and `S3_REGION`.
  - Auth: `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `S3_BUCKET`.

**Caching:**
- Redis - Optional Redis streams provide Socket.IO cross-process event distribution and stream-lag reporting in `packages/happy-server/sources/app/api/socket.ts`.
  - Connection: `REDIS_URL`.
  - Client: `ioredis` and `@socket.io/redis-streams-adapter`.
- No Redis URL means a single-process Socket.IO deployment; the server code leaves the Redis adapter disabled.

## Authentication & Identity

**Auth Provider:**
- Custom device/account authentication - server token creation and verification live in `packages/happy-server/sources/app/auth/`; CLI and agent persist account/device state beneath `HAPPY_HOME_DIR` in `packages/happy-cli/src/configuration.ts` and `packages/happy-agent/src/config.ts`.
  - Implementation: cryptographic credentials and server-issued tokens; Socket.IO middleware verifies tokens and enforces user/session/machine scope in `packages/happy-server/sources/app/api/socket.ts`.
- GitHub OAuth - optional account identity connection through `packages/happy-server/sources/app/api/routes/connectRoutes.ts`.
- RevenueCat entitlement - applied to paid voice admission in `packages/happy-server/sources/app/api/routes/voiceRoutes.ts`; it is not the base Happy identity provider.

## Monitoring & Observability

**Error Tracking:**
- Not detected. No Sentry client or server integration appears in package manifests or source imports.

**Logs:**
- Server structured logs use Pino and log helpers under `packages/happy-server/sources/utils/log.ts`; operational logging is designed to avoid raw payloads.
- CLI logs use the logger in `packages/happy-cli/src/ui/logger.ts`.
- A local development-only app-log receiver writes to `$HAPPY_HOME_DIR/app-logs` in `packages/happy-app-logs/src/server.ts`.
- Prometheus metrics are exposed by server monitoring modules under `packages/happy-server/sources/app/monitoring/`; `METRICS_ENABLED` and `METRICS_PORT` configure the exporter.
- Grafana and Prometheus manifests exist for local deployment in `packages/happy-server/deploy/overlays/local/grafana.yaml` and `packages/happy-server/deploy/overlays/local/prometheus.yaml`.

## CI/CD & Deployment

**Hosting:**
- Self-host server / relay - `packages/happy-server/deploy/` contains Kubernetes-style manifests and Debian 13 amd64 relay packaging under `packages/happy-server/deploy/debian13-amd64/`.
- Web bundle - server packages the web application via `packages/happy-server/package.json` and `packages/happy-cli/scripts/bundle-webapp.cjs`.
- Android app - Expo/React Native build and signed ARM64 APK delivery use `.github/workflows/build-android-release.yml` and `packages/happy-app/app.config.js`.
- npm distribution - CLI and agent release archives are built by `.github/workflows/build-cli-release.yml` and `.github/workflows/build-happy-agent-release.yml`.

**CI Pipeline:**
- GitHub Actions - primary continuous integration in `.github/workflows/ci.yml`, including typecheck/test matrices, packaging checks, migrations, security, Codex protocol validation, and Android field tests.
- CodeQL - code scanning in `.github/workflows/codeql.yml`.
- Dependency audit - production dependency audit in `.github/workflows/production-dependency-audit.yml`.
- Release automation - candidate rehearsal/promotion and post-CI release coordination in `.github/workflows/release-candidate-rehearsal.yml`, `.github/workflows/promote-release-candidate.yml`, and `.github/workflows/release-after-required-ci.yml`.

## Environment Configuration

**Required env vars:**
- Server base: `HANDY_MASTER_SECRET`; set `PORT`, `HOST`, and `PUBLIC_URL` for listener/public URL behavior in `packages/happy-server/sources/main.ts`, `packages/happy-server/sources/standalone.ts`, and `packages/happy-server/sources/storage/files.ts`.
- Server database: `DATABASE_URL` for PostgreSQL, or `DB_PROVIDER=pglite` with optional `PGLITE_DIR` for embedded storage in `packages/happy-server/sources/storage/db.ts`.
- Server object store, when using S3/MinIO: `S3_HOST`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `S3_BUCKET`; optional port, TLS, and region settings are defined in `packages/happy-server/sources/storage/files.ts`.
- Server scaling: `REDIS_URL` to enable the Redis streams adapter in `packages/happy-server/sources/app/api/socket.ts`.
- Server integrations: GitHub environment names listed in the GitHub integration section; `REVENUECAT_API_KEY` and `ELEVENLABS_API_KEY` for the paid voice flow.
- App endpoints/config: `EXPO_PUBLIC_HAPPY_SERVER_URL` or `EXPO_PUBLIC_SERVER_URL`, optional `EXPO_PUBLIC_LOG_SERVER_URL`, and the public analytics/purchase keys consumed by `packages/happy-app/sources/sync/`.
- CLI/agent: `HAPPY_SERVER_URL`, `HAPPY_WEBAPP_URL`, and `HAPPY_HOME_DIR`; optional runtime controls are defined in `packages/happy-cli/src/configuration.ts`.

**Secrets location:**
- Local package development environment files exist but are intentionally excluded from this analysis; never read or commit them.
- Production and release secrets are supplied through GitHub Actions repository secrets and deployment-local secret configuration under `packages/happy-server/deploy/`; secret file contents are not documented.
- User/device private material is stored outside the repository in the Happy home directory managed by `packages/happy-cli/src/configuration.ts`.

## Webhooks & Callbacks

**Incoming:**
- GitHub webhook receiver - handlers for `push`, pull request, issues, stars, repository, and other webhook events are registered in `packages/happy-server/sources/modules/github.ts`; the route is wired through the server API modules.
- Socket.IO client events - authenticated realtime updates are received at `/v1/updates` in `packages/happy-server/sources/app/api/socket.ts`.
- REST APIs - Fastify routes under `packages/happy-server/sources/app/api/routes/`, including voice token/usage endpoints in `packages/happy-server/sources/app/api/routes/voiceRoutes.ts`.

**Outgoing:**
- Socket.IO event propagation - server broadcasts session, machine, artifact, RPC, and control-plane updates through `packages/happy-server/sources/app/api/socket.ts` and `packages/happy-server/sources/app/events/`.
- Expo push notifications - `packages/happy-cli/src/api/pushNotifications.ts` sends Expo Push API batches.
- ElevenLabs API calls - `packages/happy-server/sources/app/api/routes/voiceRoutes.ts` mints conversation tokens and queries conversation usage.
- RevenueCat REST API calls - `packages/happy-server/sources/app/api/routes/voiceRoutes.ts` verifies entitlement before issuing hosted voice credentials.

---

*Integration audit: 2026-08-15*
