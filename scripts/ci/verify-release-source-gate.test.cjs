const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    validateMergedPullRequest,
    validateRequiredGate,
    validateSourceRun,
    verifyReleaseSourceGate,
} = require('./verify-release-source-gate.cjs');

const repository = 'KNaiFen/happy';
const runId = 123456;
const sourceSha = 'a'.repeat(40);
const sourceBaseSha = 'b'.repeat(40);
const repositoryRoot = path.resolve(__dirname, '../..');

function sourceRun(overrides = {}) {
    return {
        id: runId,
        name: 'Happy monorepo CI',
        path: '.github/workflows/ci.yml',
        event: 'push',
        head_branch: 'main',
        head_sha: sourceSha,
        status: 'completed',
        conclusion: 'success',
        run_attempt: 1,
        head_repository: { full_name: repository },
        repository: { full_name: repository },
        html_url: `https://github.com/${repository}/actions/runs/${runId}`,
        ...overrides,
    };
}

function requiredGate(overrides = {}) {
    return {
        name: 'Required CI gate',
        run_id: runId,
        head_sha: sourceSha,
        status: 'completed',
        conclusion: 'success',
        run_attempt: 1,
        ...overrides,
    };
}

function mergedPullRequest(overrides = {}) {
    return {
        state: 'closed',
        merged_at: '2026-08-10T10:37:08Z',
        merge_commit_sha: sourceSha,
        base: {
            ref: 'main',
            sha: sourceBaseSha,
            repo: { full_name: repository },
        },
        ...overrides,
    };
}

function response(payload, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        async json() {
            return payload;
        },
    };
}

test('accepts one successful first-attempt main gate and writes exact source outputs', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'happy-release-gate-'));
    const outputPath = path.join(directory, 'output.txt');
    const requests = [];
    const fetchImpl = async (url) => {
        requests.push(String(url));
        if (String(url).includes('/jobs?')) {
            return response({ total_count: 1, jobs: [requiredGate()] });
        }
        if (String(url).includes('/pulls?')) {
            return response([mergedPullRequest()]);
        }
        return response(sourceRun());
    };

    try {
        const result = await verifyReleaseSourceGate({
            env: {
                EXPECTED_SOURCE_SHA: sourceSha,
                GH_TOKEN: 'test-token',
                GITHUB_API_URL: 'https://api.github.test',
                GITHUB_OUTPUT: outputPath,
                GITHUB_REPOSITORY: repository,
                SOURCE_RUN_ID: String(runId),
            },
            fetchImpl,
        });

        assert.deepEqual(result, {
            sourceBaseSha,
            sourceSha,
            runId,
            runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
        });
        assert.equal(
            readFileSync(outputPath, 'utf8'),
            `source_sha=${sourceSha}\nsource_base_sha=${sourceBaseSha}\nsource_run_id=${runId}\nsource_run_url=https://github.com/${repository}/actions/runs/${runId}\n`,
        );
        assert.equal(requests.length, 3);
        assert.match(requests[1], /filter=latest&per_page=100&page=1$/);
        assert.match(requests[2], new RegExp(`/commits/${sourceSha}/pulls\\?per_page=100&page=1$`));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

for (const [name, overrides, expected] of [
    ['workflow name', { name: 'Other CI' }, /Unexpected source workflow/],
    ['workflow path', { path: '.github/workflows/other.yml' }, /Unexpected source workflow path/],
    ['event', { event: 'pull_request' }, /event must be push/],
    ['branch', { head_branch: 'feature' }, /branch must be main/],
    ['SHA', { head_sha: 'b'.repeat(40) }, /SHA mismatch/],
    ['status', { status: 'in_progress' }, /not completed/],
    ['conclusion', { conclusion: 'failure' }, /did not succeed/],
    ['rerun', { run_attempt: 2 }, /reruns cannot publish/],
    ['head repository', { head_repository: { full_name: 'other/repo' } }, /repository mismatch/],
    ['URL', { html_url: 'https://github.com/other/repo/actions/runs/123456' }, /URL mismatch/],
]) {
    test(`rejects an invalid source run ${name}`, () => {
        assert.throws(
            () => validateSourceRun(sourceRun(overrides), { repository, runId, sourceSha }),
            expected,
        );
    });
}

test('rejects missing, duplicate, failed, or mismatched Required CI gates', () => {
    assert.throws(
        () => validateRequiredGate([], { runId, sourceSha }),
        /Expected exactly one Required CI gate job, found 0/,
    );
    assert.throws(
        () => validateRequiredGate([requiredGate(), requiredGate()], { runId, sourceSha }),
        /found 2/,
    );
    assert.throws(
        () => validateRequiredGate([requiredGate({ conclusion: 'failure' })], { runId, sourceSha }),
        /did not succeed/,
    );
    assert.throws(
        () => validateRequiredGate([requiredGate({ head_sha: 'b'.repeat(40) })], { runId, sourceSha }),
        /SHA mismatch/,
    );
    assert.throws(
        () => validateRequiredGate([requiredGate({ run_attempt: 2 })], { runId, sourceSha }),
        /reruns cannot publish/,
    );
});

test('accepts exactly one merged main pull request and returns its base SHA', () => {
    assert.equal(
        validateMergedPullRequest([mergedPullRequest()], { repository, sourceSha }),
        sourceBaseSha,
    );
});

test('rejects missing, duplicate, direct-push, or mismatched pull request provenance', () => {
    assert.throws(
        () => validateMergedPullRequest([], { repository, sourceSha }),
        /found 0/,
    );
    assert.throws(
        () => validateMergedPullRequest([mergedPullRequest(), mergedPullRequest()], { repository, sourceSha }),
        /found 2/,
    );
    assert.throws(
        () => validateMergedPullRequest([mergedPullRequest({ merged_at: null })], { repository, sourceSha }),
        /found 0/,
    );
    assert.throws(
        () => validateMergedPullRequest([mergedPullRequest({ merge_commit_sha: 'c'.repeat(40) })], { repository, sourceSha }),
        /found 0/,
    );
    assert.throws(
        () => validateMergedPullRequest([mergedPullRequest({ base: { ref: 'other', sha: sourceBaseSha, repo: { full_name: repository } } })], { repository, sourceSha }),
        /found 0/,
    );
});

test('rejects invalid configuration before calling GitHub', async () => {
    let called = false;
    await assert.rejects(
        verifyReleaseSourceGate({
            env: {
                EXPECTED_SOURCE_SHA: 'not-a-sha',
                GH_TOKEN: 'test-token',
                GITHUB_OUTPUT: '/tmp/unused',
                GITHUB_REPOSITORY: repository,
                SOURCE_RUN_ID: String(runId),
            },
            fetchImpl: async () => {
                called = true;
            },
        }),
        /Invalid source SHA/,
    );
    assert.equal(called, false);
});

test('rejects a GitHub API error without consuming a response body', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'happy-release-gate-'));
    try {
        await assert.rejects(
            verifyReleaseSourceGate({
                env: {
                    EXPECTED_SOURCE_SHA: sourceSha,
                    GH_TOKEN: 'test-token',
                    GITHUB_OUTPUT: path.join(directory, 'output.txt'),
                    GITHUB_REPOSITORY: repository,
                    SOURCE_RUN_ID: String(runId),
                },
                fetchImpl: async () => response({}, { ok: false, status: 403 }),
            }),
            /GitHub API request failed with status 403/,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('paginates jobs until total_count is satisfied', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'happy-release-gate-'));
    let jobsPage = 0;
    const filler = Array.from({ length: 100 }, (_, index) => ({ name: `job-${index}` }));
    try {
        await verifyReleaseSourceGate({
            env: {
                EXPECTED_SOURCE_SHA: sourceSha,
                GH_TOKEN: 'test-token',
                GITHUB_OUTPUT: path.join(directory, 'output.txt'),
                GITHUB_REPOSITORY: repository,
                SOURCE_RUN_ID: String(runId),
            },
            fetchImpl: async (url) => {
                if (String(url).includes('/pulls?')) return response([mergedPullRequest()]);
                if (!String(url).includes('/jobs?')) return response(sourceRun());
                jobsPage += 1;
                return jobsPage === 1
                    ? response({ total_count: 101, jobs: filler })
                    : response({ total_count: 101, jobs: [requiredGate()] });
            },
        });
        assert.equal(jobsPage, 2);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('release workflows only build caller-provided gated sources', () => {
    const workflowNames = [
        'build-cli-release.yml',
        'build-android-release.yml',
        'build-debian13-relay-release.yml',
        'build-happy-agent-release.yml',
    ];

    for (const workflowName of workflowNames) {
        const workflow = readFileSync(
            path.join(repositoryRoot, '.github/workflows', workflowName),
            'utf8',
        );
        const checkoutCount = [...workflow.matchAll(/uses: actions\/checkout@[^\s]+/g)].length;
        const exactSourceCheckoutCount = [
            ...workflow.matchAll(/ref: \$\{\{ env\.SOURCE_SHA \}\}/g),
        ].length;

        assert.match(workflow, /on:\n  workflow_call:\n/);
        assert.doesNotMatch(workflow, /\n  push:\n/);
        assert.match(workflow, /source_sha:\n        required: true\n        type: string/);
        assert.match(workflow, /version:\n        required: true\n        type: string/);
        assert.equal(exactSourceCheckoutCount, checkoutCount, `${workflowName} has an unbound checkout`);
        assert.doesNotMatch(workflow, /\$\{\{ github\.sha \}\}|\$GITHUB_SHA|github\.event\.before/);
        assert.match(workflow, /SOURCE_SHA: \$\{\{ inputs\.source_sha \}\}/);
        assert.match(workflow, /VERSION: \$\{\{ inputs\.version \}\}/);
    }
});

test('the release router requires one exact first-attempt main CI gate', () => {
    const router = readFileSync(
        path.join(repositoryRoot, '.github/workflows/release-after-required-ci.yml'),
        'utf8',
    );
    const ciWorkflow = readFileSync(
        path.join(repositoryRoot, '.github/workflows/ci.yml'),
        'utf8',
    );

    assert.match(router, /workflow_run:\n    workflows: \[Happy monorepo CI\]\n    types: \[completed\]\n    branches: \[main\]/);
    assert.match(router, /github\.event\.workflow_run\.event == 'push'/);
    assert.match(router, /github\.event\.workflow_run\.conclusion == 'success'/);
    assert.match(router, /github\.event\.workflow_run\.run_attempt == 1/);
    assert.match(router, /github\.run_attempt == 1/);
    assert.match(router, /pull-requests: read/);
    assert.match(router, /ref: \$\{\{ github\.workflow_sha \}\}/);
    assert.match(router, /node scripts\/ci\/verify-release-source-gate\.cjs/);
    assert.match(router, /source_base_sha: \$\{\{ steps\.gate\.outputs\.source_base_sha \}\}/);
    assert.match(router, /SOURCE_BASE_SHA: \$\{\{ needs\.source_gate\.outputs\.source_base_sha \}\}/);
    assert.doesNotMatch(router, /git rev-parse "\$\{SOURCE_SHA\}\^"/);
    assert.match(router, /ref: \$\{\{ env\.SOURCE_SHA \}\}/);
    assert.match(router, /ANDROID_KEYSTORE_BASE64: \$\{\{ secrets\.ANDROID_KEYSTORE_BASE64 \}\}/);
    assert.doesNotMatch(router, /secrets: inherit/);
    assert.equal(
        [...router.matchAll(/uses: \.\/\.github\/workflows\/build-[^\n]+/g)].length,
        4,
    );
    assert.match(
        ciWorkflow,
        /group: happy-ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name \}\}-\$\{\{ github\.event_name == 'pull_request' && github\.ref \|\| github\.sha \}\}/,
    );
    assert.match(
        ciWorkflow,
        /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
    );
});
