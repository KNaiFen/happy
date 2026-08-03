import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { connect as connectUnixSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import WebSocket from 'ws';
import {
    CODEX_CLI_VERSION_PROBE_TIMEOUT_MS,
    MINIMUM_CODEX_CLI_VERSION,
    isCodexCliVersionAtLeast,
    parseCodexCliVersion,
} from '../../packages/happy-cli/src/codex/codexCliVersion';
import {
    OFFICIAL_CODEX_RESPONSE_SENTINEL,
    OFFICIAL_CODEX_TOOL_SENTINEL,
    type CodexResponsesFixture,
    startCodexResponsesFixture,
    writeCodexResponsesConfig,
} from './codex-responses-fixture';
import {
    LAB_RAT_AGENT_INSTRUCTION_SENTINEL,
    copyLabRatProject,
} from '../../environments/environments';

const TEMP_ROOT_CLEANUP_RETRY_DELAYS_MS = [0, 25, 100, 250, 500, 1_000] as const;
const RETRYABLE_TEMP_ROOT_CLEANUP_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);

async function main(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'happy-codex-official-app-server-'));
    const codexHome = join(root, 'codex-home');
    const projectRoot = copyLabRatProject(root);
    const originalAppServerPath = process.env.HAPPY_CODEX_APP_SERVER_PATH;
    const originalFakeScenario = process.env.HAPPY_FAKE_CODEX_SCENARIO;
    const originalCodexHome = process.env.CODEX_HOME;
    const originalPath = process.env.PATH;
    let fixture: CodexResponsesFixture | null = null;
    let websocketFixture: CodexResponsesFixture | null = null;
    let codex: InstanceType<
        typeof import('../../packages/happy-cli/src/codex/codexAppServerClient').CodexAppServerClient
    > | null = null;

    try {
        const officialVersion = configureOfficialCodexPath();
        delete process.env.HAPPY_CODEX_APP_SERVER_PATH;
        delete process.env.HAPPY_FAKE_CODEX_SCENARIO;
        const projectInstructions = await readFile(join(projectRoot, 'AGENTS.md'), 'utf8');
        assert(
            projectInstructions.includes(LAB_RAT_AGENT_INSTRUCTION_SENTINEL),
            'generated lab-rat project omitted the Codex instruction sentinel',
        );
        const projectFiles = await readdir(projectRoot);
        for (const legacyName of [
            'AGENTS.template.md',
            'agents.md',
            'CLAUDE.md',
            'CLAUDE.local.md',
        ]) {
            assert(
                !projectFiles.includes(legacyName),
                `generated lab-rat project retained ${legacyName}`,
            );
        }
        websocketFixture = await startCodexResponsesFixture({
            expectedInstructionSentinel: LAB_RAT_AGENT_INSTRUCTION_SENTINEL,
        });
        await writeCodexResponsesConfig(codexHome, websocketFixture.baseUrl);
        process.env.CODEX_HOME = codexHome;

        const { CodexAppServerClient } = await import(
            '../../packages/happy-cli/src/codex/codexAppServerClient'
        );
        const { connectCodexAppServerWebSocket } = await import(
            '../../packages/happy-cli/src/codex/codexAppServerWebSocket'
        );
        await exerciseOfficialUnixWebSocket({
            CodexAppServerClient,
            connectCodexAppServerWebSocket,
            binary: process.env.HAPPY_SCENARIO_CODEX_BIN!,
            version: officialVersion,
            cwd: projectRoot,
            socketPath: join(root, 'official-provider.sock'),
        });
        await websocketFixture.close();
        websocketFixture = null;

        fixture = await startCodexResponsesFixture({
            expectedInstructionSentinel: LAB_RAT_AGENT_INSTRUCTION_SENTINEL,
        });
        await writeCodexResponsesConfig(codexHome, fixture.baseUrl);
        codex = new CodexAppServerClient();
        const notificationMethods = new Set<string>();
        const notificationOrder: string[] = [];
        let droppedNotificationOrderEntries = 0;
        const itemTypes = new Set<string>();
        let agentText = '';
        let reasoningSummary = '';
        let commandOutput = '';
        let commandFinalOutput = '';
        let commandStatus: string | null = null;
        let commandExitCode: number | null = null;
        let resolveTurnCompleted!: () => void;
        const turnCompleted = new Promise<void>((resolve) => {
            resolveTurnCompleted = resolve;
        });
        codex.setStableNotificationHandler((notification) => {
            notificationMethods.add(notification.method);
            if (notificationOrder.length < 256) {
                notificationOrder.push(notification.method);
            } else {
                droppedNotificationOrderEntries += 1;
            }
            if (notification.method === 'turn/completed') {
                resolveTurnCompleted();
            }
            if (
                notification.method === 'item/started'
                || notification.method === 'item/completed'
            ) {
                const { item } = notification.params;
                itemTypes.add(item.type);
                if (
                    notification.method === 'item/completed'
                    && item.type === 'commandExecution'
                ) {
                    commandFinalOutput = item.aggregatedOutput ?? '';
                    commandStatus = item.status;
                    commandExitCode = item.exitCode;
                }
            } else if (notification.method === 'item/agentMessage/delta') {
                agentText += notification.params.delta;
            } else if (notification.method === 'item/reasoning/summaryTextDelta') {
                reasoningSummary += notification.params.delta;
            } else if (notification.method === 'item/commandExecution/outputDelta') {
                commandOutput += notification.params.delta;
            }
        });

        await codex.connect();
        const startedThread = await codex.startThread({
            cwd: projectRoot,
            approvalPolicy: 'never',
            sandbox: 'read-only',
        });

        const reportDiagnostics = (): void => {
            const provider = fixture!.snapshot();
            console.error(
                [
                    'Official lifecycle diagnostics:',
                    `requests=${provider.requestCount}`,
                    `toolOutput=${provider.toolOutputObserved}`,
                    `instructions=${provider.instructionSentinelObserved}`,
                    `methods=${notificationOrder.join(',')}`,
                    `droppedMethods=${droppedNotificationOrderEntries}`,
                    `commandDeltaBytes=${Buffer.byteLength(commandOutput, 'utf8')}`,
                    `commandFinalBytes=${Buffer.byteLength(commandFinalOutput, 'utf8')}`,
                    `commandStatus=${commandStatus ?? 'missing'}`,
                    `commandExitCode=${commandExitCode ?? 'missing'}`,
                    `reasoningBytes=${Buffer.byteLength(reasoningSummary, 'utf8')}`,
                    `agentBytes=${Buffer.byteLength(agentText, 'utf8')}`,
                ].join(' '),
            );
        };

        try {
            const [turnResult] = await withTimeout(
                Promise.all([
                    codex.sendTurnAndWait('exercise the official app-server lifecycle', {
                        clientUserMessageId: 'official-app-server-command',
                    }),
                    turnCompleted,
                ]),
                90_000,
                'official app-server command settlement and turn/completed',
            );
            assert.equal(
                turnResult.aborted,
                false,
                'official Codex unexpectedly aborted the turn',
            );

            const provider = fixture.snapshot();
            assert(
                provider.requestCount >= 2,
                'official Codex did not perform the tool follow-up request',
            );
            assert(
                provider.toolOutputObserved,
                'official Codex did not return function_call_output to the provider',
            );
            assert(
                provider.instructionSentinelObserved,
                'official Codex did not load the generated project AGENTS.md',
            );
            for (const method of [
                'turn/started',
                'item/started',
                'item/commandExecution/outputDelta',
                'item/reasoning/summaryTextDelta',
                'item/agentMessage/delta',
                'item/completed',
                'turn/completed',
            ]) {
                assert(notificationMethods.has(method), `official app-server omitted ${method}`);
            }
            for (const itemType of ['commandExecution', 'reasoning', 'agentMessage']) {
                assert(
                    itemTypes.has(itemType),
                    `official app-server omitted ${itemType} item lifecycle`,
                );
            }
            assert(
                commandOutput.includes(OFFICIAL_CODEX_TOOL_SENTINEL),
                'official shell command stream omitted the tool sentinel',
            );
            assert(
                commandFinalOutput.includes(OFFICIAL_CODEX_TOOL_SENTINEL),
                'official shell command final output omitted the tool sentinel',
            );
            assert.equal(commandStatus, 'completed', 'official shell command did not complete');
            assert.equal(
                commandExitCode,
                0,
                'official shell command returned a non-zero exit code',
            );
            assert(reasoningSummary.includes('official app-server tool round trip'));
            assert.equal(agentText, OFFICIAL_CODEX_RESPONSE_SENTINEL);

            const listed = await codex.listThreads({
                cursor: null,
                limit: 50,
                sortKey: 'recency_at',
                sortDirection: 'desc',
                sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
                archived: false,
                cwd: projectRoot,
                searchTerm: 'exercise the official app-server lifecycle',
            });
            assert(
                listed.data.some((thread) => thread.id === startedThread.threadId),
                'official thread/list omitted the completed root thread',
            );
            const read = await codex.readThread({
                threadId: startedThread.threadId,
                includeTurns: true,
                emitSnapshot: false,
            });
            assert.equal(read.thread.id, startedThread.threadId);
            assert.equal(read.thread.cwd, projectRoot);
            assert(read.thread.turns.length >= 1, 'official thread/read omitted completed turns');

            await codex.disconnect();
            codex = new CodexAppServerClient();
            await codex.connect();
            const resumed = await codex.resumeThread({
                threadId: startedThread.threadId,
                cwd: projectRoot,
                approvalPolicy: 'never',
                sandbox: 'read-only',
                emitSnapshot: false,
            });
            assert.equal(resumed.threadId, startedThread.threadId);
            assert.equal(resumed.thread.cwd, projectRoot);
            assert(
                resumed.thread.turns.length >= 1,
                'official thread/resume omitted the prior conversation snapshot',
            );
            console.log(
                `Official Codex app-server lifecycle passed: version=${officialVersion} requests=${provider.requestCount} instructions=ok tool=ok reasoning=ok stream=ok completion=ok history=list/read/resume`,
            );
        } catch (error) {
            reportDiagnostics();
            throw error;
        }
    } finally {
        if (codex) await codex.disconnect().catch(() => undefined);
        await websocketFixture?.close().catch(() => undefined);
        await fixture?.close().catch(() => undefined);
        restoreEnvironment('HAPPY_CODEX_APP_SERVER_PATH', originalAppServerPath);
        restoreEnvironment('HAPPY_FAKE_CODEX_SCENARIO', originalFakeScenario);
        restoreEnvironment('CODEX_HOME', originalCodexHome);
        restoreEnvironment('PATH', originalPath);
        await removeTemporaryRoot(root);
    }
}

const SAFE_TRANSPORT_ERROR_CODES = new Set([
    'EACCES',
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENAMETOOLONG',
    'ENETUNREACH',
    'ENOENT',
    'ENOTFOUND',
    'EPIPE',
    'ERR_NETWORK',
    'ESOCKETTIMEDOUT',
    'ETIMEDOUT',
]);

const MAX_OFFICIAL_PROVIDER_STDERR_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_OFFICIAL_WEBSOCKET_HANDSHAKE_RESPONSE_BYTES = 8 * 1024;
const RFC_6455_HANDSHAKE_REQUEST = Buffer.from([
    'GET / HTTP/1.1',
    'Host: localhost',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    '',
    '',
].join('\r\n'), 'ascii');

const OFFICIAL_WEBSOCKET_REJECTION_PATTERNS = [
    ['methodNotGet', 'Unsupported HTTP method used - only GET is allowed'],
    ['httpVersionTooOld', 'HTTP version must be 1.1 or higher'],
    ['missingConnectionUpgrade', 'No "Connection: upgrade" header'],
    ['missingUpgradeWebSocket', 'No "Upgrade: websocket" header'],
    ['missingWebSocketVersion', 'No "Sec-WebSocket-Version: 13" header'],
    ['missingWebSocketKey', 'No "Sec-WebSocket-Key" header'],
    ['junkAfterRequest', 'Junk after client request'],
    ['invalidHeader', 'Missing, duplicated or incorrect header'],
    ['httpParse', 'httparse error'],
    ['tooManyHeaders', 'Too many headers'],
] as const;

type OfficialWebSocketServerRejection =
    | (typeof OFFICIAL_WEBSOCKET_REJECTION_PATTERNS)[number][0]
    | 'upgradeRejectedOther'
    | 'noUpgradeRejection';

async function exerciseOfficialUnixWebSocket(options: {
    CodexAppServerClient: typeof import(
        '../../packages/happy-cli/src/codex/codexAppServerClient'
    ).CodexAppServerClient;
    connectCodexAppServerWebSocket: typeof import(
        '../../packages/happy-cli/src/codex/codexAppServerWebSocket'
    ).connectCodexAppServerWebSocket;
    binary: string;
    version: string;
    cwd: string;
    socketPath: string;
}): Promise<void> {
    await runOfficialUnixWebSocketProbe(options, 'rfc6455Handshake', async (socketPath) => {
        await waitForRfc6455WebSocketUpgrade(socketPath);
    });
    await runOfficialUnixWebSocketProbe(options, 'websocketOpen', async (socketPath) => {
        const socket = options.connectCodexAppServerWebSocket({ socketPath });
        try {
            await waitForWebSocketOpen(socket);
        } finally {
            await closeWebSocket(socket);
        }
    });
    await runOfficialUnixWebSocketProbe(options, 'initialize', async (socketPath) => {
        const parsedVersion = parseCodexCliVersion(options.version);
        assert(parsedVersion, 'validated official Codex version did not parse');
        const client = new options.CodexAppServerClient(
            undefined,
            parsedVersion,
            { webSocketEndpoint: { socketPath } },
        );
        try {
            await withTimeout(
                client.connect(),
                15_000,
                'official Unix WebSocket initialize/initialized',
            );
        } finally {
            await client.disconnect().catch(() => undefined);
        }
    });
    await runOfficialUnixWebSocketProbe(options, 'freshThreadObserver', async (socketPath) => {
        const parsedVersion = parseCodexCliVersion(options.version);
        assert(parsedVersion, 'validated official Codex version did not parse');
        const endpoint = { webSocketEndpoint: { socketPath } } as const;
        const observer = new options.CodexAppServerClient(undefined, parsedVersion, endpoint);
        const creator = new options.CodexAppServerClient(undefined, parsedVersion, endpoint);
        const observedMethods = new Set<string>();
        let subscriptionAttempts = 0;
        let subscribedTurnCount = 0;
        let snapshotItemTypes: string[] = [];
        let snapshotCommandBytes = 0;
        let snapshotReasoningBytes = 0;
        let snapshotAgentBytes = 0;
        let resolveObservedCompletion!: () => void;
        const observedCompletion = new Promise<void>((resolve) => {
            resolveObservedCompletion = resolve;
        });
        observer.setStableNotificationHandler((notification) => {
            observedMethods.add(notification.method);
            if (notification.method === 'turn/completed') resolveObservedCompletion();
        });
        try {
            // A remote bridge can read a fresh thread before the rollout exists, but
            // stable thread/resume becomes available only after the first turn starts.
            await observer.connect();
            await creator.connect();
            const started = await creator.startThread({
                cwd: options.cwd,
                approvalPolicy: 'never',
                sandbox: 'read-only',
            });
            const live = await observer.readThread({
                threadId: started.threadId,
                includeTurns: false,
                emitSnapshot: false,
            });
            assert.equal(live.thread.id, started.threadId);
            assert.equal(live.thread.turns.length, 0);

            const creatorTurn = creator.sendTurnAndWait(
                'verify a materialized stable-v2 observer receives the first turn',
                { clientUserMessageId: 'official-fresh-thread-observer-command' },
            );
            let subscribed: Awaited<ReturnType<typeof observer.subscribeThreadIfMaterialized>> = null;
            const subscriptionDeadline = Date.now() + 15_000;
            while (!subscribed && Date.now() < subscriptionDeadline) {
                subscriptionAttempts += 1;
                subscribed = await observer.subscribeThreadIfMaterialized(started.threadId);
                if (!subscribed) await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert(subscribed, 'observer could not resume the thread after its first turn materialized');
            subscribedTurnCount = subscribed.thread.turns.length;
            assert(
                subscribed.thread.turns.length >= 1,
                'materialized resume omitted the active first turn',
            );

            const [turn] = await withTimeout(Promise.all([
                creatorTurn,
                observedCompletion,
            ]), 90_000, 'materialized thread observer lifecycle');
            assert.equal(turn.aborted, false, 'fresh thread observer turn was aborted');
            assert(observedMethods.has('turn/completed'), 'materialized observer omitted turn/completed');
            for (const method of [
                'item/commandExecution/outputDelta',
                'item/reasoning/summaryTextDelta',
                'item/agentMessage/delta',
            ]) {
                assert(
                    observedMethods.has(method),
                    `materialized observer omitted ${method}`,
                );
            }

            const finalSnapshot = await observer.readThreadComplete({
                threadId: started.threadId,
                emitSnapshot: false,
            });
            const snapshotItems = finalSnapshot.thread.turns.flatMap((turn) => turn.items);
            snapshotItemTypes = [...new Set(snapshotItems.map((item) => item.type))].sort();
            for (const item of snapshotItems) {
                if (item.type === 'commandExecution') {
                    snapshotCommandBytes += Buffer.byteLength(item.aggregatedOutput ?? '', 'utf8');
                } else if (item.type === 'reasoning') {
                    snapshotReasoningBytes += Buffer.byteLength(item.summary.join(''), 'utf8');
                } else if (item.type === 'agentMessage') {
                    snapshotAgentBytes += Buffer.byteLength(item.text, 'utf8');
                }
            }
            const serializedSnapshot = JSON.stringify(finalSnapshot.thread);
            assert(
                serializedSnapshot.includes('official app-server tool round trip'),
                'materialized observer snapshot omitted reasoning summary',
            );
            assert(
                serializedSnapshot.includes(OFFICIAL_CODEX_RESPONSE_SENTINEL),
                'materialized observer snapshot omitted the assistant response',
            );
        } catch (error) {
            console.error(
                [
                    'Fresh observer diagnostics:',
                    `subscriptionAttempts=${subscriptionAttempts}`,
                    `subscribedTurns=${subscribedTurnCount}`,
                    `methods=${[...observedMethods].sort().join(',')}`,
                    `snapshotItemTypes=${snapshotItemTypes.join(',')}`,
                    `snapshotCommandBytes=${snapshotCommandBytes}`,
                    `snapshotReasoningBytes=${snapshotReasoningBytes}`,
                    `snapshotAgentBytes=${snapshotAgentBytes}`,
                ].join(' '),
            );
            throw error;
        } finally {
            await Promise.allSettled([
                observer.disconnect(),
                creator.disconnect(),
            ]);
        }
    });
}

type OfficialUnixWebSocketProbePhase =
    | 'rfc6455Handshake'
    | 'websocketOpen'
    | 'initialize'
    | 'freshThreadObserver';

async function runOfficialUnixWebSocketProbe(
    options: {
        binary: string;
        version: string;
        cwd: string;
        socketPath: string;
    },
    phase: OfficialUnixWebSocketProbePhase,
    probe: (socketPath: string) => Promise<void>,
): Promise<void> {
    const provider = spawn(
        options.binary,
        ['app-server', '--listen', `unix://${options.socketPath}`],
        {
            cwd: options.cwd,
            env: process.env,
            stdio: ['ignore', 'ignore', 'pipe'],
        },
    );
    let spawnError: unknown = null;
    let stderrBytes = 0;
    let capturedStderrBytes = 0;
    const capturedStderrChunks: Buffer[] = [];
    let currentPhase: 'listen' | OfficialUnixWebSocketProbePhase = 'listen';
    provider.once('error', (error) => {
        spawnError = error;
    });
    provider.stderr?.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += buffer.byteLength;
        const remaining = MAX_OFFICIAL_PROVIDER_STDERR_DIAGNOSTIC_BYTES - capturedStderrBytes;
        if (remaining <= 0) return;
        const captured = buffer.subarray(0, remaining);
        capturedStderrChunks.push(captured);
        capturedStderrBytes += captured.byteLength;
    });
    try {
        await waitForUnixSocket(options.socketPath, provider, () => spawnError);
        currentPhase = phase;
        await probe(options.socketPath);
        console.log(`Official Codex Unix WebSocket ${phase} passed: version=${options.version}`);
    } catch (error) {
        const diagnosticError = spawnError ?? error;
        throw new Error([
            'Official Codex Unix WebSocket initialization failed',
            `phase=${currentPhase}`,
            `kind=${safeTransportErrorKind(diagnosticError)}`,
            `code=${safeTransportErrorCode(diagnosticError)}`,
            `serverRejection=${classifyOfficialWebSocketServerRejection(Buffer.concat(capturedStderrChunks))}`,
            `stderrBytes=${stderrBytes}`,
            `providerExited=${provider.exitCode !== null || provider.signalCode !== null}`,
        ].join(' '));
    } finally {
        await stopChildProcess(provider);
        await rm(options.socketPath, { force: true });
    }
}

async function waitForRfc6455WebSocketUpgrade(socketPath: string): Promise<void> {
    const socket = connectUnixSocket({ path: socketPath });
    socket.setNoDelay(true);
    try {
        await withTimeout((async () => {
            await once(socket, 'connect');
            socket.write(RFC_6455_HANDSHAKE_REQUEST);
            let response = Buffer.alloc(0);
            for await (const chunk of socket) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                if (
                    response.byteLength + buffer.byteLength
                    > MAX_OFFICIAL_WEBSOCKET_HANDSHAKE_RESPONSE_BYTES
                ) {
                    throw new Error('Official Unix WebSocket handshake response exceeded limit');
                }
                response = Buffer.concat([response, buffer]);
                const headersEnd = response.indexOf('\r\n\r\n');
                if (headersEnd < 0) continue;
                const statusLineEnd = response.indexOf('\r\n');
                if (statusLineEnd < 0) {
                    throw new Error('Official Unix WebSocket returned an invalid HTTP response');
                }
                const statusLine = response.subarray(0, statusLineEnd).toString('ascii');
                if (!/^HTTP\/1\.[01] 101(?: |$)/.test(statusLine)) {
                    throw new Error('Official Unix WebSocket did not return HTTP 101');
                }
                return;
            }
            throw new Error('Official Unix WebSocket closed before returning HTTP 101');
        })(), 10_000, 'official RFC 6455 Unix WebSocket upgrade');
    } finally {
        socket.on('error', () => undefined);
        socket.destroy();
    }
}

function classifyOfficialWebSocketServerRejection(
    stderr: Buffer,
): OfficialWebSocketServerRejection {
    const text = stderr.toString('utf8');
    for (const [classification, pattern] of OFFICIAL_WEBSOCKET_REJECTION_PATTERNS) {
        if (text.includes(pattern)) return classification;
    }
    return text.includes('failed to upgrade control socket websocket connection')
        ? 'upgradeRejectedOther'
        : 'noUpgradeRejection';
}

async function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off('open', onOpen);
            socket.off('close', onClose);
            socket.off('error', onError);
            if (error) reject(error);
            else resolve();
        };
        const onOpen = () => finish();
        const onClose = () => finish(new Error('Official Unix WebSocket closed before open'));
        const onError = (error: Error) => finish(error);
        const timer = setTimeout(
            () => finish(new Error('Official Unix WebSocket did not open in time')),
            10_000,
        );
        socket.once('open', onOpen);
        socket.once('close', onClose);
        socket.once('error', onError);
    });
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) return;
    socket.on('error', () => undefined);
    if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
        return;
    }
    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off('close', finish);
            socket.off('error', finish);
            resolve();
        };
        const timer = setTimeout(() => {
            socket.terminate();
            finish();
        }, 500);
        socket.once('close', finish);
        socket.once('error', finish);
        socket.close(1000, 'Happy CI transport probe');
    });
}

async function waitForUnixSocket(
    socketPath: string,
    provider: ChildProcess,
    spawnError: () => unknown,
): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const currentSpawnError = spawnError();
        if (currentSpawnError) throw currentSpawnError;
        if (provider.exitCode !== null || provider.signalCode !== null) {
            throw new Error('Official app-server exited before binding its Unix socket');
        }
        try {
            if ((await stat(socketPath)).isSocket()) return;
        } catch {
            // The official app-server has not bound the private endpoint yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Official app-server did not bind its Unix socket in time');
}

function safeTransportErrorCode(error: unknown): string {
    try {
        if (!error || typeof error !== 'object' || Array.isArray(error)) return 'unknown';
        const code = (error as Record<string, unknown>).code;
        return typeof code === 'string' && SAFE_TRANSPORT_ERROR_CODES.has(code)
            ? code
            : 'unknown';
    } catch {
        return 'unknown';
    }
}

function safeTransportErrorKind(error: unknown): string {
    const code = safeTransportErrorCode(error);
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ECONNABORTED') {
        return 'timeout';
    }
    if (
        code === 'ECONNRESET'
        || code === 'ECONNREFUSED'
        || code === 'EHOSTUNREACH'
        || code === 'ENETUNREACH'
        || code === 'ENOTFOUND'
        || code === 'EAI_AGAIN'
        || code === 'ERR_NETWORK'
    ) {
        return 'network';
    }
    if (code === 'EACCES') return 'authorization';
    if (code === 'ENOENT' || code === 'ENAMETOOLONG') return 'endpoint';
    if (code === 'EPIPE') return 'transport';
    return 'unknown';
}

async function stopChildProcess(processHandle: ChildProcess): Promise<void> {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => processHandle.once('exit', () => resolve()));
    try {
        processHandle.kill('SIGTERM');
    } catch {
        return;
    }
    const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (graceful) return;
    try {
        processHandle.kill('SIGKILL');
    } catch {
        return;
    }
    await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
}

function configureOfficialCodexPath(): string {
    const binary = process.env.HAPPY_SCENARIO_CODEX_BIN?.trim();
    const expectedVersion = process.env.HAPPY_SCENARIO_CODEX_VERSION?.trim();
    if (!binary) throw new Error('HAPPY_SCENARIO_CODEX_BIN is required');
    if (!expectedVersion) throw new Error('HAPPY_SCENARIO_CODEX_VERSION is required');
    const output = execFileSync(binary, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: CODEX_CLI_VERSION_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
    }).trim();
    assert.equal(output, `codex-cli ${expectedVersion}`);
    assert(
        isCodexCliVersionAtLeast(
            parseCodexCliVersion(output),
            MINIMUM_CODEX_CLI_VERSION,
        ),
        `${output} is below the Happy minimum`,
    );
    process.env.PATH = `${dirname(binary)}${delimiter}${process.env.PATH ?? ''}`;
    return output;
}

function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

async function removeTemporaryRoot(root: string): Promise<void> {
    let lastError: unknown = null;
    for (const delayMs of TEMP_ROOT_CLEANUP_RETRY_DELAYS_MS) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
            await rm(root, { recursive: true, force: true });
            return;
        } catch (error) {
            if (!isRetryableTemporaryRootCleanupError(error)) throw error;
            lastError = error;
        }
    }
    throw lastError;
}

function isRetryableTemporaryRootCleanupError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
    const code = (error as Record<string, unknown>).code;
    return typeof code === 'string' && RETRYABLE_TEMP_ROOT_CLEANUP_CODES.has(code);
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Timed out waiting for ${label}`)),
            timeoutMs,
        );
        timer.unref();
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
