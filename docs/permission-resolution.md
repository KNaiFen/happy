# Codex Permission Resolution (stable-v2)

This document describes how the App's Codex permission choice becomes official
app-server `approvalPolicy` and `sandboxPolicy` values. It covers only the
stable-v2 integration; experimental permission-profile mutation is not used.

## Supported App Modes

The App exposes four Codex modes from
`packages/happy-app/sources/components/modelModeOptions.ts`:

| App mode | Official approval policy | Official sandbox mode | Meaning |
| --- | --- | --- | --- |
| `default` | `untrusted` | `workspace-write` | Ask before commands Codex does not consider trusted. |
| `read-only` | `never` | `read-only` | Do not ask; filesystem writes are blocked. |
| `safe-yolo` | `never` | `workspace-write` | Work freely inside the workspace sandbox. |
| `yolo` | `never` | `danger-full-access` | Full host access without ordinary approval prompts. |

`packages/happy-cli/src/codex/executionPolicy.ts` is the canonical mapping.
The CLI accepts remote changes only when the value is one of the four modes
above. Unknown values are ignored in the legacy message path and rejected by
the Sync v4 command executor, so a crafted value cannot widen sandbox access.

## App Resolution

New sessions resolve a mode in this order:

1. an explicit new-session draft selection;
2. the user's Codex default in agent settings;
3. the code default, provided that the selected machine advertises it; and
4. the first supported Codex mode.

For an existing session, the selected mode is stored with the session and sent
with an immutable `codex.command` for `turn.start` or `turn.steer`. Changing the
mode affects the next command; it does not rewrite a command already accepted
by the CLI.

## CLI And Official RPC

The CLI resolves the selected mode immediately before `thread/start` or
`turn/start` and sends the resulting official stable-v2 fields. A per-turn mode
change therefore does not restart the app-server or infer a new thread.

When Happy's optional outer OS sandbox is enabled, that sandbox is the security
boundary. The inner Codex process receives `approvalPolicy=never` and
`sandbox=danger-full-access` so it does not create a second conflicting sandbox;
the outer `@anthropic-ai/sandbox-runtime` policy continues to restrict the
actual process.

## Approval Requests

Official command, file-change, permissions, and tool-input requests become
durable `codex.request` entities. The App answers with a new immutable
`codex.command`, and the CLI reconciles it against the exact provider request
ID before replying to app-server.

- `yolo` may auto-approve ordinary Codex approval requests.
- `safe-yolo` does not auto-approve an escalation or MCP elicitation that Codex
  still surfaces; those requests are precisely the boundary the user must see.
- An outer Happy sandbox may auto-approve the inner request because the outer
  sandbox remains authoritative.
- Provider-created child sessions are read-only. They may display requests but
  cannot answer them.

Transport loss never means approval, denial, or completion. Pending requests
remain visible from the Sync v4 journal/snapshot until an authoritative result
is synchronized.

## Stable-v2 Boundary

Happy can display observed permission-profile and collaboration-mode values,
but the supported stable schema does not provide a write operation for those
settings. The App must not offer a control that silently converts them into
prompt text or enables an experimental RPC.
