# Codex Model-Aware Reasoning Effort

## Status

Implemented and archived

## Date

2026-07-27

## Summary

Happy currently caps the Codex reasoning-effort picker at `xhigh`, even when the installed Codex model supports `max` or `ultra`. The restriction is in Happy's static app and CLI compatibility layers, not in the message transport or Codex itself.

Replace the global hardcoded Codex effort list with model capabilities reported by the local Codex app-server. Publish those capabilities through encrypted machine and session metadata, consume them in every app picker, and validate remote selections against the selected model's advertised levels.

The CLI capability publisher must ship before the app starts displaying advanced levels. A new app connected to an older CLI must retain the current `xhigh` fallback.

## Verified Evidence

The diagnosis was reproduced with the locally installed `codex-cli 0.145.0` using `codex debug models`:

| Model | Default | Supported reasoning efforts |
| --- | --- | --- |
| `gpt-5.6-sol` | `low` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-terra` | `medium` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-luna` | `medium` | `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-5.5` | `medium` | `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4` | `medium` | `low`, `medium`, `high`, `xhigh` |

This proves that effort support is model-specific. Appending `max` and `ultra` to one global Codex array would expose invalid combinations, including `gpt-5.6-luna` with `ultra`.

The current Happy implementation has three stale constraints:

1. `getCodexEffortLevels()` in `packages/happy-app/sources/components/modelModeOptions.ts` returns only `low` through `xhigh`.
2. `ReasoningEffort` in `packages/happy-cli/src/codex/codexAppServerTypes.ts` was cherry-picked from Codex `0.107.0` and ends at `xhigh`.
3. `VALID_REMOTE_EFFORTS` in `packages/happy-cli/src/codex/runCodex.ts` rejects remote values above `xhigh`.

The transport is already forward-compatible:

- `MessageMetaSchema.effort` accepts `string | null`.
- Session and draft storage keep effort as a string.
- The machine spawn RPC forwards `effortLevel` as a string.
- `CodexAppServerClient.sendTurn()` forwards effort into `turn/start.params.effort`.

Codex `0.145.0` exposes the required source of truth through `model/list`. Its generated `ReasoningEffort` TypeScript type is now `string`, and each model contains `supportedReasoningEfforts` plus `defaultReasoningEffort`.

## Current Flow

```text
Mobile effort picker
|
+-- getEffortLevelsForModel(flavor, modelKey)
|   `-- getCodexEffortLevels() -> low, medium, high, xhigh
|
+-- New session
|   `-- machineSpawnNewSession({ effortLevel: string })
|       `-- daemon -> happy codex --effort <value>
|
`-- Active session message
    `-- resolveMessageModeMeta() -> meta.effort
        `-- runCodex.VALID_REMOTE_EFFORTS
            `-- CodexAppServerClient.sendTurn()
                `-- turn/start.params.effort
```

## Goals

- Show only the reasoning efforts supported by the selected Codex model.
- Support `max` and `ultra` end to end when the installed model advertises them.
- Keep new-session, active-session, HomeDock, and agent-default pickers consistent.
- Preserve safe behavior with older Happy CLI and Codex versions.
- Reject stale or crafted model/effort combinations before sending a turn.
- Keep the server and database unchanged; capability metadata remains end-to-end encrypted.

## Non-Goals

- Do not redesign the model picker or permission controls.
- Do not change Claude, Gemini, OpenClaw, Antigravity, or Rig capability handling.
- Do not bundle Codex with Happy; the system-installed Codex CLI remains authoritative.
- Do not change Happy's current default Codex effort in the first implementation. Provider defaults are used only when an existing selection becomes invalid after a model change.
- Do not add a server-side model catalog or database migration.

## Decision

Use local, model-specific capability discovery with a hardcoded compatibility fallback.

The local Happy daemon queries the installed Codex app-server and advertises a compact catalog in optional machine metadata. Every running Codex session also publishes the catalog in its session metadata. The app prefers advertised capabilities and uses the existing hardcoded list only when no catalog is available.

Advanced levels must be presence-gated. An app must not infer support from a Codex model name or Happy CLI version when the machine has not advertised the capability.

The synthetic `default model` option keeps Happy's launch-default semantics. Its effort list is resolved from Happy's configured Codex default (`gpt-5.5`), while the app-server `isDefault` marker remains catalog metadata and does not silently change the model behind that option.

## Metadata Contract

Add an optional machine-level capability envelope. The names below are proposed and may be adjusted during implementation, but the payload semantics are required.

```typescript
type CodexModelCapability = {
    code: string;
    value: string;
    description?: string | null;
    thinkingLevels: string[];
    defaultThinkingLevel: string;
    isDefault: boolean;
};

type CodexAgentCapabilities = {
    codexCliVersion: string;
    detectedAt: number;
    models: CodexModelCapability[];
};

type MachineMetadata = {
    // Existing fields omitted.
    agentCapabilities?: {
        codex?: CodexAgentCapabilities;
    };
};
```

For active and archived sessions, reuse the existing `metadata.models[]` shape and populate its already-supported `thinkingLevels` and `defaultThinkingLevel` fields. Extend the CLI-side `Metadata` type to match the app schema.

Unknown fields remain optional so old apps ignore new CLI metadata and new apps can still read metadata from old CLIs.

## Target Flow

```text
codex app-server model/list
|
+-- CodexAppServerClient.listModels()
|   `-- normalize -> CodexModelCapability[]
|
+-- Happy daemon
|   `-- MachineMetadata.agentCapabilities.codex.models
|       `-- new-session / HomeDock / agent-default pickers
|
+-- runCodex
|   `-- Session.metadata.models
|       `-- active-session model and effort pickers
|
`-- selected model capability
    +-- UI options = model.thinkingLevels
    +-- invalid existing effort -> model.defaultThinkingLevel
    `-- runtime allowlist -> turn/start.params.effort
```

## Implementation Plan

### Phase 1: Codex Protocol and Catalog Discovery

- [x] Update the cherry-picked protocol note from Codex `0.107.0` to the currently supported protocol baseline.
- [x] Change `ReasoningEffort` to the forward-compatible string type used by Codex `0.145.0`.
- [x] Add the minimal `Model`, `ReasoningEffortOption`, `ModelListParams`, and `ModelListResponse` types needed by Happy.
- [x] Add `CodexAppServerClient.listModels()` using the existing JSON-RPC request method.
- [x] Handle `model/list` pagination until `nextCursor` is null.
- [x] Normalize visible models into the compact capability contract without copying unrelated provider instructions or metadata.
- [x] Add a bounded timeout and return no catalog when discovery fails; daemon/session startup must continue.

### Phase 2: Publish Capabilities

- [x] Extend CLI and app `MachineMetadataSchema` with optional `agentCapabilities.codex`.
- [x] Discover the catalog during daemon startup before initial machine registration, with a short timeout.
- [x] Cache the catalog for the daemon lifetime to avoid starting an app-server for every picker interaction.
- [x] Extend CLI session `Metadata.models` with `thinkingLevels` and `defaultThinkingLevel`.
- [x] Query the connected session app-server and publish its catalog through `session.updateMetadata()`.
- [x] Preserve the previous metadata catalog if a reconnect-time refresh fails.

### Phase 3: Consume Capabilities in the App

- [x] Add a model mapper that preserves `thinkingLevels` and `defaultThinkingLevel`; the current generic metadata mapper drops these fields.
- [x] Make `getEffortLevelsForModel()` prefer the selected model's advertised levels.
- [x] Update the new-session screen to use the selected machine's Codex model catalog.
- [x] Update HomeDock and agent-default settings to use the same catalog.
- [x] Keep `SessionView` driven by the session catalog so archived and reconnecting sessions render consistently.
- [x] On model change, reset an unsupported effort to `defaultThinkingLevel`.
- [x] If no catalog is advertised, retain the existing hardcoded Codex list ending at `xhigh`.

### Phase 4: Runtime Validation

- [x] Replace `VALID_REMOTE_EFFORTS` with validation against the selected model's advertised levels.
- [x] Revalidate effort whenever a remote message changes the model and effort together.
- [x] Use a compatibility fallback containing known protocol values only when catalog discovery is unavailable.
- [x] Log rejected combinations with model and effort, without aborting the session process.
- [x] Forward valid `max` and `ultra` values unchanged to `turn/start.params.effort`.
- [x] Add `happy codex --effort ultra` parsing coverage; do not broaden Claude's separate effort parser.

### Phase 5: Documentation and Release

- [x] Update the Codex app-server integration document with `model/list` and model-aware effort validation.
- [ ] Add a changelog entry only when both CLI and app support are ready to ship.
- [ ] Release the Happy CLI capability publisher first.
- [ ] Release the app consumer second.
- [x] Keep advanced efforts hidden on machines running an older Happy CLI.

## Test Plan

### CLI Unit Tests

- [x] `listModels()` parses and paginates app-server responses.
- [x] Catalog normalization preserves model ID, label, effort order, and default effort.
- [x] Catalog discovery failure does not block daemon or session startup.
- [x] `handleCodexCommand(['--effort', 'ultra'])` forwards `ultra` to `runCodex()`.
- [x] A Sol or Terra turn accepts `ultra` and sends it to the app-server.
- [x] A Luna turn rejects `ultra` but accepts `max`.
- [x] A 5.5 turn rejects both `max` and `ultra` when the catalog is available.
- [x] Simultaneous model and effort changes are validated against the new model.

### App Unit Tests

- [x] Sol and Terra expose `max` and `ultra` from advertised metadata.
- [x] Luna exposes `max` but not `ultra`.
- [x] 5.5 and 5.4 continue to stop at `xhigh`.
- [x] Missing machine capabilities preserve the current fallback list.
- [x] Switching from Sol `ultra` to Luna resets effort to Luna's advertised default.
- [x] New-session spawn forwards the selected `ultra` value.
- [x] Active-session messages preserve `meta.effort = 'ultra'`.
- [x] Cross-device metadata parsing preserves unknown future effort strings.

### Verification Commands

```bash
pnpm --filter happy typecheck
pnpm --filter happy test
pnpm --filter happy-app typecheck
pnpm --filter happy-app test --run sources/components/modelModeOptions.test.ts
```

Run a real integration check against a supported installed Codex version and inspect the outgoing JSON-RPC request:

```json
{
  "method": "turn/start",
  "params": {
    "model": "gpt-5.6-sol",
    "effort": "ultra"
  }
}
```

## Acceptance Criteria

- `gpt-5.6-sol` and `gpt-5.6-terra` show and execute `ultra` from the mobile app.
- `gpt-5.6-luna` shows `max` but never shows `ultra`.
- Models whose catalog ends at `xhigh` do not show higher values.
- The same options appear in new-session, active-session, HomeDock, and default-setting surfaces.
- Valid selections survive session metadata sync across devices.
- Unsupported or stale selections are corrected before a turn is sent.
- A new app connected to an old Happy CLI retains the current `xhigh` behavior.
- An old app connected to a new Happy CLI ignores the optional capability metadata without regression.
- No Happy Server schema or database migration is required.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Codex protocol changes again | Keep effort strings open and derive options from `model/list`. |
| Catalog discovery delays daemon startup | Use a short timeout, run independent startup work in parallel, and fall back cleanly. |
| Catalog becomes stale after a Codex upgrade | Refresh on daemon restart and include `codexCliVersion` plus `detectedAt`. |
| Metadata size grows | Publish only picker fields, not full model instructions or provider payloads. |
| New app displays unsupported values on old CLI | Presence-gate advanced efforts on advertised capabilities. |
| Model changes leave an invalid effort selected | Validate in both app and CLI; reset to the model default. |

## Rollback

The change is additive. To roll back the app, stop consuming `agentCapabilities.codex` and return to the hardcoded fallback. To roll back the CLI, stop publishing the optional fields and restore the compatibility allowlist. Existing string-valued session metadata remains readable, and no server data migration is needed.

## Related Documents

- `docs/plans/metadata-driven-model-mode-selection.md`
- `docs/plans/codex-app-server-migration.md`
- `docs/competition/codex/message-protocol.md`
