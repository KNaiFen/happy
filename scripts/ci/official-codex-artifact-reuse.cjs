#!/usr/bin/env node

const {
    appendFileSync,
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const artifactNamePrefix = 'official-codex-linux-x64-r3-';
const artifactNamePattern = /^official-codex-linux-x64-r3-([0-9a-f]{64})$/;
const ciGateName = 'Required CI gate';
const ciWorkflowName = 'Happy monorepo CI';
const ciWorkflowPath = '.github/workflows/ci.yml';
const sha256Pattern = /^[0-9a-f]{64}$/;
const gitShaPattern = /^[0-9a-f]{40}$/;
const artifactDigestPattern = /^(?:sha256:)?([0-9a-f]{64})$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const artifactBinaryPaths = {
    codex: 'bin/codex',
    codexCodeModeHost: 'bin/codex-code-mode-host',
    bwrap: 'bin/codex-resources/bwrap',
};
const artifactCargoLockPaths = {
    sourceCargoLockSha256: 'Cargo.lock.source',
    resolvedCargoLockSha256: 'Cargo.lock.resolved',
};
const manifestKeys = [
    'attestationRunId',
    'binarySha256',
    'bwrapSha256',
    'commit',
    'compiledHappySourceSha',
    'compiledRunId',
    'happySourceSha',
    'recipeFingerprint',
    'recipeInputs',
    'repository',
    'resolvedCargoLockSha256',
    'runtimeBundleVersion',
    'rustToolchain',
    'rustyV8Version',
    'schemaVersion',
    'sourceCargoLockSha256',
    'tag',
    'target',
    'version',
];

function isPlainObject(value) {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expectedKeys, label) {
    if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label} keys are unexpected`);
    }
    return value;
}

function assertString(value, label, { allowEmpty = false } = {}) {
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
        throw new Error(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
    }
    return value;
}

function assertSha256(value, label) {
    if (typeof value !== 'string' || !sha256Pattern.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256 digest`);
    }
    return value;
}

function assertGitSha(value, label) {
    if (typeof value !== 'string' || !gitShaPattern.test(value)) {
        throw new Error(`${label} must be a lowercase Git SHA`);
    }
    return value;
}

function assertPositiveInteger(value, label) {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return number;
}

function assertTimestamp(value, label) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
        throw new Error(`${label} must be an ISO timestamp`);
    }
    return value;
}

function parseArtifactDigest(value) {
    if (typeof value !== 'string') {
        throw new Error('Artifact digest is missing');
    }
    const match = artifactDigestPattern.exec(value);
    if (!match) {
        throw new Error('Artifact digest must be a lowercase SHA-256 digest');
    }
    return match[1];
}

function assertRepository(value) {
    if (typeof value !== 'string' || !repositoryPattern.test(value)) {
        throw new Error('GITHUB_REPOSITORY must be an owner/name repository slug');
    }
    return value;
}

function canonicalize(value, label = 'Recipe inputs') {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0)) {
            throw new Error(`${label} contains a non-canonical number`);
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry, index) => canonicalize(entry, `${label}[${index}]`));
    }
    if (!isPlainObject(value)) throw new Error(`${label} contains an unsupported value`);
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonicalize(value[key], `${label}.${key}`)]),
    );
}

function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

function assertRecipeInputs(recipeInputs) {
    assertExactKeys(recipeInputs, [
        'artifactLayout',
        'cargoLocks',
        'environment',
        'fingerprintSchema',
        'linuxBuild',
        'manifestSchema',
        'recipeFiles',
        'release',
        'repository',
        'runner',
        'runtimeBundleVersion',
        'rust',
        'rustyV8',
    ], 'Official Codex recipe inputs');
    if (recipeInputs.fingerprintSchema !== 1
        || recipeInputs.manifestSchema !== 5
        || recipeInputs.runtimeBundleVersion !== 2) {
        throw new Error('Official Codex recipe schema is unsupported');
    }
    if (recipeInputs.repository !== 'https://github.com/openai/codex') {
        throw new Error('Official Codex recipe repository is unexpected');
    }

    assertExactKeys(recipeInputs.release, ['commit', 'tag', 'version'], 'Recipe release');
    assertGitSha(recipeInputs.release.commit, 'Recipe Codex source SHA');
    if (typeof recipeInputs.release.version !== 'string'
        || !/^\d+\.\d+\.\d+$/.test(recipeInputs.release.version)) {
        throw new Error('Recipe Codex version is invalid');
    }
    if (recipeInputs.release.tag !== `rust-v${recipeInputs.release.version}`) {
        throw new Error('Recipe Codex release tag does not match its version');
    }

    assertExactKeys(recipeInputs.cargoLocks, ['resolvedSha256', 'sourceSha256'], 'Recipe Cargo locks');
    assertSha256(recipeInputs.cargoLocks.sourceSha256, 'Recipe source Cargo.lock SHA-256');
    assertSha256(recipeInputs.cargoLocks.resolvedSha256, 'Recipe resolved Cargo.lock SHA-256');

    assertExactKeys(
        recipeInputs.rust,
        ['cargoVerbose', 'declaredToolchain', 'rustcVerbose', 'target'],
        'Recipe Rust toolchain',
    );
    if (!/^\d+\.\d+\.\d+$/.test(assertString(recipeInputs.rust.declaredToolchain, 'Recipe Rust toolchain'))) {
        throw new Error('Recipe Rust toolchain is invalid');
    }
    assertString(recipeInputs.rust.rustcVerbose, 'Recipe rustc version');
    assertString(recipeInputs.rust.cargoVerbose, 'Recipe Cargo version');
    if (!/^[A-Za-z0-9_.-]+$/.test(assertString(recipeInputs.rust.target, 'Recipe Rust target'))) {
        throw new Error('Recipe Rust target is invalid');
    }

    assertExactKeys(recipeInputs.runner, ['arch', 'imageOs', 'imageVersion', 'os'], 'Recipe runner');
    for (const key of Object.keys(recipeInputs.runner)) {
        assertString(recipeInputs.runner[key], `Recipe runner ${key}`);
    }

    assertExactKeys(
        recipeInputs.rustyV8,
        ['archiveSha256', 'bindingSha256', 'checksumsSha256', 'version'],
        'Recipe rusty_v8 assets',
    );
    if (!/^\d+\.\d+\.\d+$/.test(assertString(recipeInputs.rustyV8.version, 'Recipe rusty_v8 version'))) {
        throw new Error('Recipe rusty_v8 version is invalid');
    }
    for (const key of ['archiveSha256', 'bindingSha256', 'checksumsSha256']) {
        assertSha256(recipeInputs.rustyV8[key], `Recipe rusty_v8 ${key}`);
    }

    assertExactKeys(recipeInputs.linuxBuild, ['packages', 'tools'], 'Recipe Linux build inputs');
    assertExactKeys(
        recipeInputs.linuxBuild.packages,
        ['binutils', 'libcapDev', 'pkgConfig'],
        'Recipe Linux packages',
    );
    assertExactKeys(
        recipeInputs.linuxBuild.tools,
        ['cc', 'cxx', 'glibc', 'ld', 'strip'],
        'Recipe Linux tools',
    );
    for (const group of [recipeInputs.linuxBuild.packages, recipeInputs.linuxBuild.tools]) {
        for (const [key, value] of Object.entries(group)) {
            assertString(value, `Recipe Linux ${key}`);
        }
    }

    assertExactKeys(recipeInputs.environment, [
        'cargoIncremental',
        'cargoNetGitFetchWithCli',
        'cc',
        'cflags',
        'cxx',
        'cxxflags',
        'rustflags',
    ], 'Recipe build environment');
    for (const [key, value] of Object.entries(recipeInputs.environment)) {
        assertString(value, `Recipe environment ${key}`, { allowEmpty: true });
    }
    if (recipeInputs.environment.cargoIncremental !== '0'
        || recipeInputs.environment.cargoNetGitFetchWithCli !== 'true') {
        throw new Error('Recipe Cargo environment is unexpected');
    }

    assertExactKeys(recipeInputs.recipeFiles, ['helperSha256', 'workflowSha256'], 'Recipe files');
    assertSha256(recipeInputs.recipeFiles.helperSha256, 'Recipe helper SHA-256');
    assertSha256(recipeInputs.recipeFiles.workflowSha256, 'Recipe workflow SHA-256');

    assertExactKeys(recipeInputs.artifactLayout, ['binaries', 'cargoLocks'], 'Recipe artifact layout');
    assertExactKeys(
        recipeInputs.artifactLayout.binaries,
        Object.keys(artifactBinaryPaths),
        'Recipe binary layout',
    );
    assertExactKeys(
        recipeInputs.artifactLayout.cargoLocks,
        ['resolved', 'source'],
        'Recipe Cargo lock layout',
    );
    if (canonicalJson(recipeInputs.artifactLayout.binaries) !== canonicalJson(artifactBinaryPaths)
        || recipeInputs.artifactLayout.cargoLocks.source !== artifactCargoLockPaths.sourceCargoLockSha256
        || recipeInputs.artifactLayout.cargoLocks.resolved !== artifactCargoLockPaths.resolvedCargoLockSha256) {
        throw new Error('Recipe artifact layout is unexpected');
    }
    canonicalJson(recipeInputs);
    return recipeInputs;
}

function recipeFingerprint(recipeInputs) {
    assertRecipeInputs(recipeInputs);
    return createHash('sha256').update(canonicalJson(recipeInputs)).digest('hex');
}

function artifactNameForFingerprint(fingerprint) {
    return `${artifactNamePrefix}${assertSha256(fingerprint, 'Recipe fingerprint')}`;
}

function parseArtifactName(value) {
    if (typeof value !== 'string') throw new Error('Official Codex artifact name is missing');
    const match = artifactNamePattern.exec(value);
    if (!match) throw new Error('Official Codex artifact name does not contain a valid recipe fingerprint');
    return match[1];
}

function assertSuccessfulCiGate(jobs) {
    if (!Array.isArray(jobs)) throw new Error('CI jobs response is malformed');
    const gates = jobs.filter((job) => job && job.name === ciGateName);
    if (gates.length !== 1) {
        throw new Error(`Expected exactly one ${ciGateName} job`);
    }
    const gate = gates[0];
    if (gate.status !== 'completed' || gate.conclusion !== 'success') {
        throw new Error(`${ciGateName} did not succeed`);
    }
}

function selectUnexpiredArtifact(artifacts, expectedArtifactName = '', expectedRunId = '', expectedHeadSha = '') {
    if (!Array.isArray(artifacts)) throw new Error('CI artifacts response is malformed');
    if (expectedArtifactName) parseArtifactName(expectedArtifactName);
    const runId = expectedRunId ? assertPositiveInteger(expectedRunId, 'Expected artifact workflow run id') : 0;
    const headSha = expectedHeadSha ? assertGitSha(expectedHeadSha, 'Expected artifact workflow run SHA') : '';
    const matches = artifacts.filter((artifact) => {
        if (!artifact || typeof artifact.name !== 'string') return false;
        if (expectedArtifactName) return artifact.name === expectedArtifactName;
        return artifactNamePattern.test(artifact.name);
    });
    if (matches.length === 0) return null;
    if (matches.length !== 1) {
        throw new Error('Expected exactly one recipe-bound Official Codex artifact');
    }

    const artifact = matches[0];
    if (artifact.expired !== false) {
        throw new Error('Official Codex artifact is expired or has no expiration state');
    }
    if (runId || headSha) {
        if (!isPlainObject(artifact.workflow_run)) {
            throw new Error('Official Codex artifact workflow provenance is missing');
        }
        if (runId && assertPositiveInteger(artifact.workflow_run.id, 'Artifact workflow run id') !== runId) {
            throw new Error('Official Codex artifact workflow run does not match its producer');
        }
        if (headSha && artifact.workflow_run.head_sha !== headSha) {
            throw new Error('Official Codex artifact workflow SHA does not match its producer');
        }
    }
    return {
        artifactId: String(assertPositiveInteger(artifact.id, 'Artifact id')),
        artifactDigest: `sha256:${parseArtifactDigest(artifact.digest)}`,
        artifactName: artifact.name,
        createdAt: assertTimestamp(artifact.created_at, 'Artifact creation time'),
        recipeFingerprint: parseArtifactName(artifact.name),
    };
}

function assertCiRunIdentity({ run, expectedHeadSha = '', expectedWorkflowId, repository }) {
    if (!isPlainObject(run)) throw new Error('CI workflow run response is malformed');
    const runId = assertPositiveInteger(run.id, 'CI workflow run id');
    const workflowId = assertPositiveInteger(expectedWorkflowId, 'Expected CI workflow id');
    const expectedRepository = assertRepository(repository);
    const headSha = assertGitSha(run.head_sha, 'CI workflow run Happy source SHA');
    if (expectedHeadSha && headSha !== assertGitSha(expectedHeadSha, 'Expected Happy source SHA')) {
        throw new Error('CI workflow run Happy source SHA does not match the requested SHA');
    }
    if (run.workflow_id !== workflowId || run.path !== ciWorkflowPath || run.name !== ciWorkflowName) {
        throw new Error('Reusable artifact producer is not the canonical CI workflow');
    }
    if (!run.repository || run.repository.full_name !== expectedRepository) {
        throw new Error('Reusable artifact producer repository is unexpected');
    }
    if (run.event !== 'push' || run.head_branch !== 'main') {
        throw new Error('Reusable artifact must come from a push run on main');
    }
    if (run.run_attempt !== 1) {
        throw new Error('Reusable artifact must come from the first CI run attempt');
    }
    if (run.status !== 'completed') {
        throw new Error('CI workflow run is not complete');
    }
    return { headSha, runId };
}

function selectReusableArtifact({
    run,
    jobs,
    artifacts,
    expectedHeadSha,
    expectedArtifactName = '',
    expectedWorkflowId,
    repository,
}) {
    const { headSha, runId } = assertCiRunIdentity({
        run,
        expectedHeadSha,
        expectedWorkflowId,
        repository,
    });
    if (run.conclusion !== 'success') {
        return {
            selected: false,
            reason: 'upstream-ci-not-success',
        };
    }

    assertSuccessfulCiGate(jobs);
    const artifact = selectUnexpiredArtifact(artifacts, expectedArtifactName, runId, headSha);
    if (!artifact) {
        return {
            selected: false,
            reason: 'official-codex-not-selected',
        };
    }
    return {
        selected: true,
        reason: 'selected',
        sourceRunId: String(runId),
        headSha,
        ...artifact,
    };
}

function sha256File(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyArchiveDigest(path, artifactDigest) {
    const expectedDigest = parseArtifactDigest(artifactDigest);
    if (sha256File(path) !== expectedDigest) {
        throw new Error('Downloaded Official Codex artifact digest does not match the Actions API');
    }
}

function assertSourceManifest(manifest, {
    happySourceSha = '',
    codexCommit = '',
    recipeFingerprint: expectedRecipeFingerprint = '',
    attestationRunId = '',
} = {}) {
    assertExactKeys(manifest, manifestKeys, 'Official Codex source manifest');
    if (manifest.schemaVersion !== 5 || manifest.runtimeBundleVersion !== 2) {
        throw new Error('Official Codex source manifest schema is unsupported');
    }
    if (manifest.repository !== 'https://github.com/openai/codex') {
        throw new Error('Official Codex source manifest repository is unexpected');
    }
    assertGitSha(manifest.happySourceSha, 'Manifest Happy source SHA');
    assertGitSha(manifest.compiledHappySourceSha, 'Manifest compiled Happy source SHA');
    assertPositiveInteger(manifest.attestationRunId, 'Manifest attestation run id');
    assertPositiveInteger(manifest.compiledRunId, 'Manifest compiled run id');
    assertGitSha(manifest.commit, 'Manifest Codex source SHA');
    if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
        throw new Error('Manifest Codex version is invalid');
    }
    if (manifest.tag !== `rust-v${manifest.version}`) {
        throw new Error('Manifest Codex release tag does not match its version');
    }
    if (!/^\d+\.\d+\.\d+$/.test(assertString(manifest.rustToolchain, 'Manifest Rust toolchain'))) {
        throw new Error('Manifest Rust toolchain is invalid');
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(assertString(manifest.target, 'Manifest Rust target'))) {
        throw new Error('Manifest Rust target is invalid');
    }
    if (!/^\d+\.\d+\.\d+$/.test(assertString(manifest.rustyV8Version, 'Manifest rusty_v8 version'))) {
        throw new Error('Manifest rusty_v8 version is invalid');
    }
    assertSha256(manifest.sourceCargoLockSha256, 'Manifest source Cargo.lock SHA-256');
    assertSha256(manifest.resolvedCargoLockSha256, 'Manifest resolved Cargo.lock SHA-256');
    assertSha256(manifest.bwrapSha256, 'Manifest bwrap SHA-256');

    if (happySourceSha
        && manifest.happySourceSha !== assertGitSha(happySourceSha, 'Expected Happy source SHA')) {
        throw new Error('Official Codex artifact Happy source SHA does not match its attestation');
    }
    if (codexCommit && manifest.commit !== assertGitSha(codexCommit, 'Expected Codex source SHA')) {
        throw new Error('Official Codex artifact Codex source SHA does not match the workflow output');
    }
    if (attestationRunId
        && manifest.attestationRunId !== assertPositiveInteger(attestationRunId, 'Expected attestation run id')) {
        throw new Error('Official Codex artifact attestation run id does not match its producer');
    }

    assertExactKeys(
        manifest.binarySha256,
        Object.keys(artifactBinaryPaths),
        'Official Codex binary digests',
    );
    for (const key of Object.keys(artifactBinaryPaths)) {
        assertSha256(manifest.binarySha256[key], `Manifest ${key} SHA-256`);
    }
    if (manifest.bwrapSha256 !== manifest.binarySha256.bwrap) {
        throw new Error('Manifest bwrap digests disagree');
    }

    const calculatedFingerprint = recipeFingerprint(manifest.recipeInputs);
    if (manifest.recipeFingerprint !== calculatedFingerprint) {
        throw new Error('Official Codex recipe fingerprint does not match its canonical inputs');
    }
    if (expectedRecipeFingerprint
        && calculatedFingerprint !== assertSha256(expectedRecipeFingerprint, 'Expected recipe fingerprint')) {
        throw new Error('Official Codex recipe fingerprint does not match the requested recipe');
    }

    const recipe = manifest.recipeInputs;
    if (recipe.repository !== manifest.repository
        || recipe.release.tag !== manifest.tag
        || recipe.release.version !== manifest.version
        || recipe.release.commit !== manifest.commit
        || recipe.cargoLocks.sourceSha256 !== manifest.sourceCargoLockSha256
        || recipe.cargoLocks.resolvedSha256 !== manifest.resolvedCargoLockSha256
        || recipe.rust.declaredToolchain !== manifest.rustToolchain
        || recipe.rust.target !== manifest.target
        || recipe.rustyV8.version !== manifest.rustyV8Version) {
        throw new Error('Official Codex manifest facts disagree with its recipe inputs');
    }
    return manifest;
}

function verifyExtractedArtifact(root, expected = {}) {
    const artifactRoot = resolve(root);
    const manifestPath = `${artifactRoot}/source.json`;
    let manifestStats;
    try {
        manifestStats = statSync(manifestPath);
    } catch {
        throw new Error('Official Codex source manifest is missing');
    }
    if (!manifestStats.isFile()) throw new Error('Official Codex source manifest is not a file');
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
        throw new Error('Official Codex source manifest is invalid JSON');
    }
    assertSourceManifest(manifest, expected);

    for (const [key, relativePath] of Object.entries(artifactBinaryPaths)) {
        const path = `${artifactRoot}/${relativePath}`;
        let stats;
        try {
            stats = statSync(path);
        } catch {
            throw new Error(`Official Codex artifact is missing ${relativePath}`);
        }
        if (!stats.isFile()) throw new Error(`Official Codex artifact ${relativePath} is not a file`);
        if (sha256File(path) !== manifest.binarySha256[key]) {
            throw new Error(`Official Codex artifact ${relativePath} SHA-256 does not match source.json`);
        }
    }
    for (const [manifestKey, relativePath] of Object.entries(artifactCargoLockPaths)) {
        const path = `${artifactRoot}/${relativePath}`;
        let stats;
        try {
            stats = statSync(path);
        } catch {
            throw new Error(`Official Codex artifact is missing ${relativePath}`);
        }
        if (!stats.isFile()) throw new Error(`Official Codex artifact ${relativePath} is not a file`);
        if (sha256File(path) !== manifest[manifestKey]) {
            throw new Error(`Official Codex artifact ${relativePath} SHA-256 does not match source.json`);
        }
    }
    return manifest;
}

function attestArtifact(root, newHappySourceSha, newRunId, expected = {}) {
    const artifactRoot = resolve(root);
    const currentManifest = verifyExtractedArtifact(artifactRoot, expected);
    const updatedManifest = {
        ...currentManifest,
        happySourceSha: assertGitSha(newHappySourceSha, 'New Happy source SHA'),
        attestationRunId: assertPositiveInteger(newRunId, 'New attestation run id'),
    };
    const manifestPath = `${artifactRoot}/source.json`;
    const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
    try {
        writeFileSync(temporaryPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, { mode: 0o644 });
        renameSync(temporaryPath, manifestPath);
    } catch (error) {
        try {
            unlinkSync(temporaryPath);
        } catch {
            // Nothing to clean up.
        }
        throw error;
    }
    return verifyExtractedArtifact(artifactRoot, {
        ...expected,
        happySourceSha: updatedManifest.happySourceSha,
        attestationRunId: updatedManifest.attestationRunId,
    });
}

function ghApiJson(path, label) {
    const result = spawnSync('gh', ['api', '--method', 'GET', path], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
        throw new Error(`GitHub Actions API request failed for ${label}`);
    }
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new Error(`GitHub Actions API returned invalid JSON for ${label}`);
    }
}

function collectPaginatedCollection({ fetchPage, itemKey, label }) {
    let expectedCount;
    const values = [];
    for (let page = 1; ; page += 1) {
        const response = fetchPage(page);
        if (!response || typeof response !== 'object' || !Array.isArray(response[itemKey])) {
            throw new Error(`${label} API response is malformed`);
        }
        if (!Number.isSafeInteger(response.total_count) || response.total_count < 0) {
            throw new Error(`${label} API response has an invalid total_count`);
        }
        if (expectedCount === undefined) expectedCount = response.total_count;
        if (response.total_count !== expectedCount) {
            throw new Error(`${label} API response total_count changed during pagination`);
        }
        values.push(...response[itemKey]);
        if (values.length === expectedCount) return values;
        if (values.length > expectedCount || response[itemKey].length === 0) {
            throw new Error(`${label} API pagination is incomplete or inconsistent`);
        }
    }
}

function ghApiCollection(path, itemKey, label) {
    const separator = path.includes('?') ? '&' : '?';
    return collectPaginatedCollection({
        fetchPage: (page) => ghApiJson(`${path}${separator}per_page=100&page=${page}`, label),
        itemKey,
        label,
    });
}

function writeOutputs(values) {
    const outputs = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));
    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(
            process.env.GITHUB_OUTPUT,
            Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''),
        );
    }
    process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
}

function writeEnvironment(values) {
    if (!process.env.GITHUB_ENV) return;
    appendFileSync(
        process.env.GITHUB_ENV,
        Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''),
    );
}

function workflowIdentity(repository) {
    const workflow = ghApiJson(
        `repos/${repository}/actions/workflows/${encodeURIComponent(ciWorkflowPath)}`,
        'canonical CI workflow',
    );
    return assertPositiveInteger(workflow.id, 'Canonical CI workflow id');
}

function resolveReusableArtifact(runIdValue, expectedHeadSha) {
    const repository = assertRepository(process.env.GITHUB_REPOSITORY);
    const runId = assertPositiveInteger(runIdValue, 'CI workflow run id');
    const expectedWorkflowId = workflowIdentity(repository);
    const run = ghApiJson(`repos/${repository}/actions/runs/${runId}`, 'workflow run');
    const jobs = ghApiCollection(
        `repos/${repository}/actions/runs/${runId}/jobs?filter=latest`,
        'jobs',
        'workflow jobs',
    );
    const artifacts = ghApiCollection(
        `repos/${repository}/actions/runs/${runId}/artifacts`,
        'artifacts',
        'workflow artifacts',
    );
    const decision = selectReusableArtifact({
        run,
        jobs,
        artifacts,
        expectedHeadSha,
        expectedWorkflowId,
        repository,
    });
    if (decision.selected) {
        writeOutputs({
            selected: true,
            reason: decision.reason,
            source_run_id: decision.sourceRunId,
            head_sha: decision.headSha,
            artifact_id: decision.artifactId,
            artifact_digest: decision.artifactDigest,
            artifact_name: decision.artifactName,
            recipe_fingerprint: decision.recipeFingerprint,
        });
    } else {
        writeOutputs({
            selected: false,
            reason: decision.reason,
        });
    }
}

function artifactRunCandidates(artifacts, expectedArtifactName) {
    if (!Array.isArray(artifacts)) throw new Error('Repository artifacts response is malformed');
    const candidates = [];
    for (const artifact of artifacts) {
        try {
            if (!artifact || artifact.name !== expectedArtifactName || artifact.expired !== false) continue;
            candidates.push({
                artifactId: assertPositiveInteger(artifact.id, 'Artifact id'),
                createdAt: assertTimestamp(artifact.created_at, 'Artifact creation time'),
                runId: assertPositiveInteger(artifact.workflow_run?.id, 'Artifact workflow run id'),
            });
        } catch {
            // A malformed repository-level candidate is never reusable.
        }
    }
    candidates.sort((left, right) => (
        Date.parse(right.createdAt) - Date.parse(left.createdAt)
        || right.artifactId - left.artifactId
    ));
    const seenRunIds = new Set();
    return candidates.filter((candidate) => {
        if (seenRunIds.has(candidate.runId)) return false;
        seenRunIds.add(candidate.runId);
        return true;
    });
}

function findReusableArtifact(fingerprint) {
    const repository = assertRepository(process.env.GITHUB_REPOSITORY);
    const artifactName = artifactNameForFingerprint(fingerprint);
    const expectedWorkflowId = workflowIdentity(repository);
    const listedArtifacts = ghApiCollection(
        `repos/${repository}/actions/artifacts?name=${encodeURIComponent(artifactName)}`,
        'artifacts',
        'repository artifacts',
    );
    for (const candidate of artifactRunCandidates(listedArtifacts, artifactName)) {
        const run = ghApiJson(`repos/${repository}/actions/runs/${candidate.runId}`, 'candidate workflow run');
        try {
            assertCiRunIdentity({ run, expectedWorkflowId, repository });
        } catch (error) {
            process.stderr.write(`Skipping untrusted Official Codex run ${candidate.runId}: ${error.message}\n`);
            continue;
        }
        if (run.conclusion !== 'success') continue;
        const jobs = ghApiCollection(
            `repos/${repository}/actions/runs/${candidate.runId}/jobs?filter=latest`,
            'jobs',
            'candidate workflow jobs',
        );
        const artifacts = ghApiCollection(
            `repos/${repository}/actions/runs/${candidate.runId}/artifacts`,
            'artifacts',
            'candidate workflow artifacts',
        );
        try {
            const decision = selectReusableArtifact({
                run,
                jobs,
                artifacts,
                expectedHeadSha: run.head_sha,
                expectedArtifactName: artifactName,
                expectedWorkflowId,
                repository,
            });
            if (!decision.selected) continue;
            writeOutputs({
                selected: true,
                reason: decision.reason,
                source_run_id: decision.sourceRunId,
                head_sha: decision.headSha,
                artifact_id: decision.artifactId,
                artifact_digest: decision.artifactDigest,
                artifact_name: decision.artifactName,
                recipe_fingerprint: decision.recipeFingerprint,
            });
            return;
        } catch (error) {
            process.stderr.write(`Skipping invalid Official Codex run ${candidate.runId}: ${error.message}\n`);
        }
    }
    writeOutputs({ selected: false, reason: 'no-trusted-main-artifact' });
}

function downloadArtifactArchive(artifactIdValue, artifactDigest, destination) {
    const repository = assertRepository(process.env.GITHUB_REPOSITORY);
    const artifactId = assertPositiveInteger(artifactIdValue, 'Artifact id');
    parseArtifactDigest(artifactDigest);
    const destinationRoot = resolve(destination);
    mkdirSync(destinationRoot, { recursive: true });
    if (readdirSync(destinationRoot).length !== 0) {
        throw new Error('Official Codex artifact destination must be empty');
    }

    const archivePath = `${destinationRoot}/.official-codex-artifact-${artifactId}.zip`;
    const archiveFd = openSync(archivePath, 'w', 0o600);
    try {
        const result = spawnSync(
            'gh',
            ['api', '--method', 'GET', `repos/${repository}/actions/artifacts/${artifactId}/zip`],
            { encoding: 'utf8', stdio: ['ignore', archiveFd, 'pipe'] },
        );
        if (result.error || result.status !== 0) {
            throw new Error('GitHub Actions artifact download failed');
        }
    } finally {
        closeSync(archiveFd);
    }
    try {
        verifyArchiveDigest(archivePath, artifactDigest);
        const result = spawnSync('unzip', ['-q', archivePath, '-d', destinationRoot], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (result.error || result.status !== 0) {
            throw new Error('Downloaded Official Codex artifact could not be extracted');
        }
    } finally {
        unlinkSync(archivePath);
    }
}

function verificationOutputs(manifest) {
    return {
        attested_happy_source_sha: manifest.happySourceSha,
        attestation_run_id: manifest.attestationRunId,
        compiled_happy_source_sha: manifest.compiledHappySourceSha,
        compiled_run_id: manifest.compiledRunId,
        recipe_fingerprint: manifest.recipeFingerprint,
    };
}

function main() {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'fingerprint') {
        if (args.length !== 1) throw new Error('Usage: fingerprint <recipe-inputs-json>');
        let inputs;
        try {
            inputs = JSON.parse(readFileSync(resolve(args[0]), 'utf8'));
        } catch {
            throw new Error('Official Codex recipe inputs are missing or invalid JSON');
        }
        const fingerprint = recipeFingerprint(inputs);
        writeOutputs({
            recipe_fingerprint: fingerprint,
            artifact_name: artifactNameForFingerprint(fingerprint),
        });
        return;
    }
    if (command === 'find') {
        if (args.length !== 1) throw new Error('Usage: find <recipe-fingerprint>');
        findReusableArtifact(args[0]);
        return;
    }
    if (command === 'resolve') {
        if (args.length !== 2) throw new Error('Usage: resolve <ci-run-id> <happy-source-sha>');
        resolveReusableArtifact(args[0], args[1]);
        return;
    }
    if (command === 'download') {
        if (args.length !== 3) throw new Error('Usage: download <artifact-id> <artifact-digest> <destination>');
        downloadArtifactArchive(args[0], args[1], args[2]);
        return;
    }
    if (command === 'verify') {
        if (args.length < 2 || args.length > 5) {
            throw new Error(
                'Usage: verify <artifact-root> <happy-source-sha> [codex-source-sha] [recipe-fingerprint] [run-id]',
            );
        }
        const manifest = verifyExtractedArtifact(args[0], {
            happySourceSha: args[1],
            codexCommit: args[2] ?? '',
            recipeFingerprint: args[3] ?? '',
            attestationRunId: args[4] ?? '',
        });
        writeEnvironment({
            HAPPY_SCENARIO_CODEX_VERSION: manifest.version,
            HAPPY_SCENARIO_CODEX_COMMIT: manifest.commit,
        });
        writeOutputs(verificationOutputs(manifest));
        return;
    }
    if (command === 'attest') {
        if (args.length < 3 || args.length > 5) {
            throw new Error(
                'Usage: attest <artifact-root> <new-happy-source-sha> <new-run-id> [codex-source-sha] [recipe-fingerprint]',
            );
        }
        const manifest = attestArtifact(args[0], args[1], args[2], {
            codexCommit: args[3] ?? '',
            recipeFingerprint: args[4] ?? '',
        });
        writeOutputs(verificationOutputs(manifest));
        return;
    }
    throw new Error('Expected fingerprint, find, resolve, download, verify, or attest command');
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    artifactBinaryPaths,
    artifactCargoLockPaths,
    artifactNameForFingerprint,
    artifactRunCandidates,
    assertCiRunIdentity,
    assertRecipeInputs,
    assertSourceManifest,
    assertSuccessfulCiGate,
    attestArtifact,
    canonicalJson,
    collectPaginatedCollection,
    downloadArtifactArchive,
    parseArtifactDigest,
    parseArtifactName,
    recipeFingerprint,
    selectReusableArtifact,
    selectUnexpiredArtifact,
    verifyArchiveDigest,
    verifyExtractedArtifact,
};
