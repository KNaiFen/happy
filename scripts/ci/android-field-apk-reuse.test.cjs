const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
    chmodSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const {
    apkFileName,
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
    parseTreeEntries,
    selectTrustedArtifact,
    verifyExtractedArtifact,
} = require('./android-field-apk-reuse.cjs');

const repository = 'KNaiFen/happy';
const sourceSha = 'a'.repeat(40);
const sourceTimestamp = '2026-08-11T00:00:00Z';
const fingerprint = 'b'.repeat(64);
const artifactDigest = 'c'.repeat(64);
const artifactName = artifactNameForFingerprint(fingerprint);

function trustedRun(overrides = {}) {
    return {
        id: 901,
        workflow_id: 44,
        name: 'Codex Android field E2E',
        path: '.github/workflows/codex-android-field-e2e.yml',
        repository: { full_name: repository },
        head_repository: { full_name: repository },
        event: 'workflow_run',
        head_branch: 'main',
        head_sha: sourceSha,
        run_attempt: 1,
        status: 'completed',
        conclusion: 'failure',
        ...overrides,
    };
}

function successfulJobs(overrides = {}) {
    return [{
        name: fieldApkJobName,
        status: 'completed',
        conclusion: 'success',
        ...overrides,
    }];
}

function trustedArtifacts(overrides = {}) {
    return [{
        id: 902,
        name: artifactName,
        expired: false,
        digest: `sha256:${artifactDigest}`,
        size_in_bytes: 1024,
        workflow_run: { id: 901, head_sha: sourceSha },
        ...overrides,
    }];
}

function runCliWithFakeGh({
    command,
    archivePath,
    artifact,
    listedArtifacts,
    metadataArtifact = artifact,
    downloadFails = false,
}) {
    const root = mkdtempSync(join(tmpdir(), 'happy-field-apk-gh-'));
    const ghPath = join(root, 'gh');
    const outputPath = join(root, 'output.txt');
    const environmentPath = join(root, 'environment.txt');
    const destination = join(root, 'downloaded');
    const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const path = process.argv.at(-1) ?? '';
const output = (value) => process.stdout.write(JSON.stringify(value));
if (path.includes('/actions/workflows/')) output({ id: 44 });
else if (path.includes('/actions/artifacts?name=')) output(JSON.parse(process.env.FAKE_LISTED_ARTIFACTS));
else if (path.endsWith('/actions/artifacts/902/zip')) {
    if (process.env.FAKE_DOWNLOAD_FAILS === 'true') process.exit(7);
    process.stdout.write(fs.readFileSync(process.env.FAKE_ARCHIVE));
}
else if (path.endsWith('/actions/artifacts/902')) output(JSON.parse(process.env.FAKE_ARTIFACT));
else if (path.endsWith('/actions/runs/901')) output(JSON.parse(process.env.FAKE_RUN));
else if (path.includes('/actions/runs/901/jobs?')) output(JSON.parse(process.env.FAKE_JOBS));
else if (path.includes('/actions/runs/901/artifacts?')) output(JSON.parse(process.env.FAKE_ARTIFACTS));
else process.exit(3);
    `;
    writeFileSync(ghPath, fakeGh, { encoding: 'utf8', mode: 0o755 });
    chmodSync(ghPath, 0o755);
    writeFileSync(outputPath, '');
    writeFileSync(environmentPath, '');
    const args = command === 'find'
        ? ['find', fingerprint, '999']
        : ['download', '902', artifact.digest, fingerprint, destination];
    const result = spawnSync(
        process.execPath,
        [join(__dirname, 'android-field-apk-reuse.cjs'), ...args],
        {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${root}:${process.env.PATH ?? ''}`,
                GITHUB_REPOSITORY: repository,
                GITHUB_OUTPUT: outputPath,
                GITHUB_ENV: environmentPath,
                FAKE_ARCHIVE: archivePath,
                FAKE_ARTIFACT: JSON.stringify(metadataArtifact),
                FAKE_DOWNLOAD_FAILS: String(downloadFails),
                FAKE_LISTED_ARTIFACTS: JSON.stringify(listedArtifacts),
                FAKE_RUN: JSON.stringify(trustedRun()),
                FAKE_JOBS: JSON.stringify({ total_count: 1, jobs: successfulJobs() }),
                FAKE_ARTIFACTS: JSON.stringify({ total_count: 1, artifacts: [artifact] }),
            },
        },
    );
    return {
        ...result,
        destination,
        environment: readFileSync(environmentPath, 'utf8'),
        output: readFileSync(outputPath, 'utf8'),
        remove: () => rmSync(root, { recursive: true, force: true }),
    };
}

function createArtifactArchive({ tamperApk = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'happy-field-apk-fixture-'));
    const content = join(root, 'content');
    mkdirSync(content);
    const apkPath = join(content, apkFileName);
    writeFileSync(apkPath, 'verified apk');
    const manifest = createManifest({
        apkPath,
        appFingerprint: fingerprint,
        repository,
        compiledHappySourceSha: sourceSha,
        compiledCommitTimestamp: sourceTimestamp,
        producerRunId: 901,
        producerRunAttempt: 1,
        event: 'workflow_run',
    });
    writeFileSync(join(content, manifestFileName), `${JSON.stringify(manifest)}\n`);
    if (tamperApk) writeFileSync(apkPath, 'tampered apk');
    const archivePath = join(root, 'artifact.zip');
    const zip = spawnSync('zip', [
        '-q',
        '-j',
        '-0',
        archivePath,
        join(content, apkFileName),
        join(content, manifestFileName),
    ], { encoding: 'utf8' });
    assert.equal(zip.status, 0, zip.stderr);
    const bytes = readFileSync(archivePath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const artifact = trustedArtifacts({
        digest: `sha256:${digest}`,
        size_in_bytes: bytes.length,
        created_at: '2026-08-11T00:00:00Z',
    })[0];
    return {
        archivePath,
        artifact,
        remove: () => rmSync(root, { recursive: true, force: true }),
    };
}

test('fingerprint binds sorted Git index entries and the fixed Field build recipe', () => {
    const entries = parseTreeEntries(Buffer.from(
        `100644 ${'1'.repeat(40)} 0\tpackages/happy-app/z.ts\0`
        + `100755 ${'2'.repeat(40)} 0\tscripts/ci/build-android-field-apk.sh\0`,
    ));
    assert.deepEqual(entries.map((entry) => entry.path), [
        'packages/happy-app/z.ts',
        'scripts/ci/build-android-field-apk.sh',
    ]);
    const first = fingerprintFromEntries(entries);
    const second = fingerprintFromEntries([...entries].reverse());
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(first, second);
    assert.notEqual(first, fingerprintFromEntries([
        { ...entries[0], object: '3'.repeat(40) },
        entries[1],
    ]));
    assert.throws(
        () => parseTreeEntries(Buffer.from(`100644 ${'1'.repeat(40)} 1\tconflicted\0`)),
        /malformed/,
    );
});

test('selects an immutable APK from a successful producer job even when later Field work failed', () => {
    const selected = selectTrustedArtifact({
        run: trustedRun(),
        jobs: successfulJobs(),
        artifacts: trustedArtifacts(),
        expectedWorkflowId: 44,
        repository,
        appFingerprint: fingerprint,
        candidateArtifactId: 902,
    });
    assert.equal(selected.artifactId, 902);
    assert.equal(selected.artifactDigest, artifactDigest);
    assert.equal(selected.headSha, sourceSha);

    const inProgress = selectTrustedArtifact({
        run: trustedRun({ status: 'in_progress', conclusion: null }),
        jobs: successfulJobs(),
        artifacts: trustedArtifacts(),
        expectedWorkflowId: 44,
        repository,
        appFingerprint: fingerprint,
        candidateArtifactId: 902,
    });
    assert.equal(inProgress.runId, 901);
});

test('rejects untrusted workflow, repository, branch, attempt, job, and artifact state', () => {
    for (const run of [
        trustedRun({ workflow_id: 45 }),
        trustedRun({ head_repository: { full_name: 'fork/happy' } }),
        trustedRun({ head_branch: 'feature' }),
        trustedRun({ run_attempt: 2 }),
        trustedRun({ status: 'queued' }),
    ]) {
        assert.throws(
            () => assertFieldRunIdentity({ run, expectedWorkflowId: 44, repository }),
            /wrong workflow|wrong repository|main|first run attempt|has not started/,
        );
    }

    const base = {
        run: trustedRun(),
        jobs: successfulJobs(),
        artifacts: trustedArtifacts(),
        expectedWorkflowId: 44,
        repository,
        appFingerprint: fingerprint,
        candidateArtifactId: 902,
    };
    assert.throws(() => selectTrustedArtifact({ ...base, jobs: successfulJobs({ conclusion: 'failure' }) }), /did not succeed/);
    assert.throws(() => selectTrustedArtifact({ ...base, artifacts: trustedArtifacts({ expired: true }) }), /expired/);
    assert.throws(() => selectTrustedArtifact({ ...base, artifacts: trustedArtifacts({ digest: `sha256:${'d'.repeat(64)}` }), expectedArtifactDigest: artifactDigest }), /digest changed/);
    assert.throws(() => selectTrustedArtifact({ ...base, artifacts: [...trustedArtifacts(), ...trustedArtifacts({ id: 903 })] }), /exactly one/);
    assert.throws(() => selectTrustedArtifact({ ...base, artifacts: trustedArtifacts({ size_in_bytes: 193 * 1024 * 1024 }) }), /size limit/);
});

test('orders exact unexpired candidates newest first and deduplicates runs', () => {
    const candidates = artifactRunCandidates([
        { id: 1, name: artifactName, expired: false, created_at: '2026-08-10T00:00:00Z', workflow_run: { id: 10 } },
        { id: 2, name: artifactName, expired: false, created_at: '2026-08-11T00:00:00Z', workflow_run: { id: 11 } },
        { id: 3, name: artifactName, expired: false, created_at: '2026-08-09T00:00:00Z', workflow_run: { id: 11 } },
        { id: 4, name: 'other', expired: false, created_at: '2026-08-12T00:00:00Z', workflow_run: { id: 12 } },
        { id: 5, name: artifactName, expired: true, created_at: '2026-08-13T00:00:00Z', workflow_run: { id: 13 } },
    ], artifactName);
    assert.deepEqual(candidates.map((candidate) => candidate.artifactId), [2, 1]);
});

test('writes and verifies a source-bound manifest and APK digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'happy-field-apk-manifest-'));
    try {
        const apkPath = join(root, apkFileName);
        writeFileSync(apkPath, 'verified apk');
        const manifest = createManifest({
            apkPath,
            appFingerprint: fingerprint,
            repository,
            compiledHappySourceSha: sourceSha,
            compiledCommitTimestamp: sourceTimestamp,
            producerRunId: 901,
            producerRunAttempt: 1,
            event: 'workflow_run',
        });
        assert.equal(manifest.buildRecipe, fieldBuildRecipe);
        assert.equal(manifest.apk.sizeBytes, 12);
        assertManifest(JSON.parse(JSON.stringify(manifest)), {
            repository,
            appFingerprint: fingerprint,
            compiledHappySourceSha: sourceSha,
            compiledCommitTimestamp: sourceTimestamp,
            producerRunId: 901,
            producerRunAttempt: 1,
            event: 'workflow_run',
        });

        const extracted = join(root, 'extracted');
        mkdirSync(extracted);
        writeFileSync(join(extracted, apkFileName), 'verified apk');
        writeFileSync(join(extracted, manifestFileName), `${JSON.stringify(manifest)}\n`);
        assert.equal(
            verifyExtractedArtifact(extracted, {
                repository,
                appFingerprint: fingerprint,
                compiledHappySourceSha: sourceSha,
                compiledCommitTimestamp: sourceTimestamp,
                producerRunId: 901,
                producerRunAttempt: 1,
                event: 'workflow_run',
            }).apkPath,
            join(extracted, apkFileName),
        );

        writeFileSync(join(extracted, apkFileName), 'tampered apk');
        assert.throws(() => verifyExtractedArtifact(extracted, { appFingerprint: fingerprint }), /size|digest/);
        const wrongRecipe = JSON.parse(JSON.stringify(manifest));
        wrongRecipe.buildRecipe.nodeVersion = '23';
        assert.throws(() => assertManifest(wrongRecipe, {}), /recipe/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('artifact naming and payload policy are source-fingerprint scoped', () => {
    assert.equal(artifactName, `${artifactNamePrefixForTest()}-${fingerprint}`);
    assert.equal(maximumApkBytes, 160 * 1024 * 1024);
});

test('find and download validate the real API, outer ZIP, manifest, and APK digest', () => {
    const fixture = createArtifactArchive();
    try {
        const listedArtifacts = { total_count: 1, artifacts: [fixture.artifact] };
        const find = runCliWithFakeGh({
            command: 'find',
            archivePath: fixture.archivePath,
            artifact: fixture.artifact,
            listedArtifacts,
        });
        try {
            assert.equal(find.status, 0, find.stderr);
            assert.match(find.output, /selected=true/);
            assert.match(find.output, /reason=trusted-app-fingerprint/);
        } finally {
            find.remove();
        }

        const download = runCliWithFakeGh({
            command: 'download',
            archivePath: fixture.archivePath,
            artifact: fixture.artifact,
            listedArtifacts,
        });
        try {
            assert.equal(download.status, 0, download.stderr);
            assert.equal(readFileSync(join(download.destination, apkFileName), 'utf8'), 'verified apk');
            assert.match(download.environment, /HAPPY_FIELD_APK_PATH=.*app-release\.apk/);
            assert.match(download.output, /compiled_happy_source_sha=/);
        } finally {
            download.remove();
        }
    } finally {
        fixture.remove();
    }
});

test('find falls back to a real build when a candidate APK fails its inner digest', () => {
    const fixture = createArtifactArchive({ tamperApk: true });
    try {
        const result = runCliWithFakeGh({
            command: 'find',
            archivePath: fixture.archivePath,
            artifact: fixture.artifact,
            listedArtifacts: { total_count: 1, artifacts: [fixture.artifact] },
        });
        try {
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.output, /selected=false/);
            assert.match(result.output, /reason=no-trusted-app-fingerprint/);
            assert.match(result.stderr, /digest does not match/);
        } finally {
            result.remove();
        }
    } finally {
        fixture.remove();
    }
});

test('find rejects artifact metadata that drifts between API scopes', () => {
    const fixture = createArtifactArchive();
    try {
        const result = runCliWithFakeGh({
            command: 'find',
            archivePath: fixture.archivePath,
            artifact: fixture.artifact,
            metadataArtifact: { ...fixture.artifact, size_in_bytes: fixture.artifact.size_in_bytes + 1 },
            listedArtifacts: { total_count: 1, artifacts: [fixture.artifact] },
        });
        try {
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.output, /selected=false/);
            assert.match(result.stderr, /metadata changed/);
        } finally {
            result.remove();
        }
    } finally {
        fixture.remove();
    }
});

test('download fails closed when a selected artifact becomes unavailable', () => {
    const fixture = createArtifactArchive();
    try {
        const result = runCliWithFakeGh({
            command: 'download',
            archivePath: fixture.archivePath,
            artifact: fixture.artifact,
            listedArtifacts: { total_count: 1, artifacts: [fixture.artifact] },
            downloadFails: true,
        });
        try {
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /artifact download failed/);
            assert.equal(existsSync(result.destination), false);
            assert.doesNotMatch(result.output, /selected=false|reason=/);
        } finally {
            result.remove();
        }
    } finally {
        fixture.remove();
    }
});

test('APK builder refuses compile-time Field credentials before invoking toolchains', () => {
    const root = mkdtempSync(join(tmpdir(), 'happy-field-apk-builder-'));
    try {
        const result = spawnSync(
            'bash',
            [join(__dirname, 'build-android-field-apk.sh'), join(root, 'artifact')],
            {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    ANDROID_HOME: root,
                    RUNNER_TEMP: root,
                    HAPPY_FIELD_SOURCE_SHA: sourceSha,
                    EXPO_PUBLIC_DEV_TOKEN: 'must-not-be-embedded',
                },
            },
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /injected only at runtime/);
        assert.doesNotMatch(result.stderr, /must-not-be-embedded/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('workflow separates APK production from Field execution and keeps the full scenario', () => {
    const field = readFileSync(join(__dirname, '../../.github/workflows/codex-android-field-e2e.yml'), 'utf8');
    const apkJobStart = field.indexOf('  field_apk:');
    const fieldJobStart = field.indexOf('  android-field:');
    assert(apkJobStart > 0 && fieldJobStart > apkJobStart);
    const apkJob = field.slice(apkJobStart, fieldJobStart);
    const fieldJob = field.slice(fieldJobStart);
    assert.match(apkJob, /name: Build or reuse Android Field APK/);
    assert.match(apkJob, /android-field-apk-reuse\.cjs find/);
    assert.match(apkJob, /steps\.reuse\.outputs\.selected != 'true'/);
    assert.match(apkJob, /build-android-field-apk\.sh/);
    assert.match(apkJob, /compression-level: 0/);
    assert.match(fieldJob, /needs: \[reuse_ci_artifact, official_codex, field_dedup, field_apk\]/);
    assert.match(fieldJob, /android-field-apk-reuse\.cjs download/);
    assert.match(fieldJob, /verify-android-field-apk\.sh/);
    assert.match(fieldJob, /Run API 36 Android field scenario/);
    assert.match(fieldJob, /android-field-run-dedup\.cjs write/);
    const fixtureStepStart = fieldJob.indexOf('      - name: Start real relay and prepare App authentication');
    const fixtureStepEnd = fieldJob.indexOf('\n      - name:', fixtureStepStart + 1);
    assert(fixtureStepStart > 0 && fixtureStepEnd > fixtureStepStart);
    const fixtureStep = fieldJob.slice(fixtureStepStart, fixtureStepEnd);
    assert.match(
        fixtureStep,
        /grep -Fqx[\s\S]*Mobile Field credential server ready on 127\.0\.0\.1:\$\{HAPPY_MOBILE_E2E_BOOTSTRAP_PORT\}/,
    );
    assert.match(fixtureStep, /if grep -Fq 'Mobile Field credential request ' "\$CREDENTIAL_LOG"; then/);
    const credentialServerStart = fieldJob.indexOf('          CREDENTIAL_LOG="$RUNNER_TEMP/happy-mobile-credential-server.log"');
    const emulatorStepStart = fieldJob.indexOf('      - name: Run API 36 Android field scenario');
    assert(credentialServerStart > 0 && emulatorStepStart > credentialServerStart);
    assert.doesNotMatch(fieldJob.slice(credentialServerStart, emulatorStepStart), /\/credentials/);
    assert.doesNotMatch(fieldJob, /assembleRelease|expo prebuild|setup-gradle/);
    assert.doesNotMatch(field, /EXPO_PUBLIC_DEV_TOKEN|EXPO_PUBLIC_DEV_SECRET/);
});

function artifactNamePrefixForTest() {
    return 'codex-android-field-apk-v1';
}
