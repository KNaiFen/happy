#!/usr/bin/env node

const {
    appendFileSync,
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    statSync,
    unlinkSync,
} = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const artifactName = 'official-codex-linux-x64';
const ciGateName = 'Required CI gate';
const sha256Pattern = /^[0-9a-f]{64}$/;
const gitShaPattern = /^[0-9a-f]{40}$/;
const artifactDigestPattern = /^(?:sha256:)?([0-9a-f]{64})$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const artifactBinaryPaths = {
    codex: 'bin/codex',
    codexCodeModeHost: 'bin/codex-code-mode-host',
    bwrap: 'bin/codex-resources/bwrap',
};

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

function selectUnexpiredArtifact(artifacts) {
    if (!Array.isArray(artifacts)) throw new Error('CI artifacts response is malformed');
    const matches = artifacts.filter((artifact) => artifact && artifact.name === artifactName);
    if (matches.length === 0) return null;
    if (matches.length !== 1) {
        throw new Error(`Expected exactly one ${artifactName} artifact`);
    }

    const artifact = matches[0];
    if (artifact.expired !== false) {
        throw new Error(`${artifactName} artifact is expired or has no expiration state`);
    }
    return {
        artifactId: String(assertPositiveInteger(artifact.id, 'Artifact id')),
        artifactDigest: `sha256:${parseArtifactDigest(artifact.digest)}`,
    };
}

function selectReusableArtifact({ run, jobs, artifacts, expectedHeadSha }) {
    const headSha = assertGitSha(expectedHeadSha, 'Expected Happy source SHA');
    if (!run || typeof run !== 'object') throw new Error('CI workflow run response is malformed');
    assertPositiveInteger(run.id, 'CI workflow run id');
    if (run.event !== 'push' || run.head_branch !== 'main') {
        throw new Error('Reusable artifact must come from a push run on main');
    }
    if (run.head_sha !== headSha) {
        throw new Error('CI workflow run Happy source SHA does not match the requested SHA');
    }
    if (run.status !== 'completed') {
        throw new Error('CI workflow run is not complete');
    }
    if (run.conclusion !== 'success') {
        return {
            selected: false,
            reason: 'upstream-ci-not-success',
        };
    }

    assertSuccessfulCiGate(jobs);
    const artifact = selectUnexpiredArtifact(artifacts);
    if (!artifact) {
        return {
            selected: false,
            reason: 'official-codex-not-selected',
        };
    }
    return {
        selected: true,
        reason: 'selected',
        sourceRunId: String(run.id),
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

function assertSourceManifest(manifest, { happySourceSha, codexCommit = '' }) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('Official Codex source manifest is not an object');
    }
    if (manifest.schemaVersion !== 4 || manifest.runtimeBundleVersion !== 2) {
        throw new Error('Official Codex source manifest schema is unsupported');
    }
    if (manifest.repository !== 'https://github.com/openai/codex') {
        throw new Error('Official Codex source manifest repository is unexpected');
    }
    assertGitSha(manifest.happySourceSha, 'Manifest Happy source SHA');
    assertGitSha(manifest.commit, 'Manifest Codex source SHA');
    if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
        throw new Error('Manifest Codex version is invalid');
    }
    if (manifest.tag !== `rust-v${manifest.version}`) {
        throw new Error('Manifest Codex release tag does not match its version');
    }
    if (manifest.happySourceSha !== assertGitSha(happySourceSha, 'Expected Happy source SHA')) {
        throw new Error('Official Codex artifact Happy source SHA does not match the checkout');
    }
    if (codexCommit && manifest.commit !== assertGitSha(codexCommit, 'Expected Codex source SHA')) {
        throw new Error('Official Codex artifact Codex source SHA does not match the workflow output');
    }
    if (!manifest.binarySha256 || typeof manifest.binarySha256 !== 'object' || Array.isArray(manifest.binarySha256)) {
        throw new Error('Official Codex source manifest binary digests are missing');
    }
    const keys = Object.keys(manifest.binarySha256).sort();
    const expectedKeys = Object.keys(artifactBinaryPaths).sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
        throw new Error('Official Codex source manifest binary digest keys are unexpected');
    }
    for (const key of expectedKeys) {
        assertSha256(manifest.binarySha256[key], `Manifest ${key} SHA-256`);
    }
    return manifest;
}

function verifyExtractedArtifact(root, expected) {
    const artifactRoot = resolve(root);
    const manifestPath = `${artifactRoot}/source.json`;
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
        throw new Error('Official Codex source manifest is missing or invalid JSON');
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
        const actualDigest = sha256File(path);
        if (actualDigest !== manifest.binarySha256[key]) {
            throw new Error(`Official Codex artifact ${relativePath} SHA-256 does not match source.json`);
        }
    }
    return manifest;
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

function resolveReusableArtifact(runIdValue, expectedHeadSha) {
    const repository = assertRepository(process.env.GITHUB_REPOSITORY);
    const runId = assertPositiveInteger(runIdValue, 'CI workflow run id');
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
    });
    if (decision.selected) {
        writeOutputs({
            selected: true,
            reason: decision.reason,
            source_run_id: decision.sourceRunId,
            head_sha: decision.headSha,
            artifact_id: decision.artifactId,
            artifact_digest: decision.artifactDigest,
        });
    } else {
        writeOutputs({
            selected: false,
            reason: decision.reason,
        });
    }
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

function main() {
    const [command, ...args] = process.argv.slice(2);
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
        if (args.length < 2 || args.length > 3) {
            throw new Error('Usage: verify <artifact-root> <happy-source-sha> [codex-source-sha]');
        }
        const manifest = verifyExtractedArtifact(args[0], {
            happySourceSha: args[1],
            codexCommit: args[2] ?? '',
        });
        writeEnvironment({
            HAPPY_SCENARIO_CODEX_VERSION: manifest.version,
            HAPPY_SCENARIO_CODEX_COMMIT: manifest.commit,
        });
        return;
    }
    throw new Error('Expected resolve, download, or verify command');
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
    artifactName,
    assertSourceManifest,
    assertSuccessfulCiGate,
    collectPaginatedCollection,
    downloadArtifactArchive,
    parseArtifactDigest,
    selectReusableArtifact,
    selectUnexpiredArtifact,
    verifyArchiveDigest,
    verifyExtractedArtifact,
};
