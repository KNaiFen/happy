import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { stat, rm } from 'node:fs/promises';
import { connect as connectTcp } from 'node:net';
import { isAbsolute } from 'node:path';
import { spawn as crossSpawn } from 'cross-spawn';
import {
    assertMinimumCodexCliVersion,
    readCodexCliVersion,
    type CodexCliVersion,
} from '../codexCliVersion';
import type { CodexAppServerWebSocketEndpoint } from '../codexAppServerWebSocket';

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_RECOVERY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 5_000] as const;

export type CodexGatewayProviderState =
    | 'starting'
    | 'running'
    | 'recovering'
    | 'stopping'
    | 'stopped';

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
}

interface SpawnedProvider {
    process: ChildProcess;
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
}

export class CodexGatewayProvider {
    private current: SpawnedProvider | null = null;
    private state: CodexGatewayProviderState = 'stopped';
    private epoch = 0;
    private stopping = false;
    private recoveryPromise: Promise<void> | null = null;
    private recoveryWake: (() => void) | null = null;

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
        return this.current?.process.pid ?? null;
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
            await this.launch(false);
        } catch (error) {
            this.setState('stopped', 0);
            throw error;
        }
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
            await stopOwnedProcess(
                spawned.process,
                this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
            );
        }
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
            epoch,
            ready: false,
            terminated: false,
        };
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
            if (this.current === spawned) this.current = null;
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
                    spawned.process,
                    this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
                );
            }
            throw error;
        }
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
            if (endpoint.socketPath) {
                if ((await stat(endpoint.socketPath)).isSocket()) return;
            } else if (endpoint.url) {
                await probeLoopbackEndpoint(endpoint.url);
                return;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const kind = lastError instanceof Error ? lastError.name : 'unknown';
    throw new Error(`Codex app-server did not become ready within ${timeoutMs}ms (${kind})`);
}

async function probeLoopbackEndpoint(url: string): Promise<void> {
    const parsed = new URL(url);
    const port = Number(parsed.port || 80);
    await new Promise<void>((resolve, reject) => {
        const socket = connectTcp({ host: parsed.hostname, port });
        socket.setTimeout(250);
        socket.once('connect', () => {
            socket.destroy();
            resolve();
        });
        socket.once('timeout', () => socket.destroy(new Error('Loopback provider probe timed out')));
        socket.once('error', reject);
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
