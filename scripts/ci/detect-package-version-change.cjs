#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');

const [packageFile, beforeSha] = process.argv.slice(2);
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

if (!packageFile || !beforeSha) {
    throw new Error('Usage: detect-package-version-change.cjs <package.json> <before-sha>');
}

if (packageFile.startsWith('/') || packageFile.split('/').includes('..')) {
    throw new Error(`Package path must stay inside the repository: ${packageFile}`);
}

function readVersion(json) {
    const version = JSON.parse(json).version;
    if (typeof version !== 'string' || !stableVersionPattern.test(version)) {
        throw new Error(`Expected a stable X.Y.Z version in ${packageFile}`);
    }
    return version;
}

function compareVersions(left, right) {
    const leftParts = left.split('.').map(Number);
    const rightParts = right.split('.').map(Number);
    for (let index = 0; index < leftParts.length; index += 1) {
        if (leftParts[index] !== rightParts[index]) {
            return leftParts[index] - rightParts[index];
        }
    }
    return 0;
}

const currentVersion = readVersion(readFileSync(packageFile, 'utf8'));
let previousVersion;

if (/^[0-9a-f]{40}$/.test(beforeSha) && !/^0+$/.test(beforeSha)) {
    let previousPackageExists = false;
    try {
        execFileSync('git', ['cat-file', '-e', `${beforeSha}:${packageFile}`], {
            stdio: 'ignore',
        });
        previousPackageExists = true;
    } catch {
        previousPackageExists = false;
    }

    if (previousPackageExists) {
        const previousPackage = execFileSync('git', ['show', `${beforeSha}:${packageFile}`], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        previousVersion = readVersion(previousPackage);
    }
}

const changed = previousVersion !== currentVersion;
if (previousVersion && changed && compareVersions(currentVersion, previousVersion) <= 0) {
    throw new Error(`Version must increase: ${previousVersion} -> ${currentVersion}`);
}

const outputs = {
    changed: String(changed),
    version: currentVersion,
    previous: previousVersion ?? '',
};

if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''),
    );
}

process.stdout.write(`${JSON.stringify(outputs)}\n`);
