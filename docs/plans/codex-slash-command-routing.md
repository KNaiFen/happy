# Codex Slash-Command Routing

## Status

Proposed (deferred)

## Date

2026-07-27

## Summary

Happy can transport arbitrary mobile messages to a Codex session, but its Codex adapter does not translate most slash commands into Codex app-server operations. The app advertises `/compact`, `/clear`, `/goal`, `/mcp`, `/skills`, and discovered skill commands. Only `/clear` and `/goal` currently have dedicated Codex behavior.

Implement the missing behavior entirely in `happy-cli`. The mobile app already sends the required text and should not need to be rebuilt. Happy Server, the relay, and shared wire schemas should remain unchanged.

The first release carrying this work should be CLI `1.4.1`, built and tested by the existing version-gated GitHub Actions workflow.

## Verified Gap

The locally installed `codex-cli 0.145.0` exposes these app-server operations and payloads:

- `thread/compact/start` with `{ threadId: string }`
- `thread/compacted` and `contextCompaction` completion events
- `skills/list`
- `mcpServerStatus/list`
- Native user input `{ type: "skill", name: string, path: string }`

Happy's current paths differ:

1. `runClaude.ts` calls `parseSpecialCommand()` and isolates `/compact`, `/clear`, `/mcp`, and `/skills` before normal prompt processing.
2. `runCodex.ts` calls `enqueueCodexUserText()`, which recognizes only `/clear`.
3. `runCodex.ts` recognizes `/goal` only after a queued string has been collected and a thread has been created.
4. Every remaining slash command reaches `CodexAppServerClient.sendTurnAndWait()` as a normal text prompt.
5. `codexAppServerTypes.ts` supports text and image inputs but omits the protocol's native skill input.

The defect is therefore in the Happy CLI Codex adapter, not the mobile transport, relay server, or Codex runtime.

## Goals

- Route advertised Codex slash commands to their real app-server operations.
- Prevent commands from being combined with adjacent queued messages.
- Preserve queued user prompts unless `/clear` intentionally discards them.
- Invoke discovered Codex skills using native skill inputs rather than plain slash text.
- Render command results in the app through the existing session protocol.
- Fail explicitly when a known control command is unsupported instead of sending it to the model.
- Preserve compatibility for ordinary prompts and unknown slash-prefixed text.

## Non-Goals

- Do not modify the mobile UI or autocomplete in the first implementation.
- Do not add a server endpoint, database field, or wire-schema migration.
- Do not emulate every Codex TUI command. Commands hidden by the app, such as `/model`, `/review`, and `/permissions`, remain out of scope.
- Do not accept arbitrary skill paths from a remote message.
- Do not add per-request custom compaction prompts; the current compact RPC accepts only a thread ID.

## Current Flow

```text
Mobile app sends UserMessage { text, meta, attachments }
|
`-- runCodex.ts: session.onUserMessage()
    `-- enqueueCodexUserText()
        +-- exact /clear -> MessageQueue2.pushIsolateAndClear()
        `-- everything else -> MessageQueue2.push()
            `-- collectBatch() joins compatible messages with newlines
                +-- parseCodexGoalCommand() may handle /goal
                `-- CodexAppServerClient.sendTurnAndWait()
                    `-- turn/start.input = [{ type: "text", text: prompt }]
```

This creates two independent failures:

- A known command such as `/compact` becomes model text instead of a protocol request.
- A command such as `/goal` can be joined with a following message before it is parsed, causing command recognition to fail.

## Decision

Add a Codex-specific command router at the queue boundary and dispatch the parsed command again when the isolated queue item is consumed.

Keep `MessageQueue2` generic and unchanged. The Codex adapter will decide which existing queue operation to use:

| Input kind | Queue operation | Reason |
| --- | --- | --- |
| `/clear` | `pushIsolateAndClear()` | Reset semantics intentionally discard pending prompts. |
| Other built-in command | `pushIsolated()` | Preserve ordering and prevent batching. |
| Known skill command | `pushIsolated()` | Keep the skill invocation and its arguments in one turn. |
| Normal or unknown slash text | `push()` | Preserve current prompt batching behavior. |

Built-in commands take precedence over a skill with the same name. Unknown slash-prefixed input remains a normal prompt for backward compatibility.

## Proposed Command Model

The exact symbol names may be adjusted during implementation, but the discriminated behavior is required.

```typescript
type ParsedCodexInput =
    | { kind: 'prompt'; text: string }
    | { kind: 'clear' }
    | { kind: 'compact' }
    | { kind: 'goal'; command: CodexGoalCommand }
    | { kind: 'mcp' }
    | { kind: 'skills' }
    | { kind: 'skill'; skill: CodexSkillDescriptor; prompt: string };

type CodexSkillDescriptor = {
    command: string;
    name: string;
    path: string;
    description?: string;
    enabled: boolean;
};
```

Skill paths must come from `skills/list` or trusted local discovery. The remote message supplies only the command name and optional prompt text.

## Target Flow

```text
Mobile app sends UserMessage { text, meta, attachments }
|
`-- runCodex.ts: session.onUserMessage()
    `-- parse Codex input at enqueue time
        +-- /clear -> pushIsolateAndClear()
        +-- known built-in or skill -> pushIsolated()
        `-- prompt or unknown slash text -> push()
            |
            `-- main Codex loop parses the dequeued item
                +-- clear -> clearThreadState()
                +-- compact -> thread/compact/start
                +-- goal -> thread/goal/set or thread/goal/clear
                +-- mcp -> mcpServerStatus/list
                +-- skills -> skills/list
                +-- skill -> turn/start with native skill input
                `-- prompt -> existing turn/start path
```

## Command Semantics

| Input | Required behavior |
| --- | --- |
| `/compact` | Compact the active thread without creating a normal model turn or changing the thread ID. |
| `/compact <text>` | Return an explicit message that Codex does not support a per-request compact prompt. Do not discard the text silently. |
| `/clear` | Preserve the current local reset behavior and remove `codexThreadId` from session metadata. |
| `/goal <objective>` | Call `thread/goal/set` as an isolated command. |
| `/goal clear` | Call `thread/goal/clear` as an isolated command. |
| `/mcp` | Return app-server MCP status without consuming a model turn. |
| `/skills` | Return enabled app-server skills without consuming a model turn. |
| `/<known-skill> [prompt]` | Start a normal turn containing a native skill input plus prompt and image inputs. |
| `/<unknown>` | Continue through the normal prompt path. |

If `/compact` is used before a thread exists, report that there is no context to compact and do not create an empty thread. `/mcp` may create a thread without starting a model turn when a thread ID is required to inspect thread-scoped MCP configuration.

Known control commands with unsupported RPCs must produce a visible compatibility error. They must not fall back to a model prompt.

## Implementation Plan

### Phase 1: Command Parsing and Queue Isolation

- Replace the clear-only Codex command helper with a unified parser and enqueue helper.
- Reuse `parseSpecialCommand()` for `/compact`, `/clear`, `/mcp`, and `/skills` where its semantics match.
- Reuse `parseCodexGoalCommand()` for goal operations.
- Match discovered skill names only against the trusted skill registry.
- Use `pushIsolated()` for non-clear commands so queued prompts are not lost.
- Keep unknown slash commands and normal messages on `push()`.
- Reject attachments on non-turn control commands with a visible message instead of dropping them silently.
- Continue allowing attachments for native skill turns.

### Phase 2: App-Server Protocol Support

- Add minimal compact, skills-list, MCP-status, and native-skill types to `codexAppServerTypes.ts`.
- Extend `InputItem` with `{ type: "skill"; name: string; path: string }`.
- Add a compact request method to `CodexAppServerClient` using `thread/compact/start`.
- Track one pending compaction per active thread with a bounded timeout.
- Resolve compaction from `item/completed` where `item.type === "contextCompaction"`.
- Also accept deprecated `thread/compacted` notifications for compatibility.
- Deduplicate completion if both notification forms arrive.
- Add paginated `mcpServerStatus/list` support.
- Add `skills/list` support for the current working directory.
- Preserve the existing string prompt API while allowing an exact `InputItem[]` for native skill turns.

### Phase 3: Skill Registry

- Retain paths and descriptions during local skill discovery instead of reducing discovery to command names.
- Refresh the authoritative registry from `skills/list` after the app-server connects.
- Update session `metadata.skills` and `metadata.slashCommands` with display command names while retaining the private name-to-path map in the CLI process.
- Prefer the app-server entry when local discovery and app-server discovery disagree.
- Preserve the existing local discovery result when `skills/list` is unavailable.
- Resolve duplicate names deterministically for the current working directory.

### Phase 4: Command Execution and App Output

- Dispatch control commands before the normal model-turn construction in `runCodex.ts`.
- Keep `/clear` before thread creation.
- Handle `/skills` without requiring a thread.
- Ensure a thread exists before `/goal`, thread-scoped `/mcp`, or a native skill turn.
- Handle `/compact` only when an active thread exists.
- Extract the existing Codex event callback into a reusable local handler so synthetic `/mcp`, `/skills`, compatibility, and completion messages use the same session-protocol mapping as agent messages.
- Mark the session busy while manual compaction is running and restore ready state on success, timeout, or failure.
- Preserve model, effort, sandbox, permission, append-prompt, title-instruction, and image handling for skill turns.

### Phase 5: Compatibility and Errors

- Treat JSON-RPC method-not-found separately from timeouts and process failures.
- Recommend Codex `0.145.0` or newer when a required method is unavailable; this is the locally verified protocol baseline.
- Fall back to cached local metadata for `/skills` and configured server metadata for `/mcp` where practical.
- Never reinterpret a recognized control command as a normal prompt after an RPC failure.
- Keep the Codex process and session alive after command errors.

### Phase 6: Version and Cloud Release

- Increment only `packages/happy-cli/package.json` from `1.4.0` to `1.4.1` after implementation and verification.
- Do not change the app version.
- Run targeted CLI unit tests and TypeScript type checking locally; do not run Cargo or Tauri builds.
- Push the implementation and version bump to `main`.
- Let `.github/workflows/build-cli-release.yml` run the complete CLI build, unit suite, archive verification, and npm packing.
- Download `happy-1.4.1.tgz` into `dist/release-artifacts` after the workflow succeeds.
- Do not trigger the Android workflow, rebuild the APK, or redeploy Happy Server.

## Expected Files

- `packages/happy-cli/src/codex/codexClearCommand.ts` or its unified replacement
- `packages/happy-cli/src/codex/codexSkills.ts`
- `packages/happy-cli/src/codex/codexAppServerTypes.ts`
- `packages/happy-cli/src/codex/codexAppServerClient.ts`
- `packages/happy-cli/src/codex/runCodex.ts`
- Corresponding Codex unit-test files
- `packages/happy-cli/package.json` only when the implementation is ready to release

The first implementation should not modify `packages/happy-app`, `packages/happy-server`, `packages/happy-wire`, or either release workflow.

## Test Plan

### Parser and Queue Tests

- Exact built-in commands, surrounding whitespace, case rules, and embedded slash text.
- `/compact <text>` is recognized but rejected explicitly by the executor.
- `/clear` clears pending messages and remains isolated.
- `/compact`, `/goal`, `/mcp`, `/skills`, and known skills are isolated without clearing earlier prompts.
- Unknown slash text retains normal batching behavior.
- Built-in command names take precedence over matching skill names.

### Client Protocol Tests

- `thread/compact/start` is sent once with the active thread ID.
- A context-compaction item resolves the pending compact operation.
- The deprecated compact notification also resolves it.
- Duplicate completion notifications are harmless.
- Missing completion times out without leaving pending state behind.
- Skills and MCP list responses are parsed and MCP pagination terminates safely.
- Native skill input is serialized with the expected name and path.

### Execution Tests

- `/compact` never emits `turn/start` and preserves the thread ID.
- `/compact` before the first turn is a no-op with a visible explanation.
- `/mcp` and `/skills` do not start model turns.
- A native skill turn preserves its prompt, images, model, effort, and execution policy.
- `/goal` remains valid when another message arrives immediately afterward.
- Unsupported known commands return compatibility errors and do not reach the model.
- Ordinary text, unknown slash text, image-only turns, clear, goal, interrupt, resume, and thread fork behavior do not regress.

### Verification Commands

```bash
pnpm --filter happy exec vitest run src/codex/codexCommands.test.ts
pnpm --filter happy exec vitest run src/codex/codexSkills.test.ts
pnpm --filter happy exec vitest run src/codex/codexAppServerClient.test.ts
pnpm --filter happy typecheck
```

The GitHub release workflow remains the authoritative full build and package gate.

## Acceptance Criteria

- Sending `/compact` from the app causes exactly one `thread/compact/start` request and no text turn.
- The app visibly enters and exits a busy state during compaction.
- The active Codex thread remains usable after compaction.
- `/mcp` and `/skills` return accurate assistant-visible results without model token usage.
- An advertised skill command produces a native skill input with a trusted path.
- Control commands cannot be merged with adjacent queued messages.
- `/clear` and `/goal` preserve their intended behavior.
- Unknown slash text remains backward compatible.
- The complete CLI unit suite passes in GitHub Actions and produces `happy-1.4.1.tgz`.
- No APK, relay deployment, database migration, or local Rust/Tauri build is required.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Codex notification format changes | Accept both context-compaction item completion and the deprecated compact notification. |
| Command isolation drops prompts | Use `pushIsolated()` for every command except the intentionally destructive `/clear`. |
| Duplicate skill names select the wrong path | Source the active registry from app-server data for the current working directory and resolve deterministically. |
| Older Codex lacks an RPC | Detect method-not-found, provide an explicit upgrade message, and retain metadata fallbacks where possible. |
| Synthetic command output renders differently | Route it through the same event-to-session-protocol mapper as normal Codex agent messages. |
| A compact operation hangs | Use a bounded pending-operation timeout and clear state on every terminal path. |

## Rollback

The change is CLI-local. Rollback consists of reinstalling CLI `1.4.0`; the app, relay, server data, and Codex thread files require no migration. Compact and list operations do not introduce persistent Happy metadata beyond the already-existing thread ID and skill-command fields.

## Related Documents

- `docs/plans/codex-app-server-migration.md`
- `docs/plans/codex-model-aware-reasoning-effort.md`
- `docs/competition/codex/message-protocol.md`
