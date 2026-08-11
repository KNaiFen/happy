#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const {
    appendFileSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

const {
    collectPaginatedCollection,
    parseArtifactDigest,
    verifyArchiveDigest,
} = require('./official-codex-artifact-reuse.cjs');

const receiptSchemaVersion = 1;
const receiptKind = 'codex-android-field-success';
const receiptFileName = 'receipt.json';
const receiptArtifactPrefix = 'codex-android-field-success-v1';
const fieldWorkflowName = 'Codex Android field E2E';
const fieldWorkflowPath = '.github/workflows/codex-android-field-e2e.yml';
const fieldJobName = 'API 36 App to official Codex field round trip';
const acceptedFieldEvents = new Set(['workflow_run', 'schedule', 'workflow_dispatch']);
const maximumReceiptBytes = 64 * 1024;

function assertReceiptArchiveSize(value, label = 'Field success receipt archive size') {
    const sizeBytes = assertPositiveInteger(value, label);
    if (sizeBytes > maximumReceiptBytes) throw new Error('Field success receipt is too large');
    return sizeBytes;
}

function assertMatchingString(value, pattern, label) {
    if (typeof value !== 'string' || !pattern.test(value)) {
        throw new Error(`${label} is invalid`);
    }
    return value;
}

function assertGitSha(value, label = 'Happy source SHA') {
    return assertMatchingString(value, /^[0-9a-f]{40}$/, label);
}

function assertRecipeFingerprint(value) {
    return assertMatchingString(value, /^[0-9a-f]{64}$/, 'Official Codex recipe fingerprint');
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

function assertExactKeys(value, expectedKeys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label} keys are unexpected`);
    }
}

function receiptArtifactName(happySourceSha, recipeFingerprint) {
    return `${receiptArtifactPrefix}-${assertGitSha(happySourceSha)}-${assertRecipeFingerprint(recipeFingerprint)}`;
}

function createReceipt({
    repository,
    happySourceSha,
    recipeFingerprint,
    fieldRunId,
    fieldRunAttempt,
    sourceAttestationRunId,
    event,
}) {
    if (!acceptedFieldEvents.has(event)) throw new Error('Field event is not trusted');
    return {
        schemaVersion: receiptSchemaVersion,
        artifactKind: receiptKind,
        repository: assertRepository(repository),
        workflow: fieldWorkflowPath,
        happySourceSha: assertGitSha(happySourceSha),
        recipeFingerprint: assertRecipeFingerprint(recipeFingerprint),
        fieldRunId: assertPositiveInteger(fieldRunId, 'Field run id'),
        fieldRunAttempt: assertPositiveInteger(fieldRunAttempt, 'Field run attempt'),
        sourceAttestationRunId: assertPositiveInteger(sourceAttestationRunId, 'Source attestation run id'),
        event,
    };
}

function assertReceipt(receipt, {
    repository,
    happySourceSha,
    recipeFingerprint,
    fieldRunId,
    fieldRunAttempt,
    event,
}) {
    const expectedKeys = [
        'schemaVersion',
        'artifactKind',
        'repository',
        'workflow',
        'happySourceSha',
        'recipeFingerprint',
        'fieldRunId',
        'fieldRunAttempt',
        'sourceAttestationRunId',
        'event',
    ];
    assertExactKeys(receipt, expectedKeys, 'Field success receipt');
    if (receipt.schemaVersion !== receiptSchemaVersion) throw new Error('Field success receipt schema is unsupported');
    if (receipt.artifactKind !== receiptKind) throw new Error('Field success receipt kind is invalid');
    if (receipt.workflow !== fieldWorkflowPath) throw new Error('Field success receipt workflow is invalid');
    const normalized = createReceipt(receipt);
    if (normalized.repository !== repository) throw new Error('Field success receipt repository does not match');
    if (normalized.happySourceSha !== happySourceSha) throw new Error('Field success receipt SHA does not match');
    if (normalized.recipeFingerprint !== recipeFingerprint) {
        throw new Error('Field success receipt recipe does not match');
    }
    if (normalized.fieldRunId !== fieldRunId || normalized.fieldRunAttempt !== fieldRunAttempt) {
        throw new Error('Field success receipt run does not match');
    }
    if (normalized.event !== event) throw new Error('Field success receipt event does not match');
    return normalized;
}

function assertFieldRunIdentity({ run, expectedWorkflowId, repository, happySourceSha }) {
    if (!run || typeof run !== 'object') throw new Error('Field workflow run is malformed');
    const runId = assertPositiveInteger(run.id, 'Field run id');
    const runAttempt = assertPositiveInteger(run.run_attempt, 'Field run attempt');
    if (assertPositiveInteger(run.workflow_id, 'Field workflow id') !== expectedWorkflowId
        || run.name !== fieldWorkflowName
        || run.path !== fieldWorkflowPath) {
        throw new Error('Field receipt came from the wrong workflow');
    }
    if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) {
        throw new Error('Field receipt came from the wrong repository');
    }
    if (!acceptedFieldEvents.has(run.event)) throw new Error('Field receipt came from an unsupported event');
    if (run.head_branch !== 'main') throw new Error('Field receipt did not run on main');
    if (assertGitSha(run.head_sha, 'Field run SHA') !== happySourceSha) {
        throw new Error('Field receipt run SHA does not match');
    }
    if (run.status !== 'completed' || run.conclusion !== 'success') {
        throw new Error('Field receipt workflow did not succeed');
    }
    if (runAttempt !== 1) {
        throw new Error('Field receipt must come from the first run attempt');
    }
    return { runId, runAttempt };
}

function assertSuccessfulFieldJob(jobs) {
    if (!Array.isArray(jobs)) throw new Error('Field workflow jobs are malformed');
    const matches = jobs.filter((job) => job?.name === fieldJobName);
    if (matches.length !== 1) throw new Error('Field workflow must contain exactly one field job');
    if (matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
        throw new Error('Field workflow job did not succeed');
    }
}

function receiptRunCandidates(artifacts, expectedArtifactName) {
    if (!Array.isArray(artifacts)) throw new Error('Repository artifacts response is malformed');
    const candidates = [];
    for (const artifact of artifacts) {
        try {
            if (!artifact || artifact.name !== expectedArtifactName || artifact.expired !== false) continue;
            candidates.push({
                artifactId: assertPositiveInteger(artifact.id, 'Field receipt artifact id'),
                runId: assertPositiveInteger(artifact.workflow_run?.id, 'Field receipt workflow run id'),
                createdAt: assertTimestamp(artifact.created_at, 'Field receipt creation time'),
            });
        } catch {
            // Malformed repository-level candidates cannot suppress a real Field run.
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

function selectTrustedReceipt({
    run,
    jobs,
    artifacts,
    expectedWorkflowId,
    repository,
    happySourceSha,
    recipeFingerprint,
    candidateArtifactId,
    readReceipt,
}) {
    const { runId, runAttempt } = assertFieldRunIdentity({
        run,
        expectedWorkflowId,
        repository,
        happySourceSha,
    });
    assertSuccessfulFieldJob(jobs);
    const expectedArtifactName = receiptArtifactName(happySourceSha, recipeFingerprint);
    const matches = artifacts.filter((artifact) => artifact?.name === expectedArtifactName);
    if (matches.length !== 1) throw new Error('Field workflow must contain exactly one success receipt');
    const artifact = matches[0];
    const artifactId = assertPositiveInteger(artifact.id, 'Field receipt artifact id');
    if (artifactId !== candidateArtifactId) throw new Error('Field receipt artifact id changed during validation');
    if (artifact.expired !== false) throw new Error('Field success receipt is expired');
    const artifactDigest = parseArtifactDigest(artifact.digest);
    const sizeBytes = assertReceiptArchiveSize(artifact.size_in_bytes, 'Field receipt artifact size');
    if (assertPositiveInteger(artifact.workflow_run?.id, 'Field receipt workflow run id') !== runId
        || artifact.workflow_run?.head_sha !== happySourceSha) {
        throw new Error('Field receipt artifact is not bound to its workflow run');
    }
    const receipt = readReceipt({ artifactId, artifactDigest, sizeBytes });
    assertReceipt(receipt, {
        repository,
        happySourceSha,
        recipeFingerprint,
        fieldRunId: runId,
        fieldRunAttempt: runAttempt,
        event: run.event,
    });
    return {
        runId,
        artifactId,
        artifactDigest: `sha256:${artifactDigest}`,
        artifactName: expectedArtifactName,
    };
}

function ghApiJson(path, label) {
    const result = spawnSync('gh', ['api', '--method', 'GET', path], {
        encoding: 'utf8',
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

function readReceiptArtifact(repository, { artifactId, artifactDigest, sizeBytes }) {
    assertReceiptArchiveSize(sizeBytes);
    const root = mkdtempSync(join(tmpdir(), 'happy-android-field-receipt-'));
    const archivePath = join(root, 'receipt.zip');
    try {
        const download = spawnSync(
            'gh',
            ['api', '--method', 'GET', `repos/${repository}/actions/artifacts/${artifactId}/zip`],
            {
                encoding: null,
                maxBuffer: maximumReceiptBytes + 1,
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        if (download.error || download.status !== 0 || !Buffer.isBuffer(download.stdout)) {
            throw new Error('Field success receipt download failed');
        }
        assertReceiptArchiveSize(download.stdout.length, 'Downloaded Field receipt archive size');
        writeFileSync(archivePath, download.stdout, { encoding: 'binary', flag: 'wx', mode: 0o600 });
        verifyArchiveDigest(archivePath, artifactDigest);
        const entries = spawnSync('unzip', ['-Z1', archivePath], {
            encoding: 'utf8',
            maxBuffer: maximumReceiptBytes,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (entries.error || entries.status !== 0
            || JSON.stringify(entries.stdout.trim().split(/\r?\n/)) !== JSON.stringify([receiptFileName])) {
            throw new Error('Field success receipt archive layout is invalid');
        }
        const content = spawnSync('unzip', ['-p', archivePath, receiptFileName], {
            encoding: 'utf8',
            maxBuffer: maximumReceiptBytes + 1,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (content.error || content.status !== 0) throw new Error('Field success receipt could not be read');
        if (Buffer.byteLength(content.stdout, 'utf8') > maximumReceiptBytes) {
            throw new Error('Field success receipt content is too large');
        }
        try {
            return JSON.parse(content.stdout);
        } catch {
            throw new Error('Field success receipt is invalid JSON');
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
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

function writeReceiptFile(destination, happySourceSha, recipeFingerprint, sourceAttestationRunId) {
    const receipt = createReceipt({
        repository: process.env.GITHUB_REPOSITORY,
        happySourceSha,
        recipeFingerprint,
        fieldRunId: process.env.GITHUB_RUN_ID,
        fieldRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
        sourceAttestationRunId,
        event: process.env.GITHUB_EVENT_NAME,
    });
    const receiptPath = resolve(destination);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    writeOutputs({ artifact_name: receiptArtifactName(happySourceSha, recipeFingerprint) });
}

function findPriorReceipt(happySourceSha, recipeFingerprint, sourceBranch, currentRunIdValue) {
    const repository = assertRepository(process.env.GITHUB_REPOSITORY);
    const expectedHappySourceSha = assertGitSha(happySourceSha);
    const expectedRecipeFingerprint = assertRecipeFingerprint(recipeFingerprint);
    const artifactName = receiptArtifactName(expectedHappySourceSha, expectedRecipeFingerprint);
    const currentRunId = assertPositiveInteger(currentRunIdValue, 'Current Field run id');
    if (sourceBranch !== 'main') {
        writeOutputs({ should_run: true, reason: 'non-main-source', artifact_name: artifactName });
        return;
    }

    let listedArtifacts;
    let expectedWorkflowId;
    try {
        expectedWorkflowId = workflowIdentity(repository);
        listedArtifacts = ghApiCollection(
            `repos/${repository}/actions/artifacts?name=${encodeURIComponent(artifactName)}`,
            'artifacts',
            'Field receipt artifacts',
        );
    } catch (error) {
        process.stderr.write(`${error.message}; running Field because prior success is unproven\n`);
        writeOutputs({ should_run: true, reason: 'dedup-api-unavailable', artifact_name: artifactName });
        return;
    }

    for (const candidate of receiptRunCandidates(listedArtifacts, artifactName)) {
        if (candidate.runId === currentRunId) continue;
        try {
            const run = ghApiJson(`repos/${repository}/actions/runs/${candidate.runId}`, 'Field candidate run');
            const jobs = ghApiCollection(
                `repos/${repository}/actions/runs/${candidate.runId}/jobs?filter=latest`,
                'jobs',
                'Field candidate jobs',
            );
            const artifacts = ghApiCollection(
                `repos/${repository}/actions/runs/${candidate.runId}/artifacts`,
                'artifacts',
                'Field candidate artifacts',
            );
            const decision = selectTrustedReceipt({
                run,
                jobs,
                artifacts,
                expectedWorkflowId,
                repository,
                happySourceSha: expectedHappySourceSha,
                recipeFingerprint: expectedRecipeFingerprint,
                candidateArtifactId: candidate.artifactId,
                readReceipt: (artifact) => readReceiptArtifact(repository, artifact),
            });
            writeOutputs({
                should_run: false,
                reason: 'prior-success',
                receipt_run_id: decision.runId,
                receipt_artifact_id: decision.artifactId,
                receipt_artifact_digest: decision.artifactDigest,
                artifact_name: decision.artifactName,
            });
            return;
        } catch (error) {
            process.stderr.write(`Skipping invalid Field receipt run ${candidate.runId}: ${error.message}\n`);
        }
    }
    writeOutputs({ should_run: true, reason: 'no-prior-success', artifact_name: artifactName });
}

function main() {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'find') {
        if (args.length !== 4) {
            throw new Error('Usage: find <happy-source-sha> <recipe-fingerprint> <source-branch> <current-run-id>');
        }
        findPriorReceipt(...args);
        return;
    }
    if (command === 'write') {
        if (args.length !== 4) {
            throw new Error('Usage: write <destination> <happy-source-sha> <recipe-fingerprint> <source-run-id>');
        }
        writeReceiptFile(...args);
        return;
    }
    throw new Error('Expected find or write command');
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
    assertReceipt,
    assertReceiptArchiveSize,
    createReceipt,
    fieldJobName,
    fieldWorkflowName,
    fieldWorkflowPath,
    receiptArtifactName,
    receiptRunCandidates,
    selectTrustedReceipt,
};
