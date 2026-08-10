#!/usr/bin/env node

const { createHash } = require('node:crypto');
const {
    appendFileSync,
    lstatSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} = require('node:fs');
const path = require('node:path');
const CANDIDATE_POLICY = require('./release-candidate-policy.json');

const CANDIDATE_SCHEMA = 1;
const MAX_GITHUB_API_METADATA_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]+$/;

const PRODUCT_CONFIGS = Object.freeze(CANDIDATE_POLICY.products);

function requireValue(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function assertObject(value, name) {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
}

function assertExactKeys(value, keys, name) {
    assertObject(value, name);
    const actualKeys = Object.keys(value).sort();
    const expectedKeys = [...keys].sort();
    requireValue(
        actualKeys.length === expectedKeys.length
            && actualKeys.every((key, index) => key === expectedKeys[index]),
        `${name} has unexpected keys`,
    );
}

function validateVersion(version) {
    requireValue(typeof version === 'string' && VERSION_PATTERN.test(version), `Invalid release version: ${version}`);
    return version;
}

function validateSha256(value, name = 'SHA-256') {
    requireValue(typeof value === 'string' && SHA256_PATTERN.test(value), `Invalid ${name}: ${value}`);
    return value;
}

function validateGitSha(sourceSha) {
    requireValue(typeof sourceSha === 'string' && /^[0-9a-f]{40}$/.test(sourceSha), `Invalid source SHA: ${sourceSha}`);
    return sourceSha;
}

function productConfig(product) {
    requireValue(CANDIDATE_POLICY.schema === CANDIDATE_SCHEMA, 'Unsupported release candidate policy schema');
    requireValue(Object.hasOwn(PRODUCT_CONFIGS, product), `Unsupported release product: ${product}`);
    const config = PRODUCT_CONFIGS[product];
    assertObject(config, `Release candidate policy for ${product}`);
    requireValue(
        Number.isSafeInteger(config.archiveMaxBytes) && config.archiveMaxBytes > 0,
        `Invalid archive limit for release product: ${product}`,
    );
    requireValue(typeof config.finalArtifactName === 'string', `Invalid final artifact name for ${product}`);
    requireValue(Array.isArray(config.payloads) && config.payloads.length > 0, `Invalid payload policy for ${product}`);
    requireValue(
        Number.isSafeInteger(config.expectedEntries)
            && config.expectedEntries === config.payloads.length + 1,
        `Invalid expected entry count for release product: ${product}`,
    );
    return config;
}

function renderVersionTemplate(template, version, name) {
    requireValue(
        typeof template === 'string' && template.split('{version}').length === 2,
        `Invalid ${name} template: ${template}`,
    );
    return template.replace('{version}', version);
}

function payloadPolicies(product, version) {
    validateVersion(version);
    return productConfig(product).payloads.map((payload, index) => {
        assertExactKeys(payload, ['path', 'maxBytes'], `Release candidate payload policy ${index}`);
        requireValue(Number.isSafeInteger(payload.maxBytes) && payload.maxBytes > 0, `Invalid payload size limit: ${payload.maxBytes}`);
        return {
            maxBytes: payload.maxBytes,
            path: validatePayloadPath(renderVersionTemplate(payload.path, version, 'payload path')),
        };
    });
}

function payloadPaths(product, version) {
    return payloadPolicies(product, version).map((payload) => payload.path);
}

function candidateArtifactName(product, version, sourceSha) {
    validateVersion(version);
    validateGitSha(sourceSha);
    productConfig(product);
    return `release-candidate-${product}-${version}-${sourceSha}`;
}

function finalArtifactName(product, version) {
    validateVersion(version);
    return renderVersionTemplate(productConfig(product).finalArtifactName, version, 'final artifact name');
}

function normalizeArtifactDigest(value, name = 'artifact digest') {
    requireValue(typeof value === 'string', `Invalid ${name}: ${value}`);
    const match = /^(?:sha256:)?([0-9a-f]{64})$/.exec(value);
    requireValue(match !== null, `Invalid ${name}: ${value}`);
    return match[1];
}

function sha256Buffer(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
    return sha256Buffer(readFileSync(file));
}

function validatePayloadPath(payloadPath) {
    requireValue(
        typeof payloadPath === 'string'
            && payloadPath.length > 0
            && !payloadPath.includes('/')
            && !payloadPath.includes('\\')
            && payloadPath !== '.'
            && payloadPath !== '..',
        `Invalid candidate payload path: ${payloadPath}`,
    );
    return payloadPath;
}

function candidateFile(directory, fileName) {
    validatePayloadPath(fileName);
    const file = path.join(directory, fileName);
    const details = lstatSync(file);
    requireValue(details.isFile(), `Candidate entry must be a regular file: ${fileName}`);
    return { file, size: details.size };
}

function createCandidateManifest({ product, version, sourceSha, directory }) {
    validateVersion(version);
    validateGitSha(sourceSha);
    const payloads = payloadPolicies(product, version).map((payload) => {
        const { file, size } = candidateFile(directory, payload.path);
        requireValue(size <= payload.maxBytes, `Candidate payload exceeds its size limit: ${payload.path}`);
        return { path: payload.path, sha256: sha256File(file), size };
    });

    return {
        schema: CANDIDATE_SCHEMA,
        product,
        version,
        sourceSha,
        payloads,
    };
}

function writeCandidateManifest(options) {
    const manifest = createCandidateManifest(options);
    writeFileSync(
        path.join(options.directory, 'release-candidate.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
}

function validateCandidateManifest(manifest, { product, version, sourceSha }) {
    validateVersion(version);
    validateGitSha(sourceSha);
    const expectedPayloads = payloadPolicies(product, version);

    assertExactKeys(manifest, ['schema', 'product', 'version', 'sourceSha', 'payloads'], 'Candidate manifest');
    requireValue(manifest.schema === CANDIDATE_SCHEMA, `Unsupported candidate manifest schema: ${manifest.schema}`);
    requireValue(manifest.product === product, `Candidate product mismatch: ${manifest.product}`);
    requireValue(manifest.version === version, `Candidate version mismatch: ${manifest.version}`);
    requireValue(manifest.sourceSha === sourceSha, `Candidate source SHA mismatch: ${manifest.sourceSha}`);
    requireValue(Array.isArray(manifest.payloads), 'Candidate payloads must be an array');
    requireValue(
        manifest.payloads.length === expectedPayloads.length,
        `Candidate payload count mismatch: ${manifest.payloads.length}`,
    );

    for (const [index, expectedPayload] of expectedPayloads.entries()) {
        const payload = manifest.payloads[index];
        assertExactKeys(payload, ['path', 'sha256', 'size'], `Candidate payload ${index}`);
        requireValue(payload.path === expectedPayload.path, `Candidate payload path mismatch: ${payload.path}`);
        validatePayloadPath(payload.path);
        validateSha256(payload.sha256, `candidate payload SHA-256 for ${payload.path}`);
        requireValue(
            Number.isSafeInteger(payload.size) && payload.size >= 0 && payload.size <= expectedPayload.maxBytes,
            `Invalid candidate payload size for ${payload.path}: ${payload.size}`,
        );
    }

    return manifest;
}

function listCandidateEntries(directory) {
    return readdirSync(directory, { withFileTypes: true })
        .map((entry) => {
            requireValue(entry.isFile(), `Candidate entry must be a regular file: ${entry.name}`);
            validatePayloadPath(entry.name);
            return entry.name;
        })
        .sort();
}

function verifyExtractedCandidate({ product, version, sourceSha, directory }) {
    const expectedEntries = ['release-candidate.json', ...payloadPaths(product, version)].sort();
    const actualEntries = listCandidateEntries(directory);
    requireValue(
        actualEntries.length === expectedEntries.length
            && actualEntries.every((entry, index) => entry === expectedEntries[index]),
        `Candidate archive layout mismatch: ${actualEntries.join(', ')}`,
    );

    const manifest = validateCandidateManifest(
        JSON.parse(readFileSync(path.join(directory, 'release-candidate.json'), 'utf8')),
        { product, version, sourceSha },
    );
    for (const payload of manifest.payloads) {
        const { file, size } = candidateFile(directory, payload.path);
        requireValue(size === payload.size, `Candidate payload size mismatch: ${payload.path}`);
        requireValue(
            sha256File(file) === payload.sha256,
            `Candidate payload digest mismatch: ${payload.path}`,
        );
    }

    return manifest;
}

function validateArtifactId(value, name) {
    const number = Number(value);
    requireValue(Number.isSafeInteger(number) && number > 0, `Invalid ${name}: ${value}`);
    return number;
}

function parseRepository(repository) {
    const parts = `${repository}`.split('/');
    requireValue(
        parts.length === 2 && parts.every((part) => REPOSITORY_PART_PATTERN.test(part)),
        `Invalid GitHub repository: ${repository}`,
    );
    return parts;
}

function validateCandidateArtifactMetadata(artifact, {
    artifactDigest,
    artifactId,
    artifactName,
    maxArchiveBytes,
    routerRunId,
}) {
    assertObject(artifact, 'Candidate artifact metadata');
    const expectedArtifactId = validateArtifactId(artifactId, 'candidate artifact id');
    const expectedRouterRunId = validateArtifactId(routerRunId, 'router workflow run id');
    const expectedDigest = normalizeArtifactDigest(artifactDigest, 'candidate output digest');
    requireValue(
        Number.isSafeInteger(maxArchiveBytes) && maxArchiveBytes > 0,
        `Invalid candidate archive size limit: ${maxArchiveBytes}`,
    );

    requireValue(Number(artifact.id) === expectedArtifactId, `Candidate artifact id mismatch: ${artifact.id}`);
    requireValue(artifact.name === artifactName, `Candidate artifact name mismatch: ${artifact.name}`);
    requireValue(artifact.expired === false, 'Candidate artifact is expired');
    requireValue(
        Number(artifact.workflow_run?.id) === expectedRouterRunId,
        `Candidate artifact workflow run mismatch: ${artifact.workflow_run?.id}`,
    );
    requireValue(
        Number.isSafeInteger(artifact.size_in_bytes)
            && artifact.size_in_bytes > 0
            && artifact.size_in_bytes <= maxArchiveBytes,
        `Candidate artifact exceeds its archive size limit: ${artifact.size_in_bytes}`,
    );

    const apiDigest = normalizeArtifactDigest(artifact.digest, 'candidate API digest');
    requireValue(apiDigest === expectedDigest, 'Candidate output digest does not match Actions API digest');
    return {
        artifactId: expectedArtifactId,
        digest: apiDigest,
        sizeInBytes: artifact.size_in_bytes,
    };
}

function githubApiHeaders(token) {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'happy-release-candidate-promotion',
        'X-GitHub-Api-Version': '2022-11-28',
    };
}

async function cancelResponseBody(response) {
    try {
        if (response?.body && typeof response.body.cancel === 'function') {
            await response.body.cancel();
        }
    } catch {
        // Preserve the validation failure that caused the response to be discarded.
    }
}

async function fetchGitHubApiResponse(fetchImpl, url, token, errorLabel) {
    const response = await fetchImpl(url, {
        headers: githubApiHeaders(token),
        redirect: 'error',
    });
    if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error(`${errorLabel} failed with status ${response.status}`);
    }
    return response;
}

function validateApiRoot(apiUrl) {
    requireValue(typeof apiUrl === 'string' && apiUrl.length > 0, 'GITHUB_API_URL is required');
    let root;
    try {
        root = new URL(apiUrl);
    } catch {
        throw new Error(`Invalid GitHub API URL: ${apiUrl}`);
    }
    requireValue(root.protocol === 'https:', 'GitHub API URL must use HTTPS');
    requireValue(root.username === '' && root.password === '', 'GitHub API URL must not include credentials');
    requireValue(root.search === '' && root.hash === '', 'GitHub API URL must not include a query or fragment');
    if (!root.pathname.endsWith('/')) {
        root.pathname += '/';
    }
    return root;
}

async function readBoundedResponseBody(response, maxBytes, label) {
    const contentLength = response.headers?.get?.('content-length');
    if (contentLength !== undefined && contentLength !== null) {
        if (!/^\d+$/.test(contentLength)) {
            await cancelResponseBody(response);
            throw new Error(`${label} Content-Length is invalid`);
        }
        if (BigInt(contentLength) > BigInt(maxBytes)) {
            await cancelResponseBody(response);
            throw new Error(`${label} Content-Length exceeds its size limit`);
        }
    }

    if (!response.body || typeof response.body.getReader !== 'function') {
        await cancelResponseBody(response);
        throw new Error(`${label} response body is unavailable`);
    }
    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            const chunk = Buffer.from(value);
            if (chunk.length > maxBytes - total) {
                try {
                    await reader.cancel();
                } catch {
                    // Preserve the size-limit error.
                }
                throw new Error(`${label} body exceeds its size limit`);
            }
            total += chunk.length;
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
}

async function readCandidateMetadata(response) {
    const buffer = await readBoundedResponseBody(
        response,
        MAX_GITHUB_API_METADATA_BYTES,
        'Candidate artifact metadata',
    );
    try {
        return JSON.parse(buffer.toString('utf8'));
    } catch {
        throw new Error('Candidate artifact metadata is not valid JSON');
    }
}

function redirectTarget(location, currentUrl) {
    requireValue(
        typeof location === 'string' && location.length > 0,
        'Candidate artifact download redirect is missing Location',
    );
    let target;
    try {
        target = new URL(location, currentUrl);
    } catch {
        throw new Error('Candidate artifact download redirect Location is invalid');
    }
    requireValue(target.protocol === 'https:', 'Candidate artifact download redirect must use HTTPS');
    requireValue(
        target.username === '' && target.password === '',
        'Candidate artifact download redirect must not include credentials',
    );
    return target;
}

async function downloadCandidateArchive(fetchImpl, archiveUrl, token, maxBytes) {
    let currentUrl = archiveUrl;
    let redirectCount = 0;
    while (true) {
        const response = await fetchImpl(currentUrl, {
            headers: redirectCount === 0
                ? githubApiHeaders(token)
                : { 'User-Agent': 'happy-release-candidate-promotion' },
            redirect: 'manual',
        });
        if (REDIRECT_STATUSES.has(response.status)) {
            const location = response.headers?.get?.('location');
            await cancelResponseBody(response);
            requireValue(
                redirectCount < MAX_DOWNLOAD_REDIRECTS,
                `Candidate artifact download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects`,
            );
            currentUrl = redirectTarget(location, currentUrl);
            redirectCount += 1;
            continue;
        }
        if (!response.ok) {
            await cancelResponseBody(response);
            throw new Error(`Candidate artifact download failed with status ${response.status}`);
        }
        const archive = await readBoundedResponseBody(response, maxBytes, 'Candidate archive');
        requireValue(archive.length > 0, 'Candidate archive is empty');
        return archive;
    }
}

async function fetchCandidateArtifact({
    apiUrl = 'https://api.github.com',
    artifactDigest,
    artifactId,
    artifactName,
    fetchImpl = globalThis.fetch,
    product,
    repository,
    routerRunId,
    sourceSha,
    token,
    version,
}) {
    requireValue(typeof fetchImpl === 'function', 'A Fetch API implementation is required');
    requireValue(typeof token === 'string' && token.length > 0, 'GH_TOKEN is required');
    const [owner, repo] = parseRepository(repository);
    const config = productConfig(product);
    const candidateId = validateArtifactId(artifactId, 'candidate artifact id');
    requireValue(
        artifactName === candidateArtifactName(product, version, sourceSha),
        `Candidate output name does not match the expected source-bound name: ${artifactName}`,
    );
    const root = validateApiRoot(apiUrl);
    const artifactUrl = new URL(
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts/${candidateId}`,
        root,
    );
    const artifactResponse = await fetchGitHubApiResponse(
        fetchImpl,
        artifactUrl,
        token,
        'Candidate artifact metadata request',
    );
    const artifact = await readCandidateMetadata(artifactResponse);
    const metadata = validateCandidateArtifactMetadata(artifact, {
        artifactDigest,
        artifactId: candidateId,
        artifactName,
        maxArchiveBytes: config.archiveMaxBytes,
        routerRunId,
    });

    const archiveUrl = new URL(`${artifactUrl.href}/zip`);
    const archive = await downloadCandidateArchive(fetchImpl, archiveUrl, token, config.archiveMaxBytes);
    requireValue(archive.length === metadata.sizeInBytes, 'Candidate archive size does not match Actions API metadata');
    const archiveSha256 = sha256Buffer(archive);
    requireValue(archiveSha256 === metadata.digest, 'Candidate archive digest does not match Actions API digest');

    return {
        archive,
        archiveSha256,
        artifactId: metadata.artifactId,
        digest: metadata.digest,
    };
}

function appendOutput(outputPath, entries) {
    requireValue(typeof outputPath === 'string' && outputPath.length > 0, 'GITHUB_OUTPUT is required');
    appendFileSync(
        outputPath,
        Object.entries(entries).map(([key, value]) => `${key}=${value}\n`).join(''),
    );
}

async function downloadCandidateArtifactFromEnvironment({ env = process.env, fetchImpl = globalThis.fetch, outputPath }) {
    requireValue(typeof outputPath === 'string' && outputPath.length > 0, 'Candidate archive output path is required');
    const result = await fetchCandidateArtifact({
        apiUrl: env.GITHUB_API_URL,
        artifactDigest: env.CANDIDATE_ARTIFACT_DIGEST,
        artifactId: env.CANDIDATE_ARTIFACT_ID,
        artifactName: env.CANDIDATE_ARTIFACT_NAME,
        fetchImpl,
        product: env.PRODUCT,
        repository: env.GITHUB_REPOSITORY,
        routerRunId: env.GITHUB_RUN_ID,
        sourceSha: env.SOURCE_SHA,
        token: env.GH_TOKEN,
        version: env.VERSION,
    });
    writeFileSync(outputPath, result.archive, { mode: 0o600 });
    appendOutput(env.GITHUB_OUTPUT, {
        candidate_archive_sha256: result.archiveSha256,
        candidate_artifact_digest: `sha256:${result.digest}`,
        candidate_artifact_id: result.artifactId,
    });
    return result;
}

function writePromotionReceipt({
    candidateArtifactDigest,
    candidateArtifactId,
    candidateArtifactName: candidateName,
    candidateArchiveSha256,
    directory,
    product,
    routerRunId,
    sourceSha,
    version,
}) {
    const manifest = verifyExtractedCandidate({ directory, product, sourceSha, version });
    const artifactId = validateArtifactId(candidateArtifactId, 'candidate artifact id');
    const runId = validateArtifactId(routerRunId, 'router workflow run id');
    requireValue(
        candidateName === candidateArtifactName(product, version, sourceSha),
        `Candidate receipt name does not match the expected source-bound name: ${candidateName}`,
    );
    const candidateDigest = normalizeArtifactDigest(candidateArtifactDigest, 'candidate artifact digest');
    const archiveSha256 = validateSha256(candidateArchiveSha256, 'candidate archive SHA-256');
    requireValue(
        candidateDigest === archiveSha256,
        'Candidate receipt archive SHA-256 does not match candidate artifact digest',
    );
    const receipt = {
        schema: CANDIDATE_SCHEMA,
        product,
        version,
        sourceSha,
        candidate: {
            artifactId,
            artifactName: candidateName,
            artifactDigest: `sha256:${candidateDigest}`,
            archiveSha256,
            routerRunId: runId,
        },
        payloads: manifest.payloads,
        promotion: {
            artifactName: finalArtifactName(product, version),
            retentionDays: 30,
        },
    };
    writeFileSync(path.join(directory, 'release-promotion.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
}

async function main(argv = process.argv.slice(2), env = process.env) {
    const [command, ...arguments_] = argv;
    switch (command) {
    case 'write-manifest': {
        const [product, version, sourceSha, directory] = arguments_;
        requireValue(arguments_.length === 4, 'Usage: write-manifest <product> <version> <source-sha> <directory>');
        writeCandidateManifest({ directory, product, sourceSha, version });
        return;
    }
    case 'verify': {
        const [product, version, sourceSha, directory] = arguments_;
        requireValue(arguments_.length === 4, 'Usage: verify <product> <version> <source-sha> <directory>');
        verifyExtractedCandidate({ directory, product, sourceSha, version });
        return;
    }
    case 'download': {
        const [outputPath] = arguments_;
        requireValue(arguments_.length === 1, 'Usage: download <archive-output-path>');
        await downloadCandidateArtifactFromEnvironment({ env, outputPath });
        return;
    }
    case 'write-receipt': {
        const [product, version, sourceSha, directory] = arguments_;
        requireValue(arguments_.length === 4, 'Usage: write-receipt <product> <version> <source-sha> <directory>');
        writePromotionReceipt({
            candidateArtifactDigest: env.CANDIDATE_ARTIFACT_DIGEST,
            candidateArtifactId: env.CANDIDATE_ARTIFACT_ID,
            candidateArtifactName: env.CANDIDATE_ARTIFACT_NAME,
            candidateArchiveSha256: env.CANDIDATE_ARCHIVE_SHA256,
            directory,
            product,
            routerRunId: env.GITHUB_RUN_ID,
            sourceSha,
            version,
        });
        return;
    }
    default:
        throw new Error('Usage: release-candidate-promotion.cjs <write-manifest|verify|download|write-receipt> ...');
    }
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    CANDIDATE_SCHEMA,
    PRODUCT_CONFIGS,
    candidateArtifactName,
    createCandidateManifest,
    downloadCandidateArtifactFromEnvironment,
    fetchCandidateArtifact,
    finalArtifactName,
    normalizeArtifactDigest,
    payloadPaths,
    validateCandidateArtifactMetadata,
    validateCandidateManifest,
    verifyExtractedCandidate,
    writeCandidateManifest,
    writePromotionReceipt,
};
