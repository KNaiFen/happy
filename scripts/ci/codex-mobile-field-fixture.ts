import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import {
    access,
    chmod,
    mkdir,
    rename,
    rm,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import {
    type CodexResponsesFixture,
    startCodexResponsesFixture,
    writeCodexResponsesConfig,
} from './codex-responses-fixture';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverRoot = join(repoRoot, 'packages', 'happy-server');
const cliRoot = join(repoRoot, 'packages', 'happy-cli');
const cliEntrypoint = join(cliRoot, 'dist', 'index.mjs');
const tsxEntrypoint = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const fieldMcpServerEntrypoint = join(repoRoot, 'scripts', 'ci', 'codex-field-mcp-server.mjs');
const appVersion = packageVersion(join(repoRoot, 'packages', 'happy-app', 'package.json'));
const cliVersion = packageVersion(join(cliRoot, 'package.json'));
const relayMasterSecret = randomBytes(32).toString('base64url');

interface FixtureState {
    serverUrl: string;
    appToken: string;
    appSecret: string;
    machineId: string | null;
    phase: 'awaiting-app' | 'machine-ready';
    appId: string;
    root: string;
    verificationFile: string;
    diagnosticsFile: string;
    codexVersion: string;
}

interface FieldDiagnostic {
    schemaVersion: 8;
    phase: 'awaiting-app' | 'app-ready' | 'machine-ready' | 'waiting-for-roundtrip' | 'verified' | 'failed';
    machineRegistered: boolean;
    sessionObserved: boolean;
    commandAccepted: boolean;
    cliRoundTripObserved: boolean;
    retiredV3MessageRouteStatus: number | null;
    entityCounts: Record<string, number>;
    officialCodexVersion: string;
    providerRequestCount: number;
    providerToolOutputObserved: boolean;
    providerFixtureMcpOfferCount: number;
    providerNamespaceToolOfferCount: number;
    providerToolSearchCallCount: number;
    providerToolSearchOutputObserved: boolean;
    providerMcpToolCallCount: number;
    providerMcpToolOutputObserved: boolean;
}

interface ManagedProcess {
    name: string;
    child: ChildProcess;
}

const stateFile = requiredAbsolutePath(
    process.env.HAPPY_MOBILE_E2E_STATE_FILE,
    'HAPPY_MOBILE_E2E_STATE_FILE',
);
const fixtureRoot = requiredFixtureRoot(
    process.env.HAPPY_MOBILE_E2E_ROOT,
    'HAPPY_MOBILE_E2E_ROOT',
);
const port = parsePort(process.env.HAPPY_MOBILE_E2E_PORT ?? '53586');
const roundTripTimeoutMs = parseBoundedInteger(
    process.env.HAPPY_MOBILE_E2E_ROUNDTRIP_TIMEOUT_MS ?? '120000',
    1_000,
    30 * 60_000,
    'HAPPY_MOBILE_E2E_ROUNDTRIP_TIMEOUT_MS',
);
const waitForAppReady = process.env.HAPPY_MOBILE_E2E_WAIT_FOR_APP_READY === '1';
const appReadyTimeoutMs = parseBoundedInteger(
    process.env.HAPPY_MOBILE_E2E_APP_READY_TIMEOUT_MS ?? '300000',
    1_000,
    30 * 60_000,
    'HAPPY_MOBILE_E2E_APP_READY_TIMEOUT_MS',
);
const serverUrl = `http://127.0.0.1:${port}`;
const processes: ManagedProcess[] = [];
let stopping = false;
let requestStop: (() => void) | null = null;
let responsesFixture: CodexResponsesFixture | null = null;

async function main(): Promise<void> {
    await rm(fixtureRoot, { recursive: true, force: true });
    await mkdir(fixtureRoot, { recursive: true });
    await mkdir(dirname(stateFile), { recursive: true });

    const codexVersion = configureOfficialCodexPath();
    responsesFixture = await startCodexResponsesFixture({
        preferFixtureMcpTool: true,
        mcpFollowupDelayMs: 90_000,
    });
    const codexHome = join(fixtureRoot, 'codex-home');
    await writeCodexResponsesConfig(codexHome, responsesFixture.baseUrl, {
        fieldMcp: {
            command: process.execPath,
            args: [fieldMcpServerEntrypoint],
        },
    });
    process.env.CODEX_HOME = codexHome;
    const seededThreadId = await seedOfficialCodexHistory();
    console.log(`Seeded official Codex history ${hashForLog(seededThreadId)}`);
    await migrateRelay();
    const relay = startManagedProcess(
        'relay',
        process.execPath,
        [tsxEntrypoint, 'sources/standalone.ts', 'serve'],
        serverRoot,
        relayEnvironment(),
    );
    await waitForHealth(relay);

    const appToken = await createAppToken();
    const terminalToken = await createTerminalToken(appToken);
    const sharedSecret = randomBytes(32);
    const cliHome = join(fixtureRoot, 'cli-home');
    await prepareCliHome(cliHome, terminalToken, sharedSecret);

    const verificationFile = join(fixtureRoot, 'roundtrip-verified.json');
    const diagnosticsFile = join(fixtureRoot, 'field-diagnostics.json');
    const appReadyFile = join(fixtureRoot, 'app-ready');
    const baseState = {
        serverUrl,
        appToken,
        appSecret: sharedSecret.toString('base64url'),
        appId: 'com.slopus.happy.dev',
        root: fixtureRoot,
        verificationFile,
        diagnosticsFile,
        codexVersion,
    };

    await writeState({
        ...baseState,
        machineId: null,
        phase: 'awaiting-app',
    });
    await writeFieldDiagnostic(diagnosticsFile, {
        schemaVersion: 8,
        phase: 'awaiting-app',
        machineRegistered: false,
        sessionObserved: false,
        commandAccepted: false,
        cliRoundTripObserved: false,
        retiredV3MessageRouteStatus: null,
        entityCounts: {},
        officialCodexVersion: codexVersion,
        providerRequestCount: 0,
        providerToolOutputObserved: false,
        providerFixtureMcpOfferCount: 0,
        providerNamespaceToolOfferCount: 0,
        providerToolSearchCallCount: 0,
        providerToolSearchOutputObserved: false,
        providerMcpToolCallCount: 0,
        providerMcpToolOutputObserved: false,
    });
    if (waitForAppReady) {
        await waitForFile(appReadyFile, appReadyTimeoutMs, 'Android zero-machine app bootstrap');
        await writeFieldDiagnostic(diagnosticsFile, {
            schemaVersion: 8,
            phase: 'app-ready',
            machineRegistered: false,
            sessionObserved: false,
            commandAccepted: false,
            cliRoundTripObserved: false,
            retiredV3MessageRouteStatus: null,
            entityCounts: {},
            officialCodexVersion: codexVersion,
            providerRequestCount: 0,
            providerToolOutputObserved: false,
            providerFixtureMcpOfferCount: 0,
            providerNamespaceToolOfferCount: 0,
            providerToolSearchCallCount: 0,
            providerToolSearchOutputObserved: false,
            providerMcpToolCallCount: 0,
            providerMcpToolOutputObserved: false,
        });
    }

    const daemonEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        HAPPY_HOME_DIR: cliHome,
        HAPPY_SERVER_URL: serverUrl,
        HAPPY_DISABLE_CAFFEINATE: '1',
        HAPPY_EXPERIMENTAL: '0',
        CODEX_HOME: codexHome,
        NODE_ENV: 'test',
    };
    delete daemonEnvironment.HAPPY_CODEX_APP_SERVER_PATH;
    delete daemonEnvironment.HAPPY_FAKE_CODEX_SCENARIO;
    const daemon = startManagedProcess(
        'daemon',
        process.execPath,
        [cliEntrypoint, 'daemon', 'start-sync'],
        repoRoot,
        daemonEnvironment,
    );
    const machineId = await waitForOnlineMachine(appToken, daemon);
    await assertNoSessions(appToken);
    await writeState({
        ...baseState,
        machineId,
        phase: 'machine-ready',
    });
    await writeFieldDiagnostic(diagnosticsFile, {
        schemaVersion: 8,
        phase: 'machine-ready',
        machineRegistered: true,
        sessionObserved: false,
        commandAccepted: false,
        cliRoundTripObserved: false,
        retiredV3MessageRouteStatus: null,
        entityCounts: {},
        officialCodexVersion: codexVersion,
        providerRequestCount: 0,
        providerToolOutputObserved: false,
        providerFixtureMcpOfferCount: 0,
        providerNamespaceToolOfferCount: 0,
        providerToolSearchCallCount: 0,
        providerToolSearchOutputObserved: false,
        providerMcpToolCallCount: 0,
        providerMcpToolOutputObserved: false,
    });

    console.log(`Mobile field fixture ready for machine ${hashForLog(machineId)}`);
    void verifyFieldRoundTrip(
        appToken,
        machineId,
        verificationFile,
        diagnosticsFile,
        codexVersion,
    ).catch((error) => {
        console.error(
            `Mobile field round trip failed: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        process.exitCode = 1;
        requestShutdown();
    });
    await waitForStop();
}

async function seedOfficialCodexHistory(): Promise<string> {
    const { CodexAppServerClient } = await import(
        '../../packages/happy-cli/src/codex/codexAppServerClient'
    );
    const codex = new CodexAppServerClient();
    try {
        await codex.connect();
        const started = await codex.startThread({
            cwd: homedir(),
            approvalPolicy: 'never',
            sandbox: 'read-only',
        });
        const completed = await codex.sendTurnAndWait('resume-history-from-android-e2e', {
            clientUserMessageId: 'android-history-seed',
        });
        assert.equal(completed.aborted, false, 'Official history seed turn was aborted');
        return started.threadId;
    } finally {
        await codex.disconnect().catch(() => undefined);
    }
}

function startManagedProcess(
    name: string,
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
): ManagedProcess {
    const outputFd = openSync(join(fixtureRoot, `${name}.log`), 'a', 0o600);
    let child: ChildProcess;
    try {
        child = spawn(command, args, {
            cwd,
            env,
            stdio: ['ignore', outputFd, outputFd],
        });
    } finally {
        closeSync(outputFd);
    }
    const managed = { name, child };
    processes.push(managed);
    return managed;
}

async function migrateRelay(): Promise<void> {
    const outputPath = join(fixtureRoot, 'migration.log');
    const outputFd = openSync(outputPath, 'a', 0o600);
    let child: ChildProcess;
    try {
        child = spawn(
            process.execPath,
            [tsxEntrypoint, 'sources/standalone.ts', 'migrate'],
            {
                cwd: serverRoot,
                env: relayEnvironment(),
                stdio: ['ignore', outputFd, outputFd],
            },
        );
    } finally {
        closeSync(outputFd);
    }
    const code = await waitForExit(child);
    if (code !== 0) {
        throw new Error(`Relay migration failed with exit code ${code}; see ${outputPath}`);
    }
}

function relayEnvironment(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        DB_PROVIDER: 'pglite',
        DATA_DIR: fixtureRoot,
        PGLITE_DIR: join(fixtureRoot, 'pglite'),
        HANDY_MASTER_SECRET: relayMasterSecret,
        TSX_TSCONFIG_PATH: join(serverRoot, 'tsconfig.json'),
        HAPPY_CODEX_SYNC_V4_ENABLED: 'true',
        HOST: '127.0.0.1',
        PORT: String(port),
        NODE_ENV: 'test',
    };
}

async function waitForHealth(relay: ManagedProcess): Promise<void> {
    await waitUntil(async () => {
        assertRunning(relay);
        try {
            const response = await fetch(`${serverUrl}/health`);
            if (!response.ok) return false;
            const body = await response.json() as {
                status?: unknown;
                service?: unknown;
            };
            return body.status === 'ok' && body.service === 'happy-server';
        } catch {
            return false;
        }
    }, 30_000, 'relay health');
}

async function createAppToken(): Promise<string> {
    const keypair = nacl.sign.keyPair();
    const challenge = nacl.randomBytes(32);
    const signature = nacl.sign.detached(challenge, keypair.secretKey);
    const response = await fetch(`${serverUrl}/v1/auth`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Happy-Client': `android/${appVersion}`,
        },
        body: JSON.stringify({
            publicKey: Buffer.from(keypair.publicKey).toString('base64'),
            challenge: Buffer.from(challenge).toString('base64'),
            signature: Buffer.from(signature).toString('base64'),
        }),
    });
    assert.equal(response.status, 200, `App auth returned HTTP ${response.status}`);
    const body = await response.json() as { token?: unknown };
    if (typeof body.token !== 'string' || body.token.length === 0) {
        throw new Error('App auth response did not include a token');
    }
    return body.token;
}

async function createTerminalToken(appToken: string): Promise<string> {
    const terminalKeypair = nacl.box.keyPair();
    const publicKey = Buffer.from(terminalKeypair.publicKey).toString('base64');
    const request = async () => fetch(`${serverUrl}/v1/auth/request`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli/${cliVersion}`,
        },
        body: JSON.stringify({
            publicKey,
            supportsV2: true,
        }),
    });

    const pending = await request();
    assert.equal(pending.status, 200, `Terminal auth request returned HTTP ${pending.status}`);
    assert.equal((await pending.json() as { state?: unknown }).state, 'requested');

    const approval = await fetch(`${serverUrl}/v1/auth/response`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${appToken}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `android/${appVersion}`,
        },
        body: JSON.stringify({
            publicKey,
            response: Buffer.from('mobile-field-fixture-response').toString('base64'),
        }),
    });
    assert.equal(approval.status, 200, `Terminal auth approval returned HTTP ${approval.status}`);

    const authorized = await request();
    assert.equal(authorized.status, 200, `Terminal auth poll returned HTTP ${authorized.status}`);
    const body = await authorized.json() as {
        state?: unknown;
        token?: unknown;
    };
    assert.equal(body.state, 'authorized');
    if (typeof body.token !== 'string' || body.token.length === 0) {
        throw new Error('Terminal auth response did not include a token');
    }
    return body.token;
}

async function prepareCliHome(
    cliHome: string,
    token: string,
    secret: Buffer,
): Promise<void> {
    await mkdir(join(cliHome, 'logs'), { recursive: true });
    const accessKeyPath = join(cliHome, 'access.key');
    await writeFile(
        accessKeyPath,
        JSON.stringify({
            token,
            secret: secret.toString('base64'),
            serverOrigin: serverUrl,
        }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
    );
    await chmod(accessKeyPath, 0o600);
    await writeFile(
        join(cliHome, 'settings.json'),
        JSON.stringify({
            schemaVersion: 2,
            onboardingCompleted: true,
            daemonAutoStartWhenRunningHappy: false,
            serverUrl,
        }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
    );
}

async function waitForOnlineMachine(
    appToken: string,
    daemon: ManagedProcess,
): Promise<string> {
    let machineId: string | null = null;
    await waitUntil(async () => {
        assertRunning(daemon);
        const response = await fetch(`${serverUrl}/v1/machines`, {
            headers: appHeaders(appToken),
        });
        if (!response.ok) return false;
        const body = await response.json();
        const machines = Array.isArray(body) ? body as Array<{
            id?: unknown;
            active?: unknown;
        }> : [];
        const online = machines.find((machine) => (
            typeof machine.id === 'string' && machine.active === true
        ));
        if (!online || typeof online.id !== 'string') return false;
        machineId = online.id;
        return true;
    }, 45_000, 'online Happy machine');
    assert(machineId);
    return machineId;
}

async function assertNoSessions(appToken: string): Promise<void> {
    const response = await fetch(`${serverUrl}/v1/sessions`, {
        headers: appHeaders(appToken),
    });
    assert.equal(response.status, 200, `Session list returned HTTP ${response.status}`);
    const body = await response.json() as { sessions?: unknown[] };
    assert.deepEqual(body.sessions ?? [], [], 'Fixture must start with zero sessions');
}

async function verifyFieldRoundTrip(
    appToken: string,
    machineId: string,
    verificationFile: string,
    diagnosticsFile: string,
    codexVersion: string,
): Promise<void> {
    let verifiedSessionHash: string | null = null;
    const diagnostic: FieldDiagnostic = {
        schemaVersion: 8,
        phase: 'waiting-for-roundtrip',
        machineRegistered: true,
        sessionObserved: false,
        commandAccepted: false,
        cliRoundTripObserved: false,
        retiredV3MessageRouteStatus: null,
        entityCounts: {},
        officialCodexVersion: codexVersion,
        providerRequestCount: 0,
        providerToolOutputObserved: false,
        providerFixtureMcpOfferCount: 0,
        providerNamespaceToolOfferCount: 0,
        providerToolSearchCallCount: 0,
        providerToolSearchOutputObserved: false,
        providerMcpToolCallCount: 0,
        providerMcpToolOutputObserved: false,
    };
    let lastDiagnostic = '';
    const persistDiagnostic = async (): Promise<void> => {
        const provider = responsesFixture?.snapshot();
        diagnostic.providerRequestCount = provider?.requestCount ?? 0;
        diagnostic.providerToolOutputObserved = provider?.toolOutputObserved ?? false;
        diagnostic.providerFixtureMcpOfferCount = provider?.fixtureMcpOfferCount ?? 0;
        diagnostic.providerNamespaceToolOfferCount = provider?.namespaceToolOfferCount ?? 0;
        diagnostic.providerToolSearchCallCount = provider?.toolSearchCallCount ?? 0;
        diagnostic.providerToolSearchOutputObserved = provider?.toolSearchOutputObserved ?? false;
        diagnostic.providerMcpToolCallCount = provider?.mcpToolCallCount ?? 0;
        diagnostic.providerMcpToolOutputObserved = provider?.mcpToolOutputObserved ?? false;
        const serialized = JSON.stringify(diagnostic);
        if (serialized === lastDiagnostic) return;
        lastDiagnostic = serialized;
        await writeFieldDiagnostic(diagnosticsFile, diagnostic);
    };

    await persistDiagnostic();
    try {
        await waitUntil(async () => {
            const sessionsResponse = await fetch(`${serverUrl}/v1/sessions`, {
                headers: appHeaders(appToken),
            });
            if (!sessionsResponse.ok) return false;
            const sessionsBody = await sessionsResponse.json() as {
                sessions?: Array<{
                    id?: unknown;
                    originMachineId?: unknown;
                }>;
            };
            const session = sessionsBody.sessions?.find((candidate) => (
                typeof candidate.id === 'string'
                && candidate.originMachineId === machineId
            ));
            if (!session || typeof session.id !== 'string') return false;
            diagnostic.sessionObserved = true;

            const v3Response = await fetch(
                `${serverUrl}/v3/sessions/${encodeURIComponent(session.id)}/messages?after_seq=0&limit=100`,
                { headers: appHeaders(appToken) },
            );
            diagnostic.retiredV3MessageRouteStatus = v3Response.status;
            await persistDiagnostic();
            assert.equal(
                v3Response.status,
                404,
                'the Android round trip exposed the retired v3 message route',
            );

            const snapshotResponse = await fetch(
                `${serverUrl}/v4/sessions/${encodeURIComponent(session.id)}/snapshot?limit=100`,
                {
                    headers: {
                        ...appHeaders(appToken),
                        'X-Happy-Machine-Id': machineId,
                    },
                },
            );
            if (!snapshotResponse.ok) return false;
            const snapshot = await snapshotResponse.json() as {
                entities?: Array<{ entityType?: unknown }>;
            };
            const counts = new Map<string, number>();
            for (const entity of snapshot.entities ?? []) {
                if (typeof entity.entityType !== 'string') continue;
                counts.set(entity.entityType, (counts.get(entity.entityType) ?? 0) + 1);
            }
            diagnostic.entityCounts = Object.fromEntries(
                [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
            );
            diagnostic.commandAccepted = (counts.get('codex.command') ?? 0) >= 2;
            const provider = responsesFixture?.snapshot();
            diagnostic.cliRoundTripObserved = (
                diagnostic.commandAccepted
                && (counts.get('codex.thread') ?? 0) >= 1
                && (counts.get('codex.runtime') ?? 0) >= 1
                && (counts.get('codex.turn') ?? 0) >= 1
                && (counts.get('codex.item') ?? 0) >= 2
                && (counts.get('codex.part') ?? 0) >= 2
                && (provider?.requestCount ?? 0) >= 4
                && provider?.toolOutputObserved === true
                && (provider?.fixtureMcpOfferCount ?? 0) >= 1
                && (provider?.mcpToolCallCount ?? 0) >= 1
                && provider?.mcpToolOutputObserved === true
            );
            await persistDiagnostic();
            if (!diagnostic.cliRoundTripObserved) return false;
            verifiedSessionHash = hashForLog(session.id);
            return true;
        }, roundTripTimeoutMs, 'Android App to Codex to App round trip');
    } catch (error) {
        diagnostic.phase = 'failed';
        await persistDiagnostic();
        throw error;
    }

    diagnostic.phase = 'verified';
    await persistDiagnostic();
    await writeFile(
        verificationFile,
        JSON.stringify({
            verified: true,
            sessionHash: verifiedSessionHash,
            retiredV3MessageRouteStatus: diagnostic.retiredV3MessageRouteStatus,
            entityCounts: diagnostic.entityCounts,
            officialCodexVersion: diagnostic.officialCodexVersion,
            providerRequestCount: diagnostic.providerRequestCount,
            providerToolOutputObserved: diagnostic.providerToolOutputObserved,
            providerFixtureMcpOfferCount: diagnostic.providerFixtureMcpOfferCount,
            providerNamespaceToolOfferCount: diagnostic.providerNamespaceToolOfferCount,
            providerToolSearchCallCount: diagnostic.providerToolSearchCallCount,
            providerToolSearchOutputObserved: diagnostic.providerToolSearchOutputObserved,
            providerMcpToolCallCount: diagnostic.providerMcpToolCallCount,
            providerMcpToolOutputObserved: diagnostic.providerMcpToolOutputObserved,
            verifiedAt: Date.now(),
        }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
    );
}

function appHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        'X-Happy-Client': `android/${appVersion}`,
    };
}

async function writeState(state: FixtureState): Promise<void> {
    const temporaryPath = `${stateFile}.${process.pid}.tmp`;
    await writeFile(
        temporaryPath,
        JSON.stringify(state),
        { encoding: 'utf8', mode: 0o600 },
    );
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, stateFile);
}

async function writeFieldDiagnostic(
    path: string,
    diagnostic: FieldDiagnostic,
): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(
        temporaryPath,
        JSON.stringify(diagnostic, null, 2),
        { encoding: 'utf8', mode: 0o600 },
    );
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
}

async function waitForFile(path: string, timeoutMs: number, label: string): Promise<void> {
    await waitUntil(async () => {
        try {
            await access(path);
            return true;
        } catch {
            return false;
        }
    }, timeoutMs, label);
}

async function waitForStop(): Promise<void> {
    const stop = new Promise<void>((resolveStop) => {
        requestStop = resolveStop;
    });
    const unexpectedExits = processes.map(({ child, name }) => (
        waitForExit(child).then((code) => {
            if (!stopping) {
                throw new Error(`${name} exited unexpectedly with code ${code}`);
            }
        })
    ));
    await Promise.race([stop, ...unexpectedExits]);
}

function requestShutdown(): void {
    if (stopping) return;
    stopping = true;
    requestStop?.();
}

async function shutdown(): Promise<void> {
    stopping = true;
    await unlink(stateFile).catch(() => undefined);
    for (const { child } of [...processes].reverse()) {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
        }
    }
    await Promise.all(processes.map(async ({ child }) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = await Promise.race([
            waitForExit(child).then(() => true),
            delay(5_000).then(() => false),
        ]);
        if (!exited && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await waitForExit(child);
        }
    }));
    await responsesFixture?.close().catch(() => undefined);
    responsesFixture = null;
}

function configureOfficialCodexPath(): string {
    const binary = process.env.HAPPY_SCENARIO_CODEX_BIN?.trim();
    const expectedVersion = process.env.HAPPY_SCENARIO_CODEX_VERSION?.trim();
    if (!binary) throw new Error('HAPPY_SCENARIO_CODEX_BIN is required');
    if (!expectedVersion) throw new Error('HAPPY_SCENARIO_CODEX_VERSION is required');
    const result = spawnSync(binary, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
    });
    assert.equal(result.status, 0, `Unable to execute official Codex at ${binary}`);
    assert.equal(result.stdout.trim(), `codex-cli ${expectedVersion}`);
    process.env.PATH = `${dirname(binary)}${delimiter}${process.env.PATH ?? ''}`;
    return result.stdout.trim();
}

function assertRunning(processHandle: ManagedProcess): void {
    if (
        processHandle.child.exitCode !== null
        || processHandle.child.signalCode !== null
    ) {
        throw new Error(
            `${processHandle.name} exited before the fixture became ready`,
        );
    }
}

async function waitUntil(
    condition: () => boolean | Promise<boolean>,
    timeoutMs: number,
    label: string,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await delay(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function waitForExit(child: ChildProcess): Promise<number | null> {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    if (child.signalCode !== null) return Promise.resolve(null);
    return new Promise((resolveExit, rejectExit) => {
        child.once('exit', (code) => resolveExit(code));
        child.once('error', rejectExit);
    });
}

function delay(ms: number): Promise<void> {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function packageVersion(path: string): string {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        version?: unknown;
    };
    if (typeof parsed.version !== 'string') {
        throw new Error(`${path} has no version`);
    }
    return parsed.version;
}

function requiredAbsolutePath(value: string | undefined, name: string): string {
    if (!value?.trim()) throw new Error(`${name} is required`);
    const normalized = resolve(value);
    assert.equal(normalized, value, `${name} must be an absolute path`);
    return normalized;
}

function requiredFixtureRoot(value: string | undefined, name: string): string {
    const normalized = requiredAbsolutePath(value, name);
    const leaf = basename(normalized);
    assert(
        leaf.startsWith('happy-mobile-e2e-'),
        `${name} basename must start with happy-mobile-e2e-`,
    );
    return normalized;
}

function parsePort(value: string): number {
    return parseBoundedInteger(value, 1, 65_535, 'HAPPY_MOBILE_E2E_PORT');
}

function parseBoundedInteger(
    value: string,
    minimum: number,
    maximum: number,
    name: string,
): number {
    const parsed = Number(value);
    assert(
        Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum,
        `${name} must be an integer between ${minimum} and ${maximum}`,
    );
    return parsed;
}

function hashForLog(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

process.on('SIGINT', requestShutdown);
process.on('SIGTERM', requestShutdown);

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    })
    .finally(async () => {
        await shutdown();
    });
