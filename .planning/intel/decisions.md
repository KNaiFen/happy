# Decisions

## ADR-001: Use entity-based Sync v4 for Codex
- source: docs/decisions/ADR-001-codex-sync-v4.md
- status: locked
- decision: Codex uses encrypted entity-based Sync v4 with durable client journals, independent ACK and cursor state, polling and snapshot recovery, stable-v2 app-server APIs, and isolated read-only child sessions.
- scope: Codex, Sync v4, Wire, Server, CLI, App

## ADR-002: Separate Codex lifecycle, transport state, and timeline order
- source: docs/decisions/ADR-002-codex-session-lifecycle-and-timeline-order.md
- status: locked
- decision: Relay archival is authoritative, provider event sequence establishes turn-local order, and connection health remains independent from provider execution state.
- scope: session archival, provider timeline order, connection state, execution state

## ADR-003: Make Codex the only active default provider
- source: docs/decisions/ADR-003-codex-only-provider.md
- status: locked
- decision: Codex is the only active default provider; legacy provider metadata is unsupported while retained non-Codex integrations and shared infrastructure remain available where still used.
- scope: Codex, provider routing, Sync v4, stable-v2, CLI, App

## ADR-004: 通过持久 Gateway 运行官方 Codex TUI
- source: docs/decisions/ADR-004-codex-native-tui-gateway.md
- status: locked
- decision: Interactive Happy Codex sessions run the official Codex TUI through a persistent isolated Gateway worker that owns app-server, Sync v4, attachment, lease, and recovery state.
- scope: Codex TUI, Gateway worker, app-server, Sync v4, thread lease, attach

## ADR-005: 由 daemon 执行同源只读恢复资格预检
- source: docs/decisions/ADR-005-daemon-resume-eligibility-preflight.md
- status: locked
- decision: The daemon performs encrypted, same-origin, read-only resume eligibility preflight using Relay snapshot, binding, official thread, and Gateway evidence without changing session lifecycle.
- scope: daemon, resume preflight, machine RPC, Relay snapshot, Codex thread, Gateway

## ADR-006: Actions supply-chain controls and production dependency gates
- source: docs/decisions/ADR-006-actions-security-and-production-dependency-gates.md
- status: locked
- decision: External Actions remain SHA-pinned, CodeQL and Dependabot provide repository security coverage, and High or Critical production dependency vulnerabilities block changes subject to narrow expiring exceptions.
- scope: GitHub Actions, CodeQL, Dependabot, production dependencies, repository ruleset
