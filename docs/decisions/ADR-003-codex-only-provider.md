# ADR-003: Make Codex the only active default provider

## Status

Accepted

## Date

2026-08-01

## Context

Happy's maintained remote-control path is the official Codex app-server backed
by entity-based Sync v4. The former active Claude provider adapter had its own launch,
authentication, resume, permission, prompt, UI, and v3 projection paths, but was
no longer maintained and had no user history that needed continued rendering.
Keeping those paths active increased routing ambiguity and allowed unknown or
legacy metadata to select behavior that had not been tested with Sync v4.

Happy still has legitimate non-Codex integrations: Gemini, Agy, OpenClaw,
generic ACP, shared v3 infrastructure, competitor research, and the sandbox
package used to enforce Codex process restrictions. A vendor name alone is not
evidence that a file or dependency should be removed.

## Decision

- `happy` and unspecified new sessions select Codex. `happy codex` remains the
  explicit equivalent.
- Remove the obsolete provider's launch, authentication, connect, resume, fork,
  UI, SDK, prompt fallback, and canonical message paths.
- Reject its old command, daemon agent value, flags, session flavor, and metadata
  explicitly. Empty, unknown, or legacy values never become writable Codex
  sessions by inference.
- Codex canonical state uses Sync v4 only. Generic v3 transport remains for the
  retained agents that still require it; it is not a hidden Codex fallback.
- Codex stays on non-experimental stable-v2 with `codex-cli 0.145.0` as the
  minimum version. Only official reasoning summaries are synchronized.
- Keep `@anthropic-ai/sandbox-runtime` while Codex sandboxing depends on it.
- Keep sourced competitor research, historical changelog entries, archived
  plans, immutable external URL slugs, and third-party model labels as history
  or external facts rather than active provider support.

## Consequences

- The App and CLI have one unambiguous default lifecycle and remote-control
  path, reducing state crossover and fallback bugs.
- Users with an obsolete provider value receive an explicit unsupported error.
- Provider-neutral transports and retained agents continue to evolve without
  being mislabeled as Codex.
- Reintroducing an active provider requires a new ADR, explicit schemas,
  end-to-end tests, and a coordinated compatibility plan; restoring a command
  alias or prompt fallback is not sufficient.

## Supersedes

This ADR supersedes only the provider-scope statements in ADR-001 that retained
the obsolete provider on v3. ADR-001 remains authoritative for Codex Sync v4,
stable-v2, encryption, durable queues, lifecycle, and child-session isolation.
