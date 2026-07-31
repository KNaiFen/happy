# ADR-002: Separate Codex lifecycle, transport state, and timeline order

## Status

Accepted

## Date

2026-07-31

## Context

Codex Sync v4 persists provider entities, but three remaining projections still depend on unrelated signals:

- session archival is inferred from a best-effort RPC to the CLI, while a delayed heartbeat can set the database row active again;
- App message order falls back to timestamps created on different devices, so a fast tool item can sort before the user command that caused it; and
- UI activity is derived partly from transport connectivity, allowing a brief disconnect to replace a still-active turn with idle or offline state.

These signals are not authoritative for one another. A CLI process may be unreachable after the relay has accepted an archive. Wall clocks do not establish provider event order. A transport disconnect does not complete a provider turn.

## Decision

### Persistent archival

`Session.archivedAt` is the relay-authoritative tombstone. Archive is idempotent and immediately removes the session from active projections. Heartbeats and v3/v4 writes include an `archivedAt: null` condition and return a typed terminal error when the condition is not met. Reads remain available.

Stopping the CLI is a bounded background action and cannot roll back a successful archive. Explicit resume-in-place uses a separate idempotent unarchive endpoint authorized only by the session's original terminal machine credential.

### Provider timeline order

Each Codex item may carry an encrypted turn-local `eventSequence`. The CLI assigns it once when the item first enters the serialized stable-v2 notification stream. Later deltas and completion revisions preserve it. App ordering uses the sequence within a turn and timestamps only for legacy entities or cross-turn fallback.

Historical snapshot order is an import convention validated against the pinned stable-v2 fixture, not a general guarantee about undocumented provider response ordering. The field remains optional so existing v4 cache records can be read during upgrade.

### Orthogonal activity axes

Codex connection and provider execution are independent state axes. Business notifications change activity immediately. Transport disconnects update only connection state and retain the last official active phase until changes or a snapshot supplies a provider terminal state.

The in-chat “thinking” row is a local projection, not a synchronized message. It is replaced immediately by visible MCP, tool, or streamed assistant content and returns immediately if the turn remains active afterward.

## Alternatives Considered

### Keep RPC-first archival

Rejected because reconnect grace and RPC acknowledgement timeouts block the UI, while stale heartbeats can undo the result.

### Add timestamp offsets or clock synchronization

Rejected because clock estimates do not provide a durable causal order and introduce another distributed state dependency.

### Debounce every activity transition

Rejected because it delays real provider feedback. Only transport events are non-authoritative; provider events should remain immediate.

### Mark a turn idle on disconnect

Rejected because a disconnect conveys no provider lifecycle information and recreates the reported thinking/idle flicker.

## Consequences

- The Server requires an additive migration and explicit archived-session write guards.
- CLI and App remain compatible with old v4 item entities because `eventSequence` is optional.
- An active turn can continue to display activity for an extended outage; this is intentional until authoritative reconciliation occurs.
- Connection health may be shown separately, but it cannot replace or clear provider activity.
- Resume-in-place has an explicit authorization boundary instead of implicitly reviving a tombstoned session through heartbeat traffic.
