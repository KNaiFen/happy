const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
    chmodSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
    assertReceipt,
    assertReceiptArchiveSize,
    createReceipt,
    fieldJobName,
    fieldWorkflowName,
    fieldWorkflowPath,
    receiptArtifactName,
    receiptRunCandidates,
    selectTrustedReceipt,
} = require('./android-field-run-dedup.cjs');

const repository = 'KNaiFen/happy';
const happySourceSha = 'a'.repeat(40);
const recipeFingerprint = 'b'.repeat(64);
const workflowId = 323771769;
const fieldRunId = 42;
const artifactId = 73;

function receipt(overrides = {}) {
    return createReceipt({
        repository,
        happySourceSha,
        recipeFingerprint,
        fieldRunId,
        fieldRunAttempt: 1,
        sourceAttestationRunId: 41,
        event: 'workflow_run',
        ...overrides,
    });
}

function successfulRun(overrides = {}) {
    return {
        id: fieldRunId,
        workflow_id: workflowId,
        name: fieldWorkflowName,
        path: fieldWorkflowPath,
        event: 'workflow_run',
        head_branch: 'main',
        head_sha: happySourceSha,
        status: 'completed',
        conclusion: 'success',
        run_attempt: 1,
        repository: { full_name: repository },
        head_repository: { full_name: repository },
        ...overrides,
    };
}

function successfulJobs(overrides = {}) {
    return [{
        name: fieldJobName,
        status: 'completed',
        conclusion: 'success',
        ...overrides,
    }];
}

function receiptArtifacts(overrides = {}) {
    return [{
        id: artifactId,
        name: receiptArtifactName(happySourceSha, recipeFingerprint),
        expired: false,
        digest: `sha256:${'c'.repeat(64)}`,
        size_in_bytes: 512,
        created_at: '2026-08-11T00:00:00Z',
        workflow_run: { id: fieldRunId, head_sha: happySourceSha },
        ...overrides,
    }];
}

function selection(overrides = {}) {
    return selectTrustedReceipt({
        run: successfulRun(),
        jobs: successfulJobs(),
        artifacts: receiptArtifacts(),
        expectedWorkflowId: workflowId,
        repository,
        happySourceSha,
        recipeFingerprint,
        candidateArtifactId: artifactId,
        readReceipt: () => receipt(),
        ...overrides,
    });
}

function runFindWithFakeGh({
    listedArtifacts,
    run,
    jobs,
    artifacts,
    archivePath,
    failApi = false,
    forceRun,
    eventName,
}) {
    const root = mkdtempSync(join(tmpdir(), 'happy-android-field-dedup-gh-'));
    const ghPath = join(root, 'gh');
    const outputPath = join(root, 'output.txt');
    const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const path = process.argv.at(-1) ?? '';
const output = (value) => process.stdout.write(JSON.stringify(value));
if (${JSON.stringify(failApi)} || !path) process.exit(2);
if (path.includes('/actions/workflows/')) output({ id: ${workflowId} });
else if (path.includes('/actions/artifacts?name=')) output(JSON.parse(process.env.FAKE_LISTED_ARTIFACTS));
else if (/\\/actions\\/runs\\/\\d+$/.test(path)) output(JSON.parse(process.env.FAKE_RUN));
else if (path.includes('/jobs?')) output(JSON.parse(process.env.FAKE_JOBS));
else if (/\\/actions\\/runs\\/\\d+\\/artifacts/.test(path)) output(JSON.parse(process.env.FAKE_ARTIFACTS));
else if (path.endsWith('/zip')) process.stdout.write(fs.readFileSync(process.env.FAKE_ARCHIVE));
else process.exit(3);
`;
    writeFileSync(ghPath, fakeGh, { encoding: 'utf8', mode: 0o755 });
    chmodSync(ghPath, 0o755);
    writeFileSync(outputPath, '');
    try {
        const result = spawnSync(
            process.execPath,
            [
                join(__dirname, 'android-field-run-dedup.cjs'),
                'find',
                happySourceSha,
                recipeFingerprint,
                'main',
                '99',
                ...(forceRun === undefined ? [] : [forceRun]),
            ],
            {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PATH: `${root}:${process.env.PATH ?? ''}`,
                    GITHUB_REPOSITORY: repository,
                    GITHUB_EVENT_NAME: eventName ?? 'workflow_run',
                    GITHUB_OUTPUT: outputPath,
                    FAKE_LISTED_ARTIFACTS: JSON.stringify(listedArtifacts),
                    FAKE_RUN: JSON.stringify(run),
                    FAKE_JOBS: JSON.stringify(jobs),
                    FAKE_ARTIFACTS: JSON.stringify(artifacts),
                    FAKE_ARCHIVE: archivePath ?? '',
                },
            },
        );
        return { ...result, output: readFileSync(outputPath, 'utf8') };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test('binds receipt names and content to Happy SHA and the Official Codex recipe', () => {
    assert.equal(
        receiptArtifactName(happySourceSha, recipeFingerprint),
        `codex-android-field-success-v1-${happySourceSha}-${recipeFingerprint}`,
    );
    assert.deepEqual(assertReceipt(receipt(), {
        repository,
        happySourceSha,
        recipeFingerprint,
        fieldRunId,
        fieldRunAttempt: 1,
        event: 'workflow_run',
    }), receipt());
    assert.throws(
        () => receiptArtifactName(happySourceSha, 'B'.repeat(64)),
        /fingerprint is invalid/,
    );
    assert.throws(
        () => assertReceipt({ ...receipt(), extra: true }, {
            repository,
            happySourceSha,
            recipeFingerprint,
            fieldRunId,
            fieldRunAttempt: 1,
            event: 'workflow_run',
        }),
        /keys are unexpected/,
    );
});

test('selects only one unexpired receipt from a successful first-attempt main Field job', () => {
    assert.deepEqual(selection(), {
        runId: fieldRunId,
        artifactId,
        artifactDigest: `sha256:${'c'.repeat(64)}`,
        artifactName: receiptArtifactName(happySourceSha, recipeFingerprint),
    });
});

test('rejects untrusted Field workflow identity and terminal state', () => {
    const cases = [
        [{ workflow_id: workflowId + 1 }, /wrong workflow/],
        [{ path: '.github/workflows/other.yml' }, /wrong workflow/],
        [{ repository: { full_name: 'attacker/fork' } }, /wrong repository/],
        [{ head_repository: { full_name: 'attacker/fork' } }, /wrong repository/],
        [{ event: 'pull_request' }, /unsupported event/],
        [{ head_branch: 'feature' }, /did not run on main/],
        [{ head_sha: 'd'.repeat(40) }, /SHA does not match/],
        [{ status: 'in_progress', conclusion: null }, /did not succeed/],
        [{ conclusion: 'cancelled' }, /did not succeed/],
        [{ run_attempt: 2 }, /first run attempt/],
    ];
    for (const [runOverride, pattern] of cases) {
        assert.throws(() => selection({ run: successfulRun(runOverride) }), pattern);
    }
    assert.throws(() => selection({ jobs: successfulJobs({ conclusion: 'skipped' }) }), /job did not succeed/);
    assert.throws(() => selection({ jobs: [...successfulJobs(), ...successfulJobs()] }), /exactly one field job/);
});

test('rejects duplicate, expired, oversized, rebound, or malformed receipt artifacts', () => {
    assert.equal(assertReceiptArchiveSize(64 * 1024), 64 * 1024);
    assert.throws(() => assertReceiptArchiveSize(64 * 1024 + 1), /too large/);
    assert.throws(() => assertReceiptArchiveSize(0), /positive integer/);
    assert.throws(
        () => selection({ artifacts: [...receiptArtifacts(), ...receiptArtifacts({ id: 74 })] }),
        /exactly one success receipt/,
    );
    assert.throws(() => selection({ artifacts: receiptArtifacts({ expired: true }) }), /expired/);
    assert.throws(() => selection({ artifacts: receiptArtifacts({ size_in_bytes: 65537 }) }), /too large/);
    assert.throws(
        () => selection({ artifacts: receiptArtifacts({ workflow_run: { id: 41, head_sha: happySourceSha } }) }),
        /not bound/,
    );
    assert.throws(() => selection({ artifacts: receiptArtifacts({ digest: 'sha1:bad' }) }), /digest/);
    assert.throws(() => selection({ readReceipt: () => receipt({ recipeFingerprint: 'd'.repeat(64) }) }), /recipe does not match/);
});

test('orders exact repository receipt candidates newest first and ignores malformed entries', () => {
    const name = receiptArtifactName(happySourceSha, recipeFingerprint);
    const candidates = receiptRunCandidates([
        ...receiptArtifacts({ id: 1, created_at: '2026-08-10T00:00:00Z', workflow_run: { id: 10 } }),
        ...receiptArtifacts({ id: 2, created_at: '2026-08-11T00:00:00Z', workflow_run: { id: 11 } }),
        { name, id: 'bad', created_at: 'bad', expired: false, workflow_run: { id: 12 } },
        { name: 'other', id: 3, created_at: '2026-08-12T00:00:00Z', expired: false, workflow_run: { id: 13 } },
    ], name);
    assert.deepEqual(candidates.map((candidate) => candidate.runId), [11, 10]);
});

test('find validates the real gh API path and safely falls back when no receipt is present', () => {
    const result = runFindWithFakeGh({
        listedArtifacts: { total_count: 0, artifacts: [] },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /"reason": "no-prior-success"/);
    assert.match(result.output, /should_run=true/);
});

test('find validates a downloaded receipt archive before suppressing Field', () => {
    const root = mkdtempSync(join(tmpdir(), 'happy-android-field-dedup-archive-'));
    const receiptPath = join(root, 'receipt.json');
    const archivePath = join(root, 'receipt.zip');
    try {
        writeFileSync(receiptPath, `${JSON.stringify(receipt())}\n`);
        const archive = spawnSync('zip', ['-q', '-j', archivePath, receiptPath], { encoding: 'utf8' });
        assert.equal(archive.status, 0, archive.stderr);
        const archiveBytes = readFileSync(archivePath);
        const digest = createHash('sha256').update(archiveBytes).digest('hex');
        const artifact = receiptArtifacts({
            digest: `sha256:${digest}`,
            size_in_bytes: archiveBytes.length,
        })[0];
        const result = runFindWithFakeGh({
            listedArtifacts: { total_count: 1, artifacts: [artifact] },
            run: successfulRun(),
            jobs: { total_count: 1, jobs: successfulJobs() },
            artifacts: { total_count: 1, artifacts: [artifact] },
            archivePath,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /"reason": "prior-success"/);
        assert.match(result.output, /should_run=false/);
        assert.match(result.output, new RegExp(`receipt_artifact_id=${artifactId}`));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('find runs the real Field when the GitHub API is unavailable', () => {
    const result = runFindWithFakeGh({
        listedArtifacts: { total_count: 0, artifacts: [] },
        failApi: true,
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /"reason": "dedup-api-unavailable"/);
    assert.match(result.output, /should_run=true/);
});

test('only an explicit manual dispatch may bypass a prior success receipt', () => {
    const forced = runFindWithFakeGh({
        failApi: true,
        forceRun: 'true',
        eventName: 'workflow_dispatch',
    });
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.output, /should_run=true/);
    assert.match(forced.output, /reason=forced-manual-dispatch/);

    const rejected = runFindWithFakeGh({
        failApi: true,
        forceRun: 'true',
        eventName: 'schedule',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Only workflow_dispatch/);
});

test('workflow serializes the same Happy SHA, admits only trusted CI, and records successful receipts', () => {
    const workflowRoot = join(__dirname, '../../.github/workflows');
    const field = readFileSync(join(workflowRoot, 'codex-android-field-e2e.yml'), 'utf8');
    const ci = readFileSync(join(workflowRoot, 'ci.yml'), 'utf8');
    const helper = readFileSync(join(__dirname, 'android-field-run-dedup.cjs'), 'utf8');

    assert.match(field, /group: codex-android-field-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
    assert.match(field, /cancel-in-progress: false/);
    assert.match(field, /github\.event\.workflow_run\.event == 'push'/);
    assert.match(field, /github\.event\.workflow_run\.conclusion == 'success'/);
    assert.match(field, /github\.event\.workflow_run\.run_attempt == 1/);
    assert.match(field, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
    assert.match(field, /android-field-run-dedup\.cjs find/);
    assert.match(field, /force_full_field/);
    assert.match(field, /needs\.field_dedup\.outputs\.should_run == 'true'/);
    assert.match(field, /android-field-run-dedup\.cjs write/);
    assert.equal((field.match(/if: env\.HAPPY_FIELD_SOURCE_BRANCH == 'main' && github\.run_attempt == 1/g) ?? []).length, 2);
    assert.match(field, /name: \$\{\{ steps\.field_receipt\.outputs\.artifact_name \}\}/);
    assert.match(helper, /maxBuffer: maximumReceiptBytes \+ 1/);
    assert.match(helper, /Downloaded Field receipt archive size/);
    assert.match(ci, /node --test scripts\/ci\/android-field-run-dedup\.test\.cjs/);
});
