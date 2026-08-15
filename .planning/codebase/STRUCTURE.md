# Codebase Structure

**Analysis Date:** 2026-08-15

## Directory Layout

```text
[project-root]/
├── packages/
│   ├── happy-wire/        # Shared Sync v4 schemas and control messages
│   ├── happy-server/      # Fastify/Socket.IO control plane and persistence
│   ├── happy-cli/         # CLI, daemon, Codex Gateway, app-server bridge
│   ├── happy-app/         # Expo Router App for native, web, and Tauri shell
│   ├── happy-agent/       # Lightweight terminal remote-control client
│   ├── codium/            # Electron Codex desktop client
│   └── happy-app-logs/    # Local App log receiver utility
├── docs/                  # Current engineering docs, ADRs, plans, archives
├── scripts/               # Repository tooling, CI scenarios, docs generator
├── .github/workflows/     # CI, cloud builds, release promotion
├── environments/          # Local development environment templates/tooling
├── patches/               # patch-package patches
├── package.json           # pnpm workspace root and repo scripts
└── pnpm-lock.yaml         # Workspace dependency lockfile
```

Generated/local directories such as `node_modules/`, `dist/`, `.pnpm-store/`, `.codegraph/`, `.agents/`, `.codex/`, and `.planning/` are not application source locations. Keep machine-local agent configuration out of commits.

## Directory Purposes

**`packages/happy-wire/`:**
- Purpose: Share versioned protocol schemas and entity types without importing App, CLI, or Server implementation code.
- Contains: Zod schemas for Sync v4, control messages, encrypted entity payloads, voice payloads, and contract tests.
- Key files: `packages/happy-wire/src/index.ts`, `packages/happy-wire/src/syncV4.ts`, `packages/happy-wire/src/syncV4Entities.ts`.

**`packages/happy-server/`:**
- Purpose: Run the authenticated control plane and self-host/standalone relay.
- Contains: Fastify API composition, Socket.IO transport, domain application modules, Prisma schema/migrations, storage adapters, deployment/build scripts, and tests next to source.
- Key files: `packages/happy-server/sources/main.ts`, `packages/happy-server/sources/app/api/api.ts`, `packages/happy-server/sources/app/api/routes/v4SessionRoutes.ts`, `packages/happy-server/prisma/schema.prisma`.

**`packages/happy-server/sources/app/`:**
- Purpose: Group Server behavior by application concern rather than by framework primitive.
- Contains: `api/`, `auth/`, `account/`, `events/`, `session/`, `presence/`, `artifacts/`, `push/`, `social/`, `feed/`, `kv/`, and integration modules.
- Key files: `packages/happy-server/sources/app/events/eventRouter.ts`, `packages/happy-server/sources/app/auth/auth.ts`.

**`packages/happy-server/sources/app/api/`:**
- Purpose: Compose external HTTP and Socket.IO boundaries.
- Contains: top-level `api.ts`, `socket.ts`, endpoint modules under `routes/`, Socket.IO handlers under `socket/`, typed Fastify definitions, and API utility middleware.
- Key files: `packages/happy-server/sources/app/api/api.ts`, `packages/happy-server/sources/app/api/socket.ts`, `packages/happy-server/sources/app/api/routes/`.

**`packages/happy-server/sources/storage/`:**
- Purpose: Encapsulate data/file/object/Redis access and transaction helpers.
- Contains: Prisma/PGlite initialization, local/S3 file operations, Redis helpers, sequence/cache utilities, and storage tests.
- Key files: `packages/happy-server/sources/storage/db.ts`, `packages/happy-server/sources/storage/inTx.ts`, `packages/happy-server/sources/storage/files.ts`.

**`packages/happy-cli/`:**
- Purpose: Package the `happy` binary and all local Codex machine control behavior.
- Contains: command dispatch, API clients, daemon lifecycle, Codex app-server integration, persistent Gateway, terminal UI helpers, sandbox/resume utilities, scripts, and tests.
- Key files: `packages/happy-cli/src/index.ts`, `packages/happy-cli/src/commands/codexCommand.ts`, `packages/happy-cli/src/daemon/run.ts`.

**`packages/happy-cli/src/codex/`:**
- Purpose: Keep all official Codex stable-v2 protocol, lifecycle, command, history, and projection code in one package-local boundary.
- Contains: app-server client, generated protocol types, thread registry/history, Sync v4 mapper, command routing/execution, and Gateway implementation.
- Key files: `packages/happy-cli/src/codex/codexAppServerClient.ts`, `packages/happy-cli/src/codex/codexSyncV4Mapper.ts`, `packages/happy-cli/src/codex/gateway/codexGatewayWorker.ts`.

**`packages/happy-cli/src/api/`:**
- Purpose: Encapsulate authenticated relay requests, v4 transport/journal, encryption, and RPC registration.
- Contains: API clients, Sync v4 client/transport/crypto/journal, auth, machine/session clients, and API tests.
- Key files: `packages/happy-cli/src/api/api.ts`, `packages/happy-cli/src/api/syncV4Client.ts`, `packages/happy-cli/src/api/syncV4Journal.ts`.

**`packages/happy-app/`:**
- Purpose: Provide the Expo React Native/web App, with an optional Tauri desktop shell.
- Contains: Expo config/platform directories, route entry, `sources/` application code, browser/native assets, plugins, and Tauri Rust source.
- Key files: `packages/happy-app/index.ts`, `packages/happy-app/sources/app/_layout.tsx`, `packages/happy-app/app.config.js`, `packages/happy-app/src-tauri/src/lib.rs`.

**`packages/happy-app/sources/app/`:**
- Purpose: Define filesystem-based Expo Router routes.
- Contains: root layout, authenticated route group `(app)/`, typed parameter screens, settings, session, machine, artifact, terminal, and development screens.
- Key files: `packages/happy-app/sources/app/_layout.tsx`, `packages/happy-app/sources/app/(app)/_layout.tsx`, `packages/happy-app/sources/app/(app)/session/[id].tsx`.

**`packages/happy-app/sources/sync/`:**
- Purpose: House client domain state, encrypted Server transport, Sync v4 replay, command projection, and most App service operations.
- Contains: singleton sync lifecycle, Socket.IO client, App v4 client/transport/persistence, crypto/key management, storage, reducers, server policy, API modules, and per-feature tests.
- Key files: `packages/happy-app/sources/sync/sync.ts`, `packages/happy-app/sources/sync/syncV4Client.ts`, `packages/happy-app/sources/sync/apiSocket.ts`, `packages/happy-app/sources/sync/storage.ts`.

**`packages/happy-app/sources/components/`:**
- Purpose: Reusable UI features and visual primitives that are not route definitions.
- Contains: session views, navigation, command palette, markdown/diff/tool rendering, web components, and feature-specific subdirectories.
- Key files: `packages/happy-app/sources/components/SidebarNavigator.tsx`, `packages/happy-app/sources/components/CommandPalette/`.

**`packages/happy-agent/`:**
- Purpose: Ship a separate `happy-agent` terminal client for remote Codex workflow operations.
- Contains: Commander entry point, Server API/encryption clients, machine RPC/session helpers, config/credential persistence, and unit/integration tests.
- Key files: `packages/happy-agent/src/index.ts`, `packages/happy-agent/src/api.ts`, `packages/happy-agent/src/machineRpc.ts`, `packages/happy-agent/src/session.ts`.

**`packages/codium/`:**
- Purpose: Host an Electron/Vite experimental desktop client with local PTY, Codex auth, local worker, chat storage, and Happy IPC capabilities.
- Contains: Electron main/preload boot code, React renderer, agent/happy worker hosts, route/layout/component modules, SQLite-backed stores, and themes.
- Key files: `packages/codium/sources/boot/main/index.ts`, `packages/codium/sources/boot/preload/index.ts`, `packages/codium/sources/main.tsx`, `packages/codium/sources/app/routes.tsx`.

**`packages/happy-app-logs/`:**
- Purpose: Run a local HTTP receiver for development App logs.
- Contains: a single Node HTTP service.
- Key files: `packages/happy-app-logs/src/server.ts`.

**`docs/`:**
- Purpose: Keep current engineering documentation and accepted ADRs; use it as the shared knowledge entry point.
- Contains: current architecture/API/security/deployment docs, `decisions/`, active `plans/`, and explicit historical archives.
- Key files: `docs/README.md`, `docs/knowledge-base.md`, `docs/backend-architecture.md`, `docs/cli-architecture.md`.

**`scripts/` and `.github/workflows/`:**
- Purpose: Define repository automation, source-level validations, cloud builds, release packaging, and security gates.
- Contains: CI scenarios under `scripts/ci/`, documentation generator under `scripts/docs/`, and workflow YAMLs.
- Key files: `scripts/docs/knowledge-base.mjs`, `.github/workflows/ci.yml`, `.github/workflows/build-cli-release.yml`.

## Key File Locations

**Entry Points:**
- `packages/happy-server/sources/main.ts`: production Server process bootstrap.
- `packages/happy-server/sources/index.ts`: programmatic standalone Server API.
- `packages/happy-cli/src/index.ts`: `happy` top-level command dispatcher.
- `packages/happy-agent/src/index.ts`: `happy-agent` Commander CLI.
- `packages/happy-app/index.ts`: Expo entry that loads polyfills/styles and Expo Router.
- `packages/happy-app/sources/app/_layout.tsx`: App provider and initialization root.
- `packages/codium/sources/boot/main/index.ts`: Electron main process.
- `packages/codium/sources/main.tsx`: Electron renderer root.

**Configuration:**
- `package.json`: root workspace membership and shared scripts.
- `pnpm-workspace.yaml` or root `package.json`: workspace package declaration; this repository declares workspaces in `package.json`.
- `packages/*/package.json`: package commands, entry points, versions, and dependencies.
- `packages/happy-server/prisma/schema.prisma`: relational model.
- `packages/happy-app/app.config.js`: Expo/App configuration.
- `packages/happy-app/src-tauri/tauri.conf.json`: Tauri desktop configuration.
- `.github/workflows/*.yml`: CI/cloud-build and release boundaries.

**Core Logic:**
- `packages/happy-wire/src/syncV4.ts`: protocol validation contract.
- `packages/happy-server/sources/app/api/routes/v4SessionRoutes.ts`: Server Sync v4 endpoints.
- `packages/happy-cli/src/codex/gateway/`: durable local provider runtime.
- `packages/happy-cli/src/codex/codexSyncV4Mapper.ts`: provider-to-wire projection.
- `packages/happy-app/sources/sync/sync.ts`: App account/session synchronization orchestration.
- `packages/happy-app/sources/sync/codexV4Projection.ts`: App v4 entity-to-view-state projection.

**Testing:**
- `packages/happy-server/sources/**/*.spec.ts`: co-located Server unit/integration tests.
- `packages/happy-cli/src/**/*.test.ts`: co-located CLI/Gateway/Sync tests.
- `packages/happy-app/sources/**/*.spec.ts` and `packages/happy-app/sources/**/*.test.ts`: co-located App tests.
- `packages/happy-wire/src/**/*.test.ts`: wire contract tests.
- `scripts/ci/`: cloud scenario tests and release verification.

## Naming Conventions

**Files:**
- Use lower camel case for TypeScript modules: `codexSyncV4Mapper.ts`, `accountWriteGate.ts`, `apiSocket.ts`.
- Use `*.test.ts` or `*.spec.ts` beside the implementation for unit/behavioral tests: `codexGatewayWorker.test.ts`, `v4SessionRoutes.spec.ts`.
- Use platform suffixes when implementations differ: `apiSocket.ts`, `RealtimeProvider.web.tsx`, `encryptor.appspec.ts`.
- Use route modules named by resource plus `Routes`: `v4SessionRoutes.ts`, `machinesRoutes.ts`.

**Directories:**
- Group Server code by domain under `sources/app/<domain>/`; keep HTTP boundary wiring under `sources/app/api/`.
- Group CLI code by execution boundary under `src/codex/`, `src/daemon/`, `src/api/`, and `src/commands/`.
- Group App UI routes under `sources/app/`, reusable view code under `sources/components/`, and state/network/domain operations under `sources/sync/`.

## Where to Add New Code

**New Sync v4 feature:**
- Shared schema/entity type: `packages/happy-wire/src/`.
- Server endpoint/storage behavior: `packages/happy-server/sources/app/api/routes/` plus the matching `packages/happy-server/sources/app/<domain>/` module.
- CLI producer/Gateway behavior: `packages/happy-cli/src/codex/` or `packages/happy-cli/src/api/`.
- App projection/command/UI state: `packages/happy-app/sources/sync/`; screen rendering belongs in `packages/happy-app/sources/app/(app)/` or `packages/happy-app/sources/components/`.
- Tests: co-locate a `*.test.ts` or `*.spec.ts` with every affected package surface.

**New Server endpoint:**
- Route implementation: `packages/happy-server/sources/app/api/routes/<resource>Routes.ts`.
- Domain operation: `packages/happy-server/sources/app/<domain>/<operation>.ts`.
- Registration: add the route factory to `packages/happy-server/sources/app/api/api.ts`.
- Socket-only behavior: handler in `packages/happy-server/sources/app/api/socket/` and dispatch in `packages/happy-server/sources/app/api/socket.ts`.

**New CLI/Codex behavior:**
- Top-level command: `packages/happy-cli/src/commands/` and dispatch from `packages/happy-cli/src/index.ts`.
- Official Codex lifecycle/RPC/projection: `packages/happy-cli/src/codex/`.
- Persistent process/Gateway behavior: `packages/happy-cli/src/codex/gateway/`.
- Relay client or durable v4 queue change: `packages/happy-cli/src/api/`.

**New App screen/component:**
- Route screen: `packages/happy-app/sources/app/(app)/<feature>.tsx` or a nested route directory.
- Reusable UI: `packages/happy-app/sources/components/<Feature>/`.
- Shared App state/networking/crypto: `packages/happy-app/sources/sync/`; do not put Server transport in a route component.
- User-visible translations: `packages/happy-app/sources/text/` and every locale under `packages/happy-app/sources/text/translations/`.

**New Codium feature:**
- Privileged filesystem/process/network capability: `packages/codium/sources/boot/main/` with an explicit preload IPC bridge.
- Renderer route/view/store: `packages/codium/sources/app/`.
- Provider/Hapy local worker behavior: `packages/codium/sources/agents/` or `packages/codium/sources/happy/`.

**Utilities:**
- Server helpers: `packages/happy-server/sources/utils/`.
- CLI helpers: `packages/happy-cli/src/utils/`.
- App helpers: `packages/happy-app/sources/utils/`.
- Cross-package contracts must not be placed in utilities; add them to `packages/happy-wire/src/`.

## Special Directories

**`packages/happy-server/prisma/`:**
- Purpose: Prisma schema and migrations.
- Generated: Prisma client output is generated; migrations are source-controlled.
- Committed: Yes.

**`packages/happy-cli/src/codex/protocol/generated/`:**
- Purpose: TypeScript types generated from official Codex app-server protocol generation.
- Generated: Yes; do not edit by hand.
- Committed: Yes.

**`packages/happy-app/src-tauri/`:**
- Purpose: Rust/Tauri wrapper for the Expo web App desktop target.
- Generated: No for source/config; `target/` is generated local build output.
- Committed: source/config Yes; `target/` No.

**`dist/`:**
- Purpose: local/generated package and release outputs.
- Generated: Yes.
- Committed: No.

**`.planning/codebase/`:**
- Purpose: generated GSD codebase reference documents.
- Generated: Yes.
- Committed: managed by the GSD workflow.

**`.agents/` and `.codex/`:**
- Purpose: machine-local agent memory, instructions, skills, and worktrees.
- Generated: Mixed/local.
- Committed: No; follow `AGENTS.md` and keep these directories local.

---

*Structure analysis: 2026-08-15*
