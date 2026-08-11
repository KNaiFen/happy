'use strict';

const assert = require('node:assert/strict');
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

test('accepts only the exact unfixable Metro image-size advisory before expiry', () => {
    const result = evaluateAuditReport(
        reportWith([imageSizeAdvisory()]),
        new Date('2026-08-12T00:00:00Z'),
    );
    assert.equal(result.accepted.length, 1);
    assert.equal(result.blocking.length, 0);
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
