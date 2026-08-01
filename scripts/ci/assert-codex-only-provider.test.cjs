const assert = require('node:assert/strict');
const test = require('node:test');

const {
    isForbiddenInstructionPath,
    scanCodexOnlyBoundary,
} = require('./assert-codex-only-provider.cjs');

function scan(files) {
    return scanCodexOnlyBoundary({
        trackedFiles: Object.keys(files),
        readText: (file) => files[file] ?? '',
    });
}

test('allows exact retained dependencies, guards, labels, URLs, and research', () => {
    const violations = scan({
        'packages/happy-cli/package.json': '"@anthropic-ai/sandbox-runtime": "1.0.0"',
        'packages/happy-cli/src/index.ts': "if (args[0] === 'claude') reject();",
        'packages/happy-cli/src/agy/constants.ts': "'Claude Sonnet 4.6 (Thinking)'",
        'packages/happy-server/sources/app/api/routes/versionRoutes.ts': "'happy-claude-code-client'",
        'README.md': 'https://apps.apple.com/us/app/happy-claude-code-client/id6748571505',
        'docs/permission-resolution.md': 'outer @anthropic-ai/sandbox-runtime policy',
        'docs/research/provider-history.md': 'Claude Code historical protocol evidence',
        'docs/plans/archive/old-provider.md': 'happy claude',
        'pnpm-lock.yaml': '@anthropic-ai/sandbox-runtime@1.0.0',
    });

    assert.deepEqual(violations, []);
});

test('rejects provider and instruction paths regardless of content', () => {
    for (const file of [
        'CLAUDE.md',
        'packages/happy-app/CLAUDE.local.md',
        '.claude/settings.json',
        'packages/happy-app/.claude/agent.md',
        'packages/happy-cli/src/claude/runner.ts',
        'packages/happy-app/src/claude/bridge.ts',
    ]) {
        assert.equal(isForbiddenInstructionPath(file), true, file);
    }
});

test('rejects active links to removed provider documentation', () => {
    const violations = scan({
        'docs/README.md': '- [old](./session-protocol-claude.md)',
        'pnpm-lock.yaml': '',
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], /removed document reference/);
});

test('rejects active provider source and documentation claims', () => {
    const violations = scan({
        'packages/happy-cli/src/newProvider.ts': "import Anthropic from '@anthropic-ai/sdk';",
        'docs/cli-architecture.md': 'Happy supports Claude Code sessions.',
        'pnpm-lock.yaml': '',
    });

    assert.equal(violations.length, 2);
    assert.match(violations[0], /newProvider\.ts/);
    assert.match(violations[1], /cli-architecture\.md/);
});

test('does not allow a retained dependency outside its exact ownership file', () => {
    const violations = scan({
        'packages/happy-cli/src/newProvider.ts': "import '@anthropic-ai/sandbox-runtime';",
        'pnpm-lock.yaml': '',
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], /newProvider\.ts/);
});

test('rejects removed SDK packages from the lockfile', () => {
    const violations = scan({
        'pnpm-lock.yaml': '@anthropic-ai/claude-agent-sdk@0.2.96',
    });

    assert.deepEqual(violations, [
        'pnpm-lock.yaml: forbidden package @anthropic-ai/claude-agent-sdk',
    ]);
});
