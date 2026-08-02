import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliRoot = join(repoRoot, 'packages', 'happy-cli');
const tsxEntrypoint = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const fixtureTsconfig = join(repoRoot, 'scripts', 'ci', 'tsconfig.codex-gateway-tui.json');
const fixtureEntrypoint = join(repoRoot, 'scripts', 'ci', 'codex-gateway-tui-fixture.ts');
const tuiTestEntrypoint = join(cliRoot, 'node_modules', '.bin', 'tui-test');
const artifactRoot = process.env.HAPPY_GATEWAY_TUI_ARTIFACT_DIR
    ? resolve(process.env.HAPPY_GATEWAY_TUI_ARTIFACT_DIR)
    : await mkdtemp(join(tmpdir(), 'happy-gateway-tui-e2e-'));
const workRoot = await mkdtemp(join(tmpdir(), 'happy-gateway-tui-work-'));
const fixtureRoot = join(workRoot, 'fixture');
const stateFile = join(workRoot, 'fixture-state.json');
const fixtureLog = join(artifactRoot, 'fixture.log');
const traceDir = join(artifactRoot, 'tui-traces');

const officialBinary = requiredEnvironment('HAPPY_SCENARIO_CODEX_BIN');
const officialVersion = requiredEnvironment('HAPPY_SCENARIO_CODEX_VERSION');
const officialPath = `${dirname(officialBinary)}${delimiter}${process.env.PATH ?? ''}`;
const terminalPrompt = 'gateway-pty-terminal-message-71b408';
const appPrompt = 'gateway-pty-app-message-c38f15';
const attachPrompt = 'gateway-pty-attach-message-d2be90';
const responseSentinel = 'Official Codex source E2E response';

await mkdir(artifactRoot, { recursive: true });
await mkdir(traceDir, { recursive: true });
await writeFile(fixtureLog, '', { encoding: 'utf8', mode: 0o600 });
const fixtureOutput = openSync(fixtureLog, 'a', 0o600);
let fixture;
try {
    fixture = spawn(process.execPath, [tsxEntrypoint, '--tsconfig', fixtureTsconfig, fixtureEntrypoint], {
        cwd: repoRoot,
        env: {
            ...process.env,
            PATH: officialPath,
            HAPPY_GATEWAY_TUI_ROOT: fixtureRoot,
            HAPPY_GATEWAY_TUI_STATE_FILE: stateFile,
            HAPPY_GATEWAY_TUI_LOG_FILE: fixtureLog,
            HAPPY_SCENARIO_CODEX_BIN: officialBinary,
            HAPPY_SCENARIO_CODEX_VERSION: officialVersion,
        },
        stdio: ['ignore', fixtureOutput, fixtureOutput],
    });
} finally {
    closeSync(fixtureOutput);
}

let exitCode = 1;
try {
    const fixtureState = await waitForFixtureState();
    await waitForHealth(fixtureState.controlUrl);
    const runner = spawn(tuiTestEntrypoint, [
        '--trace',
        'tests/tui/codexGatewayTui.test.ts',
    ], {
        cwd: cliRoot,
        env: {
            ...process.env,
            PATH: officialPath,
            HAPPY_GATEWAY_TUI_CONTROL_URL: fixtureState.controlUrl,
            HAPPY_GATEWAY_TUI_SERVER_URL: fixtureState.serverUrl,
            HAPPY_GATEWAY_TUI_HAPPY_HOME: fixtureState.happyHomeDir,
            HAPPY_GATEWAY_TUI_CODEX_HOME: fixtureState.codexHome,
            HAPPY_GATEWAY_TUI_CLI_ENTRYPOINT: fixtureState.cliEntrypoint,
            HAPPY_GATEWAY_TUI_TRACE_DIR: traceDir,
            HAPPY_GATEWAY_TUI_TERMINAL_PROMPT: terminalPrompt,
            HAPPY_GATEWAY_TUI_APP_PROMPT: appPrompt,
            HAPPY_GATEWAY_TUI_ATTACH_PROMPT: attachPrompt,
            HAPPY_GATEWAY_TUI_RESPONSE_SENTINEL: responseSentinel,
        },
        stdio: 'inherit',
    });
    exitCode = await waitForExit(runner) ?? 1;
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 1;
} finally {
    try {
        const raw = JSON.parse(await readFile(stateFile, 'utf8'));
        if (typeof raw.controlUrl === 'string') {
            await fetch(`${raw.controlUrl}/shutdown`, { method: 'POST' }).catch(() => undefined);
        }
    } catch {
        fixture.kill('SIGTERM');
    }
    let fixtureExitCode;
    const fixtureExit = await Promise.race([
        waitForExit(fixture).then((code) => ({ stopped: true, code })),
        delay(15_000).then(() => ({ stopped: false, code: undefined })),
    ]);
    if (fixtureExit.stopped) fixtureExitCode = fixtureExit.code;
    if (!fixtureExit.stopped) {
        if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill('SIGKILL');
        fixtureExitCode = await waitForExit(fixture);
    }
    if (exitCode === 0 && fixtureExitCode !== 0) {
        console.error(`Codex Gateway TUI fixture exited with ${fixtureExitCode ?? fixture.signalCode ?? 'unknown'}`);
        exitCode = 1;
    }
    if (exitCode !== 0) {
        const log = await readFile(fixtureLog, 'utf8').catch(() => '');
        console.error(log.split('\n').slice(-250).join('\n'));
    }
    await rm(workRoot, { recursive: true, force: true });
}

process.exitCode = exitCode;

async function waitForFixtureState() {
    let state = null;
    await waitUntil(async () => {
        if (fixture.exitCode !== null || fixture.signalCode !== null) {
            throw new Error('Codex Gateway TUI fixture exited before it was ready');
        }
        try {
            const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
            if (
                typeof parsed.controlUrl !== 'string'
                || typeof parsed.serverUrl !== 'string'
                || typeof parsed.happyHomeDir !== 'string'
                || typeof parsed.codexHome !== 'string'
                || typeof parsed.cliEntrypoint !== 'string'
            ) return false;
            state = parsed;
            return true;
        } catch {
            return false;
        }
    }, 90_000, 'Codex Gateway TUI fixture state');
    assert(state);
    return state;
}

async function waitForHealth(controlUrl) {
    await waitUntil(async () => {
        try {
            const response = await fetch(`${controlUrl}/health`);
            return response.ok;
        } catch {
            return false;
        }
    }, 10_000, 'Codex Gateway TUI fixture health');
}

async function waitUntil(condition, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await delay(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function waitForExit(child) {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    if (child.signalCode !== null) return Promise.resolve(null);
    return new Promise((resolveExit, rejectExit) => {
        child.once('exit', (code) => resolveExit(code));
        child.once('error', rejectExit);
    });
}

function delay(ms) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function requiredEnvironment(name) {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}
