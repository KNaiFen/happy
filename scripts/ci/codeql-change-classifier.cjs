#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const shaPattern = /^[0-9a-f]{40}$/;

function isMarkdown(path) {
    return /\.mdx?$/i.test(path);
}

function shouldAnalyzePaths(paths, { forceAll = false } = {}) {
    if (forceAll) return true;
    return paths.some((path) => !isMarkdown(path));
}

function changedPathsBetween(baseSha, headSha) {
    if (!shaPattern.test(baseSha) || /^0+$/.test(baseSha)) return null;
    if (!shaPattern.test(headSha) || /^0+$/.test(headSha)) return null;
    return execFileSync(
        'git',
        ['diff', '--name-only', '-z', baseSha, headSha],
        { encoding: 'utf8' },
    ).split('\0').filter(Boolean);
}

function main() {
    const [baseSha = '', headSha = '', forceAllValue = 'false'] = process.argv.slice(2);
    const changedPaths = forceAllValue === 'true' ? [] : changedPathsBetween(baseSha, headSha);
    const shouldAnalyze = changedPaths === null
        || shouldAnalyzePaths(changedPaths, { forceAll: forceAllValue === 'true' });
    const output = `should_analyze=${shouldAnalyze}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
    process.stdout.write(output);
}

if (require.main === module) main();

module.exports = {
    changedPathsBetween,
    isMarkdown,
    shouldAnalyzePaths,
};
