const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
    artifactBinaryPaths,
    assertSourceManifest,
    collectPaginatedCollection,
    parseArtifactDigest,
    selectReusableArtifact,
    verifyArchiveDigest,
    verifyExtractedArtifact,
} = require('./official-codex-artifact-reuse.cjs');

const happySha = 'a'.repeat(40);
const codexSha = 'b'.repeat(40);

function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}

function successfulRun(overrides = {}) {
    return {
        id: 42,
        event: 'push',
        head_branch: 'main',
        head_sha: happySha,
        status: 'completed',
        conclusion: 'success',
        ...overrides,
    };
}

function successfulGate() {
    return [{
        name: 'Required CI gate',
        status: 'completed',
        conclusion: 'success',
    }];
}

function reusableArtifact(overrides = {}) {
    return [{
        id: 73,
        name: 'official-codex-linux-x64',
        expired: false,
        digest: `sha256:${'c'.repeat(64)}`,
        ...overrides,
    }];
}

function manifest(binarySha256, overrides = {}) {
    return {
        schemaVersion: 4,
        runtimeBundleVersion: 2,
        repository: 'https://github.com/openai/codex',
        happySourceSha: happySha,
        tag: 'rust-v0.147.0',
        version: '0.147.0',
        commit: codexSha,
        rustToolchain: '1.91.1',
        target: 'x86_64-unknown-linux-gnu',
        rustyV8Version: '145.0.0',
        sourceCargoLockSha256: 'd'.repeat(64),
        resolvedCargoLockSha256: 'e'.repeat(64),
        bwrapSha256: binarySha256.bwrap,
        binarySha256,
        ...overrides,
    };
}

test('selects only a successful main CI artifact for the exact Happy source SHA', () => {
    assert.deepEqual(selectReusableArtifact({
        run: successfulRun(),
        jobs: successfulGate(),
        artifacts: reusableArtifact(),
        expectedHeadSha: happySha,
    }), {
        selected: true,
        reason: 'selected',
        sourceRunId: '42',
        headSha: happySha,
        artifactId: '73',
        artifactDigest: `sha256:${'c'.repeat(64)}`,
    });
});

test('skips Field reuse when the exact CI run did not pass or did not select Official Codex', () => {
    assert.deepEqual(selectReusableArtifact({
        run: successfulRun({ conclusion: 'failure' }),
        jobs: [],
        artifacts: [],
        expectedHeadSha: happySha,
    }), {
        selected: false,
        reason: 'upstream-ci-not-success',
    });
    assert.deepEqual(selectReusableArtifact({
        run: successfulRun(),
        jobs: successfulGate(),
        artifacts: [],
        expectedHeadSha: happySha,
    }), {
        selected: false,
        reason: 'official-codex-not-selected',
    });
});

test('rejects source identity, Required CI gate, and artifact lifetime mismatches', () => {
    assert.throws(() => selectReusableArtifact({
        run: successfulRun({ head_sha: 'f'.repeat(40) }),
        jobs: successfulGate(),
        artifacts: reusableArtifact(),
        expectedHeadSha: happySha,
    }), /does not match/);
    assert.throws(() => selectReusableArtifact({
        run: successfulRun(),
        jobs: [{ name: 'Required CI gate', status: 'completed', conclusion: 'skipped' }],
        artifacts: reusableArtifact(),
        expectedHeadSha: happySha,
    }), /did not succeed/);
    assert.throws(() => selectReusableArtifact({
        run: successfulRun(),
        jobs: successfulGate(),
        artifacts: reusableArtifact({ expired: true }),
        expectedHeadSha: happySha,
    }), /expired/);
});

test('reads every Actions API page before deciding that a gate or artifact is unique', () => {
    const firstPage = [
        ...reusableArtifact(),
        ...Array.from({ length: 99 }, (_, index) => ({ name: `other-${index}` })),
    ];
    const secondPage = reusableArtifact({ id: 74 });
    const collected = collectPaginatedCollection({
        itemKey: 'artifacts',
        label: 'workflow artifacts',
        fetchPage: (page) => ({
            total_count: 101,
            artifacts: page === 1 ? firstPage : secondPage,
        }),
    });
    assert.equal(collected.length, 101);
    assert.equal(collected.at(-1).name, 'official-codex-linux-x64');
    assert.throws(() => selectReusableArtifact({
        run: successfulRun(),
        jobs: successfulGate(),
        artifacts: collected,
        expectedHeadSha: happySha,
    }), /exactly one/);
    assert.throws(() => collectPaginatedCollection({
        itemKey: 'jobs',
        label: 'workflow jobs',
        fetchPage: () => ({ total_count: 101, jobs: [] }),
    }), /pagination is incomplete/);
});

test('rejects malformed Actions artifact digests', () => {
    for (const value of [undefined, 'sha1:abcd', `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`]) {
        assert.throws(() => parseArtifactDigest(value), /Artifact digest|sha256/);
    }
});

test('rejects a downloaded archive whose bytes do not match the Actions API digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'happy-official-codex-archive-'));
    const archive = join(root, 'artifact.zip');
    try {
        writeFileSync(archive, 'artifact bytes');
        verifyArchiveDigest(archive, `sha256:${digest('artifact bytes')}`);
        assert.throws(
            () => verifyArchiveDigest(archive, `sha256:${digest('other bytes')}`),
            /does not match the Actions API/,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('binds the manifest and every extracted executable to the source SHA and digests', () => {
    const root = mkdtempSync(join(tmpdir(), 'happy-official-codex-artifact-'));
    try {
        const contents = {
            codex: 'codex binary',
            codexCodeModeHost: 'code mode host binary',
            bwrap: 'bwrap binary',
        };
        const binarySha256 = Object.fromEntries(
            Object.entries(contents).map(([key, value]) => [key, digest(value)]),
        );
        for (const [key, relativePath] of Object.entries(artifactBinaryPaths)) {
            const path = join(root, relativePath);
            mkdirSync(join(path, '..'), { recursive: true });
            writeFileSync(path, contents[key]);
        }
        writeFileSync(join(root, 'source.json'), JSON.stringify(manifest(binarySha256)));

        assert.equal(
            verifyExtractedArtifact(root, { happySourceSha: happySha, codexCommit: codexSha }).version,
            '0.147.0',
        );
        writeFileSync(join(root, artifactBinaryPaths.bwrap), 'tampered bwrap');
        assert.throws(
            () => verifyExtractedArtifact(root, { happySourceSha: happySha, codexCommit: codexSha }),
            /does not match source.json/,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('requires the schema-4 Happy source binding and exactly the three binary digest keys', () => {
    const binarySha256 = {
        codex: '1'.repeat(64),
        codexCodeModeHost: '2'.repeat(64),
        bwrap: '3'.repeat(64),
    };
    assert.throws(
        () => assertSourceManifest(manifest(binarySha256, { happySourceSha: 'f'.repeat(40) }), { happySourceSha: happySha }),
        /Happy source SHA does not match/,
    );
    assert.throws(
        () => assertSourceManifest(manifest({ ...binarySha256, extra: '4'.repeat(64) }), { happySourceSha: happySha }),
        /digest keys are unexpected/,
    );
    assert.throws(
        () => assertSourceManifest(manifest(binarySha256, { tag: 'rust-v0.146.0' }), { happySourceSha: happySha }),
        /release tag does not match/,
    );
});

test('uses the manifest-declared Codex commit when workflow_run has no callable-workflow output', () => {
    const binarySha256 = {
        codex: '1'.repeat(64),
        codexCodeModeHost: '2'.repeat(64),
        bwrap: '3'.repeat(64),
    };
    assert.equal(
        assertSourceManifest(manifest(binarySha256), { happySourceSha: happySha }).commit,
        codexSha,
    );
});

test('workflow contracts bind Field reuse to the completed CI run and exact artifact ID', () => {
    const workflowRoot = join(__dirname, '../../.github/workflows');
    const sourceBuild = readFileSync(join(workflowRoot, 'build-official-codex-source.yml'), 'utf8');
    const ci = readFileSync(join(workflowRoot, 'ci.yml'), 'utf8');
    const field = readFileSync(join(workflowRoot, 'codex-android-field-e2e.yml'), 'utf8');

    assert.match(sourceBuild, /artifact_id:\s+\$\{\{ steps\.upload\.outputs\.artifact-id \}\}/);
    assert.match(sourceBuild, /artifact_digest:\s+\$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/);
    assert.match(sourceBuild, /schemaVersion: 4/);
    assert.match(sourceBuild, /happySourceSha: \$happySourceSha/);
    assert.match(sourceBuild, /binarySha256: \{codex:/);
    assert.match(ci, /permissions:\n  actions: read\n  contents: read/);
    assert.equal((ci.match(/official-codex-artifact-reuse\.cjs download/g) ?? []).length, 2);
    assert.doesNotMatch(ci, /artifact-ids:/);
    assert.match(ci, /official-codex-artifact-reuse\.test\.cjs/);
    assert.match(field, /workflow_run:\n\s+workflows: \["Happy monorepo CI"\]\n\s+types: \[completed\]/);
    assert.doesNotMatch(field, /^  push:/m);
    assert.match(field, /actions: read/);
    assert.match(field, /official-codex-artifact-reuse\.cjs resolve/);
    assert.match(field, /official-codex-artifact-reuse\.cjs download/);
    assert.doesNotMatch(field, /artifact-ids:/);
    assert.match(field, /OFFICIAL_CODEX_ARTIFACT_ID: \$\{\{ github\.event_name == 'workflow_run'/);
    assert.match(field, /if: github\.event_name != 'workflow_run'/);
    assert.match(field, /HAPPY_EXPECTED_CODEX_COMMIT: \$\{\{ github\.event_name != 'workflow_run'/);
    assert.match(field, /repos\/openai\/codex\/releases\/tags\/\$TAG/);
    assert.match(field, /repos\/openai\/codex\/git\/ref\/tags\/\$TAG/);
    assert.match(field, /HAPPY_BUILD_COMMIT_SHA: \$\{\{ github\.event_name == 'workflow_run'/);
});
