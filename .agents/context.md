# Context

- Project: Happy is a pnpm monorepo for mobile, web, CLI, remote-agent, and encrypted-sync server products that work with Claude Code and Codex.
- Goal: Ship a self-contained Android client that exposes model-aware Codex reasoning levels without being replaced by the official OTA bundle.
- Current state: The model-aware Codex reasoning implementation is complete but unreleased. Local Android release builds can disable Expo OTA updates, and the mobile send action keeps a visible high-contrast icon.
- Constraints: Preserve existing project conventions; use pnpm with Node.js 20 or newer; do not commit generated build output, local environment files, or credentials.
- Useful paths: `docs/plans/codex-model-aware-reasoning-effort.md`, `packages/happy-app/app.config.js`, `packages/happy-app/sources/components/AgentInput.tsx`, `packages/happy-app/sources/components/modelModeOptions.ts`, and `packages/happy-cli/src/codex/codexModelCapabilities.ts`.
