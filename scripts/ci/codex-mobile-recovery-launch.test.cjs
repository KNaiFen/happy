const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const test = require('node:test');

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
    assert.match(runner, /Resolved recovery launcher start failed\./);
    assert.match(runner, /recovery-am-start\.txt/);
    assert.match(runner, /grep -Fqx 'Status: ok'/);
    assert.match(runner, /restart_app_after_process_death\n\n"\$\{MAESTRO_BIN\}"/);
});
