# Technology Stack

**Analysis Date:** 2026-08-15

## Languages

**Primary:**
- TypeScript 5.9 / 6.0 - Application, server, CLI, agent, shared protocol, Electron desktop client, and build scripts under `packages/*` and `scripts/`.

**Secondary:**
- JavaScript / CommonJS - Expo configuration, package/build scripts, CI helpers, and release tooling in `packages/happy-app/app.config.js`, `packages/*/scripts/`, and `scripts/`.
- Rust 2021, minimum 1.88 - Tauri native desktop shell in `packages/happy-app/src-tauri/Cargo.toml`.
- SQL (Prisma migrations) - Relational schema and database evolution in `packages/happy-server/prisma/schema.prisma` and `packages/happy-server/prisma/migrations/`.
- YAML - pnpm workspace definition, Expo EAS profiles, Kubernetes/deployment manifests, Maestro flows, and GitHub Actions under `pnpm-workspace.yaml`, `packages/happy-*/deploy/`, `packages/happy-app/eas.json`, `scripts/ci/maestro/`, and `.github/workflows/`.

## Runtime

**Environment:**
- Node.js 24 for primary CI, CLI, server, agent, Codium, and shared-package workflows, pinned by `.github/workflows/ci.yml` and release workflows.
- Node.js 22 for the Android build workflow in `.github/workflows/build-android-release.yml`.
- Bun 1.2.20 for the standalone server build path in `packages/happy-server/package.json` and `.github/workflows/ci.yml`.
- Java 17 and Android SDK 36 for Android release builds in `.github/workflows/build-android-release.yml`.
- Rust 1.88 for the optional Tauri desktop application in `packages/happy-app/src-tauri/Cargo.toml` and `.github/workflows/ci.yml`.

**Package Manager:**
- pnpm 10.11.0, declared in root `package.json` and package manifests.
- Lockfile: present as `pnpm-lock.yaml`.
- Workspace definition: `pnpm-workspace.yaml` enumerates seven packages.

## Frameworks

**Core:**
- Fastify 5.8.5 - HTTP API and static-serving host in `packages/happy-server/sources/`.
- Socket.IO 4.8.3 - Authenticated realtime control plane at `/v1/updates` in `packages/happy-server/sources/app/api/socket.ts`; clients live in `packages/happy-app/sources/sync/apiSocket.ts`, `packages/happy-cli/src/api/`, and `packages/happy-agent/src/machineRpc.ts`.
- Prisma 6.19.2 - Server data access and migrations in `packages/happy-server/prisma/` and `packages/happy-server/sources/storage/db.ts`.
- Expo SDK 55, React Native 0.83.1, React 19.2 - Native iOS/Android and web application in `packages/happy-app/`.
- Expo Router - App routing in `packages/happy-app/sources/app/`.
- Tauri 2.11 and Rust - Optional macOS desktop shell configured in `packages/happy-app/src-tauri/`.
- Electron 41, electron-vite 5, React 19, and Vite 8 - Codium desktop client in `packages/codium/`.
- Ink 6.5 - Interactive terminal UI for the `happy` CLI in `packages/happy-cli/src/ui/ink/`.

**Testing:**
- Vitest 3.2.6 - Default test runner for `happy-app`, `happy-agent`, `happy-cli`, `happy-server`, and `happy-wire`; per-package configuration is in `packages/*/vitest.config.ts`.
- Vitest 4.1.5 - Codium tests through `packages/codium/vitest.config.ts`.
- Maestro - Android field/recovery flows in `scripts/ci/maestro/`, launched by `.github/workflows/codex-android-field-e2e.yml`.
- `@microsoft/tui-test` - CLI gateway TUI end-to-end tests in `packages/happy-cli/tests/tui/`.

**Build/Dev:**
- `tsx` - Direct TypeScript execution throughout package `dev`, `start`, and test-support commands.
- `pkgroll` - Publishes bundled TypeScript packages from `packages/happy-cli/`, `packages/happy-agent/`, and `packages/happy-wire/`.
- Expo Application Services (EAS) - Native app build/update configuration in `packages/happy-app/eas.json` and `packages/happy-app/package.json`.
- Vite / electron-vite - Codium development and package build in `packages/codium/package.json`.
- GitHub Actions - CI, source-built Codex verification, releases, security scanning, and documentation checks in `.github/workflows/`.

## Key Dependencies

**Critical:**
- `@slopus/happy-wire` 0.1.8 - Shared Zod control-plane schemas and Codex Sync v4 wire types; consumed by `happy-app`, `happy-agent`, and `happy-server`.
- `@openai/codex` 0.146.0 - Bundled Codium runtime dependency in `packages/codium/package.json`; CLI integrates with the installed official Codex app-server via `packages/happy-cli/src/codex/codexAppServerClient.ts`.
- `@prisma/client` 6.19.2 and `prisma` 6.19.2 - Server persistence API and generated database client in `packages/happy-server/`.
- `@electric-sql/pglite` 0.3.15 and `pglite-prisma-adapter` 0.6.1 - Embedded, durable self-host database option in `packages/happy-server/sources/storage/db.ts`.
- `socket.io` / `socket.io-client` 4.8.3 - Realtime session, machine, and command transport across server, app, CLI, and agent.
- `ws` 8.21.0 - Official Codex app-server WebSocket transport in `packages/happy-cli/src/codex/codexAppServerWebSocket.ts`.
- `tweetnacl`, `@noble/ed25519`, and libsodium bindings - Device/account and payload cryptography in `packages/happy-cli/`, `packages/happy-app/`, and `packages/happy-agent/`.

**Infrastructure:**
- `ioredis` 5.6.1 and `@socket.io/redis-streams-adapter` 0.2.2 - Optional multi-process event fan-out in `packages/happy-server/sources/app/api/socket.ts`.
- `minio` 8.0.7 - S3-compatible attachment/object store client in `packages/happy-server/sources/storage/files.ts`.
- `prom-client` 15.1.3 - Prometheus metrics exporter in `packages/happy-server/sources/app/monitoring/`.
- `octokit` 5.0.3 and `@octokit/webhooks` - GitHub App, OAuth, and webhook support in `packages/happy-server/sources/modules/github.ts`.
- `expo-server-sdk` 3.15.0 - CLI-originated Expo push notification delivery in `packages/happy-cli/src/api/pushNotifications.ts`.
- `sharp` 0.35.0 - Server-side image processing in `packages/happy-server/`.
- `posthog-react-native` 4.37.5 - Opt-out-capable mobile/web analytics in `packages/happy-app/sources/track/tracking.ts`.
- RevenueCat SDKs and ElevenLabs SDKs - Subscription/paywall and voice-session capabilities in `packages/happy-app/sources/sync/revenueCat/` and `packages/happy-app/sources/realtime/`.

## Configuration

**Environment:**
- Package-local development environment files are present under `packages/happy-cli/` and `packages/happy-server/`; their contents are not read or committed.
- Configure server persistence with `DB_PROVIDER`, `DATABASE_URL` for PostgreSQL, or `PGLITE_DIR` for PGlite, as selected in `packages/happy-server/sources/storage/db.ts`.
- Configure server storage with `DATA_DIR` for local files, or the `S3_*` settings consumed by `packages/happy-server/sources/storage/files.ts`.
- Configure CLI and agent endpoints with `HAPPY_SERVER_URL`, `HAPPY_WEBAPP_URL`, and local state path `HAPPY_HOME_DIR` in `packages/happy-cli/src/configuration.ts` and `packages/happy-agent/src/config.ts`.
- Configure public Expo application values with `EXPO_PUBLIC_*` keys through `packages/happy-app/sources/sync/appConfig.ts` and `packages/happy-app/sources/sync/serverConfig.ts`; public values are not server secrets.

**Build:**
- Root orchestration: `package.json` and `pnpm-workspace.yaml`.
- TypeScript compiler options: `packages/*/tsconfig*.json`.
- App native/runtime configuration: `packages/happy-app/app.config.js`, `packages/happy-app/eas.json`, and `packages/happy-app/src-tauri/*.json`.
- Server container and relay configuration: `Dockerfile.server`, `packages/happy-server/deploy/debian13-amd64/Dockerfile`, and `packages/happy-server/deploy/debian13-amd64/compose.yaml`.
- CI and release definitions: `.github/workflows/ci.yml`, `.github/workflows/build-cli-release.yml`, `.github/workflows/build-android-release.yml`, `.github/workflows/build-debian13-relay-release.yml`, and `.github/workflows/build-happy-agent-release.yml`.

## Platform Requirements

**Development:**
- Use pnpm 10.11.0 and the package-specific Node version required by the target workflow; Node 24 is the normal server/CLI/agent baseline.
- Use Android SDK 36 and Java 17 only for Android-specific development; native release artifacts are built in GitHub Actions.
- Do not require local Rust/Tauri compilation for normal TypeScript work; `packages/happy-app/src-tauri/` is a separately configured desktop target.
- Run source-level typechecks and Vitest at the narrowest package scope; package/release builds are cloud-workflow responsibilities.

**Production:**
- Hosted control-plane server: Fastify/Socket.IO package `happy-server-self-host`, deployed from `packages/happy-server/deploy/` or its Debian relay bundle workflow.
- Native app: Expo/React Native Android and iOS, with Android artifact generation in `.github/workflows/build-android-release.yml`.
- CLI and remote agent: npm packages published from `packages/happy-cli/` and `packages/happy-agent/` by their dedicated GitHub Actions workflows.
- Desktop clients: optional Tauri shell in `packages/happy-app/src-tauri/` and Electron-based Codium in `packages/codium/`.

---

*Stack analysis: 2026-08-15*
