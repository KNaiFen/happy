'use strict';

const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../..');
const workflowDirectory = path.join(repositoryRoot, '.github', 'workflows');

function externalActionReferences(source) {
    const references = [];
    for (const [index, line] of source.split(/\r?\n/).entries()) {
        const match = /^\s*(?:-\s*)?uses\s*:\s*([^\s#]+)(?:\s+#.*)?$/.exec(line);
        if (!match || match[1].startsWith('./')) {
            continue;
        }
        references.push({ line: index + 1, value: match[1] });
    }
    return references;
}

function checkoutSteps(source) {
    const lines = source.split(/\r?\n/);
    const starts = [];
    for (let index = 0; index < lines.length; index += 1) {
        const match = /^(\s*)-\s+[A-Za-z_][A-Za-z0-9_-]*\s*:/.exec(lines[index]);
        if (match) {
            starts.push({ index, indent: match[1].length });
        }
    }

    const steps = [];
    for (let position = 0; position < starts.length; position += 1) {
        const start = starts[position];
        let end = lines.length;
        for (let next = position + 1; next < starts.length; next += 1) {
            if (starts[next].indent <= start.indent) {
                end = starts[next].index;
                break;
            }
        }
        const block = lines.slice(start.index, end).join('\n');
        if (/^\s*(?:-\s*)?uses\s*:\s*actions\/checkout@/m.test(block)) {
            steps.push({ line: start.index + 1, block });
        }
    }
    return steps;
}

function workflowViolations(name, source) {
    const violations = [];
    for (const [index, line] of source.split(/\r?\n/).entries()) {
        const canonical = /^\s*(?:-\s*)?uses\s*:/.test(line);
        const containsUsesKey = /(?:^|[-{,])\s*["']?uses["']?\s*:/.test(line.trimStart());
        if (containsUsesKey && !canonical) {
            violations.push(`${name}:${index + 1}: uses must use canonical block mapping syntax`);
        }
    }
    for (const reference of externalActionReferences(source)) {
        const separator = reference.value.lastIndexOf('@');
        const revision = separator >= 0 ? reference.value.slice(separator + 1) : '';
        if (!/^[0-9a-f]{40}$/.test(revision)) {
            violations.push(`${name}:${reference.line}: external Action is not pinned to a full commit SHA`);
        }
    }

    for (const step of checkoutSteps(source)) {
        if (!/^\s*persist-credentials\s*:\s*false\s*(?:#.*)?$/m.test(step.block)) {
            violations.push(`${name}:${step.line}: checkout must set persist-credentials: false`);
        }
    }
    return violations;
}

test('workflow security scanner rejects mutable Actions and persisted checkout credentials', () => {
    const source = `
jobs:
  example:
    steps:
      - name: Checkout
        uses : actions/checkout@v7
      - uses: ./local-action
      - uses: owner/action@v3
      - { uses: owner/inline-action@v1 }
`;
    assert.deepEqual(workflowViolations('example.yml', source), [
        'example.yml:9: uses must use canonical block mapping syntax',
        'example.yml:6: external Action is not pinned to a full commit SHA',
        'example.yml:8: external Action is not pinned to a full commit SHA',
        'example.yml:5: checkout must set persist-credentials: false',
    ]);
});

test('workflow security scanner recognizes checkout when another step key comes first', () => {
    const source = `
jobs:
  example:
    steps:
      - id: checkout
        uses: actions/checkout@${'a'.repeat(40)}
`;
    assert.deepEqual(workflowViolations('example.yml', source), [
        'example.yml:5: checkout must set persist-credentials: false',
    ]);

    const directUses = `
jobs:
  example:
    steps:
      - uses: actions/checkout@${'a'.repeat(40)}
`;
    assert.deepEqual(workflowViolations('direct.yml', directUses), [
        'direct.yml:5: checkout must set persist-credentials: false',
    ]);

    const conditionalUses = `
jobs:
  example:
    steps:
      - if: always()
        uses: actions/checkout@${'a'.repeat(40)}
`;
    assert.deepEqual(workflowViolations('conditional.yml', conditionalUses), [
        'conditional.yml:5: checkout must set persist-credentials: false',
    ]);
});

test('all GitHub workflows pin external Actions and disable checkout credential persistence', () => {
    const workflowNames = readdirSync(workflowDirectory)
        .filter((name) => /\.ya?ml$/.test(name))
        .sort();
    assert.ok(workflowNames.length > 0, 'no GitHub workflows found');

    const violations = workflowNames.flatMap((name) => workflowViolations(
        name,
        readFileSync(path.join(workflowDirectory, name), 'utf8'),
    ));
    assert.deepEqual(violations, []);
});
