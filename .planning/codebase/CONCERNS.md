# Codebase Concerns

**Analysis Date:** 2026-08-15

## Tech Debt

**CLI daemon lifecycle management:**
- Issue: The daemon owns upgrade detection, state-file cleanup, lock release, process respawn, and termination in one in-process heartbeat path. The source itself records that this self-restart design is difficult to reason about and test.
- Files: `packages/happy-cli/src/daemon/run.ts`, `packages/happy-cli/src/daemon/controlClient.ts`, `packages/happy-cli/src/utils/spawnHappyCLI.ts`
- Impact: Upgrade and recovery behavior has several independently failing steps. A failed handoff can leave a machine without a daemon while the original process has already released its resources and exited.
- Fix approach: Move long-lived daemon ownership to an OS service manager or introduce a separately supervised launcher. Until then, make the handoff transactional: attach child `error` and readiness handling, retain the old daemon until the replacement proves its control endpoint is live, and persist a structured status instead of a boolean liveness result.

**Unused voice persistence model:**
- Issue: Voice quota admission reads ElevenLabs directly, while the Prisma `VoiceConversation` table remains in the schema and migrations.
- Files: `packages/happy-server/sources/app/api/routes/voiceRoutes.ts`, `packages/happy-server/prisma/schema.prisma`, `docs/paid-voice.md`
- Impact: The unused relation and table add schema, migration, backup, and data-retention surface without contributing to quota enforcement.
- Fix approach: Create a forward migration that drops `VoiceConversation` only after confirming no deployment still writes it, then remove its relation from `Account` and update the generated Prisma client.

**Large stateful modules:**
- Issue: Synchronization, Codex routing, daemon control, and the new-session UI are concentrated in multi-thousand-line modules.
- Files: `packages/happy-app/sources/sync/sync.ts`, `packages/happy-app/sources/sync/storage.ts`, `packages/happy-app/sources/app/(app)/new/index.tsx`, `packages/happy-cli/src/codex/codexSyncV4Mapper.ts`, `packages/happy-cli/src/codex/codexAppServerClient.ts`, `packages/happy-cli/src/daemon/run.ts`
- Impact: High coupling makes lifecycle or protocol changes difficult to review and raises the chance that local changes alter unrelated state transitions.
- Fix approach: Extract explicit boundary modules around transport, persistence, projection, and UI sections. Preserve the existing focused tests before moving behavior; make each extraction own a narrow input/output contract.

## Known Bugs

**Daemon update handoff can terminate the only active daemon before replacement readiness:**
- Symptoms: A CLI bundle replacement may cause the existing daemon to delete state, release its lock, invoke a detached replacement process, and immediately exit even when the replacement cannot become healthy.
- Files: `packages/happy-cli/src/daemon/run.ts`, `packages/happy-cli/src/utils/spawnHappyCLI.ts`
- Trigger: The heartbeat detects a changed `dist/index.mjs` mtime and the spawned `happy daemon start` process later fails or exits before binding its control server.
- Workaround: Restart the daemon manually after an upgrade. The durable fix is a readiness-confirmed handoff that keeps the old daemon alive until the child owns the lock and answers its control endpoint.

## Security Considerations

**Unauthenticated log receiver:**
- Risk: The service listens on all interfaces, accepts any cross-origin POST body, and writes the supplied content to a local log. It has no authentication, request-size limit, rate limit, payload validation, or retention policy.
- Files: `packages/happy-app-logs/src/server.ts`, `packages/happy-app-logs/package.json`
- Current mitigation: Not detected in this package.
- Recommendations: Bind to loopback by default, require an explicit trusted-network opt-in for remote collection, authenticate senders, cap body size and log-file retention, validate structured fields, and escape or encode embedded newlines before writing.

**Desktop renderer receives a reusable OAuth access token:**
- Risk: The Electron IPC status/login handlers return `accessToken` into the renderer despite the renderer only displaying connection state and email. Any renderer compromise gains the bearer token.
- Files: `packages/codium/sources/boot/main/codex-oauth.ts`, `packages/codium/sources/boot/main/index.ts`, `packages/codium/sources/boot/preload/index.ts`, `packages/codium/sources/plugins/codex/index.ts`
- Current mitigation: `contextIsolation` is enabled in `packages/codium/sources/boot/main/index.ts`, and the persisted token file is written with mode `0600` in `packages/codium/sources/boot/main/codex-oauth.ts`.
- Recommendations: Keep tokens in the Electron main process and expose only `{ status, email, accountId, expiresAt }` to preload/renderer code. Add an IPC allowlist test ensuring no token-bearing field crosses the process boundary; consider enabling Electron sandboxing after validating required preload APIs.

**Unrestricted external-link opening in Codium:**
- Risk: Every renderer-created window-open request is sent directly to `shell.openExternal` without protocol or host validation.
- Files: `packages/codium/sources/boot/main/index.ts`
- Current mitigation: The popup is denied after forwarding the URL, preventing an in-app secondary BrowserWindow.
- Recommendations: Allow only `https:` (and narrowly scoped development URLs when needed), reject credential-bearing or non-web schemes, and test the policy with malicious `file:`, custom-scheme, and credential URLs.

## Performance Bottlenecks

**Unbounded log ingestion and retention:**
- Problem: Each request is accumulated in memory as a string, then appended forever to a timestamped stream; neither requests nor on-disk data have size or rate controls.
- Files: `packages/happy-app-logs/src/server.ts`
- Cause: `readBody` concatenates every incoming chunk and no rotation, quota, or backpressure policy exists around `stream.write`.
- Improvement path: Stream with a byte ceiling, reject oversized requests early, await/drain writes when backpressured, rotate files, and enforce bounded disk retention.

**Voice admission depends on an external full usage read:**
- Problem: Credential minting and usage display query ElevenLabs synchronously and sum every returned conversation for the rolling 30-day window.
- Files: `packages/happy-server/sources/app/api/routes/voiceRoutes.ts`
- Cause: `getVoiceUsage` fetches up to 100 records from the provider on the request path before permitting a conversation.
- Improvement path: Add provider timeout and bounded retry policy, cache a short-lived usage snapshot per account with explicit invalidation at token mint, and add pagination or a durable usage ledger before increasing the conversation limit.

## Fragile Areas

**Sync v4 binding reconstruction:**
- Files: `packages/happy-app/sources/sync/codexThreadHistory.ts`, `packages/happy-app/sources/sync/codexThreadHistory.spec.ts`, `packages/happy-app/sources/sync/sync.ts`
- Why fragile: It pages remote sessions, retains all raw rows in memory, decrypts each key and metadata record, and rejects the whole scan on malformed or undecryptable state. The work spans transport, encryption, protocol eligibility, and projection.
- Safe modification: Preserve cursor-cycle detection, machine-boundary validation, key zeroization, and the explicit `flavor=codex`/Sync-v4 eligibility checks. Add a fixture for every new metadata or agent-state variant before modifying parsing or lifecycle rules.
- Test coverage: Page sequencing, invalid cursors, decryption failures, and supported bindings are tested in `packages/happy-app/sources/sync/codexThreadHistory.spec.ts`; no stress fixture exercises a large multi-page encrypted history or the 1,000-page boundary.

**Codium main/preload IPC surface:**
- Files: `packages/codium/sources/boot/main/index.ts`, `packages/codium/sources/boot/preload/index.ts`, `packages/codium/sources/boot/main/codex-oauth.ts`
- Why fragile: The preload exposes terminal, file, project, account, agent, and authentication capabilities. The main-process handlers accept renderer-originated arguments with limited runtime validation.
- Safe modification: Treat every exposed method as a security boundary. Validate channel arguments in the main process, keep credentials out of return values, and add an IPC contract test whenever a capability changes.
- Test coverage: `packages/codium` has five test files for 88 source files. Its OAuth implementation and main/preload IPC registration have no direct test file.

**Daemon state and process ownership:**
- Files: `packages/happy-cli/src/daemon/run.ts`, `packages/happy-cli/src/daemon/controlClient.ts`, `packages/happy-cli/src/daemon/ensureDaemonRunning.test.ts`
- Why fragile: PID liveness, lock ownership, on-disk state, control-server availability, bundle mtime, and child process lifecycle can diverge across upgrades and crashes.
- Safe modification: Change one lifecycle invariant at a time and test process failure, stale state, lock contention, and replacement readiness together. Do not infer successful handoff from a successful spawn call alone.
- Test coverage: Startup checks are covered by `packages/happy-cli/src/daemon/ensureDaemonRunning.test.ts`; the replacement branch in `packages/happy-cli/src/daemon/run.ts` has no direct handoff/recovery test.

## Scaling Limits

**Voice conversation quota tracking:**
- Current capacity: 100 ElevenLabs conversations per account within the rolling 30-day window.
- Limit: `VOICE_MAX_CONVERSATIONS` blocks further voice credentials because the usage query uses a single provider page of 100 records.
- Scaling path: Paginate provider results or maintain a durable, privacy-reviewed aggregate so accounting remains correct beyond 100 conversations without denying legitimate users.
- Files: `packages/happy-server/sources/app/api/routes/voiceRoutes.ts`, `docs/paid-voice.md`

**Codex thread binding scan:**
- Current capacity: At most 1,000 pages of 200 sessions, or 200,000 raw session records, per machine scan.
- Limit: The app retains all rows and encryption contexts during reconstruction, then throws once the page cap is reached.
- Scaling path: Introduce resumable server-side filtering or incremental indexed bindings, process/decrypt pages incrementally, and make the cap a surfaced recovery state instead of a generic scan failure.
- Files: `packages/happy-app/sources/sync/codexThreadHistory.ts`, `packages/happy-app/sources/sync/codexThreadHistory.spec.ts`

## Dependencies at Risk

**Electron desktop platform dependency:**
- Risk: `packages/codium` uses Electron 41 and has a broad privileged IPC surface, but only a small unit-test set covers the Electron main/preload boundary.
- Impact: Electron or preload API changes can regress authentication, terminal, filesystem, or worktree behavior without source-level detection.
- Migration plan: Keep Electron upgrades isolated, add main/preload contract tests before upgrades, and run packaged smoke coverage in GitHub Actions for the privileged flows.
- Files: `packages/codium/package.json`, `packages/codium/sources/boot/main/index.ts`, `packages/codium/sources/boot/preload/index.ts`

**ElevenLabs usage API dependence:**
- Risk: Voice allowance correctness and availability depend on the provider's conversation listing semantics, single-page maximum, and response latency.
- Impact: A provider outage denies credentials with a `502`; a provider pagination change can invalidate quota decisions.
- Migration plan: Define an adapter with timeouts, pagination, schema validation, and recorded-provider-response tests; retain a privacy-safe local aggregate only if the external source can no longer satisfy quota accounting.
- Files: `packages/happy-server/sources/app/api/routes/voiceRoutes.ts`, `packages/happy-server/sources/app/api/routes/voiceRoutes.spec.ts`, `packages/happy-server/package.json`

## Missing Critical Features

**Authenticated, bounded application log collection:**
- Problem: The `happy-app-logs` service is a reachable write endpoint without an access policy or resource limits.
- Blocks: It cannot be safely exposed beyond a trusted local development environment.
- Files: `packages/happy-app-logs/src/server.ts`, `packages/happy-app-logs/package.json`

**Supervised daemon service lifecycle:**
- Problem: Daemon install, upgrade, restart, and readiness remain application-managed instead of being owned by an operating-system service manager or supervisor.
- Blocks: Reliable automatic recovery through failed upgrades and process crashes.
- Files: `packages/happy-cli/src/daemon/run.ts`, `packages/happy-cli/src/daemon/install.ts`, `packages/happy-cli/src/daemon/mac/install.ts`

## Test Coverage Gaps

**Application log receiver:**
- What's not tested: Request method/path handling, malformed JSON, body-size rejection, CORS policy, log-line encoding, write failures, and listener binding.
- Files: `packages/happy-app-logs/src/server.ts`, `packages/happy-app-logs/package.json`
- Risk: Security and availability regressions in the standalone receiver are undetected; the package declares no test command and has no test files.
- Priority: High

**Codium OAuth and privileged IPC:**
- What's not tested: PKCE state mismatch and timeout cleanup, token refresh failure, file permission behavior, token non-exposure to the renderer, IPC argument validation, PTY lifecycle, and external URL policy.
- Files: `packages/codium/sources/boot/main/codex-oauth.ts`, `packages/codium/sources/boot/main/index.ts`, `packages/codium/sources/boot/preload/index.ts`, `packages/codium/vitest.config.ts`
- Risk: Credential handling or renderer-to-main privilege regressions can ship without automated detection.
- Priority: High

**CLI daemon replacement recovery:**
- What's not tested: A replacement child failing before readiness, concurrent replacement, stale lock/state recovery after a failed handoff, and the old daemon's behavior while the child is starting.
- Files: `packages/happy-cli/src/daemon/run.ts`, `packages/happy-cli/src/utils/spawnHappyCLI.ts`, `packages/happy-cli/src/daemon/ensureDaemonRunning.test.ts`
- Risk: A package upgrade can disconnect a machine from relay control until a user intervenes.
- Priority: High

**Large encrypted session histories:**
- What's not tested: High-cardinality binding reconstruction, memory use, the 1,000-page cap, and partial recovery when one historical record cannot decrypt.
- Files: `packages/happy-app/sources/sync/codexThreadHistory.ts`, `packages/happy-app/sources/sync/codexThreadHistory.spec.ts`
- Risk: Long-lived machines can hit a hard failure or prolonged foreground work when opening Codex history.
- Priority: Medium

---

*Concerns audit: 2026-08-15*
