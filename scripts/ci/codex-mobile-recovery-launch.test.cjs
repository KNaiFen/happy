const assert = require('node:assert/strict');
const {
    mkdtemp,
    mkdir,
    readFile,
    rm,
    writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('Android bootstrap waits for the first runtime credential request and fails closed', async () => {
    const runner = await readFile(resolve(process.cwd(), 'scripts/ci/run-codex-android-field-e2e.sh'), 'utf8');
    const start = runner.indexOf('assert_first_credential_request() {');
    const end = runner.indexOf('\nrestart_app_after_process_death()', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const functionSource = runner.slice(start, end);
    const bootstrapEnd = runner.indexOf('\n  "${BOOTSTRAP_FLOW_PATH}"');
    const assertionCall = runner.indexOf('\nassert_first_credential_request\n', bootstrapEnd);
    const zeroMachineDebug = runner.indexOf('--debug-output "${DEBUG_OUTPUT_DIR}/zero-machine"');
    assert(bootstrapEnd > 0 && assertionCall > bootstrapEnd && zeroMachineDebug > assertionCall);
    assert.match(runner, /CREDENTIAL_LOG="\$\{RUNNER_TEMP\}\/happy-mobile-credential-server\.log"/);
    assert.match(runner, /test -f "\$\{CREDENTIAL_LOG\}"/);
    const root = await mkdtemp(join(tmpdir(), 'happy-android-credential-request-'));
    const sequencePath = join(root, 'seq');
    const sleepPath = join(root, 'sleep');
    try {
        await writeFile(sequencePath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\${CREDENTIAL_TEST_SEQUENCE:-1}"
`, { mode: 0o755 });
        await writeFile(sleepPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${CREDENTIAL_TEST_APPEND:-}" ]]; then
  printf '%s\\n' "$CREDENTIAL_TEST_APPEND" >> "$CREDENTIAL_LOG"
fi
`, { mode: 0o755 });

        let assertionCount = 0;
        const runAssertion = async ({ initialLog = '', append = '', sequence = '1' }) => {
            const logPath = join(root, `credential-${assertionCount++}.log`);
            await writeFile(logPath, initialLog);
            return spawnSync('bash', ['-c', `set -euo pipefail
${functionSource}
assert_first_credential_request
`], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    CREDENTIAL_LOG: logPath,
                    CREDENTIAL_TEST_APPEND: append,
                    CREDENTIAL_TEST_SEQUENCE: sequence,
                    PATH: `${root}:${process.env.PATH}`,
                },
            });
        };

        const accepted = await runAssertion({
            append: 'Mobile Field credential request 1: method=GET status=200',
            sequence: '1 2',
        });
        assert.equal(accepted.status, 0, accepted.stderr);

        const rejected = await runAssertion({
            initialLog: 'Mobile Field credential request 1: method=GET status=404\n',
        });
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, /exact loopback endpoint/);

        const missing = await runAssertion({ initialLog: '', sequence: '1' });
        assert.notEqual(missing.status, 0);
        assert.match(missing.stderr, /Timed out waiting for the App/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('Android process-death recovery uses bounded ADB startup before Maestro assertions', async () => {
    const [recoveryFlow, runner] = await Promise.all([
        readFile(resolve(process.cwd(), 'scripts/ci/maestro/codex-mobile-recovery.yml'), 'utf8'),
        readFile(resolve(process.cwd(), 'scripts/ci/run-codex-android-field-e2e.sh'), 'utf8'),
    ]);

    assert.doesNotMatch(recoveryFlow, /^\s*-\s+launchApp:/m);
    assert.match(runner, /adb shell pm path "\$\{APP_ID\}"/);
    assert.match(runner, /cmd package resolve-activity --brief/);
    assert.match(runner, /timeout 30s adb shell am start -W/);
    assert.match(runner, /-a android\.intent\.action\.MAIN/);
    assert.match(runner, /-c android\.intent\.category\.LAUNCHER/);
    assert.match(runner, /-n "\$\{resolved_component\}"/);
    assert.doesNotMatch(runner, /am start -W[\s\S]*-p "\$\{APP_ID\}"/);
    assert.match(runner, /Recovery package path lookup failed\./);
    assert.match(runner, /Recovery launcher activity resolution failed\./);
    assert.match(runner, /component_candidates="\$\(/);
    assert.match(runner, /index\(\$0, app_id "\/"\) == 1/);
    assert.match(runner, /"\$\{component_candidates\}" == \*\$'\\n'\*/);
    assert.match(runner, /Expected exactly one launcher component of \$\{APP_ID\}\./);
    assert.match(runner, /Resolved recovery launcher start failed\./);
    assert.match(runner, /recovery-am-start\.txt/);
    assert.match(runner, /grep -Fqx 'Status: ok'/);
    assert.match(runner, /restart_app_after_process_death\n\n"\$\{MAESTRO_BIN\}"/);
});

test('Android recovery selects the unique component from API 36 resolver output', async () => {
    const runner = await readFile(resolve(process.cwd(), 'scripts/ci/run-codex-android-field-e2e.sh'), 'utf8');
    const start = runner.indexOf('restart_app_after_process_death() {');
    const end = runner.indexOf('\ntest -f "${APK_PATH}"', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const root = await mkdtemp(join(tmpdir(), 'happy-android-recovery-launch-'));
    const artifactDir = join(root, 'artifacts');
    const adbPath = join(root, 'adb');
    const timeoutPath = join(root, 'timeout');
    const invocationsPath = join(root, 'adb-invocations.txt');
    try {
        await mkdir(artifactDir);
        await writeFile(adbPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$ADB_INVOCATIONS"
case "$1 $2 $3" in
  'shell pm path')
    printf 'package:/data/app/com.slopus.happy.dev/base.apk\\n'
    ;;
  'shell cmd package')
    printf 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\\n'
    printf 'com.slopus.happy.dev/.MainActivity\\n'
    ;;
  'shell am start')
    printf 'Starting: Intent { cmp=com.slopus.happy.dev/.MainActivity }\\nStatus: ok\\n'
    ;;
  *)
    exit 64
    ;;
esac
`, { mode: 0o755 });
        await writeFile(timeoutPath, `#!/usr/bin/env bash
set -euo pipefail
shift
exec "$@"
`, { mode: 0o755 });

        const functionSource = runner.slice(start, end);
        const result = spawnSync('bash', ['-c', `set -euo pipefail
ARTIFACT_DIR="$1"
APP_ID=com.slopus.happy.dev
${functionSource}
restart_app_after_process_death
`, 'bash', artifactDir], {
            encoding: 'utf8',
            env: {
                ...process.env,
                ADB_INVOCATIONS: invocationsPath,
                PATH: `${root}:${process.env.PATH}`,
            },
        });

        assert.equal(result.status, 0, result.stderr);
        const launchLog = await readFile(join(artifactDir, 'recovery-am-start.txt'), 'utf8');
        assert.match(launchLog, /priority=0 preferredOrder=0/);
        assert.match(launchLog, /selected_launcher_component=com\.slopus\.happy\.dev\/.MainActivity/);
        assert.match(launchLog, /^Status: ok$/m);
        assert.match(launchLog, /^finished_at_utc=/m);
        const invocations = await readFile(invocationsPath, 'utf8');
        assert.match(invocations, /shell am start .* -n com\.slopus\.happy\.dev\/.MainActivity/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
