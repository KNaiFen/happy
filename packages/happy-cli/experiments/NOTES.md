# Codex Experiments

These scripts are focused protocol probes, not production code.

## What Each Experiment Shows

### `experiments/codex.ts` (legacy MCP path)

Shows that we can run `codex mcp-server`, receive permission elicitation, and
auto-approve requests while preserving Codex-specific fields in elicitation
payloads.

What this demonstrates:
- Why we needed a passthrough elicitation schema (`z4mini.looseObject`) to keep
  fields like `codex_call_id`
- Why the elicitation response includes both MCP `action` and Codex
  `decision`
- How sandbox + approval policy combinations affect whether permission prompts
  appear

### `experiments/codex-reject.ts` (legacy MCP path)

Shows the rejection/abort edge case: when permission is denied, Codex can emit
`turn_aborted` without completing the pending tool call response.

What this demonstrates:
- Why `turn_aborted` must abort the client-side controller
- That aborting the controller unblocks `callTool` promptly after rejection
- Regression signal for "permission reject hangs indefinitely"

### `experiments/test-codex-protocol.cjs` (historical raw app-server probe)

Shows a minimal JSON-RPC conversation with `codex app-server --listen stdio://`
using `initialize` -> `thread/start` -> `turn/start`.

What this demonstrates:
- The wire-level request/notification flow for app-server
- The legacy notification names that this probe was originally written to
  observe (`task_complete`/`turn_aborted`)

It is not a current stable-v2 smoke test: production completion is driven by
`turn/completed`, and this script exits successfully after its timeout. Do not
use it as release or compatibility evidence.

## Status

- Current production integration: **app-server path**
- Legacy reference/regression scripts: `codex.ts`, `codex-reject.ts`
- Historical raw app-server probe: `test-codex-protocol.cjs`

## Running

```bash
# Legacy MCP exploration (auto-approve path; pass an existing working directory)
CWD="$PWD" npx tsx experiments/codex.ts

# Legacy MCP rejection/unblock exploration
npx tsx experiments/codex-reject.ts

# Historical raw app-server probe (not a smoke test)
node experiments/test-codex-protocol.cjs
```
