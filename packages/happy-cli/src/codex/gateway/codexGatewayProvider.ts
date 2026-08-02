import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { stat, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { spawn as crossSpawn } from 'cross-spawn';
import WebSocket from 'ws';
import {
    assertMinimumCodexCliVersion,
    readCodexCliVersion,
    type CodexCliVersion,
} from '../codexCliVersion';
import {
    connectCodexAppServerWebSocket,
    type CodexAppServerWebSocketEndpoint,
} from '../codexAppServerWebSocket';

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const PROVIDER_PROBE_TIMEOUT_MS = 500;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_RECOVERY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 5_000] as const;

export type CodexGatewayProviderState =
    | 'starting'
    | 'running'
    | 'recovering'
    | 'stopping'
    | 'stopped';

export type CodexGatewayProviderOwnership =
    | 'expected'
    | 'absent'
    | 'unexpected'
    | 'unverified';

export class CodexGatewayProviderOwnershipUnknownError extends Error {
    constructor() {
        super('Codex app-server ownership cannot be verified; preserving the existing endpoint');
        this.name = 'CodexGatewayProviderOwnershipUnknownError';
    }
}

export interface CodexGatewayProviderHooks {
    stateChanged?(state: CodexGatewayProviderState, attempt: number): void;
    ready?(event: { epoch: number; recovered: boolean }): Promise<void> | void;
    exited?(event: {
        epoch: number;
        code: number | null;
        signal: NodeJS.Signals | null;
        unexpected: boolean;
    }): void;
    stderr?(event: { epoch: number; bytes: number }): void;
    processChanged?(event: { pid: number | null; adopted: boolean }): Promise<void> | void;
}

interface SpawnedProvider {
    process: ChildProcess | null;
    pid: number;
    adopted: boolean;
    monitor: ReturnType<typeof setInterval> | null;
    epoch: number;
    ready: boolean;
    terminated: boolean;
}

export interface CodexGatewayProviderOptions {
    cwd: string;
    endpoint: CodexAppServerWebSocketEndpoint;
    tokenFilePath?: string;
    codexCliVersion?: CodexCliVersion;
    command?: string;
    argsPrefix?: string[];
    env?: NodeJS.ProcessEnv;
    hooks?: CodexGatewayProviderHooks;
    readyTimeoutMs?: number;
    stopTimeoutMs?: number;
    recoveryDelaysMs?: readonly number[];
    spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    waitUntilReady?: (
        endpoint: CodexAppServerWebSocketEndpoint,
        timeoutMs: number,
        isCurrent: () => boolean,
    ) => Promise<void>;
    sleep?: (milliseconds: number) => Promise<void>;
    adoptExisting?: {
        pid: number;
        inspect(pid: number): CodexGatewayProviderOwnership;
        terminate(pid: number): Promise<void>;
        pollIntervalMs?: number;
    };
}

export class CodexGatewayProvider {
    private current: SpawnedProvider | null = null;
    private state: CodexGatewayProviderState = 'stopped';
    private epoch = 0;
    private stopping = false;
    private recoveryPromise: Promise<void> | null = null;
    private recoveryWake: (() => void) | null = null;
    private preserveEndpointOnFailure = false;

    constructor(private readonly options: CodexGatewayProviderOptions) {
        validateProviderEndpoint(options.endpoint, options.tokenFilePath);
    }

    get currentState(): CodexGatewayProviderState {
        return this.state;
    }

    get currentEpoch(): number {
        return this.epoch;
    }

    get pid(): number | null {
        return this.current?.pid ?? null;
    }

    get isAdopted(): boolean {
        return this.current?.adopted === true;
    }

    get mustPreserveEndpoint(): boolean {
        return this.isAdopted || this.preserveEndpointOnFailure;
    }

    get requiresConservativeRecovery(): boolean {
        return this.preserveEndpointOnFailure;
    }

    async start(): Promise<void> {
        if (this.state !== 'stopped') return;
        this.stopping = false;
        assertMinimumCodexCliVersion(
            this.options.codexCliVersion ?? readCodexCliVersion(),
        );
        await assertProviderCredentialFile(this.options.tokenFilePath);
        this.setState('starting', 0);
        try {
            if (await this.tryAdoptExisting()) return;
            await this.launch(false);
        } catch (error) {
            if (this.mustPreserveEndpoint) this.setState('recovering', 1);
            else {
                this.clearCurrentWithoutTerminating();
                this.setState('stopped', 0);
            }
            throw error;
        }
    }

    releaseAdopted(): void {
        const current = this.current;
        if (!current?.adopted) return;
        if (current.monitor) clearInterval(current.monitor);
        current.terminated = true;
        this.current = null;
        this.state = 'stopped';
    }

    releaseForWorkerRecovery(): void {
        const current = this.current;
        if (current?.monitor) clearInterval(current.monitor);
        if (current) current.terminated = true;
        this.current = null;
        this.preserveEndpointOnFailure = false;
        this.state = 'stopped';
    }

    async stop(): Promise<void> {
        if (this.state === 'stopped') return;
        this.stopping = true;
        this.setState('stopping', 0);
        this.recoveryWake?.();
        this.recoveryWake = null;

        const spawned = this.current;
        this.current = null;
        if (spawned && !spawned.terminated) {
            spawned.terminated = true;
            if (spawned.monitor) clearInterval(spawned.monitor);
            if (spawned.adopted) {
                await this.options.adoptExisting?.terminate(spawned.pid);
            } else if (spawned.process) {
                await stopOwnedProcess(
                    spawned.process,
                    this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
                );
            }
        }
        await this.options.hooks?.processChanged?.({ pid: null, adopted: false });
        await this.recoveryPromise?.catch(() => undefined);
        if (this.options.endpoint.socketPath) {
            await rm(this.options.endpoint.socketPath, { force: true });
        }
        this.setState('stopped', 0);
    }

    private async launch(recovered: boolean): Promise<void> {
        if (this.stopping) throw new Error('Codex Gateway provider is stopping');
        if (this.options.endpoint.socketPath) {
            await rm(this.options.endpoint.socketPath, { force: true });
        }

        const epoch = ++this.epoch;
        const command = this.options.command ?? 'codex';
        const args = [
            ...(this.options.argsPrefix ?? []),
            ...buildCodexGatewayProviderArgs(this.options.endpoint, this.options.tokenFilePath),
        ];
        const env = buildProviderEnvironment(this.options.env ?? process.env);
        const spawn = this.options.spawn ?? crossSpawn;
        const processHandle = spawn(command, args, {
            cwd: this.options.cwd,
            env,
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
        });
        const spawned: SpawnedProvider = {
            process: processHandle,
            pid: processHandle.pid ?? 0,
            adopted: false,
            monitor: null,
            epoch,
            ready: false,
            terminated: false,
        };
        if (!spawned.pid) {
            processHandle.once('error', () => undefined);
            throw new Error('Codex app-server process did not start');
        }
        this.current = spawned;

        let rejectBeforeReady!: (error: Error) => void;
        const terminatedBeforeReady = new Promise<never>((_resolve, reject) => {
            rejectBeforeReady = reject;
        });
        const terminate = (event: {
            error?: Error;
            code: number | null;
            signal: NodeJS.Signals | null;
        }) => {
            if (spawned.terminated) return;
            spawned.terminated = true;
            if (spawned.monitor) clearInterval(spawned.monitor);
            if (this.current === spawned) this.current = null;
            void this.options.hooks?.processChanged?.({ pid: null, adopted: false });
            const unexpected = !this.stopping;
            this.options.hooks?.exited?.({ epoch, code: event.code, signal: event.signal, unexpected });
            if (!spawned.ready) {
                rejectBeforeReady(event.error ?? new Error(
                    `Codex app-server exited before ready (code=${event.code ?? 'none'}, signal=${event.signal ?? 'none'})`,
                ));
                return;
            }
            if (unexpected) this.beginRecovery();
        };
        processHandle.once('error', (error) => terminate({ error, code: null, signal: null }));
        processHandle.once('exit', (code, signal) => terminate({ code, signal }));
        processHandle.stderr?.on('data', (chunk: Buffer | string) => {
            if (this.current !== spawned || spawned.terminated) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
            if (bytes > 0) this.options.hooks?.stderr?.({ epoch, bytes });
        });

        const waitUntilReady = this.options.waitUntilReady ?? waitForProviderEndpoint;
        try {
            await this.options.hooks?.processChanged?.({ pid: spawned.pid, adopted: false });
            await Promise.race([
                waitUntilReady(
                    this.options.endpoint,
                    this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
                    () => this.current === spawned && !spawned.terminated && !this.stopping,
                ),
                terminatedBeforeReady,
            ]);
            if (this.current !== spawned || spawned.terminated || this.stopping) {
                throw new Error('Codex app-server stopped during startup');
            }
            await Promise.race([
                Promise.resolve(this.options.hooks?.ready?.({ epoch, recovered })),
                terminatedBeforeReady,
            ]);
            if (this.current !== spawned || spawned.terminated || this.stopping) {
                throw new Error('Codex app-server stopped during bridge initialization');
            }
            spawned.ready = true;
            this.setState('running', 0);
        } catch (error) {
            if (this.current === spawned && !spawned.terminated) {
                spawned.terminated = true;
                this.current = null;
                await stopOwnedProcess(
                    spawned.process!,
                    this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
                );
                await this.options.hooks?.processChanged?.({ pid: null, adopted: false });
            }
            throw error;
        }
    }

    private async tryAdoptExisting(): Promise<boolean> {
        const candidate = this.options.adoptExisting;
        if (!candidate) return false;
        const initialOwnership = candidate.inspect(candidate.pid);
        if (initialOwnership === 'unverified' || initialOwnership === 'unexpected') {
            this.preserveEndpointOnFailure = true;
            throw new CodexGatewayProviderOwnershipUnknownError();
        }
        if (initialOwnership === 'absent') {
            if (await this.isEndpointReachable()) {
                this.preserveEndpointOnFailure = true;
                throw new CodexGatewayProviderOwnershipUnknownError();
            }
            return false;
        }
        const waitUntilReady = this.options.waitUntilReady ?? waitForProviderEndpoint;
        try {
            await waitUntilReady(
                this.options.endpoint,
                Math.min(1_000, this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS),
                () => !this.stopping && candidate.inspect(candidate.pid) === 'expected',
            );
        } catch {
            const ownership = candidate.inspect(candidate.pid);
            if (ownership === 'expected') {
                await candidate.terminate(candidate.pid);
                await this.options.hooks?.processChanged?.({ pid: null, adopted: false });
                return false;
            }
            if (ownership === 'absent' && !(await this.isEndpointReachable())) return false;
            this.preserveEndpointOnFailure = true;
            throw new CodexGatewayProviderOwnershipUnknownError();
        }
        if (this.stopping) return false;
        if (candidate.inspect(candidate.pid) !== 'expected') {
            this.preserveEndpointOnFailure = true;
            throw new CodexGatewayProviderOwnershipUnknownError();
        }
        const epoch = ++this.epoch;
        const spawned: SpawnedProvider = {
            process: null,
            pid: candidate.pid,
            adopted: true,
            monitor: null,
            epoch,
            ready: false,
            terminated: false,
        };
        this.current = spawned;
        await this.options.hooks?.processChanged?.({ pid: candidate.pid, adopted: true });
        await this.options.hooks?.ready?.({ epoch, recovered: true });
        if (this.current !== spawned || spawned.terminated || this.stopping) {
            throw new Error('Codex app-server stopped during bridge recovery');
        }
        spawned.ready = true;
        spawned.monitor = setInterval(() => {
            if (this.current !== spawned || spawned.terminated || this.stopping) return;
            const ownership = candidate.inspect(candidate.pid);
            if (ownership === 'expected') {
                if (this.state !== 'running') this.setState('running', 0);
                return;
            }
            if (ownership !== 'absent') {
                this.preserveEndpointOnFailure = true;
                if (this.state !== 'recovering') this.setState('recovering', 1);
                return;
            }
            spawned.terminated = true;
            if (spawned.monitor) clearInterval(spawned.monitor);
            if (this.current === spawned) this.current = null;
            void this.options.hooks?.processChanged?.({ pid: null, adopted: false });
            this.options.hooks?.exited?.({
                epoch,
                code: null,
                signal: null,
                unexpected: true,
            });
            this.beginRecovery();
        }, candidate.pollIntervalMs ?? 1_000);
        spawned.monitor.unref();
        this.setState('running', 0);
        return true;
    }

    private async isEndpointReachable(): Promise<boolean> {
        const waitUntilReady = this.options.waitUntilReady ?? waitForProviderEndpoint;
        try {
            await waitUntilReady(
                this.options.endpoint,
                Math.min(1_000, this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS),
                () => !this.stopping,
            );
            return true;
        } catch {
            return false;
        }
    }

    private clearCurrentWithoutTerminating(): void {
        const current = this.current;
        if (!current) return;
        if (current.monitor) clearInterval(current.monitor);
        this.current = null;
    }

    private beginRecovery(): void {
        if (this.stopping || this.recoveryPromise) return;
        const recovery = this.recover();
        this.recoveryPromise = recovery;
        const clearRecovery = () => {
            if (this.recoveryPromise === recovery) this.recoveryPromise = null;
        };
        void recovery.then(clearRecovery, clearRecovery);
    }

    private async recover(): Promise<void> {
        const delays = this.options.recoveryDelaysMs?.length
            ? this.options.recoveryDelaysMs
            : DEFAULT_RECOVERY_DELAYS_MS;
        let attempt = 0;
        while (!this.stopping) {
            attempt += 1;
            this.setState('recovering', attempt);
            const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
            await this.waitForRecoveryDelay(delay);
            if (this.stopping) return;
            try {
                await this.launch(true);
                return;
            } catch {
                if (this.stopping) return;
            }
        }
    }

    private async waitForRecoveryDelay(milliseconds: number): Promise<void> {
        if (milliseconds <= 0) return;
        if (this.options.sleep) {
            await this.options.sleep(milliseconds);
            return;
        }
        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (this.recoveryWake === finish) this.recoveryWake = null;
                resolve();
            };
            const timer = setTimeout(finish, milliseconds);
            this.recoveryWake = finish;
        });
    }

    private setState(state: CodexGatewayProviderState, attempt: number): void {
        this.state = state;
        this.options.hooks?.stateChanged?.(state, attempt);
    }
}

export function buildCodexGatewayProviderArgs(
    endpoint: CodexAppServerWebSocketEndpoint,
    tokenFilePath?: string,
): string[] {
    if (endpoint.socketPath) {
        return ['app-server', '--listen', `unix://${endpoint.socketPath}`];
    }
    if (!endpoint.url) throw new Error('Codex Gateway provider endpoint is missing');
    const args = ['app-server', '--listen', endpoint.url];
    if (tokenFilePath) {
        args.push('--ws-auth', 'capability-token', '--ws-token-file', tokenFilePath);
    }
    return args;
}

function validateProviderEndpoint(
    endpoint: CodexAppServerWebSocketEndpoint,
    tokenFilePath?: string,
): void {
    if ((endpoint.socketPath ? 1 : 0) + (endpoint.url ? 1 : 0) !== 1) {
        throw new Error('Exactly one Codex Gateway provider endpoint is required');
    }
    if (endpoint.socketPath) {
        if (process.platform === 'win32') {
            throw new Error('Codex Gateway Unix sockets are not supported on Windows');
        }
        if (!isAbsolute(endpoint.socketPath)) {
            throw new Error('Codex Gateway Unix socket path must be absolute');
        }
        if (tokenFilePath) throw new Error('Unix Codex Gateway provider does not use a token file');
        return;
    }
    const parsed = new URL(endpoint.url!);
    if (parsed.protocol !== 'ws:') {
        throw new Error('Codex Gateway loopback provider must use ws://');
    }
    if (!isLoopbackHostname(parsed.hostname)) {
        throw new Error('Codex Gateway provider must bind to loopback');
    }
    if (!parsed.port || Number(parsed.port) < 1 || Number(parsed.port) > 65_535) {
        throw new Error('Codex Gateway loopback provider requires an explicit port');
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
        throw new Error('Codex Gateway loopback provider URL must not include a path or credentials');
    }
    if (!tokenFilePath || !endpoint.bearerToken) {
        throw new Error('Codex Gateway loopback provider requires capability-token authentication');
    }
    if (!isAbsolute(tokenFilePath)) {
        throw new Error('Codex Gateway provider token file path must be absolute');
    }
    if (endpoint.bearerToken.length < 32) {
        throw new Error('Codex Gateway provider capability token is too short');
    }
}

function isLoopbackHostname(hostname: string): boolean {
    return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function buildProviderEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'string') env[key] = value;
    }
    const filter = 'codex_core::rollout::list=off';
    if (!env.RUST_LOG) env.RUST_LOG = filter;
    else if (!env.RUST_LOG.includes('codex_core::rollout::list=')) env.RUST_LOG += `,${filter}`;
    return env;
}

async function assertProviderCredentialFile(tokenFilePath?: string): Promise<void> {
    if (!tokenFilePath) return;
    const metadata = await stat(tokenFilePath);
    if (!metadata.isFile()) throw new Error('Codex Gateway provider token path is not a file');
    if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
        throw new Error('Codex Gateway provider token file must use mode 0600');
    }
}

async function waitForProviderEndpoint(
    endpoint: CodexAppServerWebSocketEndpoint,
    timeoutMs: number,
    isCurrent: () => boolean,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
        if (!isCurrent()) throw new Error('Codex app-server startup was cancelled');
        try {
            if (endpoint.socketPath && !(await stat(endpoint.socketPath)).isSocket()) {
                throw new Error('Codex app-server endpoint is not a Unix socket');
            }
            await probeWebSocketEndpoint(endpoint);
            return;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const kind = lastError instanceof Error ? lastError.name : 'unknown';
    throw new Error(`Codex app-server did not become ready within ${timeoutMs}ms (${kind})`);
}

async function probeWebSocketEndpoint(endpoint: CodexAppServerWebSocketEndpoint): Promise<void> {
    const socket = connectCodexAppServerWebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
        let opened = false;
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off('open', onOpen);
            socket.off('close', onClose);
            socket.off('error', onError);
            if (error) {
                socket.on('error', () => undefined);
                if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
                reject(error);
            } else {
                resolve();
            }
        };
        const onOpen = () => {
            opened = true;
            socket.close(1000, 'readiness');
        };
        const onClose = () => finish(opened
            ? undefined
            : new Error('Codex app-server WebSocket closed before readiness'));
        const onError = (error: Error) => finish(error);
        const timer = setTimeout(
            () => finish(new Error('Codex app-server WebSocket readiness probe timed out')),
            PROVIDER_PROBE_TIMEOUT_MS,
        );
        socket.once('open', onOpen);
        socket.once('close', onClose);
        socket.once('error', onError);
    });
}

async function stopOwnedProcess(processHandle: ChildProcess, timeoutMs: number): Promise<void> {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => processHandle.once('exit', () => resolve()));
    try {
        processHandle.kill('SIGTERM');
    } catch {
        return;
    }
    const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
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
