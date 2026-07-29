import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, readdir, rm, stat, writeFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CODEX_CLI_VERSION_PROBE_TIMEOUT_MS,
} from '../../packages/happy-cli/src/codex/codexCliVersion';
import {
    encodeBase64,
    encrypt,
    libsodiumEncryptForPublicKey,
} from '../../packages/happy-cli/src/api/encryption';
import {
    CodexEntityV4Schema,
    SyncV4DiagnosticRecordSchema,
    type CodexCommandEntityV4,
    type CodexEntityV4,
    type CodexItemEntityV4,
    type CodexPartEntityV4,
    type CodexRequestEntityV4,
    type CodexTurnEntityV4,
    type SyncMutationV4,
    type SyncV4DiagnosticRecord,
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
const maxRelayOutputBytes = 8 * 1024 * 1024;
const rootThreadId = 'provider-thread-private-v4';
const rootTurnId = 'provider-turn-private-v4';
const rootAgentItemId = 'provider-agent-item-private-v4';
const childThreadId = 'provider-child-thread-private-v4';
const childTurnId = 'provider-child-turn-private-v4';
const childAgentItemId = 'provider-child-item-private-v4';
const approvalRequestId = '7001';
const approvalItemId = 'provider-command-item-private-v4';
const promptSecret = 'SYNCV4_PROMPT_SECRET_4f1bc74d';
const reasoningSummarySecret = 'SYNCV4_REASONING_SUMMARY_SECRET_f036f9d1';
const rawReasoningSecret = 'SYNCV4_RAW_REASONING_SECRET_839a1270';
const toolArgumentSecret = 'SYNCV4_TOOL_ARGUMENT_SECRET_9b0ce8ff';
const toolOutputSecret = 'SYNCV4_TOOL_OUTPUT_SECRET_2b1a74aa';
const approvalReasonSecret = 'SYNCV4_APPROVAL_REASON_SECRET_556f9710';
const childPromptSecret = 'SYNCV4_CHILD_PROMPT_SECRET_8d76b321';
const unknownMethodSecret = 'private/unknown/method/SYNCV4_39b420d1';
const modelSecret = 'private-model-SYNCV4-8d94d106';

type ProjectionModule = typeof import(
    '../../packages/happy-app/sources/sync/codexV4Projection'
);
type CodexV4Projection = import(
    '../../packages/happy-app/sources/sync/codexV4Projection'
).CodexV4Projection;

interface RelayProcess {
    child: ChildProcess;
    output: () => string;
}

class ScenarioStorage {
    readonly values = new Map<string, string | number | boolean>();

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

interface ScenarioAppRuntime {
    client: {
        readonly receiveCursor: number;
        start(): Promise<void>;
        stop(): void;
        pullChangesOnce(): Promise<void>;
        publishEntity(entity: CodexEntityV4): Promise<SyncMutationV4>;
        flushOutboundOnce(): Promise<void>;
    };
    projection: () => CodexV4Projection;
    seedScale: () => void;
}

function seedScaleProjection(
    projectionModule: ProjectionModule,
    projection: CodexV4Projection,
    threadId: string,
): CodexV4Projection {
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
        const scaled = projectionModule.applyCodexV4ProjectionUpdates(
            projection,
            updates,
        );
        const entityCount = Object.values(scaled.entities)
            .reduce((count, bucket) => count + Object.keys(bucket).length, 0);
        assert(entityCount >= 10_000, `scale projection contains only ${entityCount} entities`);
        return scaled;
}

async function main(): Promise<void> {
    configurePinnedCodexPath();
    const sharedHome = await mkdtemp(join(tmpdir(), 'happy-codex-scenario-home-'));
    const originalHappyHome = process.env.HAPPY_HOME_DIR;
    process.env.HAPPY_HOME_DIR = sharedHome;
    try {
        if (process.argv.includes('--real-long-turn')) {
            await runRealLongTurn();
            return;
        }
        await runLateThreadStartedScenario();
        await runHttpRelayScenario();
    } finally {
        restoreEnvironment('HAPPY_HOME_DIR', originalHappyHome);
        await rm(sharedHome, { recursive: true, force: true });
    }
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

async function runLateThreadStartedScenario(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'happy-codex-late-thread-started-'));
    const originalAppServerPath = process.env.HAPPY_CODEX_APP_SERVER_PATH;
    process.env.HAPPY_CODEX_APP_SERVER_PATH = fakeCodexPath;

    let codex: InstanceType<
        typeof import('../../packages/happy-cli/src/codex/codexAppServerClient').CodexAppServerClient
    > | null = null;
    try {
        const scenarioPath = join(root, 'late-thread-started.json');
        await writeFile(
            scenarioPath,
            JSON.stringify(lateThreadStartedScenario(root)),
        );
        process.env.HAPPY_FAKE_CODEX_SCENARIO = scenarioPath;
        const { CodexAppServerClient } = await import(
            '../../packages/happy-cli/src/codex/codexAppServerClient'
        );
        codex = new CodexAppServerClient();
        await codex.connect();
        const { threadId } = await codex.startThread({
            cwd: root,
            model: 'gpt-test',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });
        assert.equal(threadId, 'fake-thread-late');

        let lateThreadMetadataObserved = false;
        codex.setStableNotificationHandler((notification) => {
            if (
                notification.method === 'thread/started'
                && notification.params.thread.id === threadId
            ) {
                lateThreadMetadataObserved = true;
            }
        });
        let settled = false;
        const turn = codex.sendTurnAndWait('survive late thread metadata', {
            clientUserMessageId: 'late-thread-started-command',
        });
        void turn.then(
            () => { settled = true; },
            () => { settled = true; },
        );
        await waitUntil(
            () => lateThreadMetadataObserved,
            5_000,
            'late thread/started metadata',
        );
        await Promise.resolve();
        assert.equal(
            settled,
            false,
            'late thread/started metadata settled the active turn',
        );
        await codex.interruptTurn({ timeoutMs: 5_000 });
        await assert.doesNotReject(turn);
        console.log('Late thread/started ordering gate passed');
    } finally {
        if (codex) await codex.disconnect().catch(() => undefined);
        restoreEnvironment('HAPPY_CODEX_APP_SERVER_PATH', originalAppServerPath);
        delete process.env.HAPPY_FAKE_CODEX_SCENARIO;
        await rm(root, { recursive: true, force: true });
    }
}

async function runHttpRelayScenario(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'happy-codex-http-relay-'));
    const originalAppServerPath = process.env.HAPPY_CODEX_APP_SERVER_PATH;
    const masterSecret = randomBytes(32).toString('base64url');
    const relayOutputs: string[] = [];
    const cliTraceIds: string[] = [];
    const appTraceIds: string[] = [];
    const manualTraceIds: string[] = [];
    const echoedAppTraceIds = new Set<string>();
    const ciphertextCanaries: string[] = [];
    const routerErrors: unknown[] = [];

    let relay: RelayProcess | null = null;
    let socket: Socket | null = null;
    let rootSyncClient: Awaited<ReturnType<
        typeof import('../../packages/happy-cli/src/api/syncV4Client').SyncV4Client.create
    >> | null = null;
    let rootMapper: InstanceType<
        typeof import('../../packages/happy-cli/src/codex/codexSyncV4Mapper').CodexSyncV4Mapper
    > | null = null;
    let codex: InstanceType<
        typeof import('../../packages/happy-cli/src/codex/codexAppServerClient').CodexAppServerClient
    > | null = null;
    let router: InstanceType<
        typeof import('../../packages/happy-cli/src/codex/codexV4ThreadRouter').CodexV4ThreadRouter
    > | null = null;
    let rootBinding: import(
        '../../packages/happy-cli/src/codex/codexV4ThreadRouter'
    ).CodexV4SessionBinding | null = null;
    let rootApp: ScenarioAppRuntime | null = null;
    let childApp: ScenarioAppRuntime | null = null;
    let fallbackApp: ScenarioAppRuntime | null = null;
    let fallbackCli: Awaited<ReturnType<
        typeof import('../../packages/happy-cli/src/api/syncV4Client').SyncV4Client.create
    >> | null = null;
    let cliDiagnostics: InstanceType<
        typeof import('../../packages/happy-cli/src/api/syncV4Diagnostics').CliSyncV4DiagnosticLog
    > | null = null;
    let protocolTrace: InstanceType<
        typeof import('../../packages/happy-cli/src/codex/codexProtocolTrace').CodexProtocolTraceRecorder
    > | null = null;
    let generalLogPath: string | null = null;

    try {
        const port = await reservePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        await migrateRelay(root, masterSecret);
        relay = startRelay(root, port, masterSecret);
        await waitForHealth(baseUrl, relay);

        manualTraceIds.push(await verifyCorsAndTrace(baseUrl));
        const token = await createToken(baseUrl);
        const machineState = await createMachine(baseUrl, token);
        const sessionKey = randomBytes(32);
        const sessionId = await createSession(baseUrl, token, sessionKey, {
            tag: `codex-http-scenario-${Date.now()}`,
            threadId: null,
        });
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
            { SyncV4Crypto: NodeSyncV4Crypto },
            { CodexSyncV4Mapper },
            { CodexAppServerClient },
            { CodexV4RequestBroker },
            { CodexV4CommandProcessor },
            { CodexV4ThreadRouter },
            { deriveCodexV4ChildSessionIdentity },
            { CliSyncV4DiagnosticLog },
            { CodexProtocolTraceRecorder, readCodexProtocolTrace },
            { logger },
            { SyncV4Persistence },
            { AppSyncV4Client },
            { AppSyncV4HttpTransport },
            { AppSyncV4DiagnosticStore },
            projectionModule,
        ] = await Promise.all([
            import('../../packages/happy-cli/src/api/syncV4Client'),
            import('../../packages/happy-cli/src/api/syncV4Crypto'),
            import('../../packages/happy-cli/src/codex/codexSyncV4Mapper'),
            import('../../packages/happy-cli/src/codex/codexAppServerClient'),
            import('../../packages/happy-cli/src/codex/codexV4RequestBroker'),
            import('../../packages/happy-cli/src/codex/codexV4CommandProcessor'),
            import('../../packages/happy-cli/src/codex/codexV4ThreadRouter'),
            import('../../packages/happy-cli/src/codex/codexV4ChildIdentity'),
            import('../../packages/happy-cli/src/api/syncV4Diagnostics'),
            import('../../packages/happy-cli/src/codex/codexProtocolTrace'),
            import('../../packages/happy-cli/src/ui/logger'),
            import('../../packages/happy-app/sources/sync/syncV4Persistence'),
            import('../../packages/happy-app/sources/sync/syncV4Client'),
            import('../../packages/happy-app/sources/sync/syncV4HttpTransportCore'),
            import('../../packages/happy-app/sources/sync/syncV4Diagnostics'),
            import('../../packages/happy-app/sources/sync/codexV4Projection'),
        ]);

        generalLogPath = logger.getLogPath();
        const cliDiagnosticPath = join(root, 'diagnostics', 'scenario.sync-v4.jsonl');
        const protocolTracePath = join(root, 'diagnostics', 'scenario.codex-rpc.jsonl');
        cliDiagnostics = await CliSyncV4DiagnosticLog.open(cliDiagnosticPath);
        protocolTrace = await CodexProtocolTraceRecorder.open(protocolTracePath);
        const nextCliTraceId = (): string => {
            const traceId = randomBytes(16).toString('hex');
            cliTraceIds.push(traceId);
            return traceId;
        };
        const nextAppTraceId = (): string => {
            const traceId = randomBytes(16).toString('hex');
            appTraceIds.push(traceId);
            return traceId;
        };
        const appStorage = new ScenarioStorage();
        const appDiagnosticStorage = new ScenarioStorage();
        const appDiagnostics = new AppSyncV4DiagnosticStore(appDiagnosticStorage);
        const processorsBySession = new Map<
            string,
            InstanceType<typeof CodexV4CommandProcessor>
        >();
        const childBindings = new Map<string, {
            binding: import(
                '../../packages/happy-cli/src/codex/codexV4ThreadRouter'
            ).CodexV4SessionBinding;
            sessionId: string;
            sessionKey: Uint8Array;
        }>();

        const createAppRuntime = async (
            targetSessionId: string,
            targetSessionKey: Uint8Array,
            selectedThreadId: string,
            storage: ScenarioStorage,
            onEntity?: (entity: CodexEntityV4) => void,
        ): Promise<ScenarioAppRuntime> => {
            let projection = projectionModule.createCodexV4Projection(selectedThreadId);
            const persistence = new SyncV4Persistence(storage);
            const crypto = await NodeSyncV4Crypto.create({
                sessionId: targetSessionId,
                sessionKey: targetSessionKey,
            });
            const transport = new AppSyncV4HttpTransport(async (path, init = {}) => {
                const requestHeaders = new Headers(init.headers);
                const traceId = requestHeaders.get('X-Happy-Sync-Trace');
                const response = await fetch(`${baseUrl}${path}`, {
                    ...init,
                    headers: {
                        ...relayHeaders(token),
                        ...Object.fromEntries(requestHeaders.entries()),
                    },
                });
                if (traceId) {
                    assert.equal(
                        response.headers.get('x-happy-sync-trace'),
                        traceId,
                        'Server did not echo the App trace ID',
                    );
                    echoedAppTraceIds.add(traceId);
                }
                return response;
            });
            const applyEntities = (events: readonly {
                entity: CodexEntityV4;
                revision: number;
                op: 'upsert' | 'delete';
            }[]): void => {
                projection = projectionModule.applyCodexV4ProjectionUpdates(
                    projection,
                    events,
                );
                for (const event of events) onEntity?.(event.entity);
            };
            const replaceSnapshot = (events: readonly {
                entity: CodexEntityV4;
                revision: number;
                op: 'upsert' | 'delete';
            }[]): void => {
                const empty = projectionModule.createCodexV4Projection(selectedThreadId);
                projection = projectionModule.applyCodexV4ProjectionUpdates(empty, events);
                for (const event of events) onEntity?.(event.entity);
            };
            const client = await AppSyncV4Client.create({
                sessionId: targetSessionId,
                sessionKey: targetSessionKey,
                appVersion,
                persistence,
                transport,
                crypto,
                onEntity: async (event) => applyEntities([event]),
                onEntities: async (events) => applyEntities(events),
                onSnapshotReset: async () => {
                    projection = projectionModule.createCodexV4Projection(selectedThreadId);
                },
                onSnapshotReplace: async (events) => replaceSnapshot(events),
                generateMutationId: randomUUID,
                generateTraceId: nextAppTraceId,
                pollIntervalMs: 25,
                diagnostics: appDiagnostics,
                transportSecurity: 'insecureHttp',
            });
            return {
                client,
                projection: () => projection,
                seedScale: () => {
                    projection = seedScaleProjection(
                        projectionModule,
                        projection,
                        selectedThreadId,
                    );
                },
            };
        };

        const assembleBinding = (
            targetSessionId: string,
            targetSessionKey: Uint8Array,
            targetSyncClient: InstanceType<typeof SyncV4Client>,
            readOnly: boolean,
        ): {
            binding: import(
                '../../packages/happy-cli/src/codex/codexV4ThreadRouter'
            ).CodexV4SessionBinding;
            mapper: InstanceType<typeof CodexSyncV4Mapper>;
        } => {
            const mapper = new CodexSyncV4Mapper(targetSyncClient, {
                codexCliVersion: '0.145.0',
                protocolVersion: 'v2',
                flushIntervalMs: deltaIntervalMs,
                diagnostics: cliDiagnostics!,
                diagnosticSessionHash: targetSyncClient.diagnosticSessionHash,
            });
            const broker = new CodexV4RequestBroker({ mapper });
            const processor = new CodexV4CommandProcessor({
                store: targetSyncClient,
                execute: async (command): Promise<{
                    threadId: string | null;
                    turnId: string | null;
                    providerRequestId: string;
                }> => {
                    if (readOnly) throw new Error('Codex child session is read-only');
                    assert.equal(command.command, 'request.resolve');
                    const payload = objectRecord(command.payload);
                    const requestId = requiredString(payload.requestId, 'request.resolve requestId');
                    const threadId = requiredString(command.threadId, 'request.resolve threadId');
                    const resolution = await broker.resolve({
                        requestId,
                        threadId,
                        response: payload.response,
                    });
                    return {
                        threadId,
                        turnId: command.expectedTurnId,
                        providerRequestId: resolution.providerRequestId,
                    };
                },
                reconcile: async () => ({
                    action: 'notReplayed',
                    error: 'Scenario commands are never replayed',
                }),
                reconcileIntervalMs: 0,
                onError: (error) => routerErrors.push(error),
            });
            processorsBySession.set(targetSessionId, processor);
            let closePromise: Promise<void> | null = null;
            const binding: import(
                '../../packages/happy-cli/src/codex/codexV4ThreadRouter'
            ).CodexV4SessionBinding = {
                sessionId: targetSessionId,
                sessionKey: targetSessionKey,
                mapper,
                syncClient: targetSyncClient,
                commandProcessor: processor,
                requestBroker: broker,
                recover: async () => {
                    await broker.recoverPending(targetSyncClient.getPendingProviderRequests());
                    await processor.recoverPending();
                },
                close: async () => {
                    closePromise ??= (async () => {
                        processorsBySession.delete(targetSessionId);
                        processor.close();
                        await broker.failPending('brokerClosed').catch(() => undefined);
                        await mapper.close();
                        try {
                            await targetSyncClient.flushOutboundOnce();
                        } finally {
                            await targetSyncClient.close();
                        }
                    })();
                    await closePromise;
                },
            };
            return { binding, mapper };
        };

        const cliJournalRoot = join(root, 'cli-journal');
        const onRootEntity = async (
            event: import(
                '../../packages/happy-cli/src/api/syncV4Client'
            ).SyncV4AppliedEntity,
        ): Promise<void> => {
            await processorsBySession.get(sessionId)?.handle(event);
        };
        rootSyncClient = await SyncV4Client.create({
            sessionId,
            sessionKey,
            journalRoot: cliJournalRoot,
            serverUrl: baseUrl,
            token,
            pollIntervalMs: 250,
            diagnostics: cliDiagnostics,
            generateTraceId: nextCliTraceId,
            onEntity: onRootEntity,
        });
        await rootSyncClient.start();
        const restartSeed = CodexEntityV4Schema.parse({
            schemaVersion: 1,
            entityType: 'codex.commandResult',
            providerId: 'scenario-restart-seed-result',
            createdAt: 1,
            updatedAt: 1,
            commandId: 'scenario-restart-seed',
            threadId: rootThreadId,
            turnId: null,
            status: 'succeeded',
            providerRequestId: null,
            result: null,
            error: null,
        });
        const restartMutation = await rootSyncClient.publishEntity(restartSeed);
        ciphertextCanaries.push(restartMutation.ciphertext);
        await rootSyncClient.flushOutboundOnce();
        await rootSyncClient.pullChangesOnce();
        const cliCursorBeforeRestart = rootSyncClient.receiveCursor;
        assert(cliCursorBeforeRestart > 0, 'CLI restart seed did not advance its cursor');
        await rootSyncClient.close();
        rootSyncClient = await SyncV4Client.create({
            sessionId,
            sessionKey,
            journalRoot: cliJournalRoot,
            serverUrl: baseUrl,
            token,
            pollIntervalMs: 250,
            diagnostics: cliDiagnostics,
            generateTraceId: nextCliTraceId,
            onEntity: onRootEntity,
        });
        await rootSyncClient.start();
        assert.equal(rootSyncClient.receiveCursor, cliCursorBeforeRestart);
        const assembledRoot = assembleBinding(
            sessionId,
            sessionKey,
            rootSyncClient,
            false,
        );
        rootBinding = assembledRoot.binding;
        rootMapper = assembledRoot.mapper;

        const scenarioPath = join(root, 'streaming-scenario.json');
        await writeFile(scenarioPath, JSON.stringify(streamingScenario(root)));
        process.env.HAPPY_FAKE_CODEX_SCENARIO = scenarioPath;
        process.env.HAPPY_CODEX_APP_SERVER_PATH = fakeCodexPath;

        const providerDeltaTimes: number[] = [];
        codex = new CodexAppServerClient();
        codex.setDiagnosticSink(cliDiagnostics);
        codex.setProtocolTraceSink(protocolTrace);
        router = new CodexV4ThreadRouter({
            rootBinding,
            readThread: async (threadId) => (
                await codex!.readThreadComplete({ threadId, emitSnapshot: false })
            ).thread,
            createChildBinding: async (route, parentBinding) => {
                const identity = await deriveCodexV4ChildSessionIdentity({
                    parentSessionId: parentBinding.sessionId,
                    parentSessionKey: parentBinding.sessionKey,
                    childThreadId: route.thread.id,
                });
                const childSessionId = await createSession(
                    baseUrl,
                    token,
                    identity.sessionKey,
                    {
                        tag: identity.tag,
                        threadId: route.thread.id,
                        parentSessionId: parentBinding.sessionId,
                        isSideChat: true,
                        readOnly: true,
                    },
                );
                let childSyncClient: InstanceType<typeof SyncV4Client>;
                childSyncClient = await SyncV4Client.create({
                    sessionId: childSessionId,
                    sessionKey: identity.sessionKey,
                    journalRoot: join(root, 'child-journals', identity.tag),
                    serverUrl: baseUrl,
                    token,
                    pollIntervalMs: 250,
                    diagnostics: cliDiagnostics!,
                    generateTraceId: nextCliTraceId,
                    onEntity: async (event) => {
                        await processorsBySession.get(childSessionId)?.handle(event);
                    },
                });
                await childSyncClient.start();
                const assembled = assembleBinding(
                    childSessionId,
                    identity.sessionKey,
                    childSyncClient,
                    true,
                );
                childBindings.set(route.thread.id, {
                    binding: assembled.binding,
                    sessionId: childSessionId,
                    sessionKey: identity.sessionKey,
                });
                return assembled.binding;
            },
            onError: (error) => {
                if (
                    error instanceof Error
                    && error.name === 'CodexRouteAwaitingRegistrationError'
                ) return;
                routerErrors.push(error);
            },
        });
        codex.setStableNotificationHandler((notification) => {
            if (notification.method === 'item/agentMessage/delta') {
                const params = objectRecord(notification.params);
                if (params.threadId === rootThreadId && params.itemId === rootAgentItemId) {
                    providerDeltaTimes.push(performance.now());
                }
            }
            router!.handleNotification(notification);
        });
        codex.setServerRequestHandler((request) => router!.handleRequest(request));
        codex.setConnectionHandler((event) => router!.setConnection(event));
        await codex.connect();
        const { threadId } = await codex.startThread({
            cwd: root,
            model: modelSecret,
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });
        assert.equal(threadId, rootThreadId);
        await router.registerRootThread(threadId);
        await router.flush();
        await rootSyncClient.flushOutboundOnce();
        await waitUntil(
            () => invalidations.length > 0,
            5_000,
            'websocket invalidation',
        );

        const projectedDeltaTimes: number[] = [];
        let visibleDeltaCount = 0;
        rootApp = await createAppRuntime(
            sessionId,
            sessionKey,
            threadId,
            appStorage,
            (entity) => {
                if (
                    entity.entityType !== 'codex.part'
                    || entity.threadId !== threadId
                    || entity.itemId !== rootAgentItemId
                    || entity.kind !== 'text'
                ) return;
                const nextVisibleCount = Math.min(deltaCount, entity.content.length);
                const now = performance.now();
                while (visibleDeltaCount < nextVisibleCount) {
                    projectedDeltaTimes[visibleDeltaCount] = now;
                    visibleDeltaCount += 1;
                }
            },
        );
        await rootApp.client.start();
        assert.equal(rootApp.projection().thread?.threadId, threadId);
        const appCursorBeforeRestart = rootApp.client.receiveCursor;
        rootApp.client.stop();
        rootApp = await createAppRuntime(
            sessionId,
            sessionKey,
            threadId,
            appStorage,
            (entity) => {
                if (
                    entity.entityType !== 'codex.part'
                    || entity.threadId !== threadId
                    || entity.itemId !== rootAgentItemId
                    || entity.kind !== 'text'
                ) return;
                const nextVisibleCount = Math.min(deltaCount, entity.content.length);
                const now = performance.now();
                while (visibleDeltaCount < nextVisibleCount) {
                    projectedDeltaTimes[visibleDeltaCount] = now;
                    visibleDeltaCount += 1;
                }
            },
        );
        await rootApp.client.start();
        assert.equal(rootApp.client.receiveCursor, appCursorBeforeRestart);
        assert.equal(rootApp.projection().thread?.threadId, threadId);
        rootApp.seedScale();

        const invalidationCountBeforeDrop = invalidations.length;
        socket.disconnect();
        assert.equal(socket.connected, false);

        const turnPromise = codex.sendTurnAndWait(promptSecret, {
            clientUserMessageId: 'scenario-command-1',
        });

        await waitUntil(() => pendingRequest(rootApp!.projection()) !== null, 5_000, 'App approval projection');
        const pendingApproval = pendingRequest(rootApp.projection());
        assert(pendingApproval);
        assert.equal(pendingApproval.requestId, approvalRequestId);
        const approvalCommandId = randomUUID();
        const approvalCommand: CodexCommandEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.command',
            providerId: approvalCommandId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            commandId: approvalCommandId,
            threadId,
            expectedTurnId: rootTurnId,
            command: 'request.resolve',
            payload: {
                requestId: pendingApproval.requestId,
                response: { decision: 'accept' },
            },
            clientUserMessageId: approvalCommandId,
            replacesCommandId: null,
        };
        const approvalMutation = await rootApp.client.publishEntity(approvalCommand);
        ciphertextCanaries.push(approvalMutation.ciphertext);
        await rootApp.client.flushOutboundOnce();
        await rootSyncClient.pullChangesOnce();

        await waitUntil(
            () => childBindings.has(childThreadId),
            5_000,
            'provider child binding',
        );
        const child = childBindings.get(childThreadId)!;
        childApp = await createAppRuntime(
            child.sessionId,
            child.sessionKey,
            childThreadId,
            new ScenarioStorage(),
        );
        await childApp.client.start();
        await router.flush();
        await child.binding.syncClient.flushOutboundOnce();
        await childApp.client.pullChangesOnce();
        try {
            await waitUntil(() => (
                childApp!.projection().runtime?.execution.type === 'idle'
                && childApp!.projection().messages.some(
                    (message) => message.kind === 'agent-text'
                        && message.text === 'child-complete',
                )
            ), 5_000, 'provider child projection');
        } catch {
            const childProjection = childApp.projection();
            const childEntityCount = Object.values(childProjection.entities)
                .reduce((count, bucket) => count + Object.keys(bucket).length, 0);
            throw new Error(
                `Provider child projection incomplete: execution=${childProjection.runtime?.execution.type ?? 'missing'} cursor=${childApp.client.receiveCursor} entities=${childEntityCount} messages=${childProjection.messages.length}`,
            );
        }
        assert.equal(
            rootApp.projection().runtime?.execution.type,
            'active',
            'child completion changed the parent execution state',
        );

        const turnResult = await turnPromise;
        assert.deepEqual(turnResult, { aborted: false });
        await router.flush();
        await rootSyncClient.flushOutboundOnce();
        await child.binding.syncClient.flushOutboundOnce();

        await waitUntil(() => {
            return projectedDeltaTimes.length === deltaCount
                && rootApp!.projection().runtime?.execution.type === 'idle'
                && rootApp!.projection().messages.some(
                    (message) => message.kind === 'agent-text'
                        && message.text === 'x'.repeat(deltaCount),
                )
                && requestStatus(rootApp!.projection(), approvalRequestId) === 'accepted'
                && commandStatus(rootApp!.projection(), approvalCommandId) === 'succeeded';
        }, 10_000, 'polling projection convergence');
        await rootApp.client.pullChangesOnce();

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
        const rootProjection = rootApp.projection();
        assert.equal(rootProjection.runtime?.execution.type, 'idle');
        assert(rootProjection.messages.some(
            (message) => message.kind === 'agent-text'
                && message.text === 'x'.repeat(deltaCount),
        ));
        assert(Object.values(rootProjection.entities['codex.part']).some(
            (part) => part.kind === 'reasoningSummary'
                && part.content.includes(reasoningSummarySecret),
        ));
        assert(Object.values(rootProjection.entities['codex.part']).some(
            (part) => part.kind === 'commandOutput'
                && part.content.includes(toolOutputSecret),
        ));
        assert(!JSON.stringify(rootProjection).includes(rawReasoningSecret));
        assert(Object.values(rootProjection.entities['codex.relation']).some(
            (relation) => relation.childThreadId === childThreadId
                && relation.parentThreadId === rootThreadId,
        ));
        assert(!rootProjection.messages.some(
            (message) => message.kind === 'agent-text'
                && message.text === 'child-complete',
        ));
        const scaledEntityCount = Object.values(rootProjection.entities)
            .reduce((count, bucket) => count + Object.keys(bucket).length, 0);
        assert(scaledEntityCount >= 10_000);
        if (routerErrors.length > 0) {
            const failure = routerErrors[0];
            const failedThreadId = objectRecord(failure).threadId;
            const scope = failedThreadId === rootThreadId
                ? 'root'
                : failedThreadId === childThreadId ? 'child' : 'unknown';
            const message = failure instanceof Error ? failure.message : 'unknown router failure';
            throw new Error(`Router async error (${scope}): ${message}`);
        }

        rootApp.client.stop();
        rootApp = null;
        childApp.client.stop();
        childApp = null;
        await codex.disconnect();
        codex = null;
        await router.flush();
        await router.close();
        router = null;
        await rootBinding.close();
        rootBinding = null;
        rootMapper = null;
        rootSyncClient = null;
        await protocolTrace.flush();

        await terminateRelay(relay.child);
        relayOutputs.push(relay.output());
        relay = null;
        await pruneFirstMutation(root, sessionId);
        relay = startRelay(root, port, masterSecret);
        await waitForHealth(baseUrl, relay);
        await assertMachine(baseUrl, token, machineState);

        fallbackApp = await createAppRuntime(
            sessionId,
            sessionKey,
            threadId,
            new ScenarioStorage(),
        );
        await fallbackApp.client.start();
        assert.equal(fallbackApp.projection().runtime?.execution.type, 'idle');
        assert(fallbackApp.projection().messages.some(
            (message) => message.kind === 'agent-text'
                && message.text === 'x'.repeat(deltaCount),
        ));

        const fallbackEntities: CodexEntityV4[] = [];
        fallbackCli = await SyncV4Client.create({
            sessionId,
            sessionKey,
            journalRoot: join(root, 'fallback-cli-journal'),
            serverUrl: baseUrl,
            token,
            pollIntervalMs: 250,
            diagnostics: cliDiagnostics,
            generateTraceId: nextCliTraceId,
            onEntity: async (event) => {
                fallbackEntities.push(event.entity);
            },
        });
        await fallbackCli.start();
        assert(fallbackEntities.some(
            (entity) => entity.entityType === 'codex.thread'
                && entity.threadId === rootThreadId,
        ));
        assert(!JSON.stringify(fallbackEntities).includes(rawReasoningSecret));
        fallbackApp.client.stop();
        fallbackApp = null;
        await fallbackCli.close();
        fallbackCli = null;

        await terminateRelay(relay.child);
        relayOutputs.push(relay.output());
        relay = null;
        const closedProtocolTrace = protocolTrace;
        const protocolEntries = closedProtocolTrace.snapshot();
        await closedProtocolTrace.close();
        const protocolTraceStats = closedProtocolTrace.stats();
        protocolTrace = null;
        const closedCliDiagnostics = cliDiagnostics;
        await closedCliDiagnostics.close();
        const cliDiagnosticStats = closedCliDiagnostics.stats();
        cliDiagnostics = null;

        assert.equal(cliDiagnosticStats.invalidRecords, 0);
        assert.equal(cliDiagnosticStats.droppedRecords, 0);
        assert.equal(cliDiagnosticStats.writeFailures, 0);
        assert.equal(protocolTraceStats.invalidRecords, 0);
        assert.equal(protocolTraceStats.droppedRecords, 0);
        assert.equal(protocolTraceStats.writeFailures, 0);
        assert.equal(protocolTraceStats.pendingBytes, 0);
        assert(protocolEntries.length > 0);
        assert(protocolEntries.length <= 4_096);
        assert(protocolEntries.some(
            (entry) => entry.method?.startsWith('unknown:'),
        ));
        assert(protocolEntries.every(
            (entry) => entry.rpcIdHash === null || /^[0-9a-f]{24}$/.test(entry.rpcIdHash),
        ));

        const appDiagnosticRecords = appDiagnostics.records();
        const appDiagnosticStats = appDiagnostics.stats();
        assert(appDiagnosticRecords.length > 0);
        assert(appDiagnosticRecords.length <= 2_000);
        assert.equal(appDiagnosticStats.invalidRecords, 0);
        assert.equal(appDiagnosticStats.writeFailures, 0);
        assert(appDiagnosticRecords.some(
            (record) => record.event === 'snapshot' && record.phase === 'required',
        ));
        assert.equal(echoedAppTraceIds.size, appTraceIds.length);

        const cliDiagnosticRecords = await readDiagnosticRecords(cliDiagnosticPath);
        assert(cliDiagnosticRecords.length > 0);
        assert(cliDiagnosticRecords.some(
            (record) => record.event === 'snapshot' && record.phase === 'required',
        ));
        assert(cliDiagnosticRecords.some((record) => record.event === 'request'));
        await assertBoundedDiagnosticFiles(cliDiagnosticPath);
        await assertBoundedDiagnosticFiles(protocolTracePath);
        assert.deepEqual(
            await readCodexProtocolTrace(protocolTracePath),
            protocolEntries,
        );

        const serverOutput = relayOutputs.join('\n');
        assert(serverOutput.includes('sync_v4'));
        assert(serverOutput.includes('snapshot'));
        assert(serverOutput.includes('invalidation'));
        assert(serverOutput.includes('410'));
        const expectedServerTraceIds = new Set([
            ...manualTraceIds,
            ...cliTraceIds,
            ...appTraceIds,
        ]);
        for (const traceId of expectedServerTraceIds) {
            const traceSource = manualTraceIds.includes(traceId)
                ? 'manual'
                : cliTraceIds.includes(traceId) ? 'cli' : 'app';
            assert(
                serverOutput.includes(traceId),
                `Server diagnostics are missing a ${traceSource} trace`,
            );
        }

        const generalLog = generalLogPath
            ? await readFile(generalLogPath, 'utf8').catch(() => '')
            : '';
        const cliDiagnosticText = await readRotatedText(cliDiagnosticPath);
        const protocolTraceText = await readRotatedText(protocolTracePath);
        const appDiagnosticText = JSON.stringify(appDiagnosticRecords);
        const sensitiveCanaries: Array<[string, string]> = [
            ['prompt', promptSecret],
            ['reasoningSummary', reasoningSummarySecret],
            ['rawReasoning', rawReasoningSecret],
            ['toolArgument', toolArgumentSecret],
            ['toolOutput', toolOutputSecret],
            ['approvalReason', approvalReasonSecret],
            ['childPrompt', childPromptSecret],
            ['unknownMethod', unknownMethodSecret],
            ['model', modelSecret],
            ['rootThreadId', rootThreadId],
            ['rootTurnId', rootTurnId],
            ['rootAgentItemId', rootAgentItemId],
            ['childThreadId', childThreadId],
            ['childTurnId', childTurnId],
            ['childAgentItemId', childAgentItemId],
            ['token', token],
            ['sessionKey', Buffer.from(sessionKey).toString('base64')],
            ...ciphertextCanaries.map(
                (ciphertext, index): [string, string] => [`ciphertext${index}`, ciphertext],
            ),
        ];
        for (const [sinkName, text] of Object.entries({
            cliDiagnosticText,
            protocolTraceText,
            appDiagnosticText,
            generalLog,
            serverOutput,
        })) {
            for (const [canaryName, canary] of sensitiveCanaries) {
                assert(
                    !text.includes(canary),
                    `${sinkName} leaked Sync v4 canary category ${canaryName}`,
                );
            }
        }

        console.log(
            `Codex HTTP relay scenario passed: websocket=ok polling=ok restart=ok snapshot410=ok approval=ok child=ok trace=ok privacy=ok entities>=10000 deltas=${deltaCount} p95=${p95.toFixed(1)}ms`,
        );
    } finally {
        socket?.disconnect();
        fallbackApp?.client.stop();
        await fallbackCli?.close().catch(() => undefined);
        childApp?.client.stop();
        rootApp?.client.stop();
        if (codex) await codex.disconnect().catch(() => undefined);
        if (router) await router.close().catch(() => undefined);
        if (rootBinding) await rootBinding.close().catch(() => undefined);
        else {
            if (rootMapper) await rootMapper.close().catch(() => undefined);
            if (rootSyncClient) await rootSyncClient.close().catch(() => undefined);
        }
        await protocolTrace?.close().catch(() => undefined);
        await cliDiagnostics?.close().catch(() => undefined);
        if (relay) await terminateRelay(relay.child);
        restoreEnvironment('HAPPY_CODEX_APP_SERVER_PATH', originalAppServerPath);
        delete process.env.HAPPY_FAKE_CODEX_SCENARIO;
        await rm(root, { recursive: true, force: true });
    }
}

async function runRealLongTurn(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'happy-codex-real-long-turn-'));
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
        const turn = codex.sendTurnAndWait('remain active past ten minutes', {
            clientUserMessageId: 'real-long-turn-command',
        });
        const settlement = turn.then(
            () => ({
                outcome: 'resolved' as const,
                elapsedMs: performance.now() - startedAt,
                error: null,
            }),
            (error: unknown) => ({
                outcome: 'rejected' as const,
                elapsedMs: performance.now() - startedAt,
                error,
            }),
        );
        const earlySettlement = await Promise.race([
            settlement,
            delay(realLongTurnMinimumMs).then(() => null),
        ]);
        assert.equal(
            earlySettlement,
            null,
            earlySettlement
                ? `turn ${earlySettlement.outcome} after only ${earlySettlement.elapsedMs.toFixed(0)} ms`
                : 'turn settled before ten real minutes elapsed',
        );
        const completed = await settlement;
        if (completed.outcome === 'rejected') throw completed.error;
        const elapsed = completed.elapsedMs;
        assert(
            elapsed > realLongTurnMinimumMs,
            `turn completed after only ${elapsed.toFixed(0)} ms`,
        );
        console.log(`Real long-turn gate passed after ${elapsed.toFixed(0)} ms`);
    } finally {
        if (codex) await codex.disconnect().catch(() => undefined);
        restoreEnvironment('HAPPY_CODEX_APP_SERVER_PATH', originalAppServerPath);
        delete process.env.HAPPY_FAKE_CODEX_SCENARIO;
        await rm(root, { recursive: true, force: true });
    }
}

function lateThreadStartedScenario(cwd: string): Record<string, unknown> {
    const thread = {
        id: 'fake-thread-late',
        sessionId: 'fake-session-late',
        forkedFromId: null,
        parentThreadId: null,
        preview: '',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 1,
        updatedAt: 1,
        recencyAt: 1,
        status: { type: 'idle' },
        path: null,
        cwd,
        cliVersion: '0.145.0',
        source: 'appServer',
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
    };
    const startedTurn = {
        id: 'fake-turn-late',
        items: [],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt: 2,
        completedAt: null,
        durationMs: null,
    };
    return {
        strictStableV2: true,
        rules: [
            {
                on: 'thread/start',
                actions: [{
                    type: 'response',
                    result: {
                        thread,
                        model: 'gpt-test',
                        modelProvider: 'openai',
                        serviceTier: null,
                        cwd,
                        instructionSources: [],
                        approvalPolicy: 'on-request',
                        approvalsReviewer: 'user',
                        sandbox: { type: 'readOnly', networkAccess: false },
                        reasoningEffort: null,
                    },
                }],
            },
            {
                on: 'turn/start',
                actions: [
                    { type: 'response', result: { turn: startedTurn } },
                    {
                        type: 'notification',
                        method: 'turn/started',
                        params: { threadId: thread.id, turn: startedTurn },
                    },
                    {
                        type: 'notification',
                        method: 'thread/started',
                        delayMs: 10,
                        params: { thread },
                    },
                ],
            },
            {
                on: 'turn/interrupt',
                actions: [
                    { type: 'response', result: {} },
                    {
                        type: 'notification',
                        method: 'turn/completed',
                        params: {
                            threadId: thread.id,
                            turn: {
                                ...startedTurn,
                                status: 'completed',
                                completedAt: 3,
                                durationMs: 10,
                            },
                        },
                    },
                ],
            },
        ],
    };
}

function streamingScenario(cwd: string): Record<string, unknown> {
    const rootThread = {
        id: rootThreadId,
        sessionId: 'provider-session-private-v4',
        forkedFromId: null,
        parentThreadId: null,
        preview: '',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 1,
        updatedAt: 1,
        recencyAt: 1,
        status: { type: 'idle' },
        path: null,
        cwd,
        cliVersion: '0.145.0',
        source: 'appServer',
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
    };
    const childThread = {
        ...rootThread,
        id: childThreadId,
        parentThreadId: rootThreadId,
        createdAt: 2,
        updatedAt: 2,
        recencyAt: 2,
        source: {
            subAgent: {
                thread_spawn: {
                    parent_thread_id: rootThreadId,
                    depth: 1,
                    agent_path: null,
                    agent_nickname: null,
                    agent_role: null,
                },
            },
        },
    };
    const startedTurn = {
        id: rootTurnId,
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
        id: rootAgentItemId,
        text: '',
        phase: null,
        memoryCitation: null,
    };
    const completedItem = {
        ...startedItem,
        text: 'x'.repeat(deltaCount),
    };
    const reasoningItem = {
        type: 'reasoning',
        id: 'provider-reasoning-item-private-v4',
        summary: [reasoningSummarySecret],
        content: [rawReasoningSecret],
    };
    const commandItem = {
        type: 'commandExecution',
        id: approvalItemId,
        command: toolArgumentSecret,
        cwd,
        processId: null,
        source: 'agent',
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
    };
    const completedCommandItem = {
        ...commandItem,
        status: 'completed',
        aggregatedOutput: toolOutputSecret,
        exitCode: 0,
        durationMs: 2_900,
    };
    const delegationItem = {
        type: 'collabAgentToolCall',
        id: 'provider-delegation-item-private-v4',
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: rootThreadId,
        receiverThreadIds: [childThreadId],
        prompt: childPromptSecret,
        model: modelSecret,
        reasoningEffort: 'high',
        agentsStates: {},
    };
    const completedDelegationItem = {
        ...delegationItem,
        status: 'completed',
    };
    const childStartedTurn = {
        id: childTurnId,
        items: [],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt: 3,
        completedAt: null,
        durationMs: null,
    };
    const childStartedItem = {
        type: 'agentMessage',
        id: childAgentItemId,
        text: '',
        phase: null,
        memoryCitation: null,
    };
    const childCompletedItem = {
        ...childStartedItem,
        text: 'child-complete',
    };
    const childCompletedTurn = {
        ...childStartedTurn,
        items: [childCompletedItem],
        status: 'completed',
        completedAt: 5,
        durationMs: 400,
    };
    const completionDelayMs = deltaCount * deltaIntervalMs + 2_500;
    const completedTurn = {
        ...startedTurn,
        items: [
            completedItem,
            reasoningItem,
            completedCommandItem,
            completedDelegationItem,
        ],
        status: 'completed',
        completedAt: 8,
        durationMs: completionDelayMs,
    };
    return {
        strictStableV2: true,
        rules: [
            {
                on: 'thread/start',
                actions: [
                    {
                        type: 'response',
                        result: {
                            thread: rootThread,
                            model: modelSecret,
                            modelProvider: 'openai',
                            serviceTier: null,
                            cwd,
                            instructionSources: [],
                            approvalPolicy: 'on-request',
                            approvalsReviewer: 'user',
                            sandbox: { type: 'readOnly', networkAccess: false },
                            reasoningEffort: null,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'thread/started',
                        params: { thread: rootThread },
                    },
                ],
            },
            {
                on: 'turn/start',
                actions: [
                    { type: 'response', result: { turn: startedTurn } },
                    {
                        type: 'unknown',
                        method: unknownMethodSecret,
                        delayMs: 50,
                    },
                    {
                        type: 'notification',
                        method: 'turn/started',
                        params: { threadId: rootThreadId, turn: startedTurn },
                    },
                    {
                        type: 'notification',
                        method: 'item/started',
                        delayMs: 10,
                        params: {
                            threadId: rootThreadId,
                            turnId: rootTurnId,
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
                            threadId: rootThreadId,
                            turnId: rootTurnId,
                            itemId: rootAgentItemId,
                            delta: 'x',
                        },
                    },
                    {
                        type: 'notification',
                        method: 'item/started',
                        delayMs: 100,
                        params: {
                            threadId: rootThreadId,
                            turnId: rootTurnId,
                            item: {
                                ...reasoningItem,
                                summary: [],
                                content: [],
                            },
                            startedAtMs: 1_100,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'item/reasoning/summaryTextDelta',
                        delayMs: 150,
                        params: {
                            threadId: rootThreadId,
                            turnId: rootTurnId,
                            itemId: reasoningItem.id,
                            summaryIndex: 0,
                            delta: reasoningSummarySecret,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'item/reasoning/textDelta',
                        delayMs: 175,
                        params: {
                            threadId: rootThreadId,
                            turnId: rootTurnId,
                            itemId: reasoningItem.id,
                            contentIndex: 0,
                            delta: rawReasoningSecret,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'item/completed',
                        delayMs: 250,
                        params: {
                            threadId: rootThreadId,
                            turnId: rootTurnId,
                            item: reasoningItem,
                            completedAtMs: 1_250,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'item/started',
                        delayMs: 300,
                        params: {
                            threadId: rootThreadId,
                            turnId: rootTurnId,
                            item: commandItem,
                            startedAtMs: 1_300,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'item/commandExecution/outputDelta',
                        delayMs: 450,
                        params: {
                            threadId: rootThreadId,
                            turnId: rootTurnId,
                            itemId: approvalItemId,
                            delta: toolOutputSecret,
                        },
                    },
                    {
                        type: 'request',
                        id: Number(approvalRequestId),
                        method: 'item/commandExecution/requestApproval',
                        delayMs: 600,
                        params: {
                            threadId: rootThreadId,
                            turnId: rootTurnId,
                            itemId: approvalItemId,
                            startedAtMs: 1_600,
                            approvalId: null,
                            environmentId: null,
                            reason: approvalReasonSecret,
                            networkApprovalContext: null,
                            command: toolArgumentSecret,
                            cwd,
                            commandActions: [],
                            proposedExecpolicyAmendment: null,
                            proposedNetworkPolicyAmendments: null,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'item/started',
                        delayMs: 700,
                        params: {
                            threadId: rootThreadId,
                            turnId: rootTurnId,
                            item: delegationItem,
                            startedAtMs: 1_700,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'thread/started',
                        delayMs: 800,
                        params: { thread: childThread },
                    },
                    {
                        type: 'notification',
                        method: 'turn/started',
                        delayMs: 900,
                        params: {
                            threadId: childThreadId,
                            turn: childStartedTurn,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'item/started',
                        delayMs: 1_000,
                        params: {
                            threadId: childThreadId,
                            turnId: childTurnId,
                            item: childStartedItem,
                            startedAtMs: 2_000,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'item/agentMessage/delta',
                        delayMs: 1_100,
                        params: {
                            threadId: childThreadId,
                            turnId: childTurnId,
                            itemId: childAgentItemId,
                            delta: 'child-complete',
                        },
                    },
                    {
                        type: 'notification',
                        method: 'item/completed',
                        delayMs: 1_200,
                        params: {
                            threadId: childThreadId,
                            turnId: childTurnId,
                            item: childCompletedItem,
                            completedAtMs: 2_200,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'turn/completed',
                        delayMs: 1_300,
                        params: {
                            threadId: childThreadId,
                            turn: childCompletedTurn,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'item/completed',
                        delayMs: 1_400,
                        params: {
                            threadId: rootThreadId,
                            turnId: rootTurnId,
                            item: completedDelegationItem,
                            completedAtMs: 2_400,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'serverRequest/resolved',
                        delayMs: 3_000,
                        params: {
                            threadId: rootThreadId,
                            requestId: Number(approvalRequestId),
                        },
                    },
                    {
                        type: 'notification',
                        method: 'item/completed',
                        delayMs: 3_200,
                        params: {
                            threadId: rootThreadId,
                            turnId: rootTurnId,
                            item: completedCommandItem,
                            completedAtMs: 4_200,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'item/completed',
                        delayMs: completionDelayMs - 50,
                        params: {
                            threadId: rootThreadId,
                            turnId: rootTurnId,
                            item: completedItem,
                            completedAtMs: 7_950,
                        },
                    },
                    {
                        type: 'notification',
                        method: 'turn/completed',
                        delayMs: completionDelayMs,
                        params: {
                            threadId: rootThreadId,
                            turn: completedTurn,
                        },
                    },
                ],
            },
        ],
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

async function migrateRelay(root: string, masterSecret: string): Promise<void> {
    await runProcess(
        process.execPath,
        [tsxPath, 'sources/standalone.ts', 'migrate'],
        {
            cwd: serverRoot,
            env: relayEnvironment(root, masterSecret),
            label: 'PGlite migration',
        },
    );
}

function startRelay(root: string, port: number, masterSecret: string): RelayProcess {
    const child = spawn(
        process.execPath,
        [tsxPath, 'sources/standalone.ts', 'serve'],
        {
            cwd: serverRoot,
            env: {
                ...relayEnvironment(root, masterSecret),
                HOST: '127.0.0.1',
                PORT: String(port),
                HAPPY_CODEX_SYNC_V4_ENABLED: 'true',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    let output = '';
    const append = (chunk: Buffer) => {
        output = `${output}${chunk.toString('utf8')}`.slice(-maxRelayOutputBytes);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    return { child, output: () => output };
}

function relayEnvironment(root: string, masterSecret: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        DB_PROVIDER: 'pglite',
        DATA_DIR: root,
        PGLITE_DIR: join(root, 'pglite'),
        HANDY_MASTER_SECRET: masterSecret,
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
    options: {
        tag: string;
        threadId: string | null;
        parentSessionId?: string;
        isSideChat?: boolean;
        readOnly?: boolean;
    },
): Promise<string> {
    const metadata = {
        flavor: 'codex',
        codexSyncVersion: 4,
        codexThreadId: options.threadId,
        ...(options.parentSessionId
            ? { parentSessionId: options.parentSessionId }
            : {}),
        ...(options.isSideChat ? { isSideChat: true } : {}),
        ...(options.readOnly ? { codexReadOnly: true } : {}),
    };
    const recipientPublicKey = nacl.box.keyPair().publicKey;
    const encryptedSessionKey = libsodiumEncryptForPublicKey(
        sessionKey,
        recipientPublicKey,
    );
    const versionedSessionKey = new Uint8Array(encryptedSessionKey.length + 1);
    versionedSessionKey.set([0], 0);
    versionedSessionKey.set(encryptedSessionKey, 1);
    const response = await fetch(`${baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
            ...relayHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            tag: options.tag,
            metadata: encodeBase64(encrypt(sessionKey, 'dataKey', metadata)),
            agentState: null,
            dataEncryptionKey: encodeBase64(versionedSessionKey),
        }),
    });
    assert.equal(response.status, 200, `session create returned HTTP ${response.status}`);
    const body = await response.json() as { session?: { id?: unknown } };
    assert.equal(typeof body.session?.id, 'string');
    return body.session.id;
}

async function createMachine(
    baseUrl: string,
    token: string,
): Promise<{ id: string; dataEncryptionKey: string }> {
    const id = `codex-http-machine-${Date.now()}`;
    const dataEncryptionKey = randomBytes(81).toString('base64');
    const response = await fetch(`${baseUrl}/v1/machines`, {
        method: 'POST',
        headers: {
            ...relayHeaders(token),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            id,
            metadata: Buffer.from('encrypted-machine-metadata').toString('base64'),
            dataEncryptionKey,
        }),
    });
    assert.equal(response.status, 200, `machine create returned HTTP ${response.status}`);
    const body = await response.json() as {
        machine?: {
            id?: unknown;
            dataEncryptionKey?: unknown;
        };
    };
    assert.equal(body.machine?.id, id);
    assert.equal(body.machine?.dataEncryptionKey, dataEncryptionKey);
    const machine = { id, dataEncryptionKey };
    await assertMachine(baseUrl, token, machine);
    return machine;
}

async function assertMachine(
    baseUrl: string,
    token: string,
    expected: { id: string; dataEncryptionKey: string },
): Promise<void> {
    const response = await fetch(`${baseUrl}/v1/machines`, {
        headers: relayHeaders(token),
    });
    assert.equal(response.status, 200, `machine list returned HTTP ${response.status}`);
    const machines = await response.json() as Array<{
        id?: unknown;
        dataEncryptionKey?: unknown;
    }>;
    assert(Array.isArray(machines));
    assert(machines.some((machine) => (
        machine.id === expected.id
        && machine.dataEncryptionKey === expected.dataEncryptionKey
    )), 'machine list did not preserve the encrypted device key');
}

async function verifyCorsAndTrace(baseUrl: string): Promise<string> {
    const traceId = randomBytes(16).toString('hex');
    const origin = 'http://localhost:19006';
    const preflight = await fetch(`${baseUrl}/v4/capabilities`, {
        method: 'OPTIONS',
        headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'X-Happy-Client,X-Happy-Sync-Trace',
        },
    });
    assert(
        preflight.status === 200 || preflight.status === 204,
        `CORS preflight returned HTTP ${preflight.status}`,
    );
    const allowedHeaders = preflight.headers.get('access-control-allow-headers')?.toLowerCase() ?? '';
    assert(allowedHeaders.includes('x-happy-sync-trace'));

    const response = await fetch(`${baseUrl}/v4/capabilities`, {
        headers: {
            Origin: origin,
            'X-Happy-Client': `web/${appVersion}`,
            'X-Happy-Sync-Trace': traceId,
        },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-happy-sync-trace'), traceId);
    const exposedHeaders = response.headers.get('access-control-expose-headers')?.toLowerCase() ?? '';
    assert(exposedHeaders.includes('x-happy-sync-trace'));
    return traceId;
}

async function pruneFirstMutation(root: string, sessionId: string): Promise<void> {
    const { createPGlite } = await import(
        '../../packages/happy-server/sources/storage/pgliteLoader'
    );
    const pg = createPGlite(join(root, 'pglite'));
    try {
        await pg.query(
            `UPDATE "SessionMutationV4"
             SET "ciphertext" = '', "prunedAt" = CURRENT_TIMESTAMP
             WHERE "sessionId" = $1
               AND "seq" = (
                   SELECT MIN("seq")
                   FROM "SessionMutationV4"
                   WHERE "sessionId" = $1
               )`,
            [sessionId],
        );
        const result = await pg.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
             FROM "SessionMutationV4"
             WHERE "sessionId" = $1 AND "prunedAt" IS NOT NULL`,
            [sessionId],
        );
        assert.equal(result.rows[0]?.count, '1');
    } finally {
        await pg.close();
    }
}

function pendingRequest(projection: CodexV4Projection): CodexRequestEntityV4 | null {
    return Object.values(projection.entities['codex.request'])
        .find((request) => request.status === 'pending') ?? null;
}

function requestStatus(
    projection: CodexV4Projection,
    requestId: string,
): CodexRequestEntityV4['status'] | null {
    return Object.values(projection.entities['codex.request'])
        .find((request) => request.requestId === requestId)?.status ?? null;
}

function commandStatus(
    projection: CodexV4Projection,
    commandId: string,
): string | null {
    return Object.values(projection.entities['codex.commandResult'])
        .find((result) => result.commandId === commandId)?.status ?? null;
}

async function readDiagnosticRecords(path: string): Promise<SyncV4DiagnosticRecord[]> {
    const records: SyncV4DiagnosticRecord[] = [];
    const text = await readRotatedText(path);
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        records.push(SyncV4DiagnosticRecordSchema.parse(JSON.parse(line)));
    }
    return records;
}

async function assertBoundedDiagnosticFiles(path: string): Promise<void> {
    const files = await rotatedFiles(path);
    assert(files.length > 0);
    assert(files.length <= 4);
    for (const file of files) {
        const fileStat = await stat(file);
        assert(fileStat.size <= 8 * 1024 * 1024);
        if (process.platform !== 'win32') {
            assert.equal(fileStat.mode & 0o777, 0o600);
        }
    }
}

async function readRotatedText(path: string): Promise<string> {
    const files = await rotatedFiles(path);
    return (
        await Promise.all(files.map((file) => readFile(file, 'utf8')))
    ).join('\n');
}

async function rotatedFiles(path: string): Promise<string[]> {
    const filename = basename(path);
    const entries = await readdir(dirname(path)).catch(() => []);
    return entries
        .filter((entry) => entry === filename || new RegExp(
            `^${escapeRegExp(filename)}\\.\\d+$`,
        ).test(entry))
        .sort((left, right) => segmentIndex(right, filename) - segmentIndex(left, filename))
        .map((entry) => join(dirname(path), entry));
}

function segmentIndex(filename: string, base: string): number {
    if (filename === base) return 0;
    const index = Number(filename.slice(base.length + 1));
    return Number.isSafeInteger(index) ? index : Number.MAX_SAFE_INTEGER;
}

function objectRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function requiredString(value: unknown, label: string): string {
    assert(typeof value === 'string' && value.length > 0, `${label} is missing`);
    return value;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
