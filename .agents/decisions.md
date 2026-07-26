# Decisions

- [2026-07-27] Extend the existing `.agents/` directory for durable project memory.
  - Why: The directory already contains repository-specific skills and agent guidance.
  - Impact: Project context, decisions, and open items live alongside the existing agent assets without changing their layout.

- [2026-07-27] Keep the existing root `AGENTS.md` synchronization procedure and add only repository-wide maintenance rules.
  - Why: The existing procedure is a deliberate project workflow that remains applicable.
  - Impact: Future tasks have both the established main-branch synchronization rules and a persistent task-completion contract.

- [2026-07-27] Document model-aware Codex reasoning effort as a capability-driven proposal.
  - Why: Codex effort support differs by model, and static global lists already lag the installed Codex protocol.
  - Impact: The proposed implementation publishes local `model/list` capabilities from the CLI, gates advanced app options on advertised support, and requires the CLI to ship before the app consumer.
