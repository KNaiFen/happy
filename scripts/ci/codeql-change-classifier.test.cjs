'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    isMarkdown,
    shouldAnalyzePaths,
} = require('./codeql-change-classifier.cjs');

test('recognizes Markdown and MDX case-insensitively', () => {
    assert.equal(isMarkdown('README.md'), true);
    assert.equal(isMarkdown('docs/guide.MDX'), true);
    assert.equal(isMarkdown('docs/guide.ts'), false);
});

test('skips a docs-only change and scans every non-doc input', () => {
    assert.equal(shouldAnalyzePaths(['README.md', 'docs/guide.mdx']), false);
    assert.equal(shouldAnalyzePaths(['README.md', 'packages/happy-cli/src/index.ts']), true);
    assert.equal(shouldAnalyzePaths(['assets/logo.png']), true);
});

test('forces scheduled analysis even without changed paths', () => {
    assert.equal(shouldAnalyzePaths([], { forceAll: true }), true);
    assert.equal(shouldAnalyzePaths([]), false);
});
