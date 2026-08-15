<!-- refreshed: 2026-08-15 -->
# Architecture

**Analysis Date:** 2026-08-15

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────┐
│                         Client and Control Layer                    │
├────────────────────┬─────────────────────┬──────────────────────────┤
│ Expo App           │ Happy CLI Gateway   │ Auxiliary clients        │
│ `packages/         │ `packages/          │ `packages/happy-agent/` │
│ happy-app/`        │ happy-cli/`         │ `packages/codium/`       │
└─────────┬──────────┴──────────┬──────────┴────────────┬─────────────┘
          │ HTTP + Socket.IO     │ official Codex         │ shared schemas
          │                      │ app-server stable-v2   │
          ▼                      ▼                        ▼
┌──────────────────────────┐  ┌──────────────────────────────────────┐
│ Happy Server control     │  │ `@slopus/happy-wire`                │
│ plane                    │  │ Sync v4 Zod schemas and entity types │
│ `packages/happy-server/` │  │ `packages/happy-wire/src/`           │
└────────────┬─────────────┘  └──────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Postgres + Prisma, or embedded PGlite; optional S3 and Redis Streams │
│ `packages/happy-server/prisma/`, `sources/storage/`                 │
└─────────────────────────────────────────────────────────────────────┘
```

Happy is a pnpm TypeScript monorepo. The canonical Codex path is an encrypted, entity-oriented Sync v4 bridge: the CLI owns Codex app-server lifecycle and turns stable-v2 events into v4 mutations; the Server persists and orders ciphertext; the App polls/replays and projects decrypted entities. Socket.IO is an invalidation and RPC transport, not Sync v4's correctness mechanism.

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Happy Server | Starts the control plane, Fastify HTTP API, Socket.IO, persistence adapters, and background maintenance. | `packages/happy-server/sources/main.ts` |
| API composition | Builds Fastify with authentication, monitoring, route modules, static self-host serving, then attaches Socket.IO. | `packages/happy-server/sources/app/api/api.ts` |
| Sync v4 persistence | Validates and persists ordered encrypted mutations, serves changes/snapshots and session lifecycle endpoints. | `packages/happy-server/sources/app/api/routes/v4SessionRoutes.ts` |
| Event router | Routes authenticated Socket.IO updates, machine/session RPC, presence, and artifact events. | `packages/happy-server/sources/app/events/eventRouter.ts` |
| Happy CLI | Dispatches commands, starts a daemon or a persistent Codex Gateway, and exposes user commands. | `packages/happy-cli/src/index.ts` |
| Codex Gateway | Separates official Codex app-server/TUI lifecycle from the invoking shell and keeps descriptors, leases, proxy, journal, and v4 bridge coherent. | `packages/happy-cli/src/codex/gateway/` |
| Codex projection | Serializes stable-v2 notifications/snapshots into thread, runtime, turn, item, part, request, command, and relation entities. | `packages/happy-cli/src/codex/codexSyncV4Mapper.ts` |
| App shell | Bootstraps Expo Router, authentication, app-wide providers, and the Sync singleton. | `packages/happy-app/sources/app/_layout.tsx` |
| App synchronization | Owns credentials, per-session encryption keys, Socket.IO subscriptions, legacy state, and per-session v4 clients. | `packages/happy-app/sources/sync/sync.ts` |
| Wire contract | Defines the bounded v4 wire schemas shared by Server, CLI, App, and agent. | `packages/happy-wire/src/syncV4.ts` |
| Happy Agent | Supplies a smaller Commander-based remote Codex client over the same Server and wire contract. | `packages/happy-agent/src/index.ts` |
| Codium | Provides an Electron desktop client with privileged main-process workers and a React renderer. | `packages/codium/sources/boot/main/index.ts` |

## Pattern Overview

**Overall:** pnpm monorepo with package-local layered services, an encrypted control plane, and event-sourced Sync v4 projections.

**Key Characteristics:**
- Put cross-package protocol contracts in `packages/happy-wire/src/`; consume them rather than duplicating request/response validators.
- Keep Codex provider ownership inside `packages/happy-cli/src/codex/`; the Server stores opaque v4 ciphertext and does not interpret Codex payloads.
- Treat durable journal/ACK/cursor/snapshot state as correctness boundaries; use `/v1/updates` only to wake a client to poll.
- Keep platform entry points thin and delegate feature behavior into package-local modules.

## Layers

**Client surfaces:**
- Purpose: Render remote-control UIs and issue authenticated, encrypted commands.
- Location: `packages/happy-app/sources/`, `packages/happy-agent/src/`, and `packages/codium/sources/`.
- Contains: Expo Router screens, React providers, Commander commands, Electron renderer/main/preload boundaries.
- Depends on: `packages/happy-wire/src/`, Server HTTP/Socket endpoints, and client-local encryption/storage.
- Used by: end users on native/web/desktop/terminal surfaces.

**CLI orchestration and provider bridge:**
- Purpose: Own local machine identity, daemon/Gateway processes, official Codex app-server connections, and Sync v4 publication.
- Location: `packages/happy-cli/src/daemon/`, `packages/happy-cli/src/codex/`, and `packages/happy-cli/src/api/`.
- Contains: command dispatcher, app-server client, thread registry, gateway proxy/worker, journals, and API clients.
- Depends on: official `codex` app-server stable-v2, `@slopus/happy-wire`, filesystem state under `.happy`, and Server APIs.
- Used by: `happy codex`, daemon machine RPC, App-origin session control, and Sync v4 consumers.

**Control-plane API and realtime:**
- Purpose: Authenticate scopes, authorize operations, persist sync/control metadata, serve files, and route realtime control.
- Location: `packages/happy-server/sources/app/`.
- Contains: Fastify route registration, route modules, Socket.IO handlers, events, auth, account gates, session/presence/push logic.
- Depends on: Prisma storage, optional Redis Streams, configured object storage, and `@slopus/happy-wire`.
- Used by: all client packages.

**Storage and deployment modes:**
- Purpose: Abstract relational and file persistence for managed and standalone deployments.
- Location: `packages/happy-server/sources/storage/`, `packages/happy-server/prisma/`, and `packages/happy-server/sources/standalone.ts`.
- Contains: Prisma client selection, PGlite adapter, migrations, file storage, Redis helpers, and transaction utilities.
- Depends on: Postgres in normal mode or PGlite when `DB_PROVIDER=pglite`.
- Used by: Server application modules and route handlers.

## Data Flow

### Primary Codex Synchronization Path

1. `happy codex` dispatches to `handleCodexCommand()` and starts or attaches a Gateway (`packages/happy-cli/src/index.ts:149`, `packages/happy-cli/src/commands/codexCommand.ts:96`).
2. The Gateway worker validates durable descriptor/secret state, connects a `CodexAppServerClient`, and prepares the v4 bridge (`packages/happy-cli/src/codex/gateway/codexGatewayWorker.ts:62`, `packages/happy-cli/src/codex/gateway/codexGatewayWorker.ts:172`).
3. `CodexSyncV4Mapper` serializes provider notifications/snapshots into v4 entities and publishes mutations through its `SyncPublisher` (`packages/happy-cli/src/codex/codexSyncV4Mapper.ts:134`, `packages/happy-cli/src/codex/codexSyncV4Mapper.ts:173`).
4. `SyncV4Client` writes outgoing mutations to its local journal before batching authenticated HTTP uploads (`packages/happy-cli/src/api/syncV4Client.ts:247`).
5. Server v4 routes validate, order, and persist mutations; they then expose changes/snapshot recovery (`packages/happy-server/sources/app/api/routes/v4SessionRoutes.ts`).
6. The Server emits a v4 invalidation wake-up through the existing event router; App and CLI independently poll changes or replay snapshots (`packages/happy-server/sources/app/events/eventRouter.ts`, `packages/happy-app/sources/sync/syncV4Client.ts:154`).
7. The App decrypts applied entities and commits its projection only after processing, while its local client persists a receive cursor (`packages/happy-app/sources/sync/syncV4Client.ts`, `packages/happy-app/sources/sync/codexV4Projection.ts`).

### Authenticated Realtime/RPC Path

1. App `ApiSocket.connect()` opens `/v1/updates` with bearer credentials and an explicit user/session/machine scope (`packages/happy-app/sources/sync/apiSocket.ts:99`).
2. Socket.IO middleware verifies the token and scope before attaching handlers (`packages/happy-server/sources/app/api/socket.ts:79`).
3. `startSocket()` initializes the event router and registers update, ping, usage, artifact, access-key, and RPC handlers (`packages/happy-server/sources/app/api/socket.ts:20`, `packages/happy-server/sources/app/api/socket.ts:76`).
4. The App encrypts session or machine RPC parameters before `rpc-call`, then validates its lifecycle permit after the ACK (`packages/happy-app/sources/sync/apiSocket.ts:190`, `packages/happy-app/sources/sync/apiSocket.ts:216`).
5. The CLI daemon/Gateway handles the routed machine/session operation and returns an encrypted result through the Server event router (`packages/happy-cli/src/daemon/run.ts`, `packages/happy-cli/src/api/rpc/RpcHandlerManager.ts`).

### Server Startup Path

1. `main()` connects storage, initializes encryption/GitHub/files/auth, and removes unsupported sessions (`packages/happy-server/sources/main.ts:16`).
2. `startApi()` installs Fastify validation/auth/monitoring, registers route modules, listens, then attaches Socket.IO (`packages/happy-server/sources/app/api/api.ts:49`, `packages/happy-server/sources/app/api/api.ts:121`, `packages/happy-server/sources/app/api/api.ts:199`).
3. The process starts account deletion, metrics, and presence timeout workers (`packages/happy-server/sources/main.ts:43`).

**State Management:**
- Server keeps authoritative relational state in Prisma/Postgres or PGlite; optional Redis Streams distributes Socket.IO rooms across replicas (`packages/happy-server/sources/storage/db.ts:39`, `packages/happy-server/sources/app/api/socket.ts:50`).
- CLI persists Gateway descriptors/journals and Sync v4 journals locally; the Gateway owns provider lifecycle (`packages/happy-cli/src/codex/gateway/`, `packages/happy-cli/src/api/syncV4Journal.ts`).
- App uses the global `sync` service for lifecycle and key ownership, app-local persistence/MMKV for v4 recovery, and the Zustand store from `packages/happy-app/sources/sync/storage.ts` for UI-facing state (`packages/happy-app/sources/sync/sync.ts:121`).

## Key Abstractions

**Sync v4 mutation/entity contract:**
- Purpose: A bounded encrypted change protocol that separates the Server's ordering/storage responsibilities from client-side Codex projections.
- Examples: `packages/happy-wire/src/syncV4.ts`, `packages/happy-wire/src/syncV4Entities.ts`, `packages/happy-server/sources/app/api/routes/v4SessionRoutes.ts`.
- Pattern: Zod schemas plus append-only client journals, independent ACK and read cursor, contiguous change polling, and snapshot fallback.

**Codex Gateway:**
- Purpose: A durable local owner of official Codex app-server, TUI proxy, bridge, lease, and recovery state.
- Examples: `packages/happy-cli/src/codex/gateway/codexGatewayWorker.ts`, `packages/happy-cli/src/codex/gateway/codexGatewayLauncher.ts`, `packages/happy-cli/src/codex/gateway/codexGatewayJournal.ts`.
- Pattern: descriptor/secret/journal-backed worker with a protected local control endpoint and generation-aware handoffs.

**Mapper/projection pair:**
- Purpose: Translate official provider notifications into encrypted wire entities, then reconstruct UI-specific state from them.
- Examples: `packages/happy-cli/src/codex/codexSyncV4Mapper.ts`, `packages/happy-app/sources/sync/codexV4Projection.ts`.
- Pattern: serialized queue with idempotent entities and authoritative snapshot reconciliation.

**Account lifecycle fence:**
- Purpose: Prevent old account continuations from sending through a new account's credentials/socket after logout or deletion.
- Examples: `packages/happy-app/sources/sync/accountOutboundFence.ts`, `packages/happy-app/sources/sync/apiSocket.ts`, `packages/happy-app/sources/sync/sync.ts`.
- Pattern: generation/permit validation before and after asynchronous boundaries.

## Entry Points

**Server executable:**
- Location: `packages/happy-server/sources/main.ts`.
- Triggers: `pnpm --filter happy-server-self-host start`, packaged self-host runtime, or deployment launch.
- Responsibilities: initialize dependencies, start HTTP/realtime/background loops, and coordinate shutdown.

**Embeddable standalone Server:**
- Location: `packages/happy-server/sources/index.ts`.
- Triggers: consumers call `startServer()`.
- Responsibilities: configure PGlite/master secret environment and expose `startApi()` without the process wrapper.

**Happy CLI:**
- Location: `packages/happy-cli/src/index.ts`.
- Triggers: `happy` binary via `packages/happy-cli/bin/happy.mjs`.
- Responsibilities: parse top-level commands, dispatch `codex`, daemon, auth, server, resume, and diagnostics.

**Happy Agent:**
- Location: `packages/happy-agent/src/index.ts`.
- Triggers: `happy-agent` binary via `packages/happy-agent/bin/happy-agent.mjs`.
- Responsibilities: Commander command tree for remote session listing, spawning, resuming, and history operations.

**Expo App:**
- Location: `packages/happy-app/index.ts` and `packages/happy-app/sources/app/_layout.tsx`.
- Triggers: Expo native, web, or Tauri-hosted bundle.
- Responsibilities: load platform polyfills/styles and delegate routes to Expo Router with app-wide providers.

**Codium Electron desktop app:**
- Location: `packages/codium/sources/boot/main/index.ts` and `packages/codium/sources/main.tsx`.
- Triggers: Electron main process and renderer bootstrapped by `electron-vite`.
- Responsibilities: expose privileged IPC/worker services in the main process and a hash-routed React UI in the renderer.

## Architectural Constraints

- **Threading:** Node server, CLI, and Gateway run on a single-threaded event loop with child processes for daemon/Gateway/Codex; Codium's Electron main, preload, and renderer are separate processes (`packages/happy-cli/src/codex/gateway/codexGatewayWorker.ts`, `packages/codium/sources/boot/main/index.ts`).
- **Global state:** Keep package-local singletons deliberate: Server Prisma `db` is module-global (`packages/happy-server/sources/storage/db.ts:57`); App exposes mutable global `sync` and `apiSocket` (`packages/happy-app/sources/sync/sync.ts:2804`, `packages/happy-app/sources/sync/apiSocket.ts:410`).
- **Provider boundary:** Only the CLI's Codex modules own official app-server calls. Do not add a direct provider client to App or Server (`packages/happy-cli/src/codex/codexAppServerClient.ts`).
- **Sync correctness:** Do not use Socket.IO delivery, elapsed time, transport close, RPC timeout, or interrupt ACK as a completion/cursor source; recover through changes or snapshots (`packages/happy-app/sources/sync/syncV4Client.ts`, `packages/happy-cli/src/api/syncV4Client.ts`).
- **Shared contract:** Changes to v4 payloads must update `packages/happy-wire/src/` first, then consumers and contract tests.
- **Circular imports:** No intentional circular dependency is documented in the inspected package entry paths; avoid adding package cycles and prefer one-way imports from entry/composition modules to feature modules.

## Anti-Patterns

### Treating Socket.IO as Sync v4 transport of record

**What happens:** A feature applies Codex state directly from an `update`/socket event.
**Why it's wrong:** Event replay is intentionally disabled and socket loss/duplication cannot establish a durable ordered cursor (`packages/happy-server/sources/app/api/socket.ts:36`).
**Do this instead:** Persist encrypted mutations locally, poll `changes`, and use snapshot replay on cursor gaps through `packages/happy-app/sources/sync/syncV4Client.ts` or `packages/happy-cli/src/api/syncV4Client.ts`.

### Inferring provider completion from transport state

**What happens:** A Gateway/App marks a turn terminal because a WebSocket closed, an RPC timed out, or a delay elapsed.
**Why it's wrong:** Those signals only make the outcome unknown and can contradict an authoritative provider lifecycle event.
**Do this instead:** Keep connection and execution axes separate; accept terminal lifecycle only through `packages/happy-cli/src/codex/codexSyncV4Mapper.ts` notifications or a reconciled authoritative snapshot.

### Letting UI surfaces own provider state

**What happens:** An App/Electron/CLI command starts another app-server for an existing thread or writes provider state outside the Gateway.
**Why it's wrong:** Multiple writers break thread lease, command ordering, and recovery ownership.
**Do this instead:** Route interaction through `packages/happy-cli/src/codex/gateway/codexGatewayLauncher.ts` and its worker/control endpoint.

## Error Handling

**Strategy:** Validate at transport boundaries, classify recoverable failures, preserve durable state before acknowledgement, and expose only safe diagnostics.

**Patterns:**
- Fastify uses Zod type-provider validation plus registered authentication/error handlers before route modules (`packages/happy-server/sources/app/api/api.ts:85`).
- V4 client transports distinguish snapshot-required/archive terminal cases from temporary errors (`packages/happy-cli/src/api/syncV4Client.ts:87`, `packages/happy-app/sources/sync/syncV4Client.ts:75`).
- Gateway startup persists a stage-specific safe failure before rethrowing (`packages/happy-cli/src/codex/gateway/codexGatewayWorker.ts:113`).
- App lifecycle permits reject stale async requests instead of allowing cross-account writes (`packages/happy-app/sources/sync/apiSocket.ts:325`).

## Cross-Cutting Concerns

**Logging:** Use package logger adapters and payload-free diagnostic records: Server `packages/happy-server/sources/utils/log.ts`, CLI `packages/happy-cli/src/ui/logger.ts`, App `packages/happy-app/sources/log.ts`.
**Validation:** Use Zod at HTTP/wire boundaries and explicit scoped authorization for Socket.IO (`packages/happy-wire/src/syncV4.ts`, `packages/happy-server/sources/app/api/socket/authorizeSocketScope.ts`).
**Authentication:** Server bearer-token auth gates HTTP and Socket.IO; clients retain credentials locally and encrypt session/machine RPC payloads (`packages/happy-server/sources/app/auth/auth.ts`, `packages/happy-app/sources/sync/apiSocket.ts`).

---

*Architecture analysis: 2026-08-15*
