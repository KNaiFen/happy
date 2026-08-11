#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
    appendFileSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

const {
    canonicalJson,
    collectPaginatedCollection,
    parseArtifactDigest,
    verifyArchiveDigest,
} = require('./official-codex-artifact-reuse.cjs');

const manifestSchemaVersion = 1;
const artifactKind = 'codex-android-field-apk';
const artifactNamePrefix = 'codex-android-field-apk-v1';
const manifestFileName = 'field-apk-manifest.json';
const apkFileName = 'app-release.apk';
const fieldWorkflowName = 'Codex Android field E2E';
const fieldWorkflowPath = '.github/workflows/codex-android-field-e2e.yml';
const fieldApkJobName = 'Build or reuse Android Field APK';
const acceptedFieldEvents = new Set(['workflow_run', 'schedule', 'workflow_dispatch']);
const maximumArchiveBytes = 192 * 1024 * 1024;
const maximumApkBytes = 160 * 1024 * 1024;
const maximumManifestBytes = 64 * 1024;
const maximumApiBytes = 1024 * 1024;

const recipeSourcePaths = Object.freeze([
    '.github/workflows/codex-android-field-e2e.yml',
    '.npmrc',
    'package.json',
    'packages/happy-app',
    'packages/happy-wire',
    'patches',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/ci/android-field-apk-reuse.cjs',
    'scripts/ci/android_field_apk_archive.py',
    'scripts/ci/build-android-field-apk.sh',
    'scripts/ci/verify-android-field-apk.sh',
    'scripts/postinstall.cjs',
]);

const fieldBuildRecipe = Object.freeze({
    schemaVersion: 1,
    runner: 'ubuntu-latest',
    nodeVersion: '22',
    pnpmVersion: '10.11.0',
    javaDistribution: 'temurin',
    javaVersion: '17',
    androidPlatform: '36',
    androidBuildTools: '36.0.0',
    androidNdk: '27.1.12297006',
    cmakeVersion: '3.22.1',
    applicationId: 'com.slopus.happy.dev',
    architecture: 'x86_64',
    newArchitecture: true,
    appEnvironment: 'development',
    nodeEnvironment: 'production',
    otaDisabled: true,
    bootstrapUrl: 'http://127.0.0.1:53587/credentials',
    serverUrl: 'http://127.0.0.1:53586',
    allowInsecureHttp: true,
    gradleTask: 'assembleRelease',
    gradleMaxWorkers: 2,
    artifactLayout: [manifestFileName, apkFileName],
    archiveMaxBytes: maximumArchiveBytes,
    apkMaxBytes: maximumApkBytes,
    manifestMaxBytes: maximumManifestBytes,
    dynamicBuildMetadata: ['compiledHappySourceSha', 'compiledCommitTimestamp'],
});

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

function assertMatchingString(value, pattern, label) {
    if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
    return value;
}

function assertGitSha(value, label = 'Happy source SHA') {
    return assertMatchingString(value, /^[0-9a-f]{40}$/, label);
}

function assertSha256(value, label = 'App fingerprint') {
    return assertMatchingString(value, /^[0-9a-f]{64}$/, label);
}

function assertRepository(value) {
    return assertMatchingString(value, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'GitHub repository');
}

function assertPositiveInteger(value, label) {
    const normalized = typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
        ? Number(value)
        : value;
    if (!Number.isSafeInteger(normalized) || normalized <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return normalized;
}

function assertTimestamp(value, label) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
        throw new Error(`${label} is invalid`);
    }
    return value;
}

function assertBoundedSize(value, maximum, label) {
    const size = assertPositiveInteger(value, label);
    if (size > maximum) throw new Error(`${label} exceeds its size limit`);
    return size;
}

function artifactNameForFingerprint(fingerprint) {
    return `${artifactNamePrefix}-${assertSha256(fingerprint)}`;
}

function parseTreeEntries(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new Error('App fingerprint Git tree must be a buffer');
    const entries = buffer.toString('utf8').split('\0').filter(Boolean).map((line) => {
        const match = /^([0-7]{6}) ([0-9a-f]{40,64}) 0\t([^\0]+)$/.exec(line);
        if (!match) throw new Error('App fingerprint Git tree entry is malformed');
        return { mode: match[1], object: match[2], path: match[3] };
    });
    if (entries.length === 0) throw new Error('App fingerprint Git tree is empty');
    const paths = entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) throw new Error('App fingerprint Git tree has duplicate paths');
    return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function fingerprintFromEntries(entries) {
    const sortedEntries = [...entries].sort((left, right) => (
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ));
    const input = {
        fingerprintSchema: 1,
        manifestSchema: manifestSchemaVersion,
        sourcePaths: recipeSourcePaths,
        sourceEntries: sortedEntries,
        buildRecipe: fieldBuildRecipe,
    };
    return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function appFingerprint() {
    const result = spawnSync(
        'git',
        ['ls-files', '--stage', '-z', '--', ...recipeSourcePaths],
        { encoding: null, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
        throw new Error('App fingerprint Git tree could not be read');
    }
    const entries = parseTreeEntries(result.stdout);
    for (const path of recipeSourcePaths.filter((entry) => !['packages/happy-app', 'packages/happy-wire', 'patches'].includes(entry))) {
        if (!entries.some((entry) => entry.path === path)) {
            throw new Error(`App fingerprint input is missing: ${path}`);
        }
    }
    return fingerprintFromEntries(entries);
}

function sha256File(path) {
    const result = spawnSync('sha256sum', ['--', path], {
        encoding: 'utf8',
        maxBuffer: 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) throw new Error('APK SHA-256 could not be computed');
    const match = /^([0-9a-f]{64})\s/.exec(result.stdout);
    if (!match) throw new Error('APK SHA-256 output is malformed');
    return match[1];
}

function gitCommitTimestamp(commitSha) {
    const sha = assertGitSha(commitSha, 'Compiled Happy source SHA');
    const result = spawnSync('git', ['show', '-s', '--format=%cI', sha], {
        encoding: 'utf8',
        maxBuffer: 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) throw new Error('Compiled Happy commit timestamp could not be read');
    return assertTimestamp(result.stdout.trim(), 'Compiled Happy commit timestamp');
}

function createManifest({
    apkPath,
    appFingerprint: fingerprint,
    repository,
    compiledHappySourceSha,
    compiledCommitTimestamp,
    producerRunId,
    producerRunAttempt,
    event,
}) {
    if (!acceptedFieldEvents.has(event)) throw new Error('Field APK event is not trusted');
    const apk = lstatSync(apkPath);
    if (!apk.isFile() || apk.isSymbolicLink()) throw new Error('Field APK must be a regular file');
    return {
        schemaVersion: manifestSchemaVersion,
        artifactKind,
        repository: assertRepository(repository),
        workflow: fieldWorkflowPath,
        appFingerprint: assertSha256(fingerprint),
        compiledHappySourceSha: assertGitSha(compiledHappySourceSha, 'Compiled Happy source SHA'),
        compiledCommitTimestamp: assertTimestamp(compiledCommitTimestamp, 'Compiled Happy commit timestamp'),
        producerRunId: assertPositiveInteger(producerRunId, 'Producer run id'),
        producerRunAttempt: assertPositiveInteger(producerRunAttempt, 'Producer run attempt'),
        event,
        buildRecipe: fieldBuildRecipe,
        apk: {
            fileName: apkFileName,
            sizeBytes: assertBoundedSize(apk.size, maximumApkBytes, 'Field APK size'),
            sha256: sha256File(apkPath),
        },
    };
}

function assertManifest(manifest, expectations) {
    assertExactKeys(manifest, [
        'schemaVersion',
        'artifactKind',
        'repository',
        'workflow',
        'appFingerprint',
        'compiledHappySourceSha',
        'compiledCommitTimestamp',
        'producerRunId',
        'producerRunAttempt',
        'event',
        'buildRecipe',
        'apk',
    ], 'Field APK manifest');
    if (manifest.schemaVersion !== manifestSchemaVersion || manifest.artifactKind !== artifactKind) {
        throw new Error('Field APK manifest schema is unsupported');
    }
    if (manifest.workflow !== fieldWorkflowPath) throw new Error('Field APK manifest workflow is invalid');
    if (canonicalJson(manifest.buildRecipe) !== canonicalJson(fieldBuildRecipe)) {
        throw new Error('Field APK build recipe does not match');
    }
    assertExactKeys(manifest.apk, ['fileName', 'sizeBytes', 'sha256'], 'Field APK manifest payload');
    if (manifest.apk.fileName !== apkFileName) throw new Error('Field APK manifest filename is invalid');
    assertBoundedSize(manifest.apk.sizeBytes, maximumApkBytes, 'Field APK size');
    assertSha256(manifest.apk.sha256, 'Field APK digest');

    const normalized = {
        repository: assertRepository(manifest.repository),
        appFingerprint: assertSha256(manifest.appFingerprint),
        compiledHappySourceSha: assertGitSha(manifest.compiledHappySourceSha, 'Compiled Happy source SHA'),
        compiledCommitTimestamp: assertTimestamp(
            manifest.compiledCommitTimestamp,
            'Compiled Happy commit timestamp',
        ),
        producerRunId: assertPositiveInteger(manifest.producerRunId, 'Producer run id'),
        producerRunAttempt: assertPositiveInteger(manifest.producerRunAttempt, 'Producer run attempt'),
        event: manifest.event,
    };
    if (!acceptedFieldEvents.has(normalized.event)) throw new Error('Field APK manifest event is not trusted');
    for (const [key, expected] of Object.entries(expectations)) {
        if (expected !== undefined && normalized[key] !== expected) {
            throw new Error(`Field APK manifest ${key} does not match`);
        }
    }
    return manifest;
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

function ghApiJson(path, label) {
    const result = spawnSync('gh', ['api', '--method', 'GET', path], {
        encoding: 'utf8',
        maxBuffer: maximumApiBytes,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) throw new Error(`GitHub Actions API request failed for ${label}`);
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new Error(`GitHub Actions API returned invalid JSON for ${label}`);
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

function workflowIdentity(repository) {
    const workflow = ghApiJson(
        `repos/${repository}/actions/workflows/${encodeURIComponent(fieldWorkflowPath)}`,
        'Field workflow',
    );
    return assertPositiveInteger(workflow.id, 'Field workflow id');
}

function assertFieldRunIdentity({ run, expectedWorkflowId, repository }) {
    if (!isPlainObject(run)) throw new Error('Field APK workflow run is malformed');
    const runId = assertPositiveInteger(run.id, 'Field APK run id');
    const runAttempt = assertPositiveInteger(run.run_attempt, 'Field APK run attempt');
    if (assertPositiveInteger(run.workflow_id, 'Field workflow id') !== expectedWorkflowId
        || run.name !== fieldWorkflowName
        || run.path !== fieldWorkflowPath) {
        throw new Error('Field APK came from the wrong workflow');
    }
    if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) {
        throw new Error('Field APK came from the wrong repository');
    }
    if (!acceptedFieldEvents.has(run.event)) throw new Error('Field APK came from an unsupported event');
    if (run.head_branch !== 'main') throw new Error('Field APK producer did not run on main');
    const headSha = assertGitSha(run.head_sha, 'Field APK producer SHA');
    if (runAttempt !== 1) throw new Error('Field APK must come from the first run attempt');
    if (!['in_progress', 'completed'].includes(run.status)) {
        throw new Error('Field APK producer run has not started');
    }
    return { runId, runAttempt, headSha, event: run.event };
}

function assertSuccessfulFieldApkJob(jobs) {
    if (!Array.isArray(jobs)) throw new Error('Field APK workflow jobs are malformed');
    const matches = jobs.filter((job) => job?.name === fieldApkJobName);
    if (matches.length !== 1) throw new Error('Field workflow must contain exactly one APK producer job');
    if (matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
        throw new Error('Field APK producer job did not succeed');
    }
}

function artifactRunCandidates(artifacts, expectedArtifactName) {
    if (!Array.isArray(artifacts)) throw new Error('Repository artifacts response is malformed');
    const candidates = [];
    for (const artifact of artifacts) {
        try {
            if (!artifact || artifact.name !== expectedArtifactName || artifact.expired !== false) continue;
            candidates.push({
                artifactId: assertPositiveInteger(artifact.id, 'Field APK artifact id'),
                runId: assertPositiveInteger(artifact.workflow_run?.id, 'Field APK run id'),
                createdAt: assertTimestamp(artifact.created_at, 'Field APK creation time'),
            });
        } catch {
            // Malformed repository candidates are never reusable.
        }
    }
    candidates.sort((left, right) => (
        Date.parse(right.createdAt) - Date.parse(left.createdAt)
        || right.artifactId - left.artifactId
    ));
    const seenRuns = new Set();
    return candidates.filter((candidate) => {
        if (seenRuns.has(candidate.runId)) return false;
        seenRuns.add(candidate.runId);
        return true;
    });
}

function selectTrustedArtifact({
    run,
    jobs,
    artifacts,
    expectedWorkflowId,
    repository,
    appFingerprint: fingerprint,
    candidateArtifactId,
    expectedArtifactDigest,
}) {
    const identity = assertFieldRunIdentity({ run, expectedWorkflowId, repository });
    assertSuccessfulFieldApkJob(jobs);
    const artifactName = artifactNameForFingerprint(fingerprint);
    const matches = artifacts.filter((artifact) => artifact?.name === artifactName);
    if (matches.length !== 1) throw new Error('Field workflow must contain exactly one matching APK artifact');
    const artifact = matches[0];
    const artifactId = assertPositiveInteger(artifact.id, 'Field APK artifact id');
    if (artifactId !== candidateArtifactId) throw new Error('Field APK artifact id changed during validation');
    if (artifact.expired !== false) throw new Error('Field APK artifact is expired');
    const artifactDigest = parseArtifactDigest(artifact.digest);
    if (expectedArtifactDigest && artifactDigest !== parseArtifactDigest(expectedArtifactDigest)) {
        throw new Error('Field APK artifact digest changed during validation');
    }
    const sizeBytes = assertBoundedSize(artifact.size_in_bytes, maximumArchiveBytes, 'Field APK archive size');
    if (assertPositiveInteger(artifact.workflow_run?.id, 'Field APK workflow run id') !== identity.runId
        || artifact.workflow_run?.head_sha !== identity.headSha) {
        throw new Error('Field APK artifact is not bound to its workflow run');
    }
    return {
        ...identity,
        artifactId,
        artifactDigest,
        artifactName,
        sizeBytes,
    };
}

function downloadArchive(repository, artifact) {
    const result = spawnSync(
        'gh',
        ['api', '--method', 'GET', `repos/${repository}/actions/artifacts/${artifact.artifactId}/zip`],
        {
            encoding: null,
            maxBuffer: maximumArchiveBytes + 1,
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
        throw new Error('Field APK artifact download failed');
    }
    if (result.stdout.length !== artifact.sizeBytes) {
        throw new Error('Field APK archive size does not match Actions API metadata');
    }
    return result.stdout;
}

function verifyExtractedArtifact(root, expectations) {
    const artifactRoot = resolve(root);
    const entries = readdirSync(artifactRoot).sort();
    if (JSON.stringify(entries) !== JSON.stringify([apkFileName, manifestFileName].sort())) {
        throw new Error('Extracted Field APK artifact layout is invalid');
    }
    const manifestPath = join(artifactRoot, manifestFileName);
    const apkPath = join(artifactRoot, apkFileName);
    for (const path of [manifestPath, apkPath]) {
        const details = lstatSync(path);
        if (!details.isFile() || details.isSymbolicLink()) {
            throw new Error('Extracted Field APK artifact contains a non-regular file');
        }
    }
    if (statSync(manifestPath).size > maximumManifestBytes) throw new Error('Field APK manifest is too large');
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
        throw new Error('Field APK manifest is invalid JSON');
    }
    assertManifest(manifest, expectations);
    const apkSize = statSync(apkPath).size;
    if (apkSize !== manifest.apk.sizeBytes) throw new Error('Field APK size does not match its manifest');
    if (sha256File(apkPath) !== manifest.apk.sha256) throw new Error('Field APK digest does not match its manifest');
    return { manifest, apkPath };
}

function extractAndVerifyArchive(repository, artifact, destination, fingerprint) {
    const archive = downloadArchive(repository, artifact);
    const root = mkdtempSync(join(tmpdir(), 'happy-field-apk-download-'));
    const archivePath = join(root, 'artifact.zip');
    try {
        writeFileSync(archivePath, archive, { encoding: 'binary', flag: 'wx', mode: 0o600 });
        verifyArchiveDigest(archivePath, artifact.artifactDigest);
        const extraction = spawnSync(
            'python3',
            [join(__dirname, 'android_field_apk_archive.py'), 'extract', archivePath, resolve(destination)],
            { encoding: 'utf8', maxBuffer: maximumApiBytes, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        if (extraction.error || extraction.status !== 0) {
            throw new Error(`Field APK archive extraction failed: ${extraction.stderr.trim()}`);
        }
        return verifyExtractedArtifact(destination, {
            repository,
            appFingerprint: fingerprint,
            compiledHappySourceSha: artifact.headSha,
            producerRunId: artifact.runId,
            producerRunAttempt: artifact.runAttempt,
            event: artifact.event,
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function fetchTrustedArtifact(repository, expectedWorkflowId, fingerprint, artifactId, expectedDigest) {
    const metadata = ghApiJson(
        `repos/${repository}/actions/artifacts/${artifactId}`,
        'Field APK artifact metadata',
    );
    if (assertPositiveInteger(metadata.id, 'Field APK artifact id') !== artifactId) {
        throw new Error('Field APK artifact metadata id does not match');
    }
    const runId = assertPositiveInteger(metadata.workflow_run?.id, 'Field APK workflow run id');
    const run = ghApiJson(`repos/${repository}/actions/runs/${runId}`, 'Field APK producer run');
    const jobs = ghApiCollection(
        `repos/${repository}/actions/runs/${runId}/jobs?filter=latest`,
        'jobs',
        'Field APK producer jobs',
    );
    const artifacts = ghApiCollection(
        `repos/${repository}/actions/runs/${runId}/artifacts`,
        'artifacts',
        'Field APK producer artifacts',
    );
    const selected = selectTrustedArtifact({
        run,
        jobs,
        artifacts,
        expectedWorkflowId,
        repository,
        appFingerprint: fingerprint,
        candidateArtifactId: artifactId,
        expectedArtifactDigest: expectedDigest,
    });
    if (metadata.name !== selected.artifactName
        || metadata.expired !== false
        || metadata.size_in_bytes !== selected.sizeBytes
        || parseArtifactDigest(metadata.digest) !== selected.artifactDigest
        || assertPositiveInteger(metadata.workflow_run?.id, 'Field APK metadata run id') !== selected.runId
        || metadata.workflow_run?.head_sha !== selected.headSha) {
        throw new Error('Field APK artifact metadata changed during validation');
    }
    return selected;
}

function findReusableArtifact(fingerprint, currentRunIdValue) {
    const repository = assertRepository(process.env.GITHUB_REPOSITORY);
    const normalizedFingerprint = assertSha256(fingerprint);
    const currentRunId = assertPositiveInteger(currentRunIdValue, 'Current Field run id');
    const artifactName = artifactNameForFingerprint(normalizedFingerprint);
    let expectedWorkflowId;
    let listedArtifacts;
    try {
        expectedWorkflowId = workflowIdentity(repository);
        listedArtifacts = ghApiCollection(
            `repos/${repository}/actions/artifacts?name=${encodeURIComponent(artifactName)}`,
            'artifacts',
            'Field APK artifacts',
        );
    } catch (error) {
        process.stderr.write(`${error.message}; building APK because reuse is unproven\n`);
        writeOutputs({ selected: false, reason: 'reuse-api-unavailable', artifact_name: artifactName });
        return;
    }

    for (const candidate of artifactRunCandidates(listedArtifacts, artifactName)) {
        if (candidate.runId === currentRunId) continue;
        const verificationRoot = mkdtempSync(join(tmpdir(), 'happy-field-apk-candidate-'));
        const destination = join(verificationRoot, 'verified');
        try {
            const artifact = fetchTrustedArtifact(
                repository,
                expectedWorkflowId,
                normalizedFingerprint,
                candidate.artifactId,
            );
            extractAndVerifyArchive(repository, artifact, destination, normalizedFingerprint);
            writeOutputs({
                selected: true,
                reason: 'trusted-app-fingerprint',
                artifact_id: artifact.artifactId,
                artifact_digest: `sha256:${artifact.artifactDigest}`,
                artifact_name: artifact.artifactName,
                producer_run_id: artifact.runId,
                compiled_happy_source_sha: artifact.headSha,
            });
            return;
        } catch (error) {
            process.stderr.write(`Skipping invalid Field APK run ${candidate.runId}: ${error.message}\n`);
        } finally {
            rmSync(verificationRoot, { recursive: true, force: true });
        }
    }
    writeOutputs({ selected: false, reason: 'no-trusted-app-fingerprint', artifact_name: artifactName });
}

function writeManifestFile(apkPath, destination, fingerprint, compiledHappySourceSha) {
    const computedFingerprint = appFingerprint();
    if (computedFingerprint !== assertSha256(fingerprint)) {
        throw new Error('Field APK fingerprint does not match the checked-out source');
    }
    const manifest = createManifest({
        apkPath: resolve(apkPath),
        appFingerprint: computedFingerprint,
        repository: process.env.GITHUB_REPOSITORY,
        compiledHappySourceSha,
        compiledCommitTimestamp: gitCommitTimestamp(compiledHappySourceSha),
        producerRunId: process.env.GITHUB_RUN_ID,
        producerRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
        event: process.env.GITHUB_EVENT_NAME,
    });
    const manifestPath = resolve(destination);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
    });
    writeOutputs({
        artifact_name: artifactNameForFingerprint(computedFingerprint),
        apk_sha256: manifest.apk.sha256,
        apk_size_bytes: manifest.apk.sizeBytes,
    });
}

function downloadVerifiedArtifact(artifactIdValue, artifactDigest, fingerprint, destination) {
    const repository = assertRepository(process.env.GITHUB_REPOSITORY);
    const artifactId = assertPositiveInteger(artifactIdValue, 'Field APK artifact id');
    const normalizedFingerprint = assertSha256(fingerprint);
    const expectedWorkflowId = workflowIdentity(repository);
    const artifact = fetchTrustedArtifact(
        repository,
        expectedWorkflowId,
        normalizedFingerprint,
        artifactId,
        artifactDigest,
    );
    const verified = extractAndVerifyArchive(repository, artifact, destination, normalizedFingerprint);
    writeEnvironment({ HAPPY_FIELD_APK_PATH: verified.apkPath });
    writeOutputs({
        apk_path: verified.apkPath,
        compiled_happy_source_sha: verified.manifest.compiledHappySourceSha,
        compiled_commit_timestamp: verified.manifest.compiledCommitTimestamp,
        producer_run_id: verified.manifest.producerRunId,
    });
}

function main() {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'fingerprint') {
        if (args.length !== 0) throw new Error('Usage: fingerprint');
        const fingerprint = appFingerprint();
        writeOutputs({
            app_fingerprint: fingerprint,
            artifact_name: artifactNameForFingerprint(fingerprint),
        });
        return;
    }
    if (command === 'find') {
        if (args.length !== 2) throw new Error('Usage: find <app-fingerprint> <current-run-id>');
        findReusableArtifact(...args);
        return;
    }
    if (command === 'write') {
        if (args.length !== 4) {
            throw new Error('Usage: write <apk> <manifest-destination> <app-fingerprint> <compiled-happy-source-sha>');
        }
        writeManifestFile(...args);
        return;
    }
    if (command === 'download') {
        if (args.length !== 4) {
            throw new Error('Usage: download <artifact-id> <artifact-digest> <app-fingerprint> <destination>');
        }
        downloadVerifiedArtifact(...args);
        return;
    }
    throw new Error('Expected fingerprint, find, write, or download command');
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
    apkFileName,
    appFingerprint,
    artifactNameForFingerprint,
    artifactRunCandidates,
    assertFieldRunIdentity,
    assertManifest,
    createManifest,
    fieldApkJobName,
    fieldBuildRecipe,
    fingerprintFromEntries,
    manifestFileName,
    maximumApkBytes,
    maximumArchiveBytes,
    parseTreeEntries,
    recipeSourcePaths,
    selectTrustedArtifact,
    verifyExtractedArtifact,
};
