# Testing Patterns

**Analysis Date:** 2026-08-15

## Test Framework

**Runner:**
- Vitest is the primary TypeScript test runner: version `^3.2.6` is declared in `packages/happy-cli/package.json`, `packages/happy-agent/package.json`, `packages/happy-app/package.json`, `packages/happy-server/package.json`, and `packages/happy-wire/package.json`. Codium uses Vitest `^4.1.5` in `packages/codium/package.json`.
- Package configurations are `packages/happy-cli/vitest.config.ts`, `packages/happy-agent/vitest.config.ts`, `packages/happy-app/vitest.config.ts`, `packages/happy-server/vitest.config.ts`, `packages/happy-wire/vitest.config.ts`, and `packages/codium/vitest.config.ts`.
- Node's built-in `node:test` is used for CI-policy and artifact scripts in `scripts/ci/`, for example `scripts/ci/classify-workflow-changes.test.cjs` and `scripts/ci/android-field-apk-reuse.test.cjs`.
- Python `unittest` covers archive utilities in `scripts/ci/release_candidate_archive_test.py` and `scripts/ci/android_field_apk_archive_test.py`.

**Assertion Library:**
- Use Vitest `expect` with explicit imports in packages whose config has `globals: false`, including CLI, agent, App, and wire. `packages/happy-cli/src/codex/codexEffortValidation.test.ts` is the minimal pattern.
- Use Node's `assert` API with `node:test` in CI tests, as in `scripts/ci/classify-workflow-changes.test.cjs`.
- Use `unittest.TestCase` assertions and `unittest.mock.patch` in Python tests, as in `scripts/ci/release_candidate_archive_test.py`.

**Run Commands:**
```bash
pnpm --filter happy exec vitest run --project unit       # CLI unit tests
pnpm --filter happy-agent exec vitest run                # happy-agent tests
pnpm --filter happy-app exec vitest run                  # App tests
pnpm --filter happy-server-self-host exec vitest run     # Server tests
pnpm --filter happy-wire exec vitest run                 # Wire tests
pnpm --filter happy exec vitest                           # CLI watch mode
pnpm --filter happy exec vitest run --coverage --project unit  # CLI coverage reports
node --test scripts/ci/classify-workflow-changes.test.cjs # Node CI-script test
python3 scripts/ci/release_candidate_archive_test.py      # Python archive test
```
- Use the smallest package/test-file scope required. `packages/happy-cli/package.json` defines `test` as the unit project only; its `test:integration` script builds first, so keep it in cloud/build-coupled verification unless the task explicitly authorizes that path.

## Test File Organization

**Location:**
- Co-locate unit tests with the module under test. CLI examples: `packages/happy-cli/src/codex/codexEffortValidation.ts` with `.test.ts`; wire examples: `packages/happy-wire/src/syncV4.ts` with `.test.ts`; App examples: `packages/happy-app/sources/auth/AuthContext.tsx` with `.spec.ts`.
- Keep CI test files beside the scripts they exercise in `scripts/ci/`, for example `scripts/ci/release-candidate-promotion.test.cjs` and `scripts/ci/release_candidate_archive_test.py`.

**Naming:**
- CLI, agent, wire, and most App tests match `*.test.ts`; Server accepts both `*.test.ts` and `*.spec.ts` through `packages/happy-server/vitest.config.ts` and primarily uses `.spec.ts`.
- Give integration tests an explicit `.integration` qualifier. Examples include `packages/happy-cli/src/codex/codex.integration.test.ts`, `packages/happy-agent/src/happy-agent.integration.test.ts`, `packages/happy-app/sources/sync/resumeEligibility.integration.test.ts`, and `packages/happy-server/sources/app/artifacts/artifactCreate.postgres.integration.spec.ts`.
- Add a behavioral qualifier for narrowly scoped regression coverage, such as `.logging.spec.ts`, `.deletion.spec.ts`, `.machineOrigin.spec.ts`, or `.proof.spec.ts` in `packages/happy-server/sources/app/`.

**Structure:**
```
packages/<package>/<source-root>/<feature>.ts
packages/<package>/<source-root>/<feature>.test.ts | <feature>.spec.ts
packages/<package>/<source-root>/<feature>.integration.test.ts | <feature>.postgres.integration.spec.ts
scripts/ci/<script>.cjs
scripts/ci/<script>.test.cjs
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, expect, it } from 'vitest';
import { resolveCodexEffortForModel } from './codexEffortValidation';

describe('resolveCodexEffortForModel', () => {
    it('repairs max and ultra for models capped at xhigh', () => {
        expect(resolveCodexEffortForModel({ effort: 'max', model, models })).toEqual({
            effort: 'medium',
            accepted: false,
        });
    });
});
```
This is the direct pattern in `packages/happy-cli/src/codex/codexEffortValidation.test.ts`.

**Patterns:**
- Name the outer `describe` after the exported unit or user-visible lifecycle, and use full-sentence `it` names for the expected observable behavior. `packages/happy-app/sources/auth/AuthContext.spec.ts` and `packages/happy-server/sources/app/auth/auth.spec.ts` are representative.
- Put reusable static fixture data at module scope and reset mutable mocks/state in `beforeEach`. `packages/happy-agent/src/auth.test.ts` creates a fresh temporary config per test and resets `mockedAxiosPost`.
- Always restore timers, spies, temporary directories, and process-level state in `afterEach`/`finally`. See `packages/happy-agent/src/auth.test.ts`, `packages/happy-server/sources/app/auth/auth.spec.ts`, and `scripts/ci/android-field-apk-reuse.test.cjs`.
- Assert complete outputs when they define a protocol contract (`toEqual`/`toMatchObject`) and use targeted boolean/exception assertions for invalid branches. `packages/happy-wire/src/syncV4.test.ts` covers both forms.

## Mocking

**Framework:** Vitest `vi` for TypeScript; Node `mock`-free dependency injection/stubs or `assert` for CI scripts; `unittest.mock.patch` for Python.

**Patterns:**
```typescript
const { syncCreate, syncShutdown } = vi.hoisted(() => ({
    syncCreate: vi.fn(),
    syncShutdown: vi.fn(),
}));

vi.mock('@/sync/sync', () => ({ syncCreate, syncShutdown }));

beforeEach(() => {
    syncCreate.mockReset().mockResolvedValue(undefined);
    syncShutdown.mockReset().mockResolvedValue(undefined);
});
```
`packages/happy-app/sources/auth/AuthContext.spec.ts` uses this hoisted-mock pattern so module initialization sees stable mock references.

**What to Mock:**
- Mock network clients, terminal/UI rendering libraries, storage boundaries, platform APIs, and external side effects. `packages/happy-agent/src/auth.test.ts` mocks `axios`, `qrcode-terminal`, and `chalk`; `packages/happy-app/sources/auth/AuthContext.spec.ts` mocks React Native, Expo updates, sync, persistence, and push APIs.
- Prefer a small stateful fake when sequencing matters. `packages/happy-agent/src/auth.test.ts` captures the generated public key from its first mocked POST and returns an encrypted authorization response from the second.

**What NOT to Mock:**
- Do not mock the schema or pure validation unit being tested. `packages/happy-wire/src/syncV4.test.ts` exercises the actual Zod schemas against valid, invalid, and size-boundary payloads.
- Do not hide lifecycle ordering behind one broad mock assertion. Assert observable ordering using calls/awaits, as `packages/happy-app/sources/auth/AuthContext.spec.ts` does for credential revocation before external teardown.

## Fixtures and Factories

**Test Data:**
```typescript
function makeTestConfig(): Config {
    const homeDir = mkdtempSync(join(tmpdir(), 'happy-agent-auth-test-'));
    return {
        serverUrl: 'https://test-server.example.com',
        homeDir,
        credentialPath: join(homeDir, 'agent.key'),
        operationReceiptDir: join(homeDir, 'agent-operations'),
    };
}
```
This isolated temporary-directory factory is from `packages/happy-agent/src/auth.test.ts`; pair it with `rmSync(..., { recursive: true, force: true })` in `afterEach`.

**Location:**
- Keep focused factories/helpers in the test file when used by one suite, such as `makeTestConfig` in `packages/happy-agent/src/auth.test.ts` and the `mutation` fixture in `packages/happy-wire/src/syncV4.test.ts`.
- Use dedicated integration setup modules only for shared environment provisioning. CLI integration projects load `packages/happy-cli/src/testing/integration.setup.empty.ts` or `packages/happy-cli/src/testing/integration.setup.authenticated.ts` through `packages/happy-cli/vitest.config.ts`.

## Coverage

**Requirements:** No coverage threshold is enforced in package Vitest configuration. CLI and App configure V8 coverage reporters (`text`, `json`, `html`) in `packages/happy-cli/vitest.config.ts` and `packages/happy-app/vitest.config.ts`; do not treat report generation as a passing threshold.

**View Coverage:**
```bash
pnpm --filter happy exec vitest run --coverage --project unit
pnpm --filter happy-app exec vitest run --coverage
```

## Test Types

**Unit Tests:**
- Default package tests are focused unit/protocol/lifecycle tests. CLI explicitly includes `src/**/*.test.ts` but excludes `src/**/*.integration.test.ts` in its `unit` project in `packages/happy-cli/vitest.config.ts`; happy-agent similarly excludes integration files in `packages/happy-agent/vitest.config.ts`.
- Server's `packages/happy-server/vitest.config.ts` includes both `.test.ts` and `.spec.ts`, with Vitest globals enabled. Prefer explicit imports in new cross-package tests unless editing existing Server-style files that rely on globals.

**Integration Tests:**
- CLI runs isolated integration projects serially (`maxWorkers: 1`, `fileParallelism: false`) in `packages/happy-cli/vitest.config.ts`. The empty and authenticated environments have distinct setup files and 60-second test / 120-second hook timeouts.
- Integration tests are intentionally distinguished from source-only unit checks and often require built/package output, as declared by `packages/happy-cli/package.json` and `packages/happy-agent/package.json`. Follow the project cloud-build boundary in `AGENTS.md` for routine verification.

**E2E Tests:**
- No generic browser E2E framework/configuration is detected. Android Field and official Codex acceptance are CI workflows, with Node contract tests invoked by `.github/workflows/ci.yml` and source scenarios under `scripts/ci/`.

## Common Patterns

**Async Testing:**
```typescript
await expect(auth.verifyToken('terminal-token')).resolves.toMatchObject({
    userId: 'user-1',
    credentialId: 'credential-1',
});
```
Use this style for async contracts; it appears in `packages/happy-server/sources/app/auth/auth.spec.ts`. For a manually controlled promise, resolve it only after asserting the pre-completion state, as in `packages/happy-app/sources/auth/AuthContext.spec.ts`.

**Error Testing:**
```typescript
expect(() => SyncV4CapabilitiesSchema.parse(invalidCapabilities)).toThrow();
expect(SyncMutationV4Schema.safeParse(invalidMutation).success).toBe(false);
```
This direct throw/safe-parse split is established in `packages/happy-wire/src/syncV4.test.ts`. For rejected promises, use `await expect(operation()).rejects` rather than catch-and-ignore.

---

*Testing analysis: 2026-08-15*
