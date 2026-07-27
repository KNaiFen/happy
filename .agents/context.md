# Context

- Project: Happy is a pnpm monorepo for mobile, web, CLI, remote-agent, and encrypted-sync server products that work with Claude Code and Codex.
- Goal: Ship a self-contained Android client that exposes model-aware Codex reasoning levels without being replaced by the official OTA bundle.
- Current state: The model-aware Codex reasoning implementation is complete but unreleased. Local Android release builds disable Expo OTA updates, target arm64-v8a devices, use a high-contrast solid mobile send action, and keep Agent Defaults in device-local storage while mirroring them to account sync. The verified local artifacts are `dist/release-artifacts/happy-1.3.0.tgz` and `dist/release-artifacts/happy-app-1.8.0-android-arm64-v8a-no-ota.apk`; physical-device validation remains open.
- Constraints: Preserve existing project conventions; use pnpm with Node.js 20 or newer; do not commit generated build output, local environment files, or credentials.
- Installation note: npm 12 blocks dependency install scripts by default for a local global tgz install. Run `npm rebuild -g --allow-scripts=happy happy` after installation so the packaged macOS ARM64 `rg` and `difft` binaries are unpacked.
- Useful paths: `docs/plans/codex-model-aware-reasoning-effort.md`, `packages/happy-app/app.config.js`, `packages/happy-app/sources/components/AgentInput.tsx`, `packages/happy-app/sources/sync/localSettings.ts`, `packages/happy-app/sources/components/modelModeOptions.ts`, and `packages/happy-cli/src/codex/codexModelCapabilities.ts`.
