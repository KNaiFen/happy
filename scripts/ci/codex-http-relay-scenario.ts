import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CODEX_CLI_VERSION_PROBE_TIMEOUT_MS,
} from '../../packages/happy-cli/src/codex/codexCliVersion';
import {
    SyncChangesResponseV4Schema,
    SyncSnapshotResponseV4Schema,
    type CodexEntityV4,
    type CodexItemEntityV4,
    type CodexPartEntityV4,
    type CodexTurnEntityV4,
    type SyncChangeV4,
    type SyncEntitySnapshotV4,
    type SyncV4Aad,
} from '../../packages/happy-wire/src';
import { io, type Socket } from 'socket.io-client';
import nacl from 'tweetnacl';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverRoot = join(repoRoot, 'packages', 'happy-server');
const fakeCodexPath = join(
    repoRoot,
    'packages',
    'happy-cli',
    'scripts',
    'fake-codex-app-server.cjs',
);
const tsxPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const appVersion = loadPackageVersion(
    join(repoRoot, 'packages', 'happy-app', 'package.json'),
);
const deltaCount = 20;
const deltaIntervalMs = 200;
const realLongTurnMinimumMs = 10 * 60 * 1_000;

type ProjectionModule = typeof import(
    '../../packages/happy-app/sources/sync/codexV4Projection'
);
type CodexV4Projection = import(
    '../../packages/happy-app/sources/sync/codexV4Projection'
).CodexV4Projection;

interface EntityCrypto {
    decryptEntity(aad: SyncV4Aad, ciphertext: string): Promise<CodexEntityV4>;
}

interface RelayProcess {
    child: ChildProcess;
    output: () => string;
}

interface AppReceiverOptions {
    baseUrl: string;
    token: string;
    sessionId: string;
    crypto: EntityCrypto;
    projectionModule: ProjectionModule;
    selectedThreadId: string;
    onEntity?: (entity: CodexEntityV4) => void;
}

class AppReceiver {
    readonly projectionModule: ProjectionModule;
    projection: CodexV4Projection;
    cursor = 0;
    highWatermark = 0;

    constructor(private readonly options: AppReceiverOptions) {
        this.projectionModule = options.projectionModule;
        this.projection = this.projectionModule.createCodexV4Projection(
            options.selectedThreadId,
        );
    }

    async pull(): Promise<void> {
        while (true) {
            const query = new URLSearchParams({
                after_seq: String(this.cursor),
                limit: '100',
            });
            const response = await fetch(
                `${this.options.baseUrl}/v4/sessions/${encodeURIComponent(this.options.sessionId)}/changes?${query}`,
                { headers: relayHeaders(this.options.token) },
            );
            assert.equal(response.status, 200, `changes returned HTTP ${response.status}`);
            const page = SyncChangesResponseV4Schema.parse(await response.json());
            this.highWatermark = Math.max(this.highWatermark, page.highWatermark);
            for (const change of page.changes) {
                assert.equal(change.seq, this.cursor + 1, 'changes cursor must remain contiguous');
                await this.apply(change, change.seq);
                this.cursor = change.seq;
            }
            if (!page.hasMore) return;
            assert(page.changes.length > 0, 'changes page with hasMore must make progress');
        }
    }

    async snapshot(): Promise<CodexV4Projection> {
        let cursor: string | null = null;
        let snapshotProjection = this.projectionModule.createCodexV4Projection(
            this.options.selectedThreadId,
        );
        let expectedWatermark: number | null = null;
        do {
            const query = new URLSearchParams({ limit: '100' });
            if (cursor) query.set('cursor', cursor);
            const response = await fetch(
                `${this.options.baseUrl}/v4/sessions/${encodeURIComponent(this.options.sessionId)}/snapshot?${query}`,
                { headers: relayHeaders(this.options.token) },
            );
            assert.equal(response.status, 200, `snapshot returned HTTP ${response.status}`);
            const page = SyncSnapshotResponseV4Schema.parse(await response.json());
            expectedWatermark ??= page.highWatermark;
            assert.equal(page.highWatermark, expectedWatermark, 'snapshot watermark changed between pages');
            const updates = [];
            for (const entity of page.entities) {
                const plaintext = await decryptEntity(
                    this.options.sessionId,
                    this.options.crypto,
                    entity,
                );
                updates.push({
                    entity: plaintext,
                    revision: entity.revision,
                    op: entity.op,
                });
            }
            snapshotProjection = this.projectionModule.applyCodexV4ProjectionUpdates(
                snapshotProjection,
                updates,
            );
            cursor = page.nextCursor;
        } while (cursor);
        return snapshotProjection;
    }

    seedScale(threadId: string): void {
        const updates: Array<{
            entity: CodexEntityV4;
            revision: number;
            op: 'upsert';
        }> = [{
            entity: seedTurn(threadId),
            revision: 1,
            op: 'upsert',
        }];
        for (let index = 0; index < 5_000; index += 1) {
            updates.push({
                entity: seedItem(threadId, index),
                revision: 1,
                op: 'upsert',
            });
            updates.push({
                entity: seedPart(threadId, index),
                revision: 1,
                op: 'upsert',
            });
        }
        this.projection = this.projectionModule.applyCodexV4ProjectionUpdates(
            this.projection,
            updates,
        );
        const entityCount = Object.values(this.projection.entities)
            .reduce((count, bucket) => count + Object.keys(bucket).length, 0);
        assert(entityCount >= 10_000, `scale projection contains only ${entityCount} entities`);
    }

    private async apply(change: SyncChangeV4, seq: number): Promise<void> {
        const entity = await decryptEntity(
            this.options.sessionId,
            this.options.crypto,
            change,
        );
        this.projection = this.projectionModule.applyCodexV4ProjectionUpdate(
            this.projection,
            {
                entity,
                revision: change.revision,
                op: change.op,
            },
        );
        this.options.onEntity?.(entity);
        assert(seq <= this.highWatermark, 'applied seq cannot exceed high watermark');
    }
}

async function main(): Promise<void> {
    configurePinnedCodexPath();
    if (process.argv.includes('--real-long-turn')) {
        await runRealLongTurn();
        return;
    }
    await runHttpRelayScenario();
}

function configurePinnedCodexPath(): void {
    const explicitBinary = process.env.HAPPY_SCENARIO_CODEX_BIN?.trim();
    if (!explicitBinary) return;
    const output = execFileSync(explicitBinary, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: CODEX_CLI_VERSION_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
    }).trim();
    assert.equal(output, 'codex-cli 0.145.0');
    process.env.PATH = `${dirname(explicitBinary)}${delimiter}${process.env.PATH ?? ''}`;
}

async function runHttpRelayScenario(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'happy-codex-http-relay-'));
    const originalHappyHome = process.env.HAPPY_HOME_DIR;
    const originalAppServerPath = process.env.HAPPY_CODEX_APP_SERVER_PATH;
    process.env.HAPPY_HOME_DIR = join(root, 'happy-home');

    let relay: RelayProcess | null = null;
    let socket: Socket | null = null;
    let syncClient: Awaited<ReturnType<
        typeof import('../../packages/happy-cli/src/api/syncV4Client').SyncV4Client.create
    >> | null = null;
    let mapper: InstanceType<
        typeof import('../../packages/happy-cli/src/codex/codexSyncV4Mapper').CodexSyncV4Mapper
    > | null = null;
    let codex: InstanceType<
        typeof import('../../packages/happy-cli/src/codex/codexAppServerClient').CodexAppServerClient
    > | null = null;
    let polling: Promise<void> | null = null;
    let stopPolling = false;

    try {
        const port = await reservePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        await migrateRelay(root);
        relay = startRelay(root, port);
        await waitForHealth(baseUrl, relay);

        const token = await createToken(baseUrl);
        const sessionKey = randomBytes(32);
        const sessionId = await createSession(baseUrl, token, sessionKey);
        const invalidations: number[] = [];
        socket = await connectSocket(baseUrl, token, (payload) => {
            if (
                payload?.type === 'sync-v4-invalidate'
                && payload.sessionId === sessionId
                && Number.isSafeInteger(payload.highWatermark)
            ) {
                invalidations.push(payload.highWatermark);
            }
        });
        assert.equal(socket.io.engine.transport.name, 'websocket');

        const [
            { SyncV4Client },
            { SyncV4Crypto },
            { CodexSyncV4Mapper },
            { CodexAppServerClient },
            projectionModule,
        ] = await Promise.all([
            import('../../packages/happy-cli/src/api/syncV4Client'),
            import('../../packages/happy-cli/src/api/syncV4Crypto'),
            import('../../packages/happy-cli/src/codex/codexSyncV4Mapper'),
            import('../../packages/happy-cli/src/codex/codexAppServerClient'),
            import('../../packages/happy-app/sources/sync/codexV4Projection'),
        ]);

        syncClient = await SyncV4Client.create({
            sessionId,
            sessionKey,
            journalRoot: join(root, 'cli-journal'),
            serverUrl: baseUrl,
            token,
            pollIntervalMs: 250,
            onEntity: async () => undefined,
        });
        await syncClient.start();
        mapper = new CodexSyncV4Mapper(syncClient, {
            codexCliVersion: '0.145.0',
            protocolVersion: 'v2',
            flushIntervalMs: deltaIntervalMs,
        });

        const scenarioPath = join(root, 'streaming-scenario.json');
        await writeFile(scenarioPath, JSON.stringify(streamingScenario()));
        process.env.HAPPY_FAKE_CODEX_SCENARIO = scenarioPath;
        process.env.HAPPY_CODEX_APP_SERVER_PATH = fakeCodexPath;

        const providerDeltaTimes: number[] = [];
        let notificationChain = Promise.resolve();
        codex = new CodexAppServerClient();
        codex.setStableNotificationHandler((notification) => {
            if (notification.method === 'item/agentMessage/delta') {
                providerDeltaTimes.push(performance.now());
            }
            notificationChain = notificationChain.then(() => mapper!.handleNotification(notification));
        });
        await codex.connect();
        const { threadId } = await codex.startThread({
            cwd: root,
            model: 'gpt-test',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });
        assert.equal(threadId, 'fake-thread-1');

        await notificationChain;
        await mapper.flush();
        await syncClient.flushOutboundOnce();
        await waitUntil(
            () => invalidations.length > 0,
            5_000,
            'websocket invalidation',
        );

        const appCrypto = await SyncV4Crypto.create({ sessionId, sessionKey });
        const projectedDeltaTimes: number[] = [];
        let visibleDeltaCount = 0;
        const receiver = new AppReceiver({
            baseUrl,
            token,
            sessionId,
            crypto: appCrypto,
            projectionModule,
            selectedThreadId: threadId,
            onEntity: (entity) => {
                if (
                    entity.entityType !== 'codex.part'
                    || entity.threadId !== threadId
                    || entity.itemId !== 'fake-item-1'
                    || entity.kind !== 'text'
                ) return;
                const nextVisibleCount = Math.min(deltaCount, entity.content.length);
                const now = performance.now();
                while (visibleDeltaCount < nextVisibleCount) {
                    projectedDeltaTimes[visibleDeltaCount] = now;
                    visibleDeltaCount += 1;
                }
            },
        });
        await receiver.pull();
        assert.equal(receiver.projection.thread?.threadId, threadId);
        receiver.seedScale(threadId);

        const invalidationCountBeforeDrop = invalidations.length;
        socket.disconnect();
        assert.equal(socket.connected, false);

        let pollingError: unknown = null;
        polling = (async () => {
            while (!stopPolling) {
                try {
                    await receiver.pull();
                } catch (error) {
                    pollingError = error;
                    return;
                }
                await delay(25);
            }
        })();

        const turnResult = await codex.sendTurnAndWait('stream at five hertz', {
            clientUserMessageId: 'scenario-command-1',
        });
        assert.deepEqual(turnResult, { aborted: false });
        await notificationChain;
        await mapper.flush();
        await syncClient.flushOutboundOnce();

        await waitUntil(() => {
            if (pollingError) throw pollingError;
            return projectedDeltaTimes.length === deltaCount
                && receiver.projection.runtime?.execution.type === 'idle'
                && receiver.projection.messages.some(
                    (message) => message.kind === 'agent-text'
                        && message.text === 'x'.repeat(deltaCount),
                );
        }, 10_000, 'polling projection convergence');
        stopPolling = true;
        await polling;
        polling = null;
        await receiver.pull();

        assert.equal(providerDeltaTimes.length, deltaCount);
        assert.equal(projectedDeltaTimes.length, deltaCount);
        const latencies = projectedDeltaTimes.map(
            (projectedAt, index) => projectedAt - providerDeltaTimes[index],
        );
        assert(latencies.every((latency) => latency >= 0));
        const p95 = percentile(latencies, 0.95);
        assert(
            p95 < 750,
            `healthy HTTP stream p95 ${p95.toFixed(1)} ms exceeds 750 ms`,
        );
        assert.equal(
            invalidations.length,
            invalidationCountBeforeDrop,
            'disconnected App unexpectedly received an invalidation',
        );
        assert.equal(receiver.cursor, receiver.highWatermark);

        const snapshot = await receiver.snapshot();
        assert.equal(snapshot.runtime?.execution.type, 'idle');
        assert(snapshot.messages.some(
            (message) => message.kind === 'agent-text'
                && message.text === 'x'.repeat(deltaCount),
        ));

        console.log(
            `Codex HTTP relay scenario passed: websocket=ok polling=ok entities>=10000 deltas=${deltaCount} p95=${p95.toFixed(1)}ms`,
        );
    } finally {
        stopPolling = true;
        await polling?.catch(() => undefined);
        socket?.disconnect();
        if (codex) await codex.disconnect().catch(() => undefined);
        if (mapper) await mapper.close().catch(() => undefined);
        if (syncClient) await syncClient.close().catch(() => undefined);
        if (relay) await terminateRelay(relay.child);
        restoreEnvironment('HAPPY_HOME_DIR', originalHappyHome);
        restoreEnvironment('HAPPY_CODEX_APP_SERVER_PATH', originalAppServerPath);
        delete process.env.HAPPY_FAKE_CODEX_SCENARIO;
        await rm(root, { recursive: true, force: true });
    }
}

async function runRealLongTurn(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'happy-codex-real-long-turn-'));
    const originalHappyHome = process.env.HAPPY_HOME_DIR;
    const originalAppServerPath = process.env.HAPPY_CODEX_APP_SERVER_PATH;
    const requestedDuration = Number(
        process.env.HAPPY_REAL_LONG_TURN_MS ?? realLongTurnMinimumMs + 1_500,
    );
    assert(
        Number.isSafeInteger(requestedDuration)
            && requestedDuration > realLongTurnMinimumMs
            && requestedDuration <= 15 * 60 * 1_000,
        'HAPPY_REAL_LONG_TURN_MS must be between 600001 and 900000',
    );
    process.env.HAPPY_HOME_DIR = join(root, 'happy-home');
    process.env.HAPPY_CODEX_APP_SERVER_PATH = fakeCodexPath;

    let codex: InstanceType<
        typeof import('../../packages/happy-cli/src/codex/codexAppServerClient').CodexAppServerClient
    > | null = null;
    try {
        const scenarioPath = join(root, 'real-long-turn.json');
        await writeFile(
            scenarioPath,
            JSON.stringify(realLongTurnScenario(requestedDuration)),
        );
        process.env.HAPPY_FAKE_CODEX_SCENARIO = scenarioPath;
        const { CodexAppServerClient } = await import(
            '../../packages/happy-cli/src/codex/codexAppServerClient'
        );
        codex = new CodexAppServerClient();
        await codex.connect();
        await codex.startThread({
            cwd: root,
            model: 'gpt-test',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        console.log(`Starting real long-turn gate for ${requestedDuration} ms`);
        const startedAt = performance.now();
        let settled = false;
        const turn = codex.sendTurnAndWait('remain active past ten minutes', {
            clientUserMessageId: 'real-long-turn-command',
        });
        void turn.then(
            () => { settled = true; },
            () => { settled = true; },
        );
        await delay(realLongTurnMinimumMs + 250);
        assert.equal(settled, false, 'turn settled before ten real minutes elapsed');
        await assert.doesNotReject(turn);
        const elapsed = performance.now() - startedAt;
        assert(
            elapsed > realLongTurnMinimumMs,
            `turn completed after only ${elapsed.toFixed(0)} ms`,
        );
        console.log(`Real long-turn gate passed after ${elapsed.toFixed(0)} ms`);
    } finally {
        if (codex) await codex.disconnect().catch(() => undefined);
        restoreEnvironment('HAPPY_HOME_DIR', originalHappyHome);
        restoreEnvironment('HAPPY_CODEX_APP_SERVER_PATH', originalAppServerPath);
        delete process.env.HAPPY_FAKE_CODEX_SCENARIO;
        await rm(root, { recursive: true, force: true });
    }
}

function streamingScenario(): Record<string, unknown> {
    const startedTurn = {
        id: 'fake-turn-1',
        items: [],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt: 1,
        completedAt: null,
        durationMs: null,
    };
    const startedItem = {
        type: 'agentMessage',
        id: 'fake-item-1',
        text: '',
        phase: null,
        memoryCitation: null,
    };
    const completedItem = {
        ...startedItem,
        text: 'x'.repeat(deltaCount),
    };
    const completedTurn = {
        ...startedTurn,
        items: [completedItem],
        status: 'completed',
        completedAt: 5,
        durationMs: deltaCount * deltaIntervalMs,
    };
    return {
        strictStableV2: true,
        rules: [{
            on: 'turn/start',
            actions: [
                { type: 'response', result: { turn: startedTurn } },
                {
                    type: 'notification',
                    method: 'turn/started',
                    params: { threadId: 'fake-thread-1', turn: startedTurn },
                },
                {
                    type: 'notification',
                    method: 'item/started',
                    delayMs: 10,
                    params: {
                        threadId: 'fake-thread-1',
                        turnId: 'fake-turn-1',
                        item: startedItem,
                        startedAtMs: 1_000,
                    },
                },
                {
                    type: 'notification',
                    method: 'item/agentMessage/delta',
                    delayMs: deltaIntervalMs,
                    intervalMs: deltaIntervalMs,
                    repeat: deltaCount,
                    params: {
                        threadId: 'fake-thread-1',
                        turnId: 'fake-turn-1',
                        itemId: 'fake-item-1',
                        delta: 'x',
                    },
                },
                {
                    type: 'notification',
                    method: 'item/completed',
                    delayMs: deltaCount * deltaIntervalMs + 100,
                    params: {
                        threadId: 'fake-thread-1',
                        turnId: 'fake-turn-1',
                        item: completedItem,
                        completedAtMs: 5_000,
                    },
                },
                {
                    type: 'notification',
                    method: 'turn/completed',
                    delayMs: deltaCount * deltaIntervalMs + 150,
                    params: {
                        threadId: 'fake-thread-1',
                        turn: completedTurn,
                    },
                },
            ],
        }],
    };
}

function realLongTurnScenario(durationMs: number): Record<string, unknown> {
    const startedTurn = {
        id: 'fake-turn-1',
        items: [],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt: 1,
        completedAt: null,
        durationMs: null,
    };
    return {
        strictStableV2: true,
        rules: [{
            on: 'turn/start',
            actions: [
                { type: 'response', result: { turn: startedTurn } },
                {
                    type: 'notification',
                    method: 'turn/started',
                    params: { threadId: 'fake-thread-1', turn: startedTurn },
                },
                {
                    type: 'notification',
                    method: 'turn/completed',
                    delayMs: durationMs,
                    params: {
                        threadId: 'fake-thread-1',
                        turn: {
                            ...startedTurn,
                            status: 'completed',
                            completedAt: Math.ceil(durationMs / 1_000) + 1,
                            durationMs,
                        },
                    },
                },
            ],
        }],
    };
}

async function migrateRelay(root: string): Promise<void> {
    await runProcess(
        process.execPath,
        [tsxPath, 'sources/standalone.ts', 'migrate'],
        {
            cwd: serverRoot,
            env: relayEnvironment(root),
            label: 'PGlite migration',
        },
    );
}

function startRelay(root: string, port: number): RelayProcess {
    const child = spawn(
        process.execPath,
        [tsxPath, 'sources/standalone.ts', 'serve'],
        {
            cwd: serverRoot,
            env: {
                ...relayEnvironment(root),
                HOST: '127.0.0.1',
                PORT: String(port),
                HAPPY_CODEX_SYNC_V4_ENABLED: 'true',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    let output = '';
    const append = (chunk: Buffer) => {
        output = `${output}${chunk.toString('utf8')}`.slice(-32_768);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    return { child, output: () => output };
}

function relayEnvironment(root: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        DB_PROVIDER: 'pglite',
        DATA_DIR: root,
        PGLITE_DIR: join(root, 'pglite'),
        HANDY_MASTER_SECRET: randomBytes(32).toString('base64url'),
        TSX_TSCONFIG_PATH: join(serverRoot, 'tsconfig.json'),
    };
}

async function waitForHealth(baseUrl: string, relay: RelayProcess): Promise<void> {
    await waitUntil(async () => {
        if (relay.child.exitCode !== null) {
            throw new Error(
                `Happy Server exited with ${relay.child.exitCode}: ${relay.output()}`,
            );
        }
        try {
            const response = await fetch(`${baseUrl}/health`);
            if (!response.ok) return false;
            const health = await response.json() as {
                status?: string;
                service?: string;
            };
            return health.status === 'ok' && health.service === 'happy-server';
        } catch {
            return false;
        }
    }, 30_000, 'Happy Server health');
}

async function createToken(baseUrl: string): Promise<string> {
    const keypair = nacl.sign.keyPair();
    const challenge = nacl.randomBytes(32);
    const signature = nacl.sign.detached(challenge, keypair.secretKey);
    const response = await fetch(`${baseUrl}/v1/auth`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Happy-Client': `web/${appVersion}`,
        },
        body: JSON.stringify({
            publicKey: Buffer.from(keypair.publicKey).toString('base64'),
            challenge: Buffer.from(challenge).toString('base64'),
            signature: Buffer.from(signature).toString('base64'),
        }),
    });
    assert.equal(response.status, 200, `auth returned HTTP ${response.status}`);
    const body = await response.json() as { token?: unknown };
    assert.equal(typeof body.token, 'string');
    assert(body.token.length > 0);
    return body.token;
}

async function createSession(
    baseUrl: string,
    token: string,
    sessionKey: Uint8Array,
): Promise<string> {
    const response = await fetch(`${baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
            ...relayHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            tag: `codex-http-scenario-${Date.now()}`,
            metadata: JSON.stringify({
                flavor: 'codex',
                codexSyncVersion: 4,
                codexThreadId: null,
            }),
            agentState: null,
            dataEncryptionKey: Buffer.from(sessionKey).toString('base64'),
        }),
    });
    assert.equal(response.status, 200, `session create returned HTTP ${response.status}`);
    const body = await response.json() as { session?: { id?: unknown } };
    assert.equal(typeof body.session?.id, 'string');
    return body.session.id;
}

async function connectSocket(
    baseUrl: string,
    token: string,
    onEphemeral: (payload: any) => void,
): Promise<Socket> {
    const socket = io(baseUrl, {
        path: '/v1/updates',
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth: {
            token,
            clientType: 'user-scoped',
            happyClient: `web/${appVersion}`,
        },
    });
    socket.on('ephemeral', onEphemeral);
    await new Promise<void>((resolveConnection, rejectConnection) => {
        const timeout = setTimeout(() => {
            rejectConnection(new Error('Socket.IO websocket connection timed out'));
        }, 10_000);
        socket.once('connect', () => {
            clearTimeout(timeout);
            resolveConnection();
        });
        socket.once('connect_error', (error) => {
            clearTimeout(timeout);
            rejectConnection(error);
        });
    });
    return socket;
}

async function decryptEntity(
    sessionId: string,
    crypto: EntityCrypto,
    encrypted: Pick<
        SyncChangeV4 | SyncEntitySnapshotV4,
        'entityId' | 'entityType' | 'revision' | 'op' | 'ciphertext'
    >,
): Promise<CodexEntityV4> {
    return crypto.decryptEntity({
        sessionId,
        entityId: encrypted.entityId,
        entityType: encrypted.entityType,
        revision: encrypted.revision,
        op: encrypted.op,
    }, encrypted.ciphertext);
}

function seedTurn(threadId: string): CodexTurnEntityV4 {
    return {
        schemaVersion: 1,
        entityType: 'codex.turn',
        providerId: 'scale-turn',
        createdAt: 1,
        updatedAt: 1,
        threadId,
        turnId: 'scale-turn',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
        error: null,
        usage: null,
        planRevision: 0,
        diffRevision: 0,
    };
}

function seedItem(threadId: string, index: number): CodexItemEntityV4 {
    const timestamp = 10 + index;
    return {
        schemaVersion: 1,
        entityType: 'codex.item',
        providerId: `scale-item-${index}`,
        createdAt: timestamp,
        updatedAt: timestamp,
        threadId,
        turnId: 'scale-turn',
        itemId: `scale-item-${index}`,
        itemType: 'agentMessage',
        status: 'completed',
        parentItemId: null,
        clientId: null,
        phase: null,
        startedAt: timestamp,
        completedAt: timestamp,
        command: null,
        cwd: null,
        processId: null,
        exitCode: null,
        durationMs: 0,
        server: null,
        tool: null,
        arguments: null,
    };
}

function seedPart(threadId: string, index: number): CodexPartEntityV4 {
    const timestamp = 10 + index;
    return {
        schemaVersion: 1,
        entityType: 'codex.part',
        providerId: `scale-part-${index}`,
        createdAt: timestamp,
        updatedAt: timestamp,
        threadId,
        turnId: 'scale-turn',
        itemId: `scale-item-${index}`,
        partId: `scale-part-${index}`,
        kind: 'text',
        index: 0,
        chunkIndex: 0,
        content: `Scale message ${index}`,
        contentType: 'text',
        final: true,
    };
}

function relayHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        'X-Happy-Client': `web/${appVersion}`,
    };
}

async function reservePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    const port = address.port;
    await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    return port;
}

async function runProcess(
    command: string,
    args: string[],
    options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        label: string;
    },
): Promise<void> {
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk: Buffer) => {
        output = `${output}${chunk.toString('utf8')}`.slice(-32_768);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const code = await waitForExit(child);
    if (code !== 0) {
        throw new Error(`${options.label} exited with ${code}: ${output}`);
    }
}

async function terminateRelay(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    const graceful = await Promise.race([
        waitForExit(child).then(() => true),
        delay(5_000).then(() => false),
    ]);
    if (graceful || child.exitCode !== null) return;
    child.kill('SIGKILL');
    await waitForExit(child);
}

function waitForExit(child: ChildProcess): Promise<number | null> {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return new Promise((resolveExit, rejectExit) => {
        child.once('exit', (code) => resolveExit(code));
        child.once('error', rejectExit);
    });
}

async function waitUntil(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs: number,
    label: string,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!await predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for ${label}`);
        }
        await delay(20);
    }
}

function percentile(values: number[], percentileValue: number): number {
    assert(values.length > 0);
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(sorted.length * percentileValue) - 1);
    return sorted[index];
}

function delay(ms: number): Promise<void> {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

function loadPackageVersion(packagePath: string): string {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as {
        version?: unknown;
    };
    assert.equal(typeof parsed.version, 'string');
    assert(parsed.version.length > 0);
    return parsed.version;
}

void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Codex relay scenario failed: ${message}`);
    process.exitCode = 1;
});
