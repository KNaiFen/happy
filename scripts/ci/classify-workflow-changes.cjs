#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const monorepoOutputKeys = [
    'wire',
    'agent',
    'codium',
    'codium_runtime',
    'server',
    'cli',
    'app',
    'tauri',
    'migration',
    'official_codex',
    'protocol_drift',
    'codex_transport_scenarios',
    'codex_official_app_server',
    'codex_gateway_tui',
    'dependency_audit',
    'codex_provider_boundary',
];

const outputKeys = [...monorepoOutputKeys, 'cli_smoke'];
const shaPattern = /^[0-9a-f]{40}$/;

function emptyClassification() {
    return Object.fromEntries(outputKeys.map((key) => [key, false]));
}

function selectAll(classification) {
    for (const key of outputKeys) classification[key] = true;
}

function selectOfficialCodexScenarios(classification) {
    classification.official_codex = true;
    classification.codex_official_app_server = true;
    classification.codex_gateway_tui = true;
}

function normalizePath(file) {
    return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isMarkdown(file) {
    return /\.mdx?$/i.test(file);
}

function isRootInstallInput(file) {
    return file === '.npmrc'
        || file === 'package.json'
        || file === 'pnpm-lock.yaml'
        || file === 'pnpm-workspace.yaml'
        || file === 'scripts/postinstall.cjs'
        || file.startsWith('patches/');
}

function selectsCliSmoke(file) {
    return isRootInstallInput(file)
        || file.startsWith('packages/happy-cli/')
        || file.startsWith('packages/happy-server/')
        || file.startsWith('packages/happy-wire/')
        || file.startsWith('scripts/ci/')
        || file === '.github/workflows/cli-smoke-test.yml';
}

function selectSharedCodexIntegration(classification) {
    classification.codex_transport_scenarios = true;
    classification.codex_provider_boundary = true;
    selectOfficialCodexScenarios(classification);
}

function classifyPaths(paths, { forceAll = false } = {}) {
    const classification = emptyClassification();
    if (forceAll) {
        selectAll(classification);
        return classification;
    }

    const files = [...new Set(paths.map(normalizePath).filter(Boolean))];
    const sourceFiles = files.filter((file) => !isMarkdown(file));

    if (sourceFiles.some((file) =>
        isRootInstallInput(file)
        || file.startsWith('.github/workflows/')
        || file.startsWith('scripts/ci/'))) {
        selectAll(classification);
        return classification;
    }

    for (const file of sourceFiles) {
        if (selectsCliSmoke(file)) classification.cli_smoke = true;
        if (file === 'pnpm-lock.yaml' || file.endsWith('/package.json')) {
            classification.dependency_audit = true;
        }

        if (file.startsWith('packages/happy-wire/')) {
            classification.wire = true;
            classification.agent = true;
            classification.server = true;
            classification.cli = true;
            classification.app = true;
            classification.migration = true;
            classification.protocol_drift = true;
            selectSharedCodexIntegration(classification);
            continue;
        }

        if (file.startsWith('packages/happy-agent/')) {
            classification.agent = true;
            classification.codex_provider_boundary = true;
            continue;
        }

        if (file.startsWith('packages/codium/')) {
            classification.codium = true;
            classification.codium_runtime = true;
            classification.codex_provider_boundary = true;
            continue;
        }

        if (file.startsWith('packages/happy-server/')) {
            classification.server = true;
            classification.migration = true;
            selectSharedCodexIntegration(classification);
            continue;
        }

        if (file.startsWith('packages/happy-cli/')) {
            classification.cli = true;
            classification.protocol_drift = true;
            selectSharedCodexIntegration(classification);
            continue;
        }

        if (file.startsWith('packages/happy-app/')) {
            classification.app = true;
            if (file.startsWith('packages/happy-app/src-tauri/')) {
                classification.tauri = true;
            }
            selectSharedCodexIntegration(classification);
        }
    }

    return classification;
}

function changedPathsBetween(baseSha, headSha) {
    if (!shaPattern.test(baseSha) || /^0+$/.test(baseSha)) return null;
    if (!shaPattern.test(headSha) || /^0+$/.test(headSha)) return null;
    return execFileSync(
        'git',
        ['diff', '--name-only', '-z', baseSha, headSha],
        { encoding: 'utf8' },
    ).split('\0').filter(Boolean);
}

function writeOutputs(classification) {
    const outputs = Object.fromEntries(
        Object.entries(classification).map(([key, value]) => [key, String(value)]),
    );
    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(
            process.env.GITHUB_OUTPUT,
            Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''),
        );
    }
    process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
}

function main() {
    const [baseSha = '', headSha = '', forceAllValue = 'false'] = process.argv.slice(2);
    const forceAll = forceAllValue === 'true';
    const changedPaths = forceAll ? [] : changedPathsBetween(baseSha, headSha);
    writeOutputs(classifyPaths(changedPaths ?? [], {
        forceAll: forceAll || changedPaths === null,
    }));
}

if (require.main === module) main();

module.exports = {
    classifyPaths,
    monorepoOutputKeys,
    outputKeys,
};
