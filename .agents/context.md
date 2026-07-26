# Context

- Project: Happy is a pnpm monorepo for mobile, web, CLI, remote-agent, and encrypted-sync server products that work with Claude Code and Codex.
- Goal: Maintain durable repository context for future agent work while keeping each change focused and verified.
- Current state: The repository is on `main`, tracks `origin/main`, and uses `.agents/` for project skills and agent guidance.
- Constraints: Preserve existing project conventions; use pnpm with Node.js 20 or newer; do not commit generated build output, local environment files, or credentials.
- Useful paths: `packages/happy-app/`, `packages/happy-cli/`, `packages/happy-agent/`, `packages/happy-server/`, `docs/CONTRIBUTING.md`, and `.agents/skills/`.
