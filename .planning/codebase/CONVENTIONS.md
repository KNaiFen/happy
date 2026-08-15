# Coding Conventions

**Analysis Date:** 2026-08-15

## Naming Patterns

**Files:**
- Put TypeScript implementation and its focused test beside each other. Use lower camel case for modules, for example `packages/happy-cli/src/codex/codexEffortValidation.ts` and `packages/happy-cli/src/codex/codexEffortValidation.test.ts`.
- Name React component/context modules in PascalCase when the exported component is PascalCase, for example `packages/happy-app/sources/auth/AuthContext.tsx` and `packages/happy-app/sources/auth/AuthContext.spec.ts`.
- Express test scope in the suffix: use `.test.ts` in CLI, agent, wire, and most App code; use `.spec.ts` throughout Server; use additional qualifiers such as `.integration.test.ts`, `.postgres.integration.spec.ts`, `.logging.spec.ts`, or `.deletion.spec.ts` when the behavioral boundary matters. Examples: `packages/happy-cli/src/daemon/daemon.integration.test.ts`, `packages/happy-server/sources/app/account/githubOAuthAdmission.postgres.integration.spec.ts`, and `packages/happy-server/sources/app/api/api.logging.spec.ts`.
- Use `.cjs` for Node CI helpers/tests in `scripts/ci/`, for example `scripts/ci/classify-workflow-changes.test.cjs`; use snake_case Python files there, for example `scripts/ci/release_candidate_archive_test.py`.

**Functions:**
- Use lower camel case for functions and methods, including exported helpers such as `resolveCodexEffortForModel` in `packages/happy-cli/src/codex/codexEffortValidation.ts` and `isSyncV4VersionAtLeast` in `packages/happy-wire/src/syncV4.ts`.
- Name boolean predicates with `is`, `has`, `can`, or an assertion-oriented verb. Examples include `isSyncV4VersionAtLeast` in `packages/happy-wire/src/syncV4.ts` and test helpers beginning with `assert` in `scripts/ci/release_candidate_archive_test.py`.
- Make asynchronous APIs visibly asynchronous through `async` functions and await their completion in tests, as in `authLogin` tests in `packages/happy-agent/src/auth.test.ts`.

**Variables:**
- Use lower camel case for mutable and local values, including fixture values such as `capturedPublicKey`, `mockedAxiosPost`, and `consoleSpy` in `packages/happy-agent/src/auth.test.ts`.
- Use `UPPER_SNAKE_CASE` for exported protocol limits and stable constants, for example `MAX_SYNC_V4_CIPHERTEXT_LENGTH` and `CODEX_SYNC_V4_PROTOCOL_VERSION` in `packages/happy-wire/src/syncV4.ts`.
- Prefer meaningful domain names over abbreviations. Tests encode expected behavior in names such as `markCredentialsRevoked` and `syncQuarantine` in `packages/happy-app/sources/auth/AuthContext.spec.ts`.

**Types:**
- Use PascalCase for interfaces, classes, type aliases, and schema-derived types. Examples include `CodexModelCapability` in `packages/happy-cli/src/api/types.ts`, `SyncV4Capabilities` in `packages/happy-wire/src/syncV4.ts`, and `AuthContextType` in `packages/happy-app/sources/auth/AuthContext.tsx`.
- Prefer `type` imports when an import is compile-time only, for example `import type { Config }` in `packages/happy-agent/src/auth.test.ts` and `import type { CodexModelCapability }` in `packages/happy-cli/src/codex/codexEffortValidation.test.ts`.

## Code Style

**Formatting:**
- No repository-wide Prettier, Biome, or EditorConfig configuration is detected. Preserve the formatting of the package and file being changed rather than reformatting unrelated code.
- `packages/happy-cli/`, `packages/happy-agent/`, and much of `packages/happy-app/` commonly use four-space indentation and semicolons in source/test files, for example `packages/happy-cli/src/codex/codexEffortValidation.test.ts` and `packages/happy-agent/src/auth.test.ts`.
- `packages/happy-server/` and `packages/happy-wire/` use two-space indentation and semicolons in their Vitest configuration and examples such as `packages/happy-wire/src/syncV4.test.ts`.
- `packages/codium/` uses four-space indentation without semicolons, including `packages/codium/sources/agents/catalog.ts` and `packages/codium/vitest.config.ts`.
- Retain trailing commas in multiline objects, arrays, imports, and function calls where the local file already uses them, for example `packages/happy-cli/src/codex/codexEffortValidation.test.ts` and `packages/happy-agent/src/auth.test.ts`.

**Linting:**
- TypeScript strictness is the primary enforced static convention. `strict: true` is configured in `packages/happy-cli/tsconfig.json`, `packages/happy-agent/tsconfig.json`, `packages/happy-wire/tsconfig.json`, `packages/happy-app/tsconfig.json`, and `packages/happy-server/tsconfig.json`; CLI, agent, and wire also set `noImplicitAny: true`.
- Run the package-local `tsc --noEmit` script before considering TypeScript work complete. These scripts are defined in `packages/happy-cli/package.json`, `packages/happy-agent/package.json`, `packages/happy-app/package.json`, `packages/happy-server/package.json`, and `packages/happy-wire/package.json`.
- ESLint is listed only in `packages/happy-cli/package.json`; no shared ESLint configuration or repository lint script is detected. Do not claim a global lint pass as verification.

## Import Organization

**Order:**
1. Import test/framework APIs or external packages first, for example `vitest` and `tweetnacl` in `packages/happy-agent/src/auth.test.ts`.
2. Import Node built-ins as explicit `node:` modules where applicable, for example `node:fs`, `node:path`, and `node:os` in `packages/happy-agent/src/auth.test.ts`.
3. Import workspace aliases and local modules last, with type-only imports marked using `import type`, as in `packages/happy-cli/src/codex/codexEffortValidation.test.ts`.

**Path Aliases:**
- Use `@/` for package-local source roots where the package config provides it: `@` maps to `packages/happy-cli/src` in `packages/happy-cli/vitest.config.ts`, `packages/happy-agent/src` in `packages/happy-agent/vitest.config.ts`, and `packages/happy-app/sources` in `packages/happy-app/vitest.config.ts`.
- Import the shared wire package through `@slopus/happy-wire` where local source resolution is required; the alias is configured in `packages/happy-cli/vitest.config.ts`, `packages/happy-agent/vitest.config.ts`, and `packages/happy-app/vitest.config.ts`.
- Use relative imports for a nearby module and its test, for example `./codexEffortValidation` in `packages/happy-cli/src/codex/codexEffortValidation.test.ts` and `./syncV4` in `packages/happy-wire/src/syncV4.test.ts`.

## Error Handling

**Patterns:**
- Fail closed through explicit validation rather than coercing invalid protocol input. `packages/happy-wire/src/syncV4.ts` declares Zod schemas; `packages/happy-wire/src/syncV4.test.ts` covers `parse`, `safeParse`, boundary limits, and rejected values.
- In tests, assert rejected async behavior with `await expect(...).rejects` or `await expect(...).resolves`, as used in `packages/happy-server/sources/app/auth/auth.spec.ts`; assert synchronous failures using `expect(() => ...).toThrow()` as in `packages/happy-wire/src/syncV4.test.ts`.
- Catch cleanup or best-effort client failures locally, log only a concise operational message, and preserve the primary flow. `packages/happy-app/sources/auth/AuthContext.tsx` shows this around credential, persistence, and push teardown.

## Logging

**Framework:** `console` is used in CLI/App process-local code, while Server code obtains logging through `@/utils/log` as demonstrated by `packages/happy-server/sources/app/auth/auth.spec.ts`.

**Patterns:**
- Keep operational logs payload-free. Project rules in `AGENTS.md` prohibit logging plaintext prompts, reasoning, tool arguments/outputs, identifiers, bearer tokens, and cryptographic material.
- In tests, stub `console` with `vi.spyOn(console, 'log').mockImplementation(...)` and restore it in teardown, as in `packages/happy-agent/src/auth.test.ts`.
- Treat logs as observable behavior when a route/module promises them. Use focused `.logging.spec.ts` tests such as `packages/happy-server/sources/app/api/routes/artifactsRoutes.logging.spec.ts`.

## Comments

**When to Comment:**
- Add short comments only where ordering, lifecycle, security, or non-obvious test setup needs explanation. `packages/happy-cli/src/test-setup.ts` documents why integration suites provision isolated environments; `packages/happy-agent/src/auth.test.ts` explains its two POST authentication stages.
- Prefer clear test names and function names for routine behavior. Do not add narration that merely repeats the code.

**JSDoc/TSDoc:**
- Use brief block comments for module-level contracts and runtime lifecycle facts when needed; `packages/happy-cli/src/test-setup.ts` is the local pattern. Broad JSDoc/TSDoc coverage is not established, so do not introduce it mechanically.

## Function Design

**Size:** Keep helpers cohesive around one protocol, lifecycle, or UI responsibility. Extract reusable validation into named functions/schemas, as `packages/happy-wire/src/syncV4.ts` does for version comparison and payload validation.

**Parameters:**
- Use typed object parameters for multi-field inputs, particularly when values evolve together. `resolveCodexEffortForModel` is exercised with `{ effort, model, models }` in `packages/happy-cli/src/codex/codexEffortValidation.test.ts`.
- Use explicit nullable types when absence is meaningful, for example `AuthCredentials | null` in `packages/happy-app/sources/auth/AuthContext.tsx`.

**Return Values:**
- Return typed structured outcomes for accepted/repaired decisions rather than bare booleans where callers need the reason or replacement, as tested by `resolveCodexEffortForModel` in `packages/happy-cli/src/codex/codexEffortValidation.test.ts`.
- Use `undefined`/`null` deliberately and cover those branches, as in `terminalCredentialIdFromExtras` tests in `packages/happy-server/sources/app/auth/auth.spec.ts`.

## Module Design

**Exports:**
- Prefer named exports for reusable functions, constants, types, schemas, and components. Examples: `SyncV4CapabilitiesSchema` from `packages/happy-wire/src/syncV4.ts`, `AuthProvider` from `packages/happy-app/sources/auth/AuthContext.tsx`, and `agentModelById` from `packages/codium/sources/agents/catalog.ts`.
- Use a default export for tool configuration objects, as in every package `vitest.config.ts`, including `packages/happy-cli/vitest.config.ts` and `packages/happy-server/vitest.config.ts`.

**Barrel Files:**
- Keep public package aggregation at intentional entry points such as `packages/happy-wire/src/index.ts`; do not add a local barrel solely to avoid a nearby relative import.

---

*Convention analysis: 2026-08-15*
