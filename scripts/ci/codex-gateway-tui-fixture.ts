import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
    chmod,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { closeSync, openSync, readFileSync } from 'node:fs';
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import nacl from 'tweetnacl';
import type { CodexEntityV4 } from '@slopus/happy-wire';
import { decodeBase64, decryptWithDataKey } from '../../packages/happy-cli/src/api/encryption';
import { SyncV4Crypto as NodeSyncV4Crypto } from '../../packages/happy-cli/src/api/syncV4Crypto';
import { deriveKey } from '../../packages/happy-cli/src/utils/deriveKey';
import { AppSyncV4Client } from '../../packages/happy-app/sources/sync/syncV4Client';
import { AppSyncV4HttpTransport } from '../../packages/happy-app/sources/sync/syncV4HttpTransportCore';
import { SyncV4Persistence, type SyncV4KeyValueStorage } from '../../packages/happy-app/sources/sync/syncV4Persistence';
import {
    applyCodexV4ProjectionUpdates,
    createCodexV4Projection,
    newestCodexV4CommandResult,
    type CodexV4Projection,
} from '../../packages/happy-app/sources/sync/codexV4Projection';
import {
    commandForCodexV4Input,
    createCodexV4Command,
    parseCodexV4Input,
} from '../../packages/happy-app/sources/sync/codexV4Commands';
import {
    OFFICIAL_CODEX_RESPONSE_SENTINEL,
    OFFICIAL_CODEX_TOOL_SENTINEL,
    startCodexResponsesFixture,
    writeCodexResponsesConfig,
    type CodexResponsesFixture,
} from './codex-responses-fixture';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliRoot = join(repoRoot, 'packages', 'happy-cli');
const serverRoot = join(repoRoot, 'packages', 'happy-server');
const cliEntrypoint = join(cliRoot, 'bin', 'happy.mjs');
const tsxEntrypoint = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const appVersion = packageVersion(join(repoRoot, 'packages', 'happy-app', 'package.json'));
const cliVersion = packageVersion(join(cliRoot, 'package.json'));
const rawReasoningCanary = Buffer.from('b'.repeat(550)).toString('base64');

interface FixtureStateFile {
    controlUrl: string;
    serverUrl: string;
    happyHomeDir: string;
    codexHome: string;
    cliEntrypoint: string;
    codexVersion: string;
}

interface RelaySession {
    id: string;
    metadata: string;
    metadataVersion: number;
    dataEncryptionKey: string | null;
    active: boolean;
    originMachineId: string | null;
}

interface GatewayDescriptorShape {
    gatewayId: string;
    pid: number;
    providerPid: number | null;
    state: 'starting' | 'running' | 'recovering' | 'stopping' | 'stopped';
    terminalState: 'attached' | 'pendingDetach' | 'detached' | 'headless';
    current: {
        threadId: string;
        sessionId: string | null;
        generation: number;
        role: 'current' | 'draining' | 'inactive' | 'recovering';
    } | null;
    createdAt: number;
    heartbeatAt: number;
    lastError: string | null;
}

interface CommandExpectation {
    commandId: string;
    text: string;
    baselineAgentMessages: number;
}

interface AppRuntime {
    client: AppSyncV4Client;
    session: RelaySession;
    sessionKey: Uint8Array;
    metadata: Record<string, unknown>;
    projection(): CodexV4Projection;
    beginLatencyMeasurement(): void;
    projectionLags(): number[];
}

interface ManagedProcess {
    name: string;
    child: ChildProcess;
}

class MemoryStorage implements SyncV4KeyValueStorage {
    private readonly values = new Map<string, string | number | boolean>();

    getString(key: string): string | undefined {
        const value = this.values.get(key);
        return typeof value === 'string' ? value : undefined;
    }

    getNumber(key: string): number | undefined {
        const value = this.values.get(key);
        return typeof value === 'number' ? value : undefined;
    }

    set(key: string, value: string | number | boolean): void {
        this.values.set(key, value);
    }

    delete(key: string): void {
        this.values.delete(key);
    }

    getAllKeys(): string[] {
        return [...this.values.keys()];
    }
}

const fixtureRoot = requiredAbsolutePath(
    process.env.HAPPY_GATEWAY_TUI_ROOT,
    'HAPPY_GATEWAY_TUI_ROOT',
);
const stateFile = requiredAbsolutePath(
    process.env.HAPPY_GATEWAY_TUI_STATE_FILE,
    'HAPPY_GATEWAY_TUI_STATE_FILE',
);
const outerFixtureLog = requiredAbsolutePath(
    process.env.HAPPY_GATEWAY_TUI_LOG_FILE,
    'HAPPY_GATEWAY_TUI_LOG_FILE',
);
const happyHomeDir = join(fixtureRoot, 'happy-home');
const codexHome = join(fixtureRoot, 'codex-home');
const relayMasterSecret = randomBytes(32).toString('base64url');
const accountSecret = randomBytes(32);
const machineId = randomUUID();
const processes: ManagedProcess[] = [];
const appRuntimes = new Map<string, AppRuntime>();
const commandExpectations = new Map<string, CommandExpectation>();
const payloadCanaries = new Set<string>([rawReasoningCanary]);
let responsesFixture: CodexResponsesFixture | null = null;
let relayServerUrl = '';
let appToken = '';
let terminalToken = '';
let controlServer: Server | null = null;
let shuttingDown = false;
let shutdownRequested = false;
let resolveShutdown: (() => void) | null = null;

async function main(): Promise<void> {
    await rm(fixtureRoot, { recursive: true, force: true });
    await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
    await mkdir(dirname(stateFile), { recursive: true });

    const codexVersion = configureOfficialCodexPath();
    responsesFixture = await startCodexResponsesFixture();
    await writeCodexResponsesConfig(codexHome, responsesFixture.baseUrl);

    const relayPort = await reservePort();
    relayServerUrl = `http://127.0.0.1:${relayPort}`;
    await migrateRelay(relayPort);
    const relay = startManagedProcess(
        'relay',
        process.execPath,
        [tsxEntrypoint, 'sources/standalone.ts', 'serve'],
        serverRoot,
        relayEnvironment(relayPort),
    );
    await waitForHealth(relay);

    appToken = await createAppToken();
    terminalToken = await createTerminalToken(appToken);
    await prepareCliHome();

    controlServer = createServer((request, response) => {
        void handleControlRequest(request, response).catch((error) => {
            sendJson(response, 500, {
                error: error instanceof Error ? error.name : 'UnknownError',
            });
        });
    });
    await listen(controlServer);
    const address = controlServer.address() as AddressInfo;
    const controlUrl = `http://127.0.0.1:${address.port}`;
    await writeStateFile({
        controlUrl,
        serverUrl: relayServerUrl,
        happyHomeDir,
        codexHome,
        cliEntrypoint,
        codexVersion,
    });
    console.log(`Codex Gateway TUI fixture ready (${codexVersion})`);

    await new Promise<void>((resolveReady) => {
        resolveShutdown = resolveReady;
        if (shutdownRequested) resolveReady();
    });
}

async function handleControlRequest(
    request: IncomingMessage,
    response: ServerResponse,
): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { status: 'ok' });
        return;
    }
    if (request.method === 'GET' && url.pathname === '/state') {
        const message = url.searchParams.get('message');
        const commandId = url.searchParams.get('commandId');
        if (message) payloadCanaries.add(message);
        sendJson(response, 200, await fixtureStatus({ message, commandId }));
        return;
    }
    if (request.method === 'POST' && url.pathname === '/app/prompt') {
        const body = await readJsonBody(request);
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text || Buffer.byteLength(text, 'utf8') > 16_384) {
            sendJson(response, 400, { error: 'invalidPrompt' });
            return;
        }
        const published = await publishAppPrompt(text);
        sendJson(response, 200, published);
        return;
    }
    if (request.method === 'POST' && url.pathname === '/shutdown') {
        sendJson(response, 200, { stopping: true });
        requestShutdown();
        return;
    }
    sendJson(response, 404, { error: 'notFound' });
}

async function publishAppPrompt(text: string): Promise<{
    commandId: string;
    baselineAgentMessages: number;
}> {
    const runtime = await waitForAppRuntime();
    await runtime.client.pullChangesOnce();
    const projection = runtime.projection();
    const threadId = projection.thread?.threadId;
    const generation = projection.runtime?.gateway?.generation;
    if (!threadId || generation === undefined || projection.runtime?.syncState !== 'ready') {
        throw new Error('Codex Gateway App projection is not ready');
    }
    const commandId = randomUUID();
    const baselineAgentMessages = countAgentMessages(projection);
    const command = createCodexV4Command(commandForCodexV4Input({
        parsed: parseCodexV4Input(text, []),
        projection,
        threadId,
        mode: { permissionMode: 'default' },
    }), { commandId });
    assert.equal(command.bindingGeneration, generation);
    commandExpectations.set(commandId, { commandId, text, baselineAgentMessages });
    payloadCanaries.add(text);
    runtime.beginLatencyMeasurement();
    await runtime.client.publishEntity(command);
    await runtime.client.flushOutboundOnce();
    return { commandId, baselineAgentMessages };
}

async function fixtureStatus(options: {
    message: string | null;
    commandId: string | null;
}): Promise<Record<string, unknown>> {
    const descriptors = await readGatewayDescriptors();
    const descriptor = descriptors.find((candidate) => candidate.state !== 'stopped')
        ?? descriptors[0]
        ?? null;
    const session = descriptor
        ? await findGatewaySession(descriptor.gatewayId).catch(() => null)
        : null;
    const runtime = session
        ? await getOrCreateAppRuntime(session).catch(() => null)
        : [...appRuntimes.values()][0] ?? null;
    if (runtime) await runtime.client.pullChangesOnce().catch(() => undefined);
    const projection = runtime?.projection() ?? null;
    const commandExpectation = options.commandId
        ? commandExpectations.get(options.commandId) ?? null
        : null;
    const commandResult = options.commandId
        ? newestCodexV4CommandResult(projection, options.commandId)
        : null;
    const parts = projection
        ? Object.values(projection.entities['codex.part'])
        : [];
    const items = projection
        ? Object.values(projection.entities['codex.item'])
        : [];
    const projectionLags = runtime?.projectionLags() ?? [];
    const v3MessageCount = runtime
        ? await readV3MessageCount(runtime.session.id).catch(() => -1)
        : 0;
    const provider = responsesFixture?.snapshot() ?? null;

    return {
        gateway: descriptor ? {
            gatewayId: descriptor.gatewayId,
            pid: descriptor.pid,
            providerPid: descriptor.providerPid,
            state: descriptor.state,
            terminalState: descriptor.terminalState,
            threadId: descriptor.current?.threadId ?? projection?.thread?.threadId ?? null,
            sessionId: descriptor.current?.sessionId ?? runtime?.session.id ?? null,
            generation: descriptor.current?.generation ?? projection?.runtime?.gateway?.generation ?? null,
            workerAlive: isProcessAlive(descriptor.pid),
            providerAlive: descriptor.providerPid ? isProcessAlive(descriptor.providerPid) : false,
            lastError: descriptor.lastError,
        } : null,
        sessionActive: session?.active ?? runtime?.session.active ?? null,
        projectionReady: projection?.runtime?.syncState === 'ready',
        messageObserved: options.message
            ? projection?.messages.some((entry) => (
                (entry.kind === 'user-text' || entry.kind === 'agent-text')
                && entry.text === options.message
            )) ?? false
            : null,
        agentMessageCount: projection ? countAgentMessages(projection) : 0,
        reasoningSummaryCount: parts.filter((part) => part.kind === 'reasoningSummary').length,
        commandOutputCount: parts.filter((part) => (
            part.kind === 'commandOutput'
            && part.content.includes(OFFICIAL_CODEX_TOOL_SENTINEL)
        )).length,
        officialResponseCount: parts.filter((part) => (
            part.kind === 'text'
            && part.content.includes(OFFICIAL_CODEX_RESPONSE_SENTINEL)
        )).length,
        rawReasoningLeak: projection
            ? JSON.stringify(projection.entities).includes(rawReasoningCanary)
            : false,
        commandResultStatus: commandResult?.status ?? null,
        providerUserMessageObserved: options.commandId
            ? items.some((item) => item.itemType === 'userMessage' && item.clientId === options.commandId)
            : null,
        responseAfterCommand: commandExpectation && projection
            ? countAgentMessages(projection) > commandExpectation.baselineAgentMessages
            : null,
        providerRequestCount: provider?.requestCount ?? 0,
        providerToolOutputObserved: provider?.toolOutputObserved ?? false,
        v3MessageCount,
        projectionLagSamples: projectionLags.length,
        projectionLagP95Ms: percentile(projectionLags, 0.95),
        payloadLeakInLogs: await logsContainPayload([...payloadCanaries]),
    };
}

async function waitForAppRuntime(): Promise<AppRuntime> {
    let runtime: AppRuntime | null = null;
    await waitUntil(async () => {
        const descriptors = await readGatewayDescriptors();
        const descriptor = descriptors.find((candidate) => (
            candidate.state === 'running'
            && candidate.current?.sessionId
        ));
        if (!descriptor) return false;
        const session = await findGatewaySession(descriptor.gatewayId);
        if (!session) return false;
        runtime = await getOrCreateAppRuntime(session);
        await runtime.client.pullChangesOnce();
        const projection = runtime.projection();
        return projection.runtime?.syncState === 'ready' && Boolean(projection.thread?.threadId);
    }, 60_000, 'Gateway App projection');
    assert(runtime);
    return runtime;
}

async function getOrCreateAppRuntime(session: RelaySession): Promise<AppRuntime> {
    const cached = appRuntimes.get(session.id);
    if (cached) {
        cached.session.active = session.active;
        return cached;
    }
    if (!session.dataEncryptionKey) throw new Error('Gateway session has no independent data key');
    const sessionKey = await decryptSessionKey(session.dataEncryptionKey);
    const metadata = decryptWithDataKey(decodeBase64(session.metadata), sessionKey);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('Gateway session metadata could not be decrypted');
    }
    const threadId = typeof metadata.codexThreadId === 'string'
        ? metadata.codexThreadId
        : null;
    let projection = createCodexV4Projection(threadId);
    let measureProjectionLags = false;
    const projectionLags: number[] = [];
    const applyEvents = (events: readonly {
        entity: CodexEntityV4;
        source: 'cache' | 'change' | 'snapshot';
        op: 'upsert' | 'delete';
        revision: number;
    }[]): void => {
        projection = applyCodexV4ProjectionUpdates(projection, events);
        if (!measureProjectionLags) return;
        for (const event of events) {
            if (event.source !== 'change' || event.entity.entityType !== 'codex.part') continue;
            projectionLags.push(Math.max(0, Date.now() - event.entity.updatedAt));
        }
    };
    const persistence = new SyncV4Persistence(new MemoryStorage());
    const crypto = await NodeSyncV4Crypto.create({ sessionId: session.id, sessionKey });
    const transport = new AppSyncV4HttpTransport(async (path, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${appToken}`);
        headers.set('X-Happy-Client', `android/${appVersion}`);
        headers.set('X-Happy-Machine-Id', machineId);
        return fetch(`${relayServerUrl}${path}`, { ...init, headers });
    });
    const client = await AppSyncV4Client.create({
        sessionId: session.id,
        sessionKey,
        appVersion,
        persistence,
        transport,
        crypto,
        pollIntervalMs: 25,
        transportSecurity: 'insecureHttp',
        generateMutationId: randomUUID,
        generateTraceId: () => randomBytes(16).toString('hex'),
        onEntity: async (event) => applyEvents([event]),
        onEntities: async (events) => applyEvents(events),
        onSnapshotReset: async () => {
            projection = createCodexV4Projection(threadId);
        },
        onSnapshotReplace: async (events) => {
            projection = createCodexV4Projection(threadId);
            applyEvents(events);
        },
    });
    const runtime: AppRuntime = {
        client,
        session,
        sessionKey,
        metadata,
        projection: () => projection,
        beginLatencyMeasurement: () => { measureProjectionLags = true; },
        projectionLags: () => [...projectionLags],
    };
    try {
        await client.start();
    } catch (error) {
        client.stop();
        throw error;
    }
    appRuntimes.set(session.id, runtime);
    return runtime;
}

async function findGatewaySession(gatewayId: string): Promise<RelaySession | null> {
    const response = await fetch(`${relayServerUrl}/v1/sessions`, {
        headers: appHeaders(),
    });
    if (!response.ok) throw new Error(`Session list failed with HTTP ${response.status}`);
    const body = await response.json() as { sessions?: RelaySession[] };
    for (const session of body.sessions ?? []) {
        if (session.originMachineId !== machineId || !session.dataEncryptionKey) continue;
        try {
            const key = await decryptSessionKey(session.dataEncryptionKey);
            const metadata = decryptWithDataKey(decodeBase64(session.metadata), key);
            if (
                metadata
                && typeof metadata === 'object'
                && !Array.isArray(metadata)
                && metadata.codexGatewayBinding?.gatewayId === gatewayId
            ) return session;
        } catch {
            continue;
        }
    }
    return null;
}

async function decryptSessionKey(encoded: string): Promise<Uint8Array> {
    const bundle = Buffer.from(encoded, 'base64');
    if (bundle.length < 1 + 32 + nacl.box.nonceLength + nacl.box.overheadLength || bundle[0] !== 0) {
        throw new Error('Invalid wrapped session key');
    }
    const contentSeed = await deriveKey(accountSecret, 'Happy EnCoder', ['content']);
    const hashedSeed = createHash('sha512').update(contentSeed).digest();
    const recipientSecretKey = new Uint8Array(hashedSeed.subarray(0, 32));
    const ephemeralPublicKey = new Uint8Array(bundle.subarray(1, 33));
    const nonce = new Uint8Array(bundle.subarray(33, 33 + nacl.box.nonceLength));
    const ciphertext = new Uint8Array(bundle.subarray(33 + nacl.box.nonceLength));
    const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, recipientSecretKey);
    if (!decrypted || decrypted.length !== 32) throw new Error('Wrapped session key did not decrypt');
    return new Uint8Array(decrypted);
}

async function readGatewayDescriptors(): Promise<GatewayDescriptorShape[]> {
    const root = join(happyHomeDir, 'codex-gateways');
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const descriptors: GatewayDescriptorShape[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
            const parsed = JSON.parse(await readFile(
                join(root, entry.name, 'descriptor.json'),
                'utf8',
            )) as GatewayDescriptorShape;
            if (typeof parsed.gatewayId === 'string' && typeof parsed.pid === 'number') {
                descriptors.push(parsed);
            }
        } catch {
            continue;
        }
    }
    return descriptors.sort((left, right) => right.createdAt - left.createdAt);
}

async function readV3MessageCount(sessionId: string): Promise<number> {
    const response = await fetch(
        `${relayServerUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages?after_seq=0&limit=100`,
        { headers: appHeaders() },
    );
    if (!response.ok) throw new Error(`v3 message list failed with HTTP ${response.status}`);
    const body = await response.json() as { messages?: unknown[] };
    return body.messages?.length ?? 0;
}

async function logsContainPayload(canaries: string[]): Promise<boolean> {
    const filtered = canaries.filter((value) => value.length > 0);
    if (filtered.length === 0) return false;
    const roots = [
        outerFixtureLog,
        join(fixtureRoot, 'relay.log'),
        join(fixtureRoot, 'migration.log'),
        join(happyHomeDir, 'logs'),
    ];
    for (const root of roots) {
        let info;
        try {
            info = await stat(root);
        } catch {
            continue;
        }
        const files = info.isDirectory()
            ? (await readdir(root)).map((entry) => join(root, entry))
            : [root];
        for (const path of files) {
            try {
                const content = await readFile(path, 'utf8');
                if (filtered.some((canary) => content.includes(canary))) return true;
            } catch {
                continue;
            }
        }
    }
    return false;
}

async function createAppToken(): Promise<string> {
    const keypair = nacl.sign.keyPair();
    const challenge = nacl.randomBytes(32);
    const signature = nacl.sign.detached(challenge, keypair.secretKey);
    const response = await fetch(`${relayServerUrl}/v1/auth`, {
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
    assert.equal(typeof body.token, 'string');
    return body.token as string;
}

async function createTerminalToken(accountToken: string): Promise<string> {
    const terminalKeypair = nacl.box.keyPair();
    const publicKey = Buffer.from(terminalKeypair.publicKey).toString('base64');
    const createRequest = () => fetch(`${relayServerUrl}/v1/auth/request`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli/${cliVersion}`,
        },
        body: JSON.stringify({ publicKey, supportsV2: true }),
    });
    const requested = await createRequest();
    assert.equal(requested.status, 200);
    assert.equal((await requested.json() as { state?: unknown }).state, 'requested');

    const approved = await fetch(`${relayServerUrl}/v1/auth/response`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accountToken}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `android/${appVersion}`,
        },
        body: JSON.stringify({
            publicKey,
            response: Buffer.from('gateway-tui-fixture-response').toString('base64'),
        }),
    });
    assert.equal(approved.status, 200);

    const status = await fetch(
        `${relayServerUrl}/v1/auth/request/status?publicKey=${encodeURIComponent(publicKey)}`,
        { headers: { 'X-Happy-Client': `cli/${cliVersion}` } },
    );
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { status?: unknown }).status, 'authorized');

    const claimed = await createRequest();
    assert.equal(claimed.status, 200);
    const body = await claimed.json() as { state?: unknown; token?: unknown };
    assert.equal(body.state, 'authorized');
    assert.equal(typeof body.token, 'string');
    return body.token as string;
}

async function prepareCliHome(): Promise<void> {
    await mkdir(join(happyHomeDir, 'logs'), { recursive: true, mode: 0o700 });
    await writePrivateJson(join(happyHomeDir, 'access.key'), {
        token: terminalToken,
        secret: accountSecret.toString('base64'),
        serverOrigin: relayServerUrl,
    });
    await writePrivateJson(join(happyHomeDir, 'settings.json'), {
        schemaVersion: 2,
        onboardingCompleted: true,
        machineId,
        machineIdConfirmedByServer: false,
        daemonAutoStartWhenRunningHappy: false,
        serverUrl: relayServerUrl,
    });
}

function configureOfficialCodexPath(): string {
    const binary = process.env.HAPPY_SCENARIO_CODEX_BIN?.trim();
    const expectedVersion = process.env.HAPPY_SCENARIO_CODEX_VERSION?.trim();
    if (!binary || !expectedVersion) {
        throw new Error('Official Codex binary and version are required');
    }
    const result = spawnSync(binary, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
    });
    assert.equal(result.status, 0, 'Official Codex version probe failed');
    assert.equal(result.stdout.trim(), `codex-cli ${expectedVersion}`);
    process.env.PATH = `${dirname(binary)}${delimiter}${process.env.PATH ?? ''}`;
    return result.stdout.trim();
}

async function migrateRelay(port: number): Promise<void> {
    const child = startManagedProcess(
        'migration',
        process.execPath,
        [tsxEntrypoint, 'sources/standalone.ts', 'migrate'],
        serverRoot,
        relayEnvironment(port),
    );
    const code = await waitForExit(child.child);
    const processIndex = processes.indexOf(child);
    if (processIndex >= 0) processes.splice(processIndex, 1);
    if (code !== 0) throw new Error(`Relay migration exited with code ${code}`);
}

function relayEnvironment(port: number): NodeJS.ProcessEnv {
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

function startManagedProcess(
    name: string,
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
): ManagedProcess {
    const outputPath = join(fixtureRoot, `${name}.log`);
    const outputFd = openSync(outputPath, 'a', 0o600);
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

async function waitForHealth(relay: ManagedProcess): Promise<void> {
    await waitUntil(async () => {
        if (!isChildRunning(relay.child)) {
            throw new Error('Relay exited before becoming healthy');
        }
        try {
            const response = await fetch(`${relayServerUrl}/health`);
            if (!response.ok) return false;
            const body = await response.json() as { status?: unknown; service?: unknown };
            return body.status === 'ok' && body.service === 'happy-server';
        } catch {
            return false;
        }
    }, 30_000, 'relay health');
}

async function reservePort(): Promise<number> {
    const server = createServer();
    await listen(server);
    const address = server.address() as AddressInfo;
    await closeServer(server);
    return address.port;
}

async function listen(server: Server): Promise<void> {
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', rejectListen);
            resolveListen();
        });
    });
}

async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
    });
}

async function writeStateFile(state: FixtureStateFile): Promise<void> {
    const temporary = `${stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, stateFile);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
    const handle = await open(path, 'w', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    await chmod(path, 0o600);
}

function appHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${appToken}`,
        'X-Happy-Client': `android/${appVersion}`,
    };
}

function countAgentMessages(projection: CodexV4Projection): number {
    return projection.messages.filter((message) => message.kind === 'agent-text').length;
}

function percentile(values: number[], ratio: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
    return sorted[index];
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function isChildRunning(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > 64 * 1024) throw new Error('Control request body is too large');
        chunks.push(buffer);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Control request body must be an object');
    }
    return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) return;
    response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        Connection: 'close',
    });
    response.end(JSON.stringify(body));
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
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    if (typeof parsed.version !== 'string') throw new Error(`${path} has no version`);
    return parsed.version;
}

function requiredAbsolutePath(value: string | undefined, name: string): string {
    if (!value?.trim()) throw new Error(`${name} is required`);
    const normalized = resolve(value);
    assert.equal(normalized, value, `${name} must be absolute`);
    return normalized;
}

function requestShutdown(): void {
    shutdownRequested = true;
    resolveShutdown?.();
}

async function stopHappyProcesses(): Promise<void> {
    const environment = {
        ...process.env,
        HAPPY_HOME_DIR: happyHomeDir,
        HAPPY_SERVER_URL: relayServerUrl,
        CODEX_HOME: codexHome,
        HAPPY_DISABLE_CAFFEINATE: '1',
        HAPPY_EXPERIMENTAL: '0',
        NODE_ENV: 'test',
    };
    for (const descriptor of await readGatewayDescriptors()) {
        if (descriptor.state === 'stopped') continue;
        await runCleanupCommand(['codex', 'stop', descriptor.gatewayId, '--force'], environment);
    }
    await runCleanupCommand(['daemon', 'stop'], environment);
}

async function runCleanupCommand(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    const child = spawn(process.execPath, [cliEntrypoint, ...args], {
        cwd: cliRoot,
        env,
        stdio: 'ignore',
    });
    await Promise.race([waitForExit(child), delay(5_000)]);
    if (isChildRunning(child)) child.kill('SIGKILL');
}

async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopHappyProcesses().catch(() => undefined);
    for (const runtime of appRuntimes.values()) runtime.client.stop();
    appRuntimes.clear();
    if (controlServer) await closeServer(controlServer).catch(() => undefined);
    controlServer = null;
    await responsesFixture?.close().catch(() => undefined);
    responsesFixture = null;
    for (const { child } of [...processes].reverse()) {
        if (isChildRunning(child)) child.kill('SIGTERM');
    }
    await Promise.all(processes.map(async ({ child }) => {
        if (!isChildRunning(child)) return;
        const exited = await Promise.race([
            waitForExit(child).then(() => true),
            delay(5_000).then(() => false),
        ]);
        if (!exited && isChildRunning(child)) child.kill('SIGKILL');
    }));
}

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    })
    .finally(shutdown);
