# ADR-001: Use entity-based Sync v4 for Codex

## Status

Accepted

## Date

2026-07-27

## Context

Happy's original Codex integration projected provider events into the v3 chat
stream and treated the relay connection as a reliable transport. That design
had several coupled failure modes:

- send acknowledgements and the receive cursor shared state;
- the CLI outbox was memory-backed and could be reordered under pressure;
- Socket.IO delivery was treated as data instead of an invalidation hint;
- one selected thread and turn owned completion state for all notifications;
- a wall-clock timeout could mark a healthy long turn as complete;
- child-thread events could overwrite the selected parent projection; and
- the App could not rebuild execution, approval, or streaming state after a
  restart.

These are cross-layer correctness failures. Replacing only the Codex CLI
adapter cannot repair Server sequencing, App persistence, projection recovery,
or child-session navigation. The earlier assumptions that the existing
transport was sufficient and that Codex was a CLI-only change are therefore
rejected.

Claude's v3 integration does not share the Codex provider protocol and remains
supported. A provider-wide migration would increase release risk without
helping the Codex failure modes.

## Decision

### Scope and cutover

Codex sessions use Sync v4 across Wire, Server, CLI, and App. Claude sessions
continue to use v3. Codex does not dual-write v3 and v4 canonical state.

The four distributables are upgraded as one coordinated compatibility set.
The Server routes may be deployed before the clients, but Codex v4 is enabled
only after the matching App and CLI are available and no old Codex turn is
running. The disabled legacy Codex adapter is retained for one patch cycle as
an emergency code rollback. Database changes are additive and rollback never
deletes Sync v4 data.

### Outer synchronization protocol

The Server stores opaque, encrypted entity mutations and assigns a per-session
`syncV4Seq`. It exposes three authenticated operations:

- `POST /v4/sessions/:sessionId/mutations` returns ordered mutation ACKs only;
- `GET /v4/sessions/:sessionId/changes?after_seq=N` advances only the caller's
  receive cursor; and
- `GET /v4/sessions/:sessionId/snapshot` rebuilds the latest entity set at a
  declared high watermark.

Send ACK state, receive cursor state, and snapshot watermark are independent.
Socket.IO sends only `{ sessionId, highWatermark }` invalidations. Correctness
comes from polling and pull recovery, so a lost or duplicated invalidation is
harmless. A cursor older than retained journal data receives HTTP 410 with
`snapshotRequired`.

Mutation IDs are idempotency keys. Reusing an ID with different content is a
conflict. Lower entity revisions are journaled as `superseded`; revision gaps
are allowed. Deletes remain as entity tombstones. Journal rows are pruned only
after they are both older than seven days and outside the most recent 100,000
rows for that session.

The Server never receives provider IDs or plaintext entity content. The App
and CLI derive `entityId` by HMAC over entity type and provider ID with the
session key. Entity content uses AEAD, with session ID, opaque entity ID,
entity type, revision, and operation in AAD. Logs and protocol traces contain
only payload shape, timing, and hashed IDs.

### Durable clients

The CLI owns an append-only JSONL journal under `~/.happy/sync-v4/`. It records
outbound mutations, inbound changes, ACKs, receive cursor, entity revisions,
and command transitions. A mutation is sent FIFO only after it is durable. An
inbound change is journaled before decryption and execution, and the cursor is
advanced only after processing. A truncated final record is recoverable;
compaction uses atomic rename.

The App stores entity cache records, outbox mutations, revision watermarks,
snapshot markers, and receive cursor as separate MMKV keys. Entity writes
precede cursor writes. Startup hydrates the local cache before pulling. A
corrupt cache or HTTP 410 starts a marked snapshot rebuild, resets the in-memory
projection, then reapplies unacknowledged outbox entities. Stopped client
generations cannot write shared persistence after an in-flight request returns.

### Inner Codex entity model

Canonical Codex state is represented by independently revisioned entities:

- `codex.thread`, `codex.runtime`, and `codex.turn` for provider and execution
  lifecycle;
- `codex.item` and ordered `codex.part` records for streamed content and tools;
- `codex.request` for approvals, permissions, and tool user input;
- immutable `codex.command` and `codex.commandResult` records for remote
  operations; and
- `codex.relation` for parent delegation and child Happy sessions.

Text, reasoning summaries, command output, patches, plan updates, and MCP
progress are split into UTF-8 chunks no larger than 64 KiB. Full chunks are
immutable; only the current tail part receives revisions. A mutation ciphertext
is limited to 256 KiB, and a batch is limited to 100 mutations and 4 MiB.

Only official reasoning summaries are synchronized. Raw reasoning text is
counted for local diagnostics but is never written to Sync v4.

### Codex Gateway protocol boundary

Happy generates protocol types from exactly `codex-cli 0.145.0` using
`codex app-server generate-ts` without experimental flags. The generator
rejects any other version. Runtime accepts `0.145.0` or newer and refuses older
or unreadable versions. Initialization always advertises
`experimentalApi: false`.

Stable notifications are routed by their real `(threadId, turnId, itemId)` into
a per-thread registry. An unknown thread creates a placeholder and triggers
`thread/read`; it is never guessed to be the selected thread or a sidechain.
Legacy `codex/event/*` notifications may be observed for compatibility
coverage, but they do not produce canonical entities.

Turn completion has no wall-clock timeout. A turn ends only from official
`turn/completed`, an authoritative non-active thread status, or a recovered
thread snapshot. RPC timeout or transport loss means the outcome is unknown and
must be reconciled; it does not mean idle or completed.

Streaming deltas are coalesced for at most 200 ms. Lifecycle boundaries such as
started, completed, blocked, and error flush immediately.

### Commands and provider completion

App commands are immutable entities. Cancellation, editing, or replacement
creates another command referencing the original. The App and CLI never update
the same command entity. Prompt and steer requests set
`clientUserMessageId=commandId`, allowing restart reconciliation against the
official `UserMessage.clientId`.

Read-only commands may be retried. Non-idempotent control calls are not replayed
when their RPC outcome is unknown. Interrupts are scoped to the expected turn
ID, and approval responses are scoped to the provider request ID.

`/compact` maps to `thread/compact/start` and never becomes prompt text. The RPC
acknowledgement is not completion: success is published only after the matching
`contextCompaction` item has emitted both `item/started` and `item/completed` in
the same process generation. There is no completion timer. The deprecated
`thread/compacted` notification is coverage-only and is not canonical.

`/review` maps to `review/start`. Recognized control commands fail explicitly
if unavailable and never fall through to a normal prompt.

Codex 0.145 stable v2 exposes observed permission-profile and collaboration-mode
settings, but does not expose stable request fields that write either setting.
Sync v4 therefore preserves and displays those observed values but does not
offer remote writes for them. Happy will not enable experimental API methods to
fill this gap. Approval policy, sandbox policy, model, reasoning effort, and
other stable turn overrides remain remotely controllable.

### History migration and child threads

The first v4 resume of an existing Codex session transitions encrypted sync
state from `pending` to `importing` to `ready`. The App continues to render the
old v3 history until `ready`, then renders only the v4 projection. Old v3 rows
remain available for rollback.

Codex 0.145 stable v2 does not provide the proposed `thread/turns/list` and
`thread/items/list` pagination calls. Migration first calls
`thread/read(includeTurns=true)`. It falls back to a plain `thread/resume` only
for the exact official error `paginated threads do not support
thread/read(includeTurns=true)`, because stable resume materializes the full
turn history. No experimental pagination field is sent.

Child thread IDs found in official collaboration items become real Happy side
sessions. Each child has its own session key, runtime, turns, and message flow.
The parent retains a delegation relation and navigation target. Child sessions
are hidden from the top-level list, have no input composer, and are read-only.
A child completion can update only that child's runtime and relation.

### Explicit exclusions

This integration does not remotely expose account login, configuration or raw
filesystem mutation, bare process control, plugin marketplace operations,
Codex's own remote control, realtime voice, feedback upload, or Windows sandbox
management.

## Alternatives Considered

### Patch the v3 Codex adapter

Rejected. It cannot recover durable send state, split send ACKs from receive
cursors, rebuild provider execution state, or isolate child projections.

### Move every provider to Sync v4

Rejected for this release. Claude remains maintained on v3, and changing it
would enlarge the compatibility and rollback surface without fixing an
additional Codex requirement.

### Dual-write Codex to v3 and v4

Rejected. Two canonical histories make ordering, deduplication, activation, and
rollback ambiguous. Migration retains v3 history but does not keep writing it.

### Use experimental Codex app-server methods

Rejected. Experimental request shapes are not a supportable compatibility
floor. Missing stable operations remain explicitly unavailable until the pinned
stable schema supports them.

### Treat Socket.IO as the event stream

Rejected. Reconnect gaps and lost invalidations must not lose canonical state.
The sequence journal and snapshot are authoritative.

### Let the Server decode Codex entities

Rejected. It would weaken Happy's end-to-end encryption boundary and expose
provider IDs, prompts, tool arguments, and outputs to the relay.

## Consequences

- Codex synchronization becomes recoverable after App, CLI, or Server restart,
  at the cost of new persistence and projection complexity.
- Long turns cannot end merely because time elapsed. During disconnection the
  App preserves the last status and labels it unknown instead of showing idle.
- Coordinated releases are mandatory for Codex; partial client rollout is not a
  supported long-term mode.
- Stable-v2 limitations are visible capability gaps rather than silently using
  experimental RPCs or prompt fallbacks.
- Entity and mutation metrics can diagnose lag and conflicts without recording
  plaintext content.
- Additive tables and retained v3 history allow code rollback without a
  destructive database rollback.

## Superseded Documents

This ADR supersedes the architectural and release-scope assumptions in:

- `docs/plans/codex-app-server-migration.md`; and
- `docs/plans/codex-slash-command-routing.md`.

Those files remain as historical implementation plans. Where they conflict
with this ADR, this ADR is authoritative.
