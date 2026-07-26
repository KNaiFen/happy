# Context

- Project: Happy is a pnpm monorepo for mobile, web, CLI, remote-agent, and encrypted-sync server products that work with Claude Code and Codex.
- Goal: Add model-aware Codex reasoning-effort selection so the mobile app can safely expose `max` and `ultra` where supported.
- Current state: The model-aware Codex reasoning implementation is complete but unreleased. CLI `model/list` discovery publishes machine/session capabilities, the app consumes them in all model/effort pickers, and runtime validation prevents unsupported model/effort pairs.
- Constraints: Preserve existing project conventions; use pnpm with Node.js 20 or newer; do not commit generated build output, local environment files, or credentials.
- Useful paths: `docs/plans/codex-model-aware-reasoning-effort.md`, `packages/happy-app/sources/components/modelModeOptions.ts`, `packages/happy-cli/src/codex/codexModelCapabilities.ts`, `packages/happy-cli/src/codex/codexEffortValidation.ts`, and `packages/happy-cli/src/codex/runCodex.ts`.
