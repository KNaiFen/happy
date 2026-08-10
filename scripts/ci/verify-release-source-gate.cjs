#!/usr/bin/env node

const { appendFileSync } = require('node:fs');

const EXPECTED_WORKFLOW_NAME = 'Happy monorepo CI';
const EXPECTED_WORKFLOW_PATH = '.github/workflows/ci.yml';
const EXPECTED_GATE_NAME = 'Required CI gate';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]+$/;

function requireValue(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function parseRepository(repository) {
    const parts = repository.split('/');
    requireValue(
        parts.length === 2 && parts.every((part) => REPOSITORY_PART_PATTERN.test(part)),
        `Invalid GitHub repository: ${repository}`,
    );
    return parts;
}

function validateSourceRun(run, { repository, runId, sourceSha }) {
    requireValue(Number(run.id) === runId, `Source run id mismatch: ${run.id}`);
    requireValue(run.name === EXPECTED_WORKFLOW_NAME, `Unexpected source workflow: ${run.name}`);
    requireValue(run.path === EXPECTED_WORKFLOW_PATH, `Unexpected source workflow path: ${run.path}`);
    requireValue(run.event === 'push', `Source workflow event must be push: ${run.event}`);
    requireValue(run.head_branch === 'main', `Source workflow branch must be main: ${run.head_branch}`);
    requireValue(run.head_sha === sourceSha, `Source workflow SHA mismatch: ${run.head_sha}`);
    requireValue(run.status === 'completed', `Source workflow is not completed: ${run.status}`);
    requireValue(run.conclusion === 'success', `Source workflow did not succeed: ${run.conclusion}`);
    requireValue(run.run_attempt === 1, `Source workflow reruns cannot publish a version: ${run.run_attempt}`);
    requireValue(
        run.head_repository?.full_name === repository,
        `Source workflow repository mismatch: ${run.head_repository?.full_name}`,
    );
    requireValue(run.repository?.full_name === repository, `Workflow repository mismatch: ${run.repository?.full_name}`);
    requireValue(
        run.html_url === `https://github.com/${repository}/actions/runs/${runId}`,
        `Source workflow URL mismatch: ${run.html_url}`,
    );
}

function validateRequiredGate(jobs, { runId, sourceSha }) {
    const gates = jobs.filter((job) => job.name === EXPECTED_GATE_NAME);
    requireValue(gates.length === 1, `Expected exactly one ${EXPECTED_GATE_NAME} job, found ${gates.length}`);

    const [gate] = gates;
    requireValue(Number(gate.run_id) === runId, `Required gate run id mismatch: ${gate.run_id}`);
    requireValue(gate.head_sha === sourceSha, `Required gate SHA mismatch: ${gate.head_sha}`);
    requireValue(gate.status === 'completed', `Required gate is not completed: ${gate.status}`);
    requireValue(gate.conclusion === 'success', `Required gate did not succeed: ${gate.conclusion}`);
    requireValue(gate.run_attempt === 1, `Required gate reruns cannot publish a version: ${gate.run_attempt}`);
}

function validateMergedPullRequest(pulls, { repository, sourceSha }) {
    const matches = pulls.filter((pull) => (
        pull.state === 'closed'
        && pull.merged_at
        && pull.base?.ref === 'main'
        && pull.base?.repo?.full_name === repository
        && SHA_PATTERN.test(pull.base?.sha ?? '')
        && pull.merge_commit_sha === sourceSha
    ));
    requireValue(
        matches.length === 1,
        `Expected exactly one merged main pull request for source SHA, found ${matches.length}`,
    );
    return matches[0].base.sha;
}

async function fetchJson(fetchImpl, url, token) {
    const response = await fetchImpl(url, {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'happy-release-source-gate',
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    requireValue(response.ok, `GitHub API request failed with status ${response.status}`);
    return response.json();
}

async function fetchRunJobs(fetchImpl, jobsUrl, token) {
    const jobs = [];
    let expectedTotal;

    for (let page = 1; page <= 100; page += 1) {
        const url = new URL(jobsUrl);
        url.searchParams.set('filter', 'latest');
        url.searchParams.set('per_page', '100');
        url.searchParams.set('page', String(page));
        const payload = await fetchJson(fetchImpl, url, token);
        requireValue(Array.isArray(payload.jobs), 'GitHub jobs response is missing jobs');
        requireValue(Number.isSafeInteger(payload.total_count), 'GitHub jobs response is missing total_count');

        expectedTotal ??= payload.total_count;
        requireValue(payload.total_count === expectedTotal, 'GitHub jobs total changed while paging');
        jobs.push(...payload.jobs);

        if (jobs.length >= expectedTotal) {
            requireValue(jobs.length === expectedTotal, 'GitHub jobs response exceeded total_count');
            return jobs;
        }
        requireValue(payload.jobs.length > 0, 'GitHub jobs pagination ended before total_count');
    }

    throw new Error('GitHub jobs response exceeded the pagination limit');
}

async function fetchAssociatedPullRequests(fetchImpl, pullsUrl, token) {
    const pulls = [];

    for (let page = 1; page <= 100; page += 1) {
        const url = new URL(pullsUrl);
        url.searchParams.set('per_page', '100');
        url.searchParams.set('page', String(page));
        const payload = await fetchJson(fetchImpl, url, token);
        requireValue(Array.isArray(payload), 'GitHub pull request response must be an array');
        pulls.push(...payload);

        if (payload.length < 100) {
            return pulls;
        }
    }

    throw new Error('GitHub pull request response exceeded the pagination limit');
}

async function verifyReleaseSourceGate({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
    const repository = env.GITHUB_REPOSITORY ?? '';
    const sourceSha = env.EXPECTED_SOURCE_SHA ?? '';
    const runIdText = env.SOURCE_RUN_ID ?? '';
    const token = env.GH_TOKEN ?? '';
    const outputPath = env.GITHUB_OUTPUT ?? '';
    const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com';
    const runId = Number(runIdText);

    parseRepository(repository);
    requireValue(SHA_PATTERN.test(sourceSha), `Invalid source SHA: ${sourceSha}`);
    requireValue(Number.isSafeInteger(runId) && runId > 0, `Invalid source run id: ${runIdText}`);
    requireValue(token.length > 0, 'GH_TOKEN is required');
    requireValue(outputPath.length > 0, 'GITHUB_OUTPUT is required');
    requireValue(typeof fetchImpl === 'function', 'A Fetch API implementation is required');

    const [owner, repo] = parseRepository(repository);
    const repositoryPath = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const runUrl = new URL(
        `/repos/${repositoryPath}/actions/runs/${runId}`,
        apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`,
    );
    const run = await fetchJson(fetchImpl, runUrl, token);
    validateSourceRun(run, { repository, runId, sourceSha });

    const jobs = await fetchRunJobs(fetchImpl, `${runUrl}/jobs`, token);
    validateRequiredGate(jobs, { runId, sourceSha });
    const pullsUrl = new URL(
        `/repos/${repositoryPath}/commits/${sourceSha}/pulls`,
        apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`,
    );
    const sourceBaseSha = validateMergedPullRequest(
        await fetchAssociatedPullRequests(fetchImpl, pullsUrl, token),
        { repository, sourceSha },
    );

    appendFileSync(
        outputPath,
        `source_sha=${sourceSha}\nsource_base_sha=${sourceBaseSha}\nsource_run_id=${runId}\nsource_run_url=${run.html_url}\n`,
    );
    return { sourceBaseSha, sourceSha, runId, runUrl: run.html_url };
}

if (require.main === module) {
    verifyReleaseSourceGate().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    EXPECTED_GATE_NAME,
    EXPECTED_WORKFLOW_NAME,
    EXPECTED_WORKFLOW_PATH,
    fetchAssociatedPullRequests,
    fetchRunJobs,
    validateMergedPullRequest,
    validateRequiredGate,
    validateSourceRun,
    verifyReleaseSourceGate,
};
