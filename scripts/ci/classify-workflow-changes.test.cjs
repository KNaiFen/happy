const assert = require('node:assert/strict');
const test = require('node:test');

const {
    classifyPaths,
    outputKeys,
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

test('selects App and Tauri checks without widening to unrelated packages', () => {
    assert.deepEqual(selected(['packages/happy-app/src-tauri/src/lib.rs']), [
        'app',
        'codex_gateway_tui',
        'codex_official_app_server',
        'codex_provider_boundary',
        'codex_transport_scenarios',
        'official_codex',
        'tauri',
    ]);
});

test('runs dependency audit for package manifests', () => {
    const classification = classifyPaths(['packages/happy-agent/package.json']);
    assert.equal(classification.agent, true);
    assert.equal(classification.dependency_audit, true);
    assert.equal(classification.cli_smoke, false);
});

test('treats root install, workflow, and CI fixture inputs as global', () => {
    for (const path of [
        'pnpm-lock.yaml',
        '.github/workflows/ci.yml',
        'scripts/ci/example.ts',
    ]) {
        const classification = classifyPaths([path]);
        assert.deepEqual(
            Object.keys(classification).filter((key) => classification[key]).sort(),
            [...outputKeys].sort(),
            path,
        );
    }
});

test('forces every check for manual workflow dispatch', () => {
    const classification = classifyPaths([], { forceAll: true });
    assert.equal(Object.values(classification).every(Boolean), true);
});
