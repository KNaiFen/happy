#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const WORKFLOW_SLA = Object.freeze({
    '.github/workflows/ci.yml': { queueMinutes: 20, runningMinutes: 90 },
    '.github/workflows/cli-smoke-test.yml': { queueMinutes: 20, runningMinutes: 50 },
    '.github/workflows/codex-android-field-e2e.yml': { queueMinutes: 30, runningMinutes: 150 },
    '.github/workflows/release-after-required-ci.yml': { queueMinutes: 10, runningMinutes: 30 },
    '.github/workflows/release-candidate-rehearsal.yml': { queueMinutes: 10, runningMinutes: 120 },
    '.github/workflows/build-cli-release.yml': { queueMinutes: 10, runningMinutes: 45 },
    '.github/workflows/build-android-release.yml': { queueMinutes: 10, runningMinutes: 75 },
    '.github/workflows/build-debian13-relay-release.yml': { queueMinutes: 10, runningMinutes: 105 },
    '.github/workflows/build-happy-agent-release.yml': { queueMinutes: 10, runningMinutes: 45 },
});

const ACTIVE_STATUSES = new Set(['queued', 'in_progress']);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function validRunUrl(value, id) {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:'
            && url.hostname === 'github.com'
            && url.pathname === `/KNaiFen/happy/actions/runs/${id}`;
    } catch {
        return false;
    }
}

function minutesSince(value, now) {
    if (typeof value !== 'string') return null;
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return null;
    return Math.max(0, (now.valueOf() - timestamp) / 60_000);
}

function validRun(run) {
    return run
        && typeof run === 'object'
        && Number.isSafeInteger(run.id)
        && Number.isSafeInteger(run.workflow_id)
        && typeof run.path === 'string'
        && typeof run.head_sha === 'string'
        && validRunUrl(run.html_url, run.id)
        && SHA_PATTERN.test(run.head_sha)
        && ACTIVE_STATUSES.has(run.status);
}

function laterRun(run, candidate) {
    if (run.workflow_id !== candidate.workflow_id || run.head_sha !== candidate.head_sha) return false;
    const runCreated = Date.parse(run.created_at);
    const candidateCreated = Date.parse(candidate.created_at);
    if (Number.isNaN(runCreated) || Number.isNaN(candidateCreated)) return false;
    return candidateCreated > runCreated || (candidateCreated === runCreated && candidate.id > run.id);
}

function decideCancellations(runs, now = new Date(), policy = WORKFLOW_SLA) {
    const activeRuns = [...new Map(
        runs.filter(validRun).map((run) => [run.id, run]),
    ).values()];
    const decisions = [];

    for (const run of activeRuns) {
        const sla = policy[run.path];
        if (!sla) continue;

        if (run.status === 'queued' && activeRuns.some((candidate) => laterRun(run, candidate))) {
            decisions.push({ ageMinutes: minutesSince(run.created_at, now), rule: 'superseded-same-sha', run });
            continue;
        }

        if (run.status === 'queued') {
            const ageMinutes = minutesSince(run.created_at, now);
            if (ageMinutes !== null && ageMinutes > sla.queueMinutes) {
                decisions.push({ ageMinutes, rule: 'queue-sla', run });
            }
        } else {
            const ageMinutes = minutesSince(run.run_started_at, now);
            if (ageMinutes !== null && ageMinutes > sla.runningMinutes) {
                decisions.push({ ageMinutes, rule: 'running-sla', run });
            }
        }
    }

    return decisions.sort((left, right) => left.run.id - right.run.id);
}

function runGh(arguments_, { expectJson = false } = {}) {
    const result = spawnSync('gh', arguments_, {
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || result.signal) {
        throw new Error(`gh command failed (status=${result.status}, signal=${result.signal ?? 'none'})`);
    }
    if (!expectJson) return null;
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new Error('gh command returned invalid JSON');
    }
}

function paginatedRuns(repository, status) {
    const pages = runGh([
        'api', '--paginate', '--slurp',
        `repos/${repository}/actions/runs?status=${status}&per_page=100`,
    ], { expectJson: true });
    if (!Array.isArray(pages)) throw new Error('GitHub Actions list response is invalid');
    return pages.flatMap((page) => Array.isArray(page?.workflow_runs) ? page.workflow_runs : []);
}

function readRun(repository, id) {
    return runGh(['api', `repos/${repository}/actions/runs/${id}`], { expectJson: true });
}

function cancelRun(repository, id) {
    runGh(['api', '--method', 'POST', `repos/${repository}/actions/runs/${id}/cancel`]);
}

function issueTitle(id) {
    return `Actions SLA watchdog: run ${id}`;
}

function issueBody(decision) {
    const age = decision.ageMinutes === null ? 'unknown' : `${Math.floor(decision.ageMinutes)} minutes`;
    return [
        `Workflow: \`${decision.run.path}\``,
        `Run: [${decision.run.id}](${decision.run.html_url})`,
        `Status: \`${decision.run.status}\``,
        `Age: ${age}`,
        `Rule: \`${decision.rule}\``,
    ].join('\n');
}

function upsertIssue(repository, decision) {
    const title = issueTitle(decision.run.id);
    const query = `repo:${repository} is:issue in:title "${title}"`;
    const search = runGh(['api', '--method', 'GET', 'search/issues', '-f', `q=${query}`], { expectJson: true });
    const issue = Array.isArray(search?.items) ? search.items.find((item) => item.title === title) : null;
    const endpoint = issue
        ? `repos/${repository}/issues/${issue.number}`
        : `repos/${repository}/issues`;
    const method = issue ? 'PATCH' : 'POST';
    runGh([
        'api', '--method', method, endpoint,
        '-f', `title=${title}`,
        '-f', `body=${issueBody(decision)}`,
    ]);
}

function stillCancellable(run, decision) {
    return validRun(run)
        && run.id === decision.run.id
        && run.workflow_id === decision.run.workflow_id
        && run.head_sha === decision.run.head_sha;
}

function main() {
    const repository = process.env.GITHUB_REPOSITORY ?? '';
    if (!REPOSITORY_PATTERN.test(repository)) {
        throw new Error('GITHUB_REPOSITORY is not a valid owner/repository name');
    }

    const runs = [...paginatedRuns(repository, 'queued'), ...paginatedRuns(repository, 'in_progress')];
    const decisions = decideCancellations(runs);
    let terminated = 0;
    for (const decision of decisions) {
        const current = readRun(repository, decision.run.id);
        if (!stillCancellable(current, decision)) continue;
        cancelRun(repository, decision.run.id);
        upsertIssue(repository, decision);
        terminated += 1;
    }

    if (terminated > 0) {
        throw new Error(`Actions SLA watchdog terminated ${terminated} run(s)`);
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`Actions SLA watchdog failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    WORKFLOW_SLA,
    decideCancellations,
    issueBody,
    issueTitle,
    laterRun,
    minutesSince,
    stillCancellable,
    validRun,
};
