const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { activeDocs } = require('./assert-codex-only-provider.cjs');

const {
    classifyPaths,
    changedPathsBetween,
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

test('keeps ordinary Markdown and archives on lightweight gates', () => {
    assert.deepEqual(selected([
        'docs/plans/archive/finished.md',
        'docs/research/provider-history.md',
        'packages/happy-app/guide.mdx',
    ]), []);
});

test('checks every active document without selecting package builds', () => {
    for (const document of activeDocs) {
        assert.deepEqual(selected([document]), ['codex_provider_boundary'], document);
    }
    assert.deepEqual(selected(['README.md', 'packages/happy-agent/src/index.ts']), [
        'agent', 'codex_provider_boundary',
    ]);
});

test('main entry patterns cover active docs and standalone manifest inputs', () => {
    const workflow = readFileSync(path.join(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
    const push = workflow.split('  push:\n')[1].split('  pull_request:')[0];
    const patterns = [...push.matchAll(/^      - "(.+)"$/gm)].map((match) => match[1]);
    const matches = (file) => patterns.reduce((included, pattern) => {
        const excluded = pattern.startsWith('!');
        const glob = excluded ? pattern.slice(1) : pattern;
        return path.matchesGlob(file, glob) ? !excluded : included;
    }, false);
    for (const file of [...activeDocs, ...standaloneDockerFileInputs]) {
        assert.equal(matches(file), true, file);
    }
    assert.equal(matches('docs/plans/archive/finished.md'), false);
});

test('Git scope preserves rename sources, deletions, PR merge-base, and push differences', (t) => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'happy-ci-scope-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const write = (file, content) => {
        mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        writeFileSync(path.join(cwd, file), content);
    };
    const commit = () => {
        git('add', '.');
        git('-c', 'user.name=CI test', '-c', 'user.email=ci@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
        return git('rev-parse', 'HEAD');
    };
    git('init', '-q', '-b', 'main');
    write('packages/happy-cli/move.ts', 'export const value = 1;\n');
    write('packages/happy-cli/document.ts', 'export const document = 1;\n');
    write('packages/happy-server/remove.ts', 'export const removed = 1;\n');
    write('docs/guide.md', 'base\n');
    const base = commit();
    write('packages/happy-app/main-only.ts', 'export const main = 1;\n');
    const main = commit();
    git('checkout', '-qb', 'topic', base);
    write('docs/guide.md', 'topic\n');
    const docsHead = commit();
    const prPaths = changedPathsBetween(main, docsHead, { cwd, eventName: 'pull_request' });
    assert.deepEqual(prPaths, ['docs/guide.md']);
    assert.deepEqual(selected(prPaths), []);
    assert.ok(changedPathsBetween(main, docsHead, { cwd, eventName: 'push' }).includes('packages/happy-app/main-only.ts'));

    mkdirSync(path.join(cwd, 'packages/happy-agent'), { recursive: true });
    renameSync(path.join(cwd, 'packages/happy-cli/move.ts'), path.join(cwd, 'packages/happy-agent/move.ts'));
    renameSync(path.join(cwd, 'packages/happy-cli/document.ts'), path.join(cwd, 'docs/document.md'));
    rmSync(path.join(cwd, 'packages/happy-server/remove.ts'));
    const moved = commit();
    const paths = changedPathsBetween(main, moved, { cwd, eventName: 'pull_request' });
    assert.deepEqual(paths, [
        'docs/document.md', 'docs/guide.md', 'packages/happy-agent/move.ts',
        'packages/happy-cli/document.ts', 'packages/happy-cli/move.ts', 'packages/happy-server/remove.ts',
    ]);
    const scope = classifyPaths(paths);
    assert.equal(scope.cli, true);
    assert.equal(scope.agent, true);
    assert.equal(scope.server, true);
    const codeql = require('./codeql-change-classifier.cjs');
    assert.equal(codeql.changedPathsBetween, changedPathsBetween);
    assert.equal(codeql.shouldAnalyzePaths(paths), true);
    assert.equal(codeql.shouldAnalyzePaths(prPaths), false);

    git('-c', 'user.name=CI test', '-c', 'user.email=ci@example.test', '-c', 'commit.gpgsign=false', 'merge', '--no-edit', 'main');
    assert.deepEqual(changedPathsBetween(main, git('rev-parse', 'HEAD'), { cwd, eventName: 'pull_request' }), paths);
    git('-c', 'user.name=CI test', '-c', 'user.email=ci@example.test', '-c', 'commit.gpgsign=false', 'revert', '--no-edit', moved);
    assert.deepEqual(changedPathsBetween(main, git('rev-parse', 'HEAD'), { cwd, eventName: 'pull_request' }), ['docs/guide.md']);
    assert.equal(changedPathsBetween('0'.repeat(40), moved, { cwd }), null);
    assert.throws(() => changedPathsBetween('f'.repeat(40), moved, { cwd }));
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
