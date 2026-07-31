#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..', '..');
const targets = [
    'packages/happy-cli',
    'packages/happy-app/sources',
    'packages/happy-agent',
    'packages/codium',
    'packages/happy-server',
    'packages/happy-wire',
];
const trackedFiles = execFileSync('git', ['ls-files', '--', ...targets], {
    cwd: root,
    encoding: 'utf8',
}).split('\n').filter(Boolean);

const productFiles = trackedFiles.filter((file) => (
    /\.(?:[cm]?[jt]sx?|json)$/.test(file)
    && existsSync(resolve(root, file))
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
    && !file.includes('/__testdata__/')
    && !file.includes('/changelog/')
));

const allowedLines = [
    {
        file: 'packages/happy-cli/package.json',
        test: (line) => line.includes('@anthropic-ai/sandbox-runtime'),
        reason: 'Codex sandbox runtime dependency',
    },
    {
        file: 'packages/happy-cli/src/sandbox/config.ts',
        test: (line) => line.includes('@anthropic-ai/sandbox-runtime'),
        reason: 'Codex sandbox runtime type import',
    },
    {
        file: 'packages/happy-cli/src/sandbox/manager.ts',
        test: (line) => line.includes('@anthropic-ai/sandbox-runtime'),
        reason: 'Codex sandbox runtime implementation import',
    },
    {
        file: 'packages/happy-cli/src/index.ts',
        test: (line) => line.includes("args[0] === 'claude'"),
        reason: 'explicit removed-command rejection',
    },
    {
        file: 'packages/happy-cli/src/daemon/spawnPlan.ts',
        test: (line) => line.includes("agent === 'claude'"),
        reason: 'explicit removed-agent rejection',
    },
    {
        file: 'packages/happy-cli/src/commands/codexCommand.ts',
        test: (line) => line.includes("'--claude-env'"),
        reason: 'explicit removed-flag rejection',
    },
    {
        file: 'packages/happy-app/sources/sync/ops.ts',
        test: (line) => line.includes('claudeSessionId: _removedSessionId'),
        reason: 'deprecated metadata key sanitization before republish',
    },
    {
        file: 'packages/happy-app/sources/components/modelModeOptions.ts',
        test: (line) => line.includes("key: 'Claude Opus 4.6 (Thinking)'")
            || line.includes("name: 'claude opus 4.6 (thinking)'")
            || line.includes("key: 'Claude Sonnet 4.6 (Thinking)'")
            || line.includes("name: 'claude sonnet 4.6 (thinking)'"),
        reason: 'external Agy model catalog label',
    },
    {
        file: 'packages/happy-cli/src/agy/constants.ts',
        test: (line) => line.includes("'Claude Sonnet 4.6 (Thinking)'")
            || line.includes("'Claude Opus 4.6 (Thinking)'"),
        reason: 'external Agy model catalog label',
    },
    {
        file: 'packages/happy-server/sources/app/api/routes/versionRoutes.ts',
        test: (line) => line.includes('happy-claude-code-client'),
        reason: 'immutable App Store URL slug',
    },
];

const violations = [];
for (const file of productFiles) {
    const lines = readFileSync(resolve(root, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
        if (!/claude|anthropic/i.test(line)) return;
        const allowed = allowedLines.some((entry) => entry.file === file && entry.test(line));
        if (!allowed) violations.push(`${file}:${index + 1}: ${line.trim()}`);
    });
}

const lockfile = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8');
for (const forbidden of [
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/claude-code',
    '@anthropic-ai/sdk',
]) {
    if (lockfile.includes(forbidden)) {
        violations.push(`pnpm-lock.yaml: forbidden package ${forbidden}`);
    }
}

if (violations.length > 0) {
    console.error('Claude provider boundary violations:');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
}

console.log(`Claude provider boundary passed (${productFiles.length} product files scanned).`);
