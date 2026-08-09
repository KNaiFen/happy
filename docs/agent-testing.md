# Agent Testing

Happy uses distinct layers so a passing mock does not get reported as proof of
the real Codex integration.

## Layer 1: Codex Gateway

Source-level tests exercise parsing, routing, lifecycle, permissions, streaming,
Sync v4 persistence, crash recovery, and projection behavior with deterministic
fixtures. These tests are fast and may use a fake JSON-RPC or Responses endpoint,
but they are regression tests rather than final acceptance.

The cloud-only official scenario builds the latest stable upstream Codex source,
starts the real `codex app-server`, and drives meaningful thread, turn, tool,
reasoning-summary, stream, and completion behavior. Its local Responses fixture
removes the need for model credentials without replacing the official app-server.
The scenario also creates a lab-rat project from
`environments/lab-rat-todo-project/AGENTS.template.md` and verifies that a
sentinel present only in the generated `AGENTS.md` reaches the provider request.

Do not treat an empty wall-clock wait, a fake app-server, or a mocked SDK as this
layer's acceptance evidence.

## Layer 2: Happy Product Chain

Transport scenarios cover CLI journal persistence, relay sequencing, App cache
projection, invalidation loss, reconnect, duplicate and out-of-order delivery,
approval round trips, tool ordering, child sessions, process restart, and
snapshot recovery. Browser and Android field scenarios then verify the visible
session flow, including a zero-machine first launch and the first Sync v4 reply.

The Android API 36 field scenario also verifies request-response recovery with
the source-built official Codex app-server and an MCP SDK server. The MCP tool
opens a real form elicitation, the test queues a follow-up turn, and the App is
killed while the request is still waiting for input. After relaunching the same
session, the test verifies that the radio option starts unchecked, submits the
selected value, observes the MCP's exact accepted-choice marker, consumes the
queued turn, and receives a response sentinel dedicated to that queued input.
Fixture diagnostics must independently confirm that the expected choice reached
the MCP tool and that the exact queued message reached the Responses provider;
a generic tool output, a disappearing queue dock, or a visible request card
alone is not acceptance evidence.

After the recovered request, queued follow-up, and compaction checks, the field
flow sends the structured `/clear` control and then a unique post-clear prompt.
A dedicated Responses sentinel proves that exact prompt reached the provider;
the flow also rechecks restored history so rollback-state repair cannot erase the
App timeline. `/clear` itself must not appear as provider prompt text or an
internal control card.

The fixture decrypts the final Sync v4 snapshot with the session data key. The
field run passes only when the selected thread's runtime is connected and idle,
has no pending approval or user-input count, no decrypted thread has an
`inProgress` turn, every observed turn has an authoritative terminal timestamp,
and no request remains pending. Interrupted rollback history is valid terminal
history; visible streamed text before `response.completed` is insufficient to
prove turn completion. Diagnostic schema 13 separately records the post-clear
provider sentinel, absence of `/clear` provider text, idle runtime,
no-active-turn state, and successful structured rollback command.

The recovered request must not show a running-tool timer, and a failed internal
`request.resolve` command must not appear as a separate timeline card. The
scenario retains the context-compaction and restored-history assertions after
the recovered turn so request recovery cannot hide regressions in the remaining
session timeline.

## Retained Agents

Gemini, Agy, OpenClaw, and generic ACP runners keep their own focused tests.
They must not be used as substitutes for the Codex official scenario, and an
unsupported provider value must fail explicitly rather than fall back to Codex.

## Where Tests Run

Routine unit tests and `tsc --noEmit` may run locally from source. Anything that
builds a distributable, Docker image, Rust/Tauri target, Android app, packed npm
archive, or upstream Codex source runs in GitHub Actions.
