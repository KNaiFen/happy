'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    evaluateAuditReport,
} = require('./audit-production-dependencies.cjs');

function reportWith(advisories) {
    return { advisories: Object.fromEntries(advisories.map((advisory, index) => [String(index), advisory])) };
}

function imageSizeAdvisory(overrides = {}) {
    return {
        severity: 'high',
        github_advisory_id: 'GHSA-w3rx-r6r6-pgpr',
        module_name: 'image-size',
        patched_versions: '<0.0.0',
        findings: [{ paths: ['packages__happy-app>expo>@expo/metro>metro>image-size'] }],
        ...overrides,
    };
}

function prismaDeepmergeAdvisory(overrides = {}) {
    return {
        severity: 'high',
        github_advisory_id: 'GHSA-ggr8-5vv4-36mx',
        module_name: 'deepmerge-ts',
        patched_versions: '>=8.0.0',
        findings: [{ paths: ['packages__happy-server>prisma>@prisma/config>deepmerge-ts'] }],
        ...overrides,
    };
}

test('accepts only the exact unfixable Metro image-size advisory before expiry', () => {
    const result = evaluateAuditReport(
        reportWith([imageSizeAdvisory()]),
        new Date('2026-08-12T00:00:00Z'),
    );
    assert.equal(result.accepted.length, 1);
    assert.equal(result.blocking.length, 0);
});

test('accepts only the exact Prisma deepmerge advisory before its short expiry', () => {
    const accepted = evaluateAuditReport(
        reportWith([prismaDeepmergeAdvisory()]),
        new Date('2026-08-18T00:00:00Z'),
    );
    assert.equal(accepted.accepted.length, 1);
    assert.equal(accepted.blocking.length, 0);

    const changedScope = evaluateAuditReport(reportWith([
        prismaDeepmergeAdvisory({
            findings: [{ paths: ['packages__happy-server>@prisma/config>deepmerge-ts'] }],
        }),
        prismaDeepmergeAdvisory({ patched_versions: '>=7.1.6' }),
    ]));
    assert.deepEqual(changedScope.blocking.map(({ reason }) => reason), [
        'allowlist scope changed',
        'allowlist scope changed',
    ]);

    const expired = evaluateAuditReport(
        reportWith([prismaDeepmergeAdvisory()]),
        new Date('2026-09-19T00:00:00Z'),
    );
    assert.deepEqual(expired.blocking.map(({ reason }) => reason), [
        'exception expired 2026-09-18',
    ]);
});

test('blocks a new high advisory and a critical advisory', () => {
    const result = evaluateAuditReport(reportWith([
        { severity: 'high', github_advisory_id: 'GHSA-new', module_name: 'new-package', findings: [] },
        { severity: 'critical', github_advisory_id: 'GHSA-critical', module_name: 'critical-package', findings: [] },
    ]));
    assert.equal(result.accepted.length, 0);
    assert.deepEqual(result.blocking.map(({ reason }) => reason), ['not allowlisted', 'not allowlisted']);
});

test('blocks an allowlisted advisory when its path or fix status changes', () => {
    const changedPath = imageSizeAdvisory({ findings: [{ paths: ['packages__happy-server>image-size'] }] });
    const nowFixable = imageSizeAdvisory({ patched_versions: '>=2.1.0' });
    const result = evaluateAuditReport(reportWith([changedPath, nowFixable]));
    assert.deepEqual(result.blocking.map(({ reason }) => reason), [
        'allowlist scope changed',
        'allowlist scope changed',
    ]);
});

test('blocks an expired exception and ignores moderate advisories', () => {
    const result = evaluateAuditReport(
        reportWith([
            imageSizeAdvisory(),
            { severity: 'moderate', github_advisory_id: 'GHSA-moderate', module_name: 'moderate-package' },
        ]),
        new Date('2026-11-13T00:00:00Z'),
    );
    assert.equal(result.accepted.length, 0);
    assert.deepEqual(result.blocking.map(({ reason }) => reason), ['exception expired 2026-11-12']);
});

test('fails closed for malformed or registry-error reports', () => {
    assert.throws(() => evaluateAuditReport(null), /object/);
    assert.throws(() => evaluateAuditReport({ error: { message: 'registry unavailable' } }), /registry error/);
    assert.throws(() => evaluateAuditReport({}), /missing advisories/);
    assert.throws(() => evaluateAuditReport({ advisories: [] }), /missing advisories/);
    assert.throws(
        () => evaluateAuditReport(reportWith([{ severity: 'unknown' }])),
        /unknown severity/,
    );
    assert.throws(
        () => evaluateAuditReport(reportWith([null])),
        /invalid advisory/,
    );
});

test('weekly workflow keeps the production audit narrow and reproducible', () => {
    const workflow = readFileSync(
        path.join(__dirname, '../../.github/workflows/production-dependency-audit.yml'),
        'utf8',
    );
    assert.match(workflow, /schedule:\n\s+- cron: '[^']+'/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /permissions:\n\s+contents: read\n/);
    assert.match(workflow, /timeout-minutes: 15/);
    assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
    assert.match(workflow, /pnpm\/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86/);
    assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /version: 10\.11\.0/);
    assert.match(workflow, /node-version: 24/);
    assert.match(workflow, /run: node scripts\/ci\/audit-production-dependencies\.cjs/);
    assert.doesNotMatch(workflow, /pnpm install|pnpm build|pnpm pack/);
});
