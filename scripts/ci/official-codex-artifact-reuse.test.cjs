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
    artifactCargoLockPaths,
    artifactNameForFingerprint,
    artifactRunCandidates,
    assertSourceManifest,
    attestArtifact,
    collectPaginatedCollection,
    parseArtifactDigest,
    parseArtifactName,
    recipeFingerprint,
    selectReusableArtifact,
    verifyArchiveDigest,
    verifyExtractedArtifact,
} = require('./official-codex-artifact-reuse.cjs');

const happySha = 'a'.repeat(40);
const compiledHappySha = 'd'.repeat(40);
const codexSha = 'b'.repeat(40);
const repository = 'KNaiFen/happy';
const workflowId = 99;

function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}

function recipeInputs(overrides = {}) {
    return {
        fingerprintSchema: 1,
        manifestSchema: 5,
        runtimeBundleVersion: 2,
        repository: 'https://github.com/openai/codex',
        release: {
            tag: 'rust-v0.147.0',
            version: '0.147.0',
            commit: codexSha,
        },
        cargoLocks: {
            sourceSha256: '1'.repeat(64),
            resolvedSha256: '2'.repeat(64),
        },
        rust: {
            declaredToolchain: '1.91.1',
            rustcVerbose: 'rustc 1.91.1 (fixture)',
            cargoVerbose: 'cargo 1.91.1 (fixture)',
            target: 'x86_64-unknown-linux-gnu',
        },
        runner: {
            os: 'Linux',
            arch: 'X64',
            imageOs: 'ubuntu22',
            imageVersion: '20260801.1',
        },
        rustyV8: {
            version: '145.0.0',
            archiveSha256: '3'.repeat(64),
            bindingSha256: '4'.repeat(64),
            checksumsSha256: '5'.repeat(64),
        },
        linuxBuild: {
            packages: {
                binutils: '2.40-2ubuntu4.1',
                pkgConfig: '1.8.1-1ubuntu2',
                libcapDev: '1:2.66-4ubuntu0.1',
            },
            tools: {
                cc: 'cc (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0',
                cxx: 'c++ (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0',
                ld: 'GNU ld (GNU Binutils for Ubuntu) 2.38',
                strip: 'GNU strip (GNU Binutils for Ubuntu) 2.38',
                glibc: 'ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35',
            },
        },
        environment: {
            cargoIncremental: '0',
            cargoNetGitFetchWithCli: 'true',
            rustflags: '',
            cflags: '',
            cxxflags: '',
            cc: '',
            cxx: '',
        },
        recipeFiles: {
            workflowSha256: '6'.repeat(64),
            helperSha256: '7'.repeat(64),
        },
        artifactLayout: {
            binaries: artifactBinaryPaths,
            cargoLocks: {
                source: artifactCargoLockPaths.sourceCargoLockSha256,
                resolved: artifactCargoLockPaths.resolvedCargoLockSha256,
            },
        },
        ...overrides,
    };
}

function successfulRun(overrides = {}) {
    return {
        id: 42,
        workflow_id: workflowId,
        name: 'Happy monorepo CI',
        path: '.github/workflows/ci.yml',
        event: 'push',
        head_branch: 'main',
        head_sha: happySha,
        status: 'completed',
        conclusion: 'success',
        run_attempt: 1,
        repository: { full_name: repository },
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
    const fingerprint = recipeFingerprint(recipeInputs());
    return [{
        id: 73,
        name: artifactNameForFingerprint(fingerprint),
        expired: false,
        digest: `sha256:${'c'.repeat(64)}`,
        created_at: '2026-08-11T00:00:00Z',
        workflow_run: { id: 42, head_sha: happySha },
        ...overrides,
    }];
}

function manifest(binarySha256, overrides = {}) {
    const inputs = overrides.recipeInputs ?? recipeInputs();
    return {
        schemaVersion: 5,
        runtimeBundleVersion: 2,
        repository: 'https://github.com/openai/codex',
        happySourceSha: happySha,
        attestationRunId: 42,
        compiledHappySourceSha: compiledHappySha,
        compiledRunId: 41,
        recipeFingerprint: recipeFingerprint(inputs),
        recipeInputs: inputs,
        tag: 'rust-v0.147.0',
        version: '0.147.0',
        commit: codexSha,
        rustToolchain: '1.91.1',
        target: 'x86_64-unknown-linux-gnu',
        rustyV8Version: '145.0.0',
        sourceCargoLockSha256: inputs.cargoLocks.sourceSha256,
        resolvedCargoLockSha256: inputs.cargoLocks.resolvedSha256,
        bwrapSha256: binarySha256.bwrap,
        binarySha256,
        ...overrides,
    };
}

function writeArtifactRoot() {
    const root = mkdtempSync(join(tmpdir(), 'happy-official-codex-artifact-'));
    const contents = {
        codex: 'codex binary',
        codexCodeModeHost: 'code mode host binary',
        bwrap: 'bwrap binary',
        sourceLock: 'source lock',
        resolvedLock: 'resolved lock',
    };
    const binarySha256 = Object.fromEntries(
        Object.entries(contents)
            .filter(([key]) => key in artifactBinaryPaths)
            .map(([key, value]) => [key, digest(value)]),
    );
    for (const [key, relativePath] of Object.entries(artifactBinaryPaths)) {
        const path = join(root, relativePath);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, contents[key]);
    }
    writeFileSync(join(root, artifactCargoLockPaths.sourceCargoLockSha256), contents.sourceLock);
    writeFileSync(join(root, artifactCargoLockPaths.resolvedCargoLockSha256), contents.resolvedLock);
    const artifactManifest = manifest({
        ...binarySha256,
        bwrap: binarySha256.bwrap,
    }, {
        recipeInputs: recipeInputs({
            cargoLocks: {
                sourceSha256: digest(contents.sourceLock),
                resolvedSha256: digest(contents.resolvedLock),
            },
        }),
        sourceCargoLockSha256: digest(contents.sourceLock),
        resolvedCargoLockSha256: digest(contents.resolvedLock),
        bwrapSha256: binarySha256.bwrap,
    });
    writeFileSync(join(root, 'source.json'), `${JSON.stringify(artifactManifest)}\n`);
    return { root, artifactManifest };
}

test('canonical recipe fingerprints are stable and change for each build input', () => {
    const base = recipeInputs();
    assert.equal(recipeFingerprint(base), recipeFingerprint({
        ...base,
        release: { ...base.release },
        environment: { ...base.environment },
    }));
    assert.notEqual(recipeFingerprint(base), recipeFingerprint({
        ...base,
        runner: { ...base.runner, imageVersion: '20260802.1' },
    }));
    assert.notEqual(recipeFingerprint(base), recipeFingerprint({
        ...base,
        rustyV8: { ...base.rustyV8, archiveSha256: '8'.repeat(64) },
    }));
    assert.equal(parseArtifactName(artifactNameForFingerprint(recipeFingerprint(base))), recipeFingerprint(base));
});

test('selects only a successful first-attempt main CI artifact for the exact recipe', () => {
    const expectedArtifactName = artifactNameForFingerprint(recipeFingerprint(recipeInputs()));
    assert.deepEqual(selectReusableArtifact({
        run: successfulRun(),
        jobs: successfulGate(),
        artifacts: reusableArtifact(),
        expectedHeadSha: happySha,
        expectedArtifactName,
        expectedWorkflowId: workflowId,
        repository,
    }), {
        selected: true,
        reason: 'selected',
        sourceRunId: '42',
        headSha: happySha,
        artifactId: '73',
        artifactDigest: `sha256:${'c'.repeat(64)}`,
        artifactName: expectedArtifactName,
        createdAt: '2026-08-11T00:00:00Z',
        recipeFingerprint: recipeFingerprint(recipeInputs()),
    });
});

test('skips reuse when the exact CI run did not pass or did not select Official Codex', () => {
    assert.deepEqual(selectReusableArtifact({
        run: successfulRun({ conclusion: 'failure' }),
        jobs: [],
        artifacts: [],
        expectedHeadSha: happySha,
        expectedWorkflowId: workflowId,
        repository,
    }), {
        selected: false,
        reason: 'upstream-ci-not-success',
    });
    assert.deepEqual(selectReusableArtifact({
        run: successfulRun(),
        jobs: successfulGate(),
        artifacts: [],
        expectedHeadSha: happySha,
        expectedWorkflowId: workflowId,
        repository,
    }), {
        selected: false,
        reason: 'official-codex-not-selected',
    });
});

test('rejects untrusted producer identity, gate, attempt, and artifact lifetime mismatches', () => {
    const base = {
        jobs: successfulGate(),
        artifacts: reusableArtifact(),
        expectedHeadSha: happySha,
        expectedWorkflowId: workflowId,
        repository,
    };
    for (const [override, pattern] of [
        [{ event: 'pull_request' }, /push run/],
        [{ event: 'workflow_dispatch' }, /push run/],
        [{ path: '.github/workflows/other.yml' }, /canonical CI/],
        [{ workflow_id: workflowId + 1 }, /canonical CI/],
        [{ run_attempt: 2 }, /first CI run/],
        [{ repository: { full_name: 'attacker/fork' } }, /repository/],
        [{ head_sha: 'f'.repeat(40) }, /does not match/],
    ]) {
        assert.throws(() => selectReusableArtifact({ run: successfulRun(override), ...base }), pattern);
    }
    assert.throws(
        () => selectReusableArtifact({
            run: successfulRun(),
            jobs: [{ name: 'Required CI gate', status: 'completed', conclusion: 'skipped' }],
            artifacts: reusableArtifact(),
            expectedHeadSha: happySha,
            expectedWorkflowId: workflowId,
            repository,
        }),
        /did not succeed/,
    );
    assert.throws(
        () => selectReusableArtifact({ ...base, run: successfulRun(), jobs: successfulGate(), artifacts: reusableArtifact({ expired: true }) }),
        /expired/,
    );
    assert.throws(
        () => selectReusableArtifact({
            ...base,
            run: successfulRun(),
            artifacts: reusableArtifact({ workflow_run: { id: 41, head_sha: happySha } }),
        }),
        /workflow run does not match/,
    );
    assert.throws(
        () => selectReusableArtifact({
            ...base,
            run: successfulRun(),
            artifacts: reusableArtifact({ workflow_run: { id: 42, head_sha: 'f'.repeat(40) } }),
        }),
        /workflow SHA does not match/,
    );
});

test('reads every Actions API page and rejects duplicate recipe artifacts in one run', () => {
    const firstPage = [
        ...reusableArtifact(),
        ...Array.from({ length: 99 }, (_, index) => ({ name: `other-${index}` })),
    ];
    const secondPage = reusableArtifact({ id: 74, created_at: '2026-08-11T00:01:00Z' });
    const collected = collectPaginatedCollection({
        itemKey: 'artifacts',
        label: 'workflow artifacts',
        fetchPage: (page) => ({
            total_count: 101,
            artifacts: page === 1 ? firstPage : secondPage,
        }),
    });
    assert.equal(collected.length, 101);
    assert.equal(collected.at(-1).name, reusableArtifact()[0].name);
    assert.throws(() => selectReusableArtifact({
        run: successfulRun(),
        jobs: successfulGate(),
        artifacts: collected,
        expectedHeadSha: happySha,
        expectedWorkflowId: workflowId,
        repository,
    }), /exactly one/);
    assert.throws(() => collectPaginatedCollection({
        itemKey: 'jobs',
        label: 'workflow jobs',
        fetchPage: () => ({ total_count: 101, jobs: [] }),
    }), /pagination is incomplete/);
});

test('orders repository candidates newest first and ignores malformed entries', () => {
    const name = reusableArtifact()[0].name;
    const candidates = artifactRunCandidates([
        { ...reusableArtifact()[0], id: 1, created_at: '2026-08-10T00:00:00Z', workflow_run: { id: 10 } },
        { ...reusableArtifact()[0], id: 2, created_at: '2026-08-11T00:00:00Z', workflow_run: { id: 11 } },
        { name, id: 'bad', created_at: 'bad', workflow_run: { id: 12 }, expired: false },
        { name: 'other', id: 3, created_at: '2026-08-12T00:00:00Z', workflow_run: { id: 13 }, expired: false },
    ], name);
    assert.deepEqual(candidates.map((candidate) => candidate.runId), [11, 10]);
});

test('rejects malformed Actions artifact digests and names', () => {
    assert.equal(parseArtifactDigest('a'.repeat(64)), 'a'.repeat(64));
    assert.equal(parseArtifactDigest(`sha256:${'a'.repeat(64)}`), 'a'.repeat(64));
    for (const value of [undefined, 'sha1:abcd', `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`]) {
        assert.throws(() => parseArtifactDigest(value), /Artifact digest|sha256/);
    }
    assert.throws(() => parseArtifactName('official-codex-linux-x64'), /recipe fingerprint/);
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

test('binds the manifest, Cargo locks, and every extracted executable to the recipe and digests', () => {
    const { root } = writeArtifactRoot();
    try {
        const expected = recipeFingerprint(recipeInputs({
            cargoLocks: {
                sourceSha256: digest('source lock'),
                resolvedSha256: digest('resolved lock'),
            },
        }));
        assert.equal(
            verifyExtractedArtifact(root, {
                happySourceSha: happySha,
                codexCommit: codexSha,
                recipeFingerprint: expected,
                attestationRunId: 42,
            }).version,
            '0.147.0',
        );
        writeFileSync(join(root, artifactBinaryPaths.bwrap), 'tampered bwrap');
        assert.throws(
            () => verifyExtractedArtifact(root, { happySourceSha: happySha }),
            /does not match source.json/,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('re-attestation changes only the current Happy binding and preserves compiled provenance', () => {
    const { root, artifactManifest } = writeArtifactRoot();
    try {
        const newSha = 'e'.repeat(40);
        const updated = attestArtifact(root, newSha, 77, { codexCommit: codexSha });
        assert.equal(updated.happySourceSha, newSha);
        assert.equal(updated.attestationRunId, 77);
        assert.equal(updated.compiledHappySourceSha, artifactManifest.compiledHappySourceSha);
        assert.equal(updated.compiledRunId, artifactManifest.compiledRunId);
        assert.equal(updated.recipeFingerprint, artifactManifest.recipeFingerprint);
        assert.deepEqual(updated.binarySha256, artifactManifest.binarySha256);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('requires schema-5 attestation fields and rejects recipe or binary tampering', () => {
    const binarySha256 = {
        codex: '1'.repeat(64),
        codexCodeModeHost: '2'.repeat(64),
        bwrap: '3'.repeat(64),
    };
    assert.throws(
        () => assertSourceManifest({
            ...manifest(binarySha256),
            schemaVersion: 4,
        }, { happySourceSha: happySha }),
        /schema is unsupported/,
    );
    assert.throws(
        () => assertSourceManifest(manifest(binarySha256, { recipeFingerprint: 'f'.repeat(64) }), { happySourceSha: happySha }),
        /fingerprint does not match/,
    );
    assert.throws(
        () => assertSourceManifest(manifest({ ...binarySha256, extra: '4'.repeat(64) }), { happySourceSha: happySha }),
        /keys are unexpected/,
    );
});

test('workflow contracts preserve trusted cross-run provenance and exact Field consumption', () => {
    const workflowRoot = join(__dirname, '../../.github/workflows');
    const sourceBuild = readFileSync(join(workflowRoot, 'build-official-codex-source.yml'), 'utf8');
    const ci = readFileSync(join(workflowRoot, 'ci.yml'), 'utf8');
    const field = readFileSync(join(workflowRoot, 'codex-android-field-e2e.yml'), 'utf8');

    assert.match(sourceBuild, /permissions:\n  actions: read\n  contents: read/);
    assert.match(sourceBuild, /group: official-codex-source-\$\{\{ github\.repository \}\}/);
    assert.doesNotMatch(sourceBuild, /official-codex-source-\$\{\{ github\.repository \}\}-\$\{\{ github\.ref \}\}/);
    assert.match(sourceBuild, /official-codex-artifact-reuse\.cjs fingerprint/);
    assert.match(sourceBuild, /official-codex-artifact-reuse\.cjs find/);
    assert.match(sourceBuild, /official-codex-artifact-reuse\.cjs attest/);
    assert.ok(
        sourceBuild.indexOf('rustc -vV > "$RUNNER_TEMP/rustc-vV.txt"')
        > sourceBuild.indexOf('rustup override set'),
        'recipe compiler facts must be captured after the source toolchain override',
    );
    assert.match(sourceBuild, /schemaVersion: 5/);
    assert.match(sourceBuild, /schemaVersion: 4, commit: \$commit, resolvedCargoLockSha256/);
    assert.match(sourceBuild, /compiledHappySourceSha: \$compiledHappySourceSha, compiledRunId: \$compiledRunId/);
    assert.equal((sourceBuild.match(/jq -r '\.schemaVersion' "\$MARKER"\)" = 4/g) ?? []).length, 2);
    assert.match(sourceBuild, /compiled_happy_source_sha=%s.*COMPILED_HAPPY_SOURCE_SHA/s);
    assert.match(sourceBuild, /compiled_happy_source_sha: \$\{\{ steps\.verified_reuse\.outputs\.compiled_happy_source_sha \|\| steps\.cached_binary\.outputs\.compiled_happy_source_sha \|\| github\.sha \}\}/);
    assert.match(sourceBuild, /compiled_run_id: \$\{\{ steps\.verified_reuse\.outputs\.compiled_run_id \|\| steps\.cached_binary\.outputs\.compiled_run_id \|\| github\.run_id \}\}/);
    assert.match(sourceBuild, /--argjson compiledRunId "\$COMPILED_RUN_ID"/);
    assert.doesNotMatch(sourceBuild, /--arg compiledHappySourceSha "\$HAPPY_SOURCE_SHA"/);
    assert.match(sourceBuild, /name: \$\{\{ steps\.recipe\.outputs\.artifact_name \}\}/);
    assert.match(sourceBuild, /artifact_id: \$\{\{ steps\.upload\.outputs\.artifact-id \|\| steps\.reuse\.outputs\.artifact_id \}\}/);
    assert.match(sourceBuild, /compiledHappySourceSha/);
    assert.equal((ci.match(/official-codex-artifact-reuse\.cjs download/g) ?? []).length, 2);
    assert.equal((ci.match(/needs\.official_codex\.outputs\.attested_happy_source_sha/g) ?? []).length, 2);
    assert.equal((ci.match(/needs\.official_codex\.outputs\.recipe_fingerprint/g) ?? []).length, 2);
    assert.doesNotMatch(ci, /official-codex-artifact-reuse\.cjs verify\n\s+"\$RUNNER_TEMP\/official-codex" "\$\{\{ github\.sha \}\}"/);
    assert.match(field, /workflow_run:\n\s+workflows: \["Happy monorepo CI"\]\n\s+types: \[completed\]/);
    assert.doesNotMatch(field, /^  push:/m);
    assert.match(field, /HAPPY_OFFICIAL_CODEX_ATTESTED_SHA/);
    assert.match(field, /HAPPY_OFFICIAL_CODEX_RECIPE_FINGERPRINT/);
    assert.match(field, /official-codex-artifact-reuse\.cjs resolve/);
    assert.match(field, /official-codex-artifact-reuse\.cjs verify/);
});
