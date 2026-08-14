const assert = require('node:assert/strict');
const test = require('node:test');

const {
    classifyPaths,
    outputKeys,
    standaloneDockerDirectoryInputs,
    standaloneDockerFileInputs,
} = require('./classify-workflow-changes.cjs');

function selected(paths, options) {
    return Object.entries(classifyPaths(paths, options))
        .filter(([, value]) => value)
        .map(([key]) => key)
        .sort();
}

test('keeps Markdown-only changes on lightweight gates', () => {
    assert.deepEqual(selected([
        'docs/README.md',
        'packages/happy-cli/README.md',
        'packages/happy-app/guide.mdx',
    ]), []);
});

test('propagates Wire changes to every retained consumer and Codex integration', () => {
    assert.deepEqual(selected(['packages/happy-wire/src/index.ts']), [
        'agent',
        'app',
        'cli',
        'cli_smoke',
        'codex_gateway_tui',
        'codex_official_app_server',
        'codex_provider_boundary',
        'codex_transport_scenarios',
        'migration',
        'official_codex',
        'protocol_drift',
        'server',
        'wire',
    ]);
});

test('keeps independent Agent and Codium changes narrow', () => {
    assert.deepEqual(selected(['packages/happy-agent/src/index.ts']), [
        'agent',
        'codex_provider_boundary',
    ]);
    assert.deepEqual(selected(['packages/codium/src/main.ts']), [
        'codex_provider_boundary',
        'codium',
        'codium_runtime',
    ]);
});

test('keeps CLI changes coupled to protocol, packed smoke, and Codex scenarios', () => {
    assert.deepEqual(selected(['packages/happy-cli/src/index.ts']), [
        'cli',
        'cli_smoke',
        'codex_gateway_tui',
        'codex_official_app_server',
        'codex_provider_boundary',
        'codex_transport_scenarios',
        'official_codex',
        'protocol_drift',
    ]);
});

test('keeps Server changes coupled to migrations, packed smoke, and Codex scenarios', () => {
    assert.deepEqual(selected(['packages/happy-server/sources/main.ts']), [
        'cli_smoke',
        'codex_gateway_tui',
        'codex_official_app_server',
        'codex_provider_boundary',
        'codex_transport_scenarios',
        'migration',
        'official_codex',
        'server',
    ]);
});

test('routes the root standalone Dockerfile to Server and migration checks', () => {
    assert.deepEqual(selected(['Dockerfile.server']), [
        'migration',
        'server',
    ]);
});

test('routes every direct standalone Docker build input to Server checks', () => {
    const inputs = [
        ...standaloneDockerFileInputs,
        ...standaloneDockerDirectoryInputs.map((prefix) => `${prefix}fixture`),
    ];

    for (const input of inputs) {
        const classification = classifyPaths([input]);
        assert.equal(classification.server, true, input);
        assert.equal(classification.migration, true, input);
    }
});

test('keeps App checks selected for App-owned standalone Docker inputs', () => {
    for (const input of standaloneDockerFileInputs.filter((path) => path.startsWith('packages/happy-app/'))) {
        assert.equal(classifyPaths([input]).app, true, input);
    }
    assert.equal(classifyPaths(['packages/happy-app/patches/fixture']).app, true);
});

test('selects App and Tauri checks without widening to unrelated packages', () => {
    assert.deepEqual(selected(['packages/happy-app/src-tauri/src/lib.rs']), [
        'app',
        'tauri',
    ]);
});

test('selects Android Field only for non-Tauri App changes', () => {
    const app = classifyPaths(['packages/happy-app/sources/components/AgentInput.tsx']);
    assert.equal(app.android_field, true);
    assert.equal(app.official_codex, true);
    assert.equal(classifyPaths(['packages/happy-app/sources/sync/sync.ts']).android_field, true);
    const tauri = classifyPaths(['packages/happy-app/src-tauri/src/lib.rs']);
    assert.equal(tauri.android_field, false);
    assert.equal(tauri.official_codex, false);
    assert.equal(classifyPaths(['scripts/ci/official-codex-artifact-reuse.cjs']).android_field, true);
    const fieldFixture = classifyPaths(['scripts/ci/codex-mobile-field-fixture.ts']);
    assert.equal(fieldFixture.android_field, true);
    assert.equal(fieldFixture.official_codex, true);
});

test('selects official Field and Gateway scenarios for their shared MCP server', () => {
    assert.deepEqual(selected(['scripts/ci/codex-field-mcp-server.mjs']), [
        'android_field',
        'codex_gateway_tui',
        'codex_official_app_server',
        'official_codex',
        'workflow_contracts',
    ]);
});

test('runs dependency audit for package manifests', () => {
    const classification = classifyPaths(['packages/happy-agent/package.json']);
    assert.equal(classification.agent, true);
    assert.equal(classification.dependency_audit, true);
    assert.equal(classification.cli_smoke, false);
});

test('treats root install inputs as global and CI fixtures as contract-only', () => {
    const lockfile = classifyPaths(['pnpm-lock.yaml']);
    assert.deepEqual(
        Object.keys(lockfile).filter((key) => lockfile[key]).sort(),
        [...outputKeys].sort(),
    );
    const fixture = classifyPaths(['scripts/ci/example.ts']);
    assert.deepEqual(
        Object.keys(fixture).filter((key) => fixture[key]).sort(),
        ['workflow_contracts'],
    );
    const ci = classifyPaths(['.github/workflows/ci.yml']);
    assert.deepEqual(
        Object.keys(ci).filter((key) => ci[key]).sort(),
        [...outputKeys].sort(),
    );
});

test('runs every job when the classifier itself changes', () => {
    const classification = classifyPaths(['scripts/ci/classify-workflow-changes.cjs']);
    assert.deepEqual(
        Object.keys(classification).filter((key) => classification[key]).sort(),
        [...outputKeys].sort(),
    );
});

test('forces every check for manual workflow dispatch', () => {
    const classification = classifyPaths([], { forceAll: true });
    assert.equal(Object.values(classification).every(Boolean), true);
});
