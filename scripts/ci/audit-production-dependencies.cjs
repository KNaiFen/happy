#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const severityRank = new Map([
    ['low', 1],
    ['moderate', 2],
    ['high', 3],
    ['critical', 4],
]);

const PRODUCTION_AUDIT_EXCEPTIONS = [
    {
        ghsa: 'GHSA-w3rx-r6r6-pgpr',
        module: 'image-size',
        path: 'packages__happy-app>expo>@expo/metro>metro>image-size',
        patchedVersions: '<0.0.0',
        expiresOn: '2026-11-12',
        reason: 'Expo Metro build tooling only; the advisory has no patched release.',
    },
    {
        ghsa: 'GHSA-5p2g-fcmc-qvqq',
        module: 'image-size',
        path: 'packages__happy-app>expo>@expo/metro>metro>image-size',
        patchedVersions: '<0.0.0',
        expiresOn: '2026-11-12',
        reason: 'Expo Metro build tooling only; the advisory has no patched release.',
    },
    {
        ghsa: 'GHSA-ggr8-5vv4-36mx',
        module: 'deepmerge-ts',
        path: 'packages__happy-server>prisma>@prisma/config>deepmerge-ts',
        patchedVersions: '>=8.0.0',
        expiresOn: '2026-09-18',
        reason: 'Prisma config tooling pins 7.1.5 and reads only trusted repository configuration; no patched Prisma release exists.',
    },
];

function highOrCritical(advisory) {
    return severityRank.get(advisory.severity) >= severityRank.get('high');
}

function advisoryPaths(advisory) {
    return [...new Set(
        (Array.isArray(advisory.findings) ? advisory.findings : [])
            .flatMap((finding) => Array.isArray(finding?.paths) ? finding.paths : []),
    )].sort();
}

function validateAdvisory(advisory) {
    if (!advisory || typeof advisory !== 'object' || Array.isArray(advisory)) {
        throw new Error('pnpm audit report contains an invalid advisory');
    }
    if (!severityRank.has(advisory.severity)) {
        throw new Error(`pnpm audit advisory has an unknown severity: ${String(advisory.severity)}`);
    }
}

function evaluateAuditReport(report, now = new Date()) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
        throw new Error('pnpm audit did not return an object');
    }
    if (report.error) {
        throw new Error('pnpm audit returned a registry error');
    }
    if (!report.advisories || typeof report.advisories !== 'object' || Array.isArray(report.advisories)) {
        throw new Error('pnpm audit report is missing advisories');
    }

    const accepted = [];
    const blocking = [];
    for (const advisory of Object.values(report.advisories)) {
        validateAdvisory(advisory);
        if (!highOrCritical(advisory)) continue;
        const exception = PRODUCTION_AUDIT_EXCEPTIONS.find(
            (candidate) => candidate.ghsa === advisory.github_advisory_id,
        );
        if (!exception) {
            blocking.push({ advisory, reason: 'not allowlisted' });
            continue;
        }

        const expiresAt = new Date(`${exception.expiresOn}T23:59:59.999Z`);
        const paths = advisoryPaths(advisory);
        const exceptionMatches = advisory.module_name === exception.module
            && advisory.patched_versions === exception.patchedVersions
            && paths.length === 1
            && paths[0] === exception.path;

        if (!exceptionMatches) {
            blocking.push({ advisory, reason: 'allowlist scope changed' });
        } else if (Number.isNaN(expiresAt.valueOf()) || now > expiresAt) {
            blocking.push({ advisory, reason: `exception expired ${exception.expiresOn}` });
        } else {
            accepted.push({ advisory, exception });
        }
    }

    return { accepted, blocking };
}

function formatFinding({ advisory, reason }) {
    const ghsa = advisory.github_advisory_id ?? 'unknown-advisory';
    const moduleName = advisory.module_name ?? 'unknown-module';
    const paths = advisoryPaths(advisory).join(', ') || 'unknown-path';
    return `${ghsa} ${moduleName}: ${reason}; paths=${paths}`;
}

function main() {
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const result = spawnSync(
        pnpm,
        ['audit', '--prod', '--audit-level=high', '--json'],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.signal || ![0, 1].includes(result.status)) {
        throw new Error(`pnpm audit failed without a usable report (status=${result.status}, signal=${result.signal ?? 'none'})`);
    }

    let report;
    try {
        report = JSON.parse(result.stdout);
    } catch {
        throw new Error('pnpm audit returned invalid JSON');
    }

    const evaluation = evaluateAuditReport(report);
    for (const { advisory, exception } of evaluation.accepted) {
        process.stdout.write(
            `Accepted temporary production-audit exception ${advisory.github_advisory_id} `
            + `through ${exception.expiresOn}: ${exception.reason}\n`,
        );
    }
    if (evaluation.blocking.length > 0) {
        for (const finding of evaluation.blocking) {
            process.stderr.write(`${formatFinding(finding)}\n`);
        }
        process.exitCode = 1;
        return;
    }
    process.stdout.write(
        `Production dependency audit passed with ${evaluation.accepted.length} temporary exception(s).\n`,
    );
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`Production dependency audit failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    PRODUCTION_AUDIT_EXCEPTIONS,
    advisoryPaths,
    evaluateAuditReport,
    highOrCritical,
    validateAdvisory,
};
