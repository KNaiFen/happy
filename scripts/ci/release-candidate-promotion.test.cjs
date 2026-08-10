const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const candidatePolicy = require('./release-candidate-policy.json');

const {
    candidateArtifactName,
    fetchCandidateArtifact,
    finalArtifactName,
    normalizeArtifactDigest,
    payloadPaths,
    rehearsalArtifactName,
    validateCandidateArtifactMetadata,
    validateCandidateManifest,
    verifyExtractedCandidate,
    writeCandidateManifest,
    writePromotionReceipt,
} = require('./release-candidate-promotion.cjs');

const sourceSha = 'a'.repeat(40);
const artifactDigest = 'b'.repeat(64);
const repository = 'KNaiFen/happy';
const routerRunId = 123456;
const repositoryRoot = path.resolve(__dirname, '../..');

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function temporaryCandidate(product, version) {
    const directory = mkdtempSync(path.join(tmpdir(), `happy-${product}-candidate-`));
    for (const [index, payloadPath] of payloadPaths(product, version).entries()) {
        writeFileSync(path.join(directory, payloadPath), `${product}-${version}-${index}`);
    }
    return directory;
}

function candidateMetadata(overrides = {}) {
    return {
        id: 987654,
        name: candidateArtifactName('cli', '1.4.50', sourceSha),
        expired: false,
        digest: `sha256:${artifactDigest}`,
        size_in_bytes: 1024,
        workflow_run: { id: routerRunId },
        ...overrides,
    };
}

function responseBody(chunks, onCancel) {
    let index = 0;
    let cancelled = false;
    const cancel = async () => {
        if (!cancelled) {
            cancelled = true;
            onCancel?.();
        }
    };
    return {
        cancel,
        getReader() {
            return {
                cancel,
                async read() {
                    if (cancelled || index >= chunks.length) {
                        return { done: true, value: undefined };
                    }
                    const value = chunks[index];
                    index += 1;
                    return { done: false, value };
                },
                releaseLock() {},
            };
        },
    };
}

function response(payload, options = {}) {
    const status = options.status ?? 200;
    const ok = options.ok ?? (status >= 200 && status < 300);
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
    const chunks = (options.chunks ?? [bytes]).map((chunk) => Buffer.from(chunk));
    const headers = new Map(
        Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]),
    );
    return {
        body: responseBody(chunks, options.onCancel),
        headers: {
            get(name) {
                return headers.get(name.toLowerCase()) ?? null;
            },
        },
        ok,
        status,
        async json() {
            throw new Error('response.json() must not be used');
        },
        async arrayBuffer() {
            throw new Error('response.arrayBuffer() must not be used');
        },
    };
}

test('writes and verifies strict source-bound manifests for every release product', () => {
    const products = [
        ['cli', '1.4.50', 'happy-cli-1.4.50'],
        ['android', '1.11.46', 'happy-app-1.11.46-android-arm64-v8a-no-ota'],
        ['relay', '1.1.42', 'happy-relay-server-1.1.42-debian13-amd64'],
        ['agent', '0.1.10', 'happy-agent-0.1.10'],
    ];

    for (const [product, version, finalName] of products) {
        const directory = temporaryCandidate(product, version);
        try {
            const manifest = writeCandidateManifest({ directory, product, sourceSha, version });
            assert.equal(manifest.product, product);
            assert.equal(manifest.version, version);
            assert.equal(manifest.sourceSha, sourceSha);
            assert.deepEqual(verifyExtractedCandidate({ directory, product, sourceSha, version }), manifest);
            assert.equal(finalArtifactName(product, version), finalName);
            assert.equal(
                candidateArtifactName(product, version, sourceSha),
                `release-candidate-${product}-${version}-${sourceSha}`,
            );
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }
});

test('rejects a candidate with an extra entry or a tampered payload', () => {
    const directory = temporaryCandidate('cli', '1.4.50');
    try {
        writeCandidateManifest({ directory, product: 'cli', sourceSha, version: '1.4.50' });
        writeFileSync(path.join(directory, 'unexpected.txt'), 'unexpected');
        assert.throws(
            () => verifyExtractedCandidate({ directory, product: 'cli', sourceSha, version: '1.4.50' }),
            /Candidate archive layout mismatch/,
        );
        rmSync(path.join(directory, 'unexpected.txt'));
        writeFileSync(path.join(directory, 'happy-1.4.50.tgz'), 'tampered');
        assert.throws(
            () => verifyExtractedCandidate({ directory, product: 'cli', sourceSha, version: '1.4.50' }),
            /Candidate payload (size|digest) mismatch/,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('rejects a manifest payload above the shared product policy', () => {
    assert.throws(
        () => validateCandidateManifest({
            schema: 1,
            product: 'agent',
            version: '0.1.10',
            sourceSha,
            payloads: [{
                path: 'happy-agent-0.1.10.tgz',
                sha256: 'c'.repeat(64),
                size: 16 * 1024 * 1024 + 1,
            }],
        }, {
            product: 'agent',
            sourceSha,
            version: '0.1.10',
        }),
        /Invalid candidate payload size/,
    );
});

test('android payload policy keeps headroom above the latest rehearsed APK', () => {
    const rehearsedApkBytes = 125_068_159;
    const maxBytes = candidatePolicy.products.android.payloads[0].maxBytes;
    assert.ok(rehearsedApkBytes * 5 <= maxBytes * 4, 'Android rehearsal must stay below 80% of its payload limit');
    assert.doesNotThrow(() => validateCandidateManifest({
        schema: 1,
        product: 'android',
        version: '1.11.45',
        sourceSha,
        payloads: [{
            path: 'happy-app-1.11.45-android-arm64-v8a-no-ota.apk',
            sha256: 'c'.repeat(64),
            size: rehearsedApkBytes,
        }],
    }, {
        product: 'android',
        sourceSha,
        version: '1.11.45',
    }));
});

test('rejects malformed digest formats', () => {
    assert.equal(normalizeArtifactDigest(artifactDigest), artifactDigest);
    assert.equal(normalizeArtifactDigest(`sha256:${artifactDigest}`), artifactDigest);
    for (const invalid of ['', 'sha512:' + artifactDigest, `sha256:${artifactDigest.toUpperCase()}`, 'a'.repeat(63)]) {
        assert.throws(() => normalizeArtifactDigest(invalid), /Invalid artifact digest/);
    }
});

test('requires an exact unexpired candidate artifact from this router run', () => {
    const options = {
        artifactDigest,
        artifactId: 987654,
        artifactName: candidateArtifactName('cli', '1.4.50', sourceSha),
        maxArchiveBytes: 128 * 1024 * 1024,
        routerRunId,
    };
    assert.deepEqual(validateCandidateArtifactMetadata(candidateMetadata(), options), {
        artifactId: 987654,
        digest: artifactDigest,
        sizeInBytes: 1024,
    });

    for (const [name, overrides, expected] of [
        ['id', { id: 1 }, /id mismatch/],
        ['name', { name: 'other' }, /name mismatch/],
        ['expiration', { expired: true }, /expired/],
        ['workflow run', { workflow_run: { id: 9 } }, /workflow run mismatch/],
        ['API digest', { digest: 'sha256:' + 'c'.repeat(64) }, /does not match/],
    ]) {
        assert.throws(() => validateCandidateArtifactMetadata(candidateMetadata(overrides), options), expected, name);
    }
});

test('downloads only the API-verified candidate ZIP and rejects tampering', async () => {
    const archive = Buffer.from('candidate zip bytes');
    const archiveDigest = sha256(archive);
    const metadata = candidateMetadata({ digest: `sha256:${archiveDigest}`, size_in_bytes: archive.length });
    const requests = [];
    const result = await fetchCandidateArtifact({
        apiUrl: 'https://api.github.test/api/v3',
        artifactDigest: archiveDigest,
        artifactId: metadata.id,
        artifactName: metadata.name,
        fetchImpl: async (url, init) => {
            requests.push({ init, url: String(url) });
            if (String(url).endsWith('/zip')) {
                return response(Buffer.alloc(0), {
                    headers: { location: '/signed-download/candidate.zip?signature=redacted' },
                    status: 302,
                });
            }
            if (String(url).includes('/signed-download/')) {
                return response(archive, {
                    headers: { 'content-length': archive.length },
                    chunks: [archive.subarray(0, 4), archive.subarray(4)],
                });
            }
            const metadataBytes = Buffer.from(JSON.stringify(metadata));
            return response(metadata, {
                chunks: [metadataBytes.subarray(0, 7), metadataBytes.subarray(7)],
            });
        },
        product: 'cli',
        repository,
        routerRunId,
        sourceSha,
        token: 'test-token',
        version: '1.4.50',
    });
    assert.equal(result.archive.toString('utf8'), 'candidate zip bytes');
    assert.equal(result.archiveSha256, archiveDigest);
    assert.equal(requests.length, 3);
    assert.match(requests[0].url, /\/api\/v3\/repos\/KNaiFen\/happy\/actions\/artifacts\/987654$/);
    assert.equal(requests[0].init.redirect, 'error');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer test-token');
    assert.match(requests[1].url, /\/api\/v3\/repos\/KNaiFen\/happy\/actions\/artifacts\/987654\/zip$/);
    assert.equal(requests[1].init.redirect, 'manual');
    assert.equal(requests[1].init.headers.Authorization, 'Bearer test-token');
    assert.match(requests[2].url, /\/signed-download\/candidate\.zip\?signature=redacted$/);
    assert.equal(requests[2].init.redirect, 'manual');
    assert.equal(requests[2].init.headers.Authorization, undefined);

    await assert.rejects(
        fetchCandidateArtifact({
            apiUrl: 'https://api.github.test/api/v3',
            artifactDigest: archiveDigest,
            artifactId: metadata.id,
            artifactName: metadata.name,
            fetchImpl: async (url) => {
                if (String(url).endsWith('/zip')) {
                    return response(Buffer.alloc(archive.length, 0x74));
                }
                return response(metadata);
            },
            product: 'cli',
            repository,
            routerRunId,
            sourceSha,
            token: 'test-token',
            version: '1.4.50',
        }),
        /archive digest does not match/,
    );
});

test('bounds metadata reads and requires a streaming response body', async () => {
    const options = {
        apiUrl: 'https://api.github.test/api/v3',
        artifactDigest,
        artifactId: 987654,
        artifactName: candidateArtifactName('cli', '1.4.50', sourceSha),
        product: 'cli',
        repository,
        routerRunId,
        sourceSha,
        token: 'test-token',
        version: '1.4.50',
    };
    let contentLengthCancelled = false;
    await assert.rejects(
        fetchCandidateArtifact({
            ...options,
            fetchImpl: async () => response(candidateMetadata(), {
                headers: { 'content-length': 1024 * 1024 + 1 },
                onCancel: () => {
                    contentLengthCancelled = true;
                },
            }),
        }),
        /metadata Content-Length exceeds/,
    );
    assert.equal(contentLengthCancelled, true);

    let bodyCancelled = false;
    await assert.rejects(
        fetchCandidateArtifact({
            ...options,
            fetchImpl: async () => response(Buffer.alloc(1024 * 1024 + 1), {
                chunks: [Buffer.alloc(1024 * 1024), Buffer.alloc(1)],
                onCancel: () => {
                    bodyCancelled = true;
                },
            }),
        }),
        /metadata body exceeds/,
    );
    assert.equal(bodyCancelled, true);

    await assert.rejects(
        fetchCandidateArtifact({
            ...options,
            fetchImpl: async () => response(Buffer.from('{')),
        }),
        /metadata is not valid JSON/,
    );
    await assert.rejects(
        fetchCandidateArtifact({
            ...options,
            fetchImpl: async () => ({
                arrayBuffer: async () => Buffer.from('{}').buffer,
                body: null,
                headers: { get: () => null },
                ok: true,
                status: 200,
            }),
        }),
        /metadata response body is unavailable/,
    );
});

test('rejects unsafe artifact redirects and caps redirect traversal', async () => {
    const baseOptions = {
        apiUrl: 'https://api.github.test/api/v3',
        artifactDigest,
        artifactId: 987654,
        artifactName: candidateArtifactName('cli', '1.4.50', sourceSha),
        product: 'cli',
        repository,
        routerRunId,
        sourceSha,
        token: 'test-token',
        version: '1.4.50',
    };
    for (const [location, expected] of [
        [undefined, /missing Location/],
        ['http://downloads.github.test/candidate.zip', /must use HTTPS/],
        ['https://user:pass@downloads.github.test/candidate.zip', /must not include credentials/],
    ]) {
        let redirectCancelled = false;
        await assert.rejects(
            fetchCandidateArtifact({
                ...baseOptions,
                fetchImpl: async (url) => {
                    if (String(url).endsWith('/zip')) {
                        return response(Buffer.alloc(0), {
                            headers: location === undefined ? {} : { location },
                            onCancel: () => {
                                redirectCancelled = true;
                            },
                            status: 302,
                        });
                    }
                    return response(candidateMetadata());
                },
            }),
            expected,
        );
        assert.equal(redirectCancelled, true);
    }

    let downloadRequests = 0;
    await assert.rejects(
        fetchCandidateArtifact({
            ...baseOptions,
            fetchImpl: async (url) => {
                if (!String(url).endsWith('/actions/artifacts/987654')) {
                    downloadRequests += 1;
                    return response(Buffer.alloc(0), {
                        headers: { location: `/redirect-${downloadRequests}` },
                        status: 302,
                    });
                }
                return response(candidateMetadata());
            },
        }),
        /exceeded 5 redirects/,
    );
    assert.equal(downloadRequests, 6);
});

test('validates every redirect hop and strips authorization after the API entry point', async () => {
    const baseOptions = {
        apiUrl: 'https://api.github.test/api/v3',
        artifactDigest,
        artifactId: 987654,
        artifactName: candidateArtifactName('cli', '1.4.50', sourceSha),
        product: 'cli',
        repository,
        routerRunId,
        sourceSha,
        token: 'test-token',
        version: '1.4.50',
    };
    for (const location of [
        'http://downloads.github.test/second-hop',
        'https://user:pass@downloads.github.test/second-hop',
    ]) {
        const requests = [];
        await assert.rejects(
            fetchCandidateArtifact({
                ...baseOptions,
                fetchImpl: async (url, init) => {
                    requests.push({ init, url: String(url) });
                    if (String(url).endsWith('/actions/artifacts/987654')) {
                        return response(candidateMetadata());
                    }
                    if (requests.length === 2) {
                        return response(Buffer.alloc(0), {
                            headers: { location: '/first-hop' },
                            status: 302,
                        });
                    }
                    return response(Buffer.alloc(0), { headers: { location }, status: 302 });
                },
            }),
            /HTTPS|credentials/,
        );
        assert.equal(requests.length, 3);
        assert.equal(requests[1].init.headers.Authorization, 'Bearer test-token');
        assert.equal(requests[2].init.headers.Authorization, undefined);
        assert.equal(requests[2].init.redirect, 'manual');
    }

    const archive = Buffer.from('two-hop candidate zip');
    const archiveDigest = sha256(archive);
    const requests = [];
    await fetchCandidateArtifact({
        ...baseOptions,
        artifactDigest: archiveDigest,
        fetchImpl: async (url, init) => {
            requests.push({ init, url: String(url) });
            if (String(url).endsWith('/actions/artifacts/987654')) {
                return response(candidateMetadata({ digest: `sha256:${archiveDigest}`, size_in_bytes: archive.length }));
            }
            if (requests.length === 2) {
                return response(Buffer.alloc(0), { headers: { location: '/first-hop' }, status: 302 });
            }
            if (requests.length === 3) {
                return response(Buffer.alloc(0), {
                    headers: { location: 'https://downloads.github.test/final-hop' },
                    status: 302,
                });
            }
            return response(archive);
        },
    });
    assert.equal(requests.length, 4);
    assert.equal(requests[0].init.headers.Authorization, 'Bearer test-token');
    assert.equal(requests[1].init.headers.Authorization, 'Bearer test-token');
    for (const request of requests.slice(2)) {
        assert.equal(request.init.headers.Authorization, undefined);
        assert.equal(request.init.redirect, 'manual');
    }
});

test('cancels non-success API and archive response bodies before failing', async () => {
    const options = {
        apiUrl: 'https://api.github.test/api/v3',
        artifactDigest,
        artifactId: 987654,
        artifactName: candidateArtifactName('cli', '1.4.50', sourceSha),
        product: 'cli',
        repository,
        routerRunId,
        sourceSha,
        token: 'test-token',
        version: '1.4.50',
    };
    let metadataCancelled = false;
    await assert.rejects(
        fetchCandidateArtifact({
            ...options,
            fetchImpl: async () => response(Buffer.alloc(0), {
                onCancel: () => {
                    metadataCancelled = true;
                },
                status: 502,
            }),
        }),
        /metadata request failed with status 502/,
    );
    assert.equal(metadataCancelled, true);

    let archiveCancelled = false;
    await assert.rejects(
        fetchCandidateArtifact({
            ...options,
            fetchImpl: async (url) => {
                if (String(url).endsWith('/zip')) {
                    return response(Buffer.alloc(0), {
                        onCancel: () => {
                            archiveCancelled = true;
                        },
                        status: 503,
                    });
                }
                return response(candidateMetadata());
            },
        }),
        /download failed with status 503/,
    );
    assert.equal(archiveCancelled, true);
});

test('requires an HTTPS API root without credentials or query state', async () => {
    const metadata = candidateMetadata({ size_in_bytes: 1 });
    for (const apiUrl of ['http://api.github.test', 'https://user:pass@api.github.test', 'https://api.github.test?token=leak']) {
        await assert.rejects(
            fetchCandidateArtifact({
                apiUrl,
                artifactDigest,
                artifactId: metadata.id,
                artifactName: metadata.name,
                fetchImpl: async () => response(metadata),
                product: 'cli',
                repository,
                routerRunId,
                sourceSha,
                token: 'test-token',
                version: '1.4.50',
            }),
            /HTTPS|credentials|query|fragment/,
        );
    }
});

test('rejects an Actions artifact whose API size exceeds the product limit', () => {
    assert.throws(
        () => validateCandidateArtifactMetadata(candidateMetadata({ size_in_bytes: 256 * 1024 * 1024 }), {
            artifactDigest,
            artifactId: 987654,
            artifactName: candidateArtifactName('cli', '1.4.50', sourceSha),
            maxArchiveBytes: 192 * 1024 * 1024,
            routerRunId,
        }),
        /archive size limit/,
    );
});

test('writes a digest-bound promotion receipt from a verified candidate without rebuilding payloads', () => {
    const directory = temporaryCandidate('relay', '1.1.42');
    try {
        const manifest = writeCandidateManifest({ directory, product: 'relay', sourceSha, version: '1.1.42' });
        const receipt = writePromotionReceipt({
            candidateArtifactDigest: `sha256:${artifactDigest}`,
            candidateArtifactId: 987654,
            candidateArtifactName: candidateArtifactName('relay', '1.1.42', sourceSha),
            candidateArchiveSha256: artifactDigest,
            directory,
            product: 'relay',
            promotionArtifactName: finalArtifactName('relay', '1.1.42'),
            promotionMode: 'release',
            promotionRetentionDays: 30,
            routerRunId,
            sourceSha,
            version: '1.1.42',
        });
        assert.equal(receipt.sourceSha, sourceSha);
        assert.equal(receipt.schema, 2);
        assert.equal(receipt.candidate.artifactId, 987654);
        assert.equal(
            receipt.candidate.artifactDigest,
            `sha256:${receipt.candidate.archiveSha256}`,
        );
        assert.deepEqual(receipt.payloads, manifest.payloads);
        assert.deepEqual(receipt.promotion, {
            artifactName: 'happy-relay-server-1.1.42-debian13-amd64',
            mode: 'release',
            retentionDays: 30,
        });
        assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'release-promotion.json'), 'utf8')), receipt);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('writes an explicitly source-bound short-lived rehearsal receipt', () => {
    const directory = temporaryCandidate('agent', '0.1.10');
    const artifactName = rehearsalArtifactName('agent', '0.1.10', sourceSha, routerRunId);
    try {
        writeCandidateManifest({ directory, product: 'agent', sourceSha, version: '0.1.10' });
        const receipt = writePromotionReceipt({
            candidateArtifactDigest: artifactDigest,
            candidateArtifactId: 987654,
            candidateArtifactName: candidateArtifactName('agent', '0.1.10', sourceSha),
            candidateArchiveSha256: artifactDigest,
            directory,
            product: 'agent',
            promotionArtifactName: artifactName,
            promotionMode: 'rehearsal',
            promotionRetentionDays: 1,
            routerRunId,
            sourceSha,
            version: '0.1.10',
        });
        assert.deepEqual(receipt.promotion, {
            artifactName,
            mode: 'rehearsal',
            retentionDays: 1,
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('rejects promotion targets whose mode, name, or retention can be confused with a release', () => {
    for (const [overrides, expected] of [
        [{ promotionMode: 'other' }, /Invalid promotion mode/],
        [{ promotionArtifactName: 'happy-agent-0.1.10' }, /rehearsal artifact name does not match/],
        [{ promotionRetentionDays: 30 }, /Invalid rehearsal artifact retention/],
        [{
            promotionArtifactName: finalArtifactName('agent', '0.1.10'),
            promotionMode: 'release',
            promotionRetentionDays: 1,
        }, /Invalid release artifact retention/],
        [{
            promotionMode: 'release',
            promotionRetentionDays: 30,
        }, /release artifact name does not match/],
    ]) {
        const directory = temporaryCandidate('agent', '0.1.10');
        try {
            writeCandidateManifest({ directory, product: 'agent', sourceSha, version: '0.1.10' });
            assert.throws(
                () => writePromotionReceipt({
                    candidateArtifactDigest: artifactDigest,
                    candidateArtifactId: 987654,
                    candidateArtifactName: candidateArtifactName('agent', '0.1.10', sourceSha),
                    candidateArchiveSha256: artifactDigest,
                    directory,
                    product: 'agent',
                    promotionArtifactName: rehearsalArtifactName('agent', '0.1.10', sourceSha, routerRunId),
                    promotionMode: 'rehearsal',
                    promotionRetentionDays: 1,
                    routerRunId,
                    sourceSha,
                    version: '0.1.10',
                    ...overrides,
                }),
                expected,
            );
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }
});

test('rejects a promotion receipt when the downloaded archive digest differs', () => {
    const directory = temporaryCandidate('agent', '0.1.10');
    try {
        writeCandidateManifest({ directory, product: 'agent', sourceSha, version: '0.1.10' });
        assert.throws(
            () => writePromotionReceipt({
                candidateArtifactDigest: artifactDigest,
                candidateArtifactId: 987654,
                candidateArtifactName: candidateArtifactName('agent', '0.1.10', sourceSha),
                candidateArchiveSha256: 'c'.repeat(64),
                directory,
                product: 'agent',
                routerRunId,
                sourceSha,
                version: '0.1.10',
            }),
            /archive SHA-256 does not match candidate artifact digest/,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('release workflows expose short-lived candidates and the router promotes without builds', () => {
    function assertPinnedWorkflowActions(workflow, name) {
        const references = [...workflow.matchAll(/^\s*uses:\s+([^\s#]+)@([^\s#]+)/gm)];
        for (const [, action, ref] of references) {
            assert.match(ref, /^[0-9a-f]{40}$/, `${name} has an unpinned ${action} action`);
        }
        const checkoutCount = (workflow.match(/uses:\s+actions\/checkout@/g) ?? []).length;
        const nonPersistedCheckoutCount = (workflow.match(/persist-credentials:\s+false/g) ?? []).length;
        assert.equal(nonPersistedCheckoutCount, checkoutCount, `${name} checkout credentials are not fully disabled`);
    }

    const workflows = [
        ['cli', 'build-cli-release.yml'],
        ['android', 'build-android-release.yml'],
        ['relay', 'build-debian13-relay-release.yml'],
        ['agent', 'build-happy-agent-release.yml'],
    ];

    for (const [product, workflowName] of workflows) {
        const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows', workflowName), 'utf8');
        assertPinnedWorkflowActions(workflow, workflowName);
        assert.match(workflow, /workflow_call:[\s\S]*candidate_artifact_id:/);
        assert.match(workflow, /candidate_artifact_digest:/);
        assert.match(workflow, /candidate_artifact_name:/);
        assert.match(workflow, /id: upload_candidate/);
        assert.match(workflow, /release-candidate-promotion\.cjs write-manifest/);
        assert.match(workflow, new RegExp(`release-candidate-${product}-\\$\\{VERSION\\}-\\$\\{SOURCE_SHA\\}`));
        assert.match(workflow, /retention-days: 7/);
        assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/);
        assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/);
        assert.doesNotMatch(workflow, /uses: (?:actions|pnpm|android-actions|gradle|oven-sh|docker|aquasecurity)\/[^\n]+@v/);
        assert.doesNotMatch(workflow, /\n  push:\n/);
        if (product === 'relay') {
            assert.match(workflow, /DOCKER_BUILD_RECORD_UPLOAD: "false"/);
        }
    }

    const router = readFileSync(
        path.join(repositoryRoot, '.github/workflows/release-after-required-ci.yml'),
        'utf8',
    );
    assertPinnedWorkflowActions(router, 'release-after-required-ci.yml');
    for (const product of workflows.map(([name]) => name)) {
        const job = new RegExp(`  promote_${product}:([\\s\\S]*?)(?=\\n  promote_|$)`).exec(router)?.[1];
        assert.ok(job, `missing promotion job for ${product}`);
        assert.match(job, /uses: \.\/\.github\/workflows\/promote-release-candidate\.yml/);
        assert.match(job, new RegExp(`product: ${product}`));
        assert.match(job, new RegExp(`candidate_artifact_id: \\$\\{\\{ needs\\.${product}\\.outputs\\.candidate_artifact_id \\}\\}`));
        assert.match(job, /promotion_mode: release/);
        assert.match(job, /promotion_retention_days: 30/);
        assert.doesNotMatch(job, /\n\s+run:|actions\/upload-artifact|release-candidate-promotion\.cjs/);
    }
    assert.match(router, /actions: read/);
    assert.match(router, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/);
    assert.doesNotMatch(router, /actions\/upload-artifact|release-candidate-promotion\.cjs/);

    const promotionWorkflow = readFileSync(
        path.join(repositoryRoot, '.github/workflows/promote-release-candidate.yml'),
        'utf8',
    );
    assertPinnedWorkflowActions(promotionWorkflow, 'promote-release-candidate.yml');
    assert.match(promotionWorkflow, /on:\n  workflow_call:\n/);
    assert.match(promotionWorkflow, /promotion_mode:\n        required: true\n        type: string/);
    assert.match(promotionWorkflow, /promotion_retention_days:\n        required: true\n        type: number/);
    assert.match(promotionWorkflow, /release-candidate-promotion\.cjs download/);
    assert.match(promotionWorkflow, /release-candidate-promotion\.cjs validate-target/);
    assert.match(promotionWorkflow, /release_candidate_archive\.py extract/);
    assert.match(promotionWorkflow, /release-candidate-promotion\.cjs verify /);
    assert.match(promotionWorkflow, /release-candidate-promotion\.cjs write-receipt/);
    assert.match(promotionWorkflow, /id: upload_promoted/);
    assert.match(promotionWorkflow, /retention-days: \$\{\{ inputs\.promotion_retention_days \}\}/);
    assert.match(promotionWorkflow, /persist-credentials: false/);
    assert.doesNotMatch(promotionWorkflow, /\bpnpm\b|\bgradlew\b|\bdocker\b|\bpack\b|\bunzip\b/);

    const rehearsal = readFileSync(
        path.join(repositoryRoot, '.github/workflows/release-candidate-rehearsal.yml'),
        'utf8',
    );
    assertPinnedWorkflowActions(rehearsal, 'release-candidate-rehearsal.yml');
    assert.match(rehearsal, /on:\n  workflow_dispatch:\n/);
    assert.doesNotMatch(rehearsal, /\n  (?:push|pull_request|workflow_run):\n/);
    assert.match(rehearsal, /github\.run_attempt == 1/);
    assert.match(rehearsal, /github\.ref == 'refs\/heads\/main'/);
    assert.match(rehearsal, /inputs\.source_sha == github\.sha/);
    assert.match(rehearsal, /EXPECTED_SOURCE_SHA: \$\{\{ inputs\.source_sha \}\}/);
    assert.match(rehearsal, /SOURCE_RUN_ID: \$\{\{ inputs\.source_run_id \}\}/);
    assert.match(rehearsal, /node scripts\/ci\/verify-release-source-gate\.cjs/);
    assert.equal(
        [...rehearsal.matchAll(/uses: \.\/\.github\/workflows\/build-[^\n]+/g)].length,
        4,
    );
    assert.equal(
        [...rehearsal.matchAll(/uses: \.\/\.github\/workflows\/promote-release-candidate\.yml/g)].length,
        4,
    );
    assert.equal([...rehearsal.matchAll(/promotion_mode: rehearsal/g)].length, 4);
    assert.equal([...rehearsal.matchAll(/promotion_retention_days: 1/g)].length, 4);
    assert.match(rehearsal, /name: Release rehearsal gate/);
    assert.match(rehearsal, /require_path cli/);
    assert.match(rehearsal, /cli\|android\|relay\|agent/);
    assert.match(rehearsal, /ANDROID_KEYSTORE_BASE64: \$\{\{ secrets\.ANDROID_KEYSTORE_BASE64 \}\}/);
    assert.doesNotMatch(rehearsal, /secrets: inherit/);
    const ciWorkflow = readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    assertPinnedWorkflowActions(ciWorkflow, 'ci.yml');
    const officialCodexWorkflow = readFileSync(
        path.join(repositoryRoot, '.github/workflows/build-official-codex-source.yml'),
        'utf8',
    );
    assertPinnedWorkflowActions(officialCodexWorkflow, 'build-official-codex-source.yml');
    assert.match(ciWorkflow, /node --test scripts\/ci\/release-candidate-promotion\.test\.cjs/);
    const transportJob = /  codex_transport_scenarios:([\s\S]*?)(?=\n  codex_official_app_server:)/.exec(ciWorkflow)?.[1];
    assert.ok(transportJob, 'missing Codex transport scenario job');
    assert.match(transportJob, /timeout --kill-after=30s 5m pnpm install --frozen-lockfile/);
    assert.match(ciWorkflow, /python3 scripts\/ci\/release_candidate_archive_test\.py/);
});
