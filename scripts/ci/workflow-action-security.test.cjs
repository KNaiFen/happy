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

function namedSteps(source, name) {
    const lines = source.split(/\r?\n/);
    const startLine = `      - name: ${name}`;
    const steps = [];
    for (let start = 0; start < lines.length; start += 1) {
        if (lines[start] !== startLine) {
            continue;
        }
        let end = start + 1;
        while (end < lines.length && !/^      - /.test(lines[end])) {
            end += 1;
        }
        steps.push(lines.slice(start, end).join('\n'));
    }
    return steps;
}

function requiredNamedStep(source, name) {
    const steps = namedSteps(source, name);
    assert.equal(steps.length, 1, `${name} must appear exactly once`);
    return steps[0];
}

function assertUnconditionalStep(step, name) {
    assert.doesNotMatch(step, /(?:^|\n)\s*["']?if["']?\s*:/, `${name} must not be conditional`);
    assert.doesNotMatch(step, /(?:^|\n)\s*["']?continue-on-error["']?\s*:/, `${name} must not continue on error`);
}

function namedJob(source, name, nextName) {
    const start = source.indexOf(`  ${name}:\n`);
    if (start < 0) {
        return null;
    }
    const end = source.indexOf(`\n  ${nextName}:\n`, start + 1);
    return source.slice(start, end < 0 ? source.length : end);
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

test('Tauri CI enforces the pinned High/Critical and unscored Cargo audit policy', () => {
    const workflow = readFileSync(path.join(workflowDirectory, 'ci.yml'), 'utf8');
    const policy = readFileSync(path.join(
        repositoryRoot,
        'packages',
        'happy-app',
        'src-tauri',
        '.cargo',
        'audit.toml',
    ), 'utf8');

    assert.equal((workflow.match(/^  tauri:$/gm) || []).length, 1, 'Tauri job must appear exactly once');
    const tauriJob = namedJob(workflow, 'tauri', 'migration');

    assert.ok(tauriJob, 'missing Tauri CI job');
    const rustSetup = requiredNamedStep(tauriJob, 'Set up Rust');
    const installAudit = requiredNamedStep(tauriJob, 'Install pinned cargo-audit');
    const auditStep = requiredNamedStep(tauriJob, 'Audit Tauri High/Critical and unscored production advisories');

    assert.match(tauriJob, /^    if: needs\.classify\.outputs\.tauri == 'true'$/m);
    assert.match(rustSetup, /^        uses: dtolnay\/rust-toolchain@[0-9a-f]{40}(?:\s+#.*)?$/m);
    assert.match(rustSetup, /^          toolchain: 1\.88\.0$/m);
    assert.match(rustSetup, /^          components: rustfmt$/m);
    assertUnconditionalStep(rustSetup, 'Set up Rust');
    assert.match(tauriJob, /cargo metadata --locked --format-version 1/);
    assert.match(installAudit, /^        run: cargo install cargo-audit --locked --version 0\.22\.2$/m);
    assertUnconditionalStep(installAudit, 'Install pinned cargo-audit');
    assert.match(auditStep, /^        working-directory: packages\/happy-app\/src-tauri$/m);
    assert.match(auditStep, /^        run: cargo audit$/m);
    assertUnconditionalStep(auditStep, 'Audit Tauri High/Critical and unscored production advisories');
    assert.doesNotMatch(tauriJob, /(?:^|\n)\s*["']?continue-on-error["']?\s*:/);
    assert.match(policy, /^# Unscored RustSec vulnerability advisories match the threshold and fail closed\.$/m);
    assert.match(policy, /^severity_threshold = "high"$/m);
    assert.match(policy, /^ignore = \[\]$/m);
    assert.match(policy, /^deny = \[\]$/m);
    assert.match(policy, /^fetch = true$/m);
    assert.match(policy, /^stale = false$/m);
});

test('Tauri audit contract rejects duplicate, conditional, and soft-failing security steps', () => {
    const installName = 'Install pinned cargo-audit';
    const duplicate = `
      - name: ${installName}
        run: cargo install cargo-audit --locked --version 0.22.2
      - name: ${installName}
        if: false
        run: cargo install cargo-audit --locked --version 0.22.2
`;
    assert.throws(() => requiredNamedStep(duplicate, installName), /must appear exactly once/);

    const conditional = `
      - name: ${installName}
        if: false
        run: cargo install cargo-audit --locked --version 0.22.2
`;
    assert.throws(
        () => assertUnconditionalStep(requiredNamedStep(conditional, installName), installName),
        /must not be conditional/,
    );

    const softFailing = `
      - name: ${installName}
        continue-on-error: true
        run: cargo install cargo-audit --locked --version 0.22.2
`;
    assert.throws(
        () => assertUnconditionalStep(requiredNamedStep(softFailing, installName), installName),
        /must not continue on error/,
    );
});
