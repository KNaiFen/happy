#!/usr/bin/env node
'use strict';

const { appendFileSync } = require('node:fs');
const { changedPathsBetween } = require('./classify-workflow-changes.cjs');

function isMarkdown(path) {
    return /\.mdx?$/i.test(path);
}

function shouldAnalyzePaths(paths, { forceAll = false } = {}) {
    if (forceAll) return true;
    return paths.some((path) => !isMarkdown(path));
}

function main() {
    const [baseSha = '', headSha = '', forceAllValue = 'false', eventName = ''] = process.argv.slice(2);
    const changedPaths = forceAllValue === 'true' ? [] : changedPathsBetween(baseSha, headSha, { eventName });
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
