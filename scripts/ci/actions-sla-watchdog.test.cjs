'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    WORKFLOW_SLA,
    decideCancellations,
    issueBody,
    issueTitle,
    stillCancellable,
} = require('./actions-sla-watchdog.cjs');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const now = new Date('2026-08-14T12:00:00Z');

function run(overrides = {}) {
    const candidate = {
        created_at: '2026-08-14T11:45:00Z',
        head_sha: 'a'.repeat(40),
        id: 1,
        path: '.github/workflows/ci.yml',
        run_started_at: null,
        status: 'queued',
        workflow_id: 99,
        ...overrides,
    };
    return {
        ...candidate,
        html_url: overrides.html_url ?? `https://github.com/KNaiFen/happy/actions/runs/${candidate.id}`,
    };
}

test('only cancels runs after, not at, their configured SLA', () => {
    const atLimit = run({ created_at: '2026-08-14T11:40:00Z' });
    const overLimit = run({ id: 2, created_at: '2026-08-14T11:39:59Z', workflow_id: 100 });
    const decisions = decideCancellations([atLimit, overLimit], now);
    assert.deepEqual(decisions.map(({ rule, run: candidate }) => [candidate.id, rule]), [[2, 'queue-sla']]);

    const runningAtLimit = run({ id: 3, run_started_at: '2026-08-14T10:30:00Z', status: 'in_progress' });
    const runningOverLimit = run({ id: 4, run_started_at: '2026-08-14T10:29:59Z', status: 'in_progress' });
    const runningDecisions = decideCancellations([runningAtLimit, runningOverLimit], now);
    assert.deepEqual(runningDecisions.map(({ run: candidate }) => candidate.id), [4]);
});

test('only supersedes older queued runs for the same workflow and source SHA', () => {
    const older = run({ id: 10, created_at: '2026-08-14T11:55:00Z' });
    const newer = run({ id: 11, created_at: '2026-08-14T11:56:00Z' });
    const differentSha = run({ id: 12, head_sha: 'b'.repeat(40), created_at: '2026-08-14T11:57:00Z' });
    const decisions = decideCancellations([older, newer, differentSha], now);
    assert.deepEqual(decisions.map(({ rule, run: candidate }) => [candidate.id, rule]), [[10, 'superseded-same-sha']]);
});

test('fails safe for unknown workflows and malformed runs', () => {
    const unknown = run({ id: 20, path: '.github/workflows/unknown.yml', created_at: '2026-08-14T01:00:00Z' });
    const malformed = run({ id: 21, head_sha: 'not-a-sha', created_at: '2026-08-14T01:00:00Z' });
    const malformedUrl = run({ id: 22, html_url: 'https://example.test/actions/runs/22', created_at: '2026-08-14T01:00:00Z' });
    assert.deepEqual(decideCancellations([unknown, malformed, malformedUrl], now), []);
});

test('does not cancel a run that became terminal before the cancellation request', () => {
    const decision = decideCancellations([run({ created_at: '2026-08-14T11:00:00Z' })], now)[0];
    assert.equal(stillCancellable(run({ status: 'completed' }), decision), false);
    assert.equal(stillCancellable(run(), decision), true);
});

test('issue contents remain restricted to run facts and rule', () => {
    const decision = decideCancellations([run({ created_at: '2026-08-14T11:00:00Z' })], now)[0];
    assert.equal(issueTitle(1), 'Actions SLA watchdog: run 1');
    assert.equal(issueBody(decision), [
        'Workflow: `.github/workflows/ci.yml`',
        'Run: [1](https://github.com/KNaiFen/happy/actions/runs/1)',
        'Status: `queued`',
        'Age: 60 minutes',
        'Rule: `queue-sla`',
    ].join('\n'));
});

test('watchdog workflow is scheduled, scoped, and unable to cancel another watchdog run', () => {
    const workflow = readFileSync(
        path.join(repositoryRoot, '.github', 'workflows', 'actions-sla-watchdog.yml'),
        'utf8',
    );
    assert.match(workflow, /schedule:\n    - cron: '\*\/15 \* \* \* \*'/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /(?:^|\n)  (?:push|pull_request|workflow_run):/);
    assert.match(workflow, /actions: write/);
    assert.match(workflow, /contents: read/);
    assert.match(workflow, /issues: write/);
    assert.match(workflow, /group: actions-sla-watchdog/);
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, /timeout-minutes: 5/);
    assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
    assert.match(workflow, /node scripts\/ci\/actions-sla-watchdog\.cjs/);
    assert.ok(Object.keys(WORKFLOW_SLA).length >= 8);
});
