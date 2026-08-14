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
    'workflow_contracts',
];

const outputKeys = [...monorepoOutputKeys, 'cli_smoke', 'android_field'];
const shaPattern = /^[0-9a-f]{40}$/;
const standaloneDockerFileInputs = [
    '.dockerignore',
    'Dockerfile.server',
    'packages/happy-app/package.json',
    'packages/happy-server/package.json',
    'packages/happy-cli/package.json',
    'packages/happy-agent/package.json',
    'packages/happy-wire/package.json',
    'packages/happy-app-logs/package.json',
    'packages/codium/package.json',
    'packages/happy-app/sources/sync/apiTypes.ts',
    'packages/happy-app/sources/sync/profile.ts',
    'packages/happy-app/sources/sync/friendTypes.ts',
    'packages/happy-app/sources/sync/feedTypes.ts',
];
const standaloneDockerDirectoryInputs = [
    'packages/happy-app/patches/',
    'packages/happy-cli/scripts/',
    'packages/happy-cli/tools/',
];

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

function selectWorkflowContracts(classification) {
    classification.workflow_contracts = true;
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

function isStandaloneDockerInput(file) {
    return standaloneDockerFileInputs.includes(file)
        || standaloneDockerDirectoryInputs.some((prefix) => file.startsWith(prefix));
}

function selectsCliSmoke(file) {
    return isRootInstallInput(file)
        || file.startsWith('packages/happy-cli/')
        || file.startsWith('packages/happy-server/')
        || file.startsWith('packages/happy-wire/')
        || file === '.github/workflows/cli-smoke-test.yml';
}

function isAppCodexIntegrationInput(file) {
    return file.startsWith('packages/happy-app/sources/sync/')
        || file.startsWith('packages/happy-app/sources/auth/')
        || file.startsWith('packages/happy-app/sources/realtime/')
        || file === 'packages/happy-app/app.config.js'
        || file === 'packages/happy-app/mobileFieldConfig.cjs';
}

function selectSharedCodexIntegration(classification) {
    classification.codex_transport_scenarios = true;
    classification.codex_provider_boundary = true;
    selectOfficialCodexScenarios(classification);
}

function classifyWorkflowInput(file, classification) {
    selectWorkflowContracts(classification);

    if (file === '.github/workflows/ci.yml') {
        selectAll(classification);
        return;
    }
    if (file === '.github/workflows/build-official-codex-source.yml') {
        selectOfficialCodexScenarios(classification);
        classification.android_field = true;
        return;
    }
    if (file === '.github/workflows/codex-android-field-e2e.yml') {
        classification.android_field = true;
        classification.official_codex = true;
        return;
    }
    if (file === '.github/workflows/cli-smoke-test.yml') {
        classification.cli_smoke = true;
        return;
    }
    if (file === '.github/workflows/build-cli-release.yml') {
        classification.cli = true;
        return;
    }
    if (file === '.github/workflows/build-android-release.yml') {
        classification.app = true;
        return;
    }
    if (file === '.github/workflows/build-happy-agent-release.yml') {
        classification.agent = true;
        classification.wire = true;
        return;
    }
    if (file === '.github/workflows/build-debian13-relay-release.yml') {
        classification.server = true;
        classification.migration = true;
        return;
    }
    if (file.startsWith('.github/workflows/')) return;

    if (file.includes('classify-workflow-changes')) {
        selectAll(classification);
        return;
    }

    if (file.endsWith('codex-field-mcp-server.mjs')) {
        classification.android_field = true;
        selectOfficialCodexScenarios(classification);
        return;
    }

    if (file.includes('android-field') || file.includes('android_field') || file.includes('mobile-field') || file.includes('codex-mobile')) {
        classification.android_field = true;
        classification.official_codex = true;
        return;
    }
    if (file.includes('official-codex-artifact-reuse')) {
        selectOfficialCodexScenarios(classification);
        classification.android_field = true;
        return;
    }
    if (file.includes('codex-gateway') || file.includes('codex-official') || file.includes('official-codex') || file.includes('codex-responses')) {
        selectOfficialCodexScenarios(classification);
        return;
    }
    if (file.includes('codex-http-relay')) {
        selectSharedCodexIntegration(classification);
        return;
    }
    if (file.includes('assert-codex-only-provider')) {
        classification.codex_provider_boundary = true;
        return;
    }
    if (file.includes('codium-codex-runtime')) {
        classification.codium_runtime = true;
        return;
    }
    if (file.includes('standalone-server') || file.includes('debian13-relay') || file.includes('verify-deployed-server')) {
        classification.server = true;
        classification.migration = true;
        return;
    }
    if (file.includes('audit-production-dependencies')) {
        classification.dependency_audit = true;
        return;
    }
    if (file.includes('verify-http-platform-config')) {
        classification.app = true;
        return;
    }
    if (file.includes('happy-agent-package-smoke')) {
        classification.agent = true;
        classification.wire = true;
        return;
    }
    if (file.includes('cli')) {
        classification.cli = true;
        classification.cli_smoke = true;
    }
}

function classifyPaths(paths, { forceAll = false } = {}) {
    const classification = emptyClassification();
    if (forceAll) {
        selectAll(classification);
        return classification;
    }

    const files = [...new Set(paths.map(normalizePath).filter(Boolean))];
    const sourceFiles = files.filter((file) => !isMarkdown(file));

    for (const file of sourceFiles) {
        if (isRootInstallInput(file)) {
            selectAll(classification);
            continue;
        }
        if (file === 'pnpm-lock.yaml' || file.endsWith('/package.json')) {
            selectWorkflowContracts(classification);
            classification.dependency_audit = true;
        }
        if (file.startsWith('.github/workflows/') || file.startsWith('scripts/ci/')) {
            classifyWorkflowInput(file, classification);
            continue;
        }
        if (selectsCliSmoke(file)) classification.cli_smoke = true;

        if (isStandaloneDockerInput(file)) {
            classification.server = true;
            classification.migration = true;
            if (file === 'Dockerfile.server') continue;
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
            } else {
                classification.android_field = true;
                classification.official_codex = true;
                if (isAppCodexIntegrationInput(file)) selectSharedCodexIntegration(classification);
            }
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
    standaloneDockerDirectoryInputs,
    standaloneDockerFileInputs,
};
