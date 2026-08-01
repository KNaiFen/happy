#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { basename, resolve } = require('node:path');

const root = resolve(__dirname, '..', '..');

const productTargets = [
    'packages/happy-cli/',
    'packages/happy-app/sources/',
    'packages/happy-agent/',
    'packages/codium/',
    'packages/happy-server/',
    'packages/happy-wire/',
];

const activeDocs = new Set([
    'README.md',
    'PRODUCT.md',
    'PRIVACY.md',
    'docs/README.md',
    'docs/CONTRIBUTING.md',
    'docs/api.md',
    'docs/backend-architecture.md',
    'docs/cli-architecture.md',
    'docs/encryption.md',
    'docs/permission-resolution.md',
    'docs/agent-testing.md',
    'packages/happy-cli/README.md',
    'packages/happy-server/README.md',
]);

const allowedProductLines = [
    {
        file: 'packages/happy-cli/package.json',
        test: (line) => line.includes('@anthropic-ai/sandbox-runtime'),
        reason: 'Codex outer sandbox dependency',
    },
    {
        file: 'packages/happy-cli/src/sandbox/config.ts',
        test: (line) => line.includes('@anthropic-ai/sandbox-runtime'),
        reason: 'Codex outer sandbox type import',
    },
    {
        file: 'packages/happy-cli/src/sandbox/manager.ts',
        test: (line) => line.includes('@anthropic-ai/sandbox-runtime'),
        reason: 'Codex outer sandbox implementation import',
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

const allowedDocLines = [
    {
        file: 'README.md',
        test: (line) => line.includes('apps.apple.com/us/app/happy-claude-code-client/'),
        reason: 'immutable App Store URL slug',
    },
    {
        file: 'docs/permission-resolution.md',
        test: (line) => line.includes('@anthropic-ai/sandbox-runtime'),
        reason: 'Codex outer sandbox dependency',
    },
];

const forbiddenPackages = [
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/claude-code',
    '@anthropic-ai/sdk',
];

const forbiddenActiveDocReferences = [
    'session-protocol-claude.md',
    'packages/happy-cli/agents.md',
    'docs/plans/codex-app-server-migration.md',
];

function isProductFile(file) {
    return productTargets.some((target) => file.startsWith(target))
        && /\.(?:[cm]?[jt]sx?|json)$/.test(file)
        && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
        && !file.includes('/__testdata__/')
        && !file.includes('/changelog/');
}

function isForbiddenInstructionPath(file) {
    const normalized = file.replaceAll('\\', '/');
    return basename(normalized) === 'CLAUDE.md'
        || basename(normalized) === 'CLAUDE.local.md'
        || normalized.startsWith('.claude/')
        || normalized.includes('/.claude/')
        || normalized.startsWith('src/claude/')
        || normalized.includes('/src/claude/');
}

function isAllowedLine(file, line, rules) {
    return rules.some((entry) => entry.file === file && entry.test(line));
}

function scanCodexOnlyBoundary({ trackedFiles, readText }) {
    const violations = [];

    for (const file of trackedFiles) {
        if (isForbiddenInstructionPath(file)) {
            violations.push(`${file}: forbidden active provider/instruction path`);
        }

        const scanProduct = isProductFile(file);
        const scanDoc = activeDocs.has(file);
        if (!scanProduct && !scanDoc) continue;

        const lines = readText(file).split(/\r?\n/);
        lines.forEach((line, index) => {
            if (
                scanDoc
                && forbiddenActiveDocReferences.some((reference) => line.includes(reference))
            ) {
                violations.push(`${file}:${index + 1}: removed document reference: ${line.trim()}`);
                return;
            }
            if (!/claude|anthropic/i.test(line)) return;
            const rules = scanProduct ? allowedProductLines : allowedDocLines;
            if (!isAllowedLine(file, line, rules)) {
                violations.push(`${file}:${index + 1}: ${line.trim()}`);
            }
        });
    }

    const lockfile = readText('pnpm-lock.yaml');
    for (const forbidden of forbiddenPackages) {
        if (lockfile.includes(forbidden)) {
            violations.push(`pnpm-lock.yaml: forbidden package ${forbidden}`);
        }
    }

    return violations;
}

function listRepositoryFiles() {
    return execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard'],
        { cwd: root, encoding: 'utf8' },
    ).split('\n').filter(Boolean);
}

function main() {
    const repositoryFiles = listRepositoryFiles().filter((file) => existsSync(resolve(root, file)));
    const violations = scanCodexOnlyBoundary({
        trackedFiles: repositoryFiles,
        readText: (file) => readFileSync(resolve(root, file), 'utf8'),
    });

    if (violations.length > 0) {
        console.error('Codex-only provider boundary violations:');
        for (const violation of violations) console.error(`- ${violation}`);
        process.exitCode = 1;
        return;
    }

    const productCount = repositoryFiles.filter(isProductFile).length;
    console.log(`Codex-only provider boundary passed (${productCount} product files scanned).`);
}

module.exports = {
    isForbiddenInstructionPath,
    isProductFile,
    scanCodexOnlyBoundary,
};

if (require.main === module) main();
