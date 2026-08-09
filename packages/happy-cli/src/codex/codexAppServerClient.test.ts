import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import { logger } from '@/ui/logger';
import type { Thread } from './protocol';

const {
    mockExecFileSync,
    mockInitializeSandbox,
    mockWrapForMcpTransport,
    mockSandboxCleanup,
    mockSpawn,
} = vi.hoisted(() => ({
    mockExecFileSync: vi.fn(),
    mockInitializeSandbox: vi.fn(),
    mockWrapForMcpTransport: vi.fn(),
    mockSandboxCleanup: vi.fn(),
    mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    execFileSync: mockExecFileSync,
    spawn: mockSpawn,
}));

vi.mock('cross-spawn', () => ({
    spawn: mockSpawn,
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: mockInitializeSandbox,
    wrapForMcpTransport: mockWrapForMcpTransport,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('../package.json', () => ({
    default: { version: '0.0.1-test' },
}));

type MockRpcMessage = {
    id?: number;
    method?: string;
    params?: any;
    result?: any;
    error?: { code: number | string; message?: string; data?: unknown };
};

function pushJsonLine(stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }, payload: unknown) {
    stdout.push(JSON.stringify(payload) + '\n');
}

// Mock child process with stdin/stdout/stderr
function createMockProcess(opts?: {
    pid?: number;
    initializeDelayMs?: number;
    onRequest?: (msg: MockRpcMessage, stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }) => void;
}) {
    const { Readable, Writable } = require('stream');
    const initializeDelayMs = opts?.initializeDelayMs ?? 5;
    const stdin = new Writable({ write: (_: any, __: any, cb: () => void) => cb() });
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const proc = Object.assign(new (require('events').EventEmitter)(), {
        stdin,
        stdout,
        stderr,
        pid: opts?.pid ?? 12345,
        kill: vi.fn(),
    });
    // Send initialize response immediately when stdin is written to
    const origWrite = stdin.write.bind(stdin);
    stdin.write = (data: any, ...args: any[]) => {
        try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
            if (msg.method === 'initialize' && msg.id != null) {
                // Send response on next tick
                setTimeout(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { userAgent: 'test' } });
                }, initializeDelayMs);
            }
            opts?.onRequest?.(msg, stdout);
        } catch {}
        return origWrite(data, ...args);
    };
    return proc;
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const sandboxConfig: SandboxConfig = {
    enabled: true,
    workspaceRoot: '~/projects',
    sessionIsolation: 'workspace',
    customWritePaths: [],
    denyReadPaths: ['~/.ssh'],
    extraWritePaths: ['/tmp'],
    denyWritePaths: ['.env'],
    networkMode: 'allowed',
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: true,
};

describe('CodexAppServerClient sandbox integration', () => {
    const originalRustLog = process.env.RUST_LOG;
    const originalAppServerPath = process.env.HAPPY_CODEX_APP_SERVER_PATH;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.RUST_LOG = originalRustLog;
        delete process.env.HAPPY_CODEX_APP_SERVER_PATH;
        mockExecFileSync.mockReturnValue('codex-cli 0.145.0');
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockWrapForMcpTransport.mockResolvedValue({ command: 'sh', args: ['-c', 'wrapped codex app-server'] });
        mockSpawn.mockImplementation(() => createMockProcess());
    });

    afterAll(() => {
        process.env.RUST_LOG = originalRustLog;
        if (originalAppServerPath === undefined) {
            delete process.env.HAPPY_CODEX_APP_SERVER_PATH;
        } else {
            process.env.HAPPY_CODEX_APP_SERVER_PATH = originalAppServerPath;
        }
    });

    it('reports goal action support for Codex versions with goal action requests', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');

        mockExecFileSync.mockReturnValue('codex-cli 0.140.0');
        expect(new CodexAppServerClient().supportsGoalActions()).toBe(true);

        mockExecFileSync.mockReturnValue('codex-cli 0.130.0');
        expect(new CodexAppServerClient().supportsGoalActions()).toBe(false);
    });

    it('reports turn steering support from Codex 0.145 onward', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');

        mockExecFileSync.mockReturnValue('codex-cli 0.145.0');
        expect(new CodexAppServerClient().supportsTurnSteering()).toBe(true);

        mockExecFileSync.mockReturnValue('codex-cli 0.144.9');
        expect(new CodexAppServerClient().supportsTurnSteering()).toBe(false);
    });

    it('reuses one provider version probe for capabilities and connect', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        expect(client.supportsGoalActions()).toBe(true);
        expect(client.supportsTurnSteering()).toBe(true);
        await client.connect();

        expect(mockExecFileSync).toHaveBeenCalledOnce();
        await client.disconnect();
    });

    it('refuses to connect to Codex versions older than 0.145.0', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        mockExecFileSync.mockReturnValue('codex-cli 0.144.9');

        await expect(new CodexAppServerClient().connect()).rejects.toThrow('found 0.144.9');
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('can launch the payload-free fake app-server through an explicit local test path', async () => {
        process.env.HAPPY_CODEX_APP_SERVER_PATH = '/tmp/fake-codex-app-server.cjs';
        const proc = createMockProcess();
        mockSpawn.mockReturnValue(proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        expect(mockSpawn).toHaveBeenCalledWith(
            process.execPath,
            ['/tmp/fake-codex-app-server.cjs'],
            expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
        );
        expect(mockExecFileSync).not.toHaveBeenCalled();
        await client.disconnect();
    });

    it('publishes connection uncertainty across startup and unexpected process exit', async () => {
        const proc = createMockProcess();
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const states: Array<{
            connection: string;
            statusUnknown: boolean;
            error: string | null;
        }> = [];
        client.setConnectionHandler((event) => states.push(event));

        await client.connect();
        proc.emit('error', new Error('transport failed'));
        proc.emit('exit', 1, null);

        expect(states).toEqual([
            { connection: 'disconnected', statusUnknown: true, error: null },
            { connection: 'connecting', statusUnknown: true, error: null },
            { connection: 'connected', statusUnknown: false, error: null },
            { connection: 'error', statusUnknown: true, error: 'unknown' },
            { connection: 'disconnected', statusUnknown: true, error: null },
        ]);
    });

    it('records both JSON-RPC directions through the redacted trace sink', async () => {
        const proc = createMockProcess();
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const record = vi.fn();
        client.setProtocolTraceSink({ record });

        await client.connect();

        expect(record).toHaveBeenCalledWith('outbound', expect.objectContaining({ method: 'initialize' }));
        expect(record).toHaveBeenCalledWith('inbound', expect.objectContaining({ result: { userAgent: 'test' } }));
        expect(record).toHaveBeenCalledWith('outbound', expect.objectContaining({ method: 'initialized' }));
        await client.disconnect();
    });

    it('adopts a terminal root snapshot locally without sending a duplicate lifecycle event', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const notifications = vi.fn();
        client.setStableNotificationHandler(notifications);
        const snapshot = {
            id: 'thread-terminal-root',
            parentThreadId: null,
            status: { type: 'idle' },
            turns: [],
        } as unknown as Thread;

        client.adoptThreadSnapshot(snapshot);

        expect(client.threadId).toBe('thread-terminal-root');
        expect(notifications).not.toHaveBeenCalled();
    });

    it('emits exact 0.145 stable-v2 initialize, thread, and turn request shapes', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-shape', turns: [], status: { type: 'idle' } },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            serviceTier: null,
                            cwd: '/tmp/project',
                            instructionSources: [],
                            approvalPolicy: 'on-request',
                            approvalsReviewer: 'user',
                            sandbox: {
                                type: 'workspaceWrite',
                                writableRoots: [],
                                networkAccess: false,
                                excludeTmpdirEnvVar: false,
                                excludeSlashTmp: false,
                            },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            turn: {
                                id: 'turn-shape',
                                items: [],
                                itemsView: 'full',
                                status: 'inProgress',
                                error: null,
                                startedAt: 1,
                                completedAt: null,
                                durationMs: null,
                            },
                        },
                    }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            mcpServers: {
                happy: { command: 'happy-mcp', args: ['serve'], optional: undefined },
            },
        });
        await client.startTurnOnThread('thread-shape', 'run tests', {
            clientUserMessageId: 'command-shape',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            model: 'gpt-test',
            effort: 'high',
        });

        expect(requests.find((msg) => msg.method === 'initialize')).toEqual({
            id: 1,
            method: 'initialize',
            params: {
                clientInfo: {
                    name: 'happy-codex',
                    title: 'Happy Codex Client',
                    version: expect.any(String),
                },
                capabilities: {
                    experimentalApi: false,
                    requestAttestation: false,
                },
            },
        });
        expect(requests.find((msg) => msg.method === 'initialized')).toEqual({ method: 'initialized' });
        expect(requests.find((msg) => msg.method === 'thread/start')?.params).toEqual({
            model: 'gpt-test',
            modelProvider: null,
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            config: {
                mcp_servers: { happy: { command: 'happy-mcp', args: ['serve'] } },
            },
            baseInstructions: null,
            developerInstructions: null,
        });
        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toEqual({
            threadId: 'thread-shape',
            clientUserMessageId: 'command-shape',
            input: [{ type: 'text', text: 'run tests', text_elements: [] }],
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            model: 'gpt-test',
            effort: 'high',
            sandboxPolicy: {
                type: 'workspaceWrite',
                writableRoots: [],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
            },
        });
        expect(requests.every((message) => !Object.prototype.hasOwnProperty.call(message, 'jsonrpc'))).toBe(true);

        await client.disconnect();
    });

    it('rejects pending RPC immediately when stdout closes without a process exit', async () => {
        const proc = createMockProcess();
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient, CodexRpcOutcomeUnknownError } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const states: string[] = [];
        client.setConnectionHandler((event) => states.push(event.connection));
        await client.connect();

        const pending = client.listModels({ timeoutMs: 10_000 });
        proc.stdout.push(null);

        await expect(pending).rejects.toBeInstanceOf(CodexRpcOutcomeUnknownError);
        expect(states.at(-1)).toBe('disconnected');
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('steers the active turn without interrupting it', async () => {
        mockExecFileSync.mockReturnValue('codex-cli 0.145.0');
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-steer', path: '/tmp/thread-steer' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-steer', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: { threadId: 'thread-steer', turn: { id: 'turn-steer' } },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/steer' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        const activeTurn = client.sendTurnAndWait('original request');
        await waitFor(() => client.turnId === 'turn-steer');

        await client.steerTurn('use the edited file', {
            clientUserMessageId: 'queued-message-1',
            extraInputItems: [{ type: 'localImage', path: '/tmp/guide.png' }],
        });

        expect(requests.find((msg) => msg.method === 'turn/steer')?.params).toEqual({
            threadId: 'thread-steer',
            expectedTurnId: 'turn-steer',
            clientUserMessageId: 'queued-message-1',
            input: [
                { type: 'text', text: 'use the edited file', text_elements: [] },
                { type: 'localImage', path: '/tmp/guide.png' },
            ],
        });
        expect(requests.some((msg) => msg.method === 'turn/interrupt')).toBe(false);

        pushJsonLine(proc.stdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-steer',
                turn: { id: 'turn-steer', items: [], status: 'completed', error: null },
            },
        });
        await expect(activeTurn).resolves.toEqual({ aborted: false });
        await client.disconnect();
    });

    it('keeps child lifecycle notifications out of the selected parent session', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-parent', path: '/tmp/thread-parent' },
                            model: 'gpt-test',
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-parent', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-parent',
                                turn: { id: 'turn-parent', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'thread/read' && msg.id != null && msg.params?.threadId === 'thread-child') {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: {
                                id: 'thread-child',
                                status: { type: 'idle' },
                                turns: [{ id: 'turn-child', items: [], status: 'completed', error: null }],
                            },
                        },
                    }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((event) => events.push(event as Record<string, unknown>));
        await client.connect();
        await client.startThread({ model: 'gpt-test' });

        let parentSettled = false;
        const parentTurn = client.sendTurnAndWait('parent work');
        void parentTurn.then(() => { parentSettled = true; });
        await waitFor(() => client.turnId === 'turn-parent');

        pushJsonLine(proc.stdout, {
            method: 'turn/started',
            params: {
                threadId: 'thread-child',
                turn: { id: 'turn-child', items: [], status: 'inProgress', error: null },
            },
        });
        pushJsonLine(proc.stdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-child',
                turn: { id: 'turn-child', items: [], status: 'completed', error: null },
            },
        });
        pushJsonLine(proc.stdout, {
            method: 'codex/event',
            params: {
                threadId: 'thread-child',
                msg: { type: 'task_complete', turn_id: 'turn-child' },
            },
        });

        await waitFor(() => requests.some((request) => request.method === 'thread/read'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(parentSettled).toBe(false);
        expect(client.threadId).toBe('thread-parent');
        expect(client.turnId).toBe('turn-parent');
        expect(requests.filter((request) => request.method === 'thread/read')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);

        pushJsonLine(proc.stdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-parent',
                turn: { id: 'turn-parent', items: [], status: 'completed', error: null },
            },
        });
        pushJsonLine(proc.stdout, {
            method: 'codex/event',
            params: {
                threadId: 'thread-parent',
                msg: { type: 'task_complete', turn_id: 'turn-parent' },
            },
        });
        await expect(parentTurn).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    it('drops malformed terminal notifications without settling the active turn', async () => {
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-malformed' }, model: 'gpt-test' },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            turn: {
                                id: 'turn-malformed',
                                items: [],
                                status: 'inProgress',
                                error: null,
                            },
                        },
                    }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        const diagnostics: Array<Record<string, unknown>> = [];
        client.setEventHandler((event) => events.push(event as Record<string, unknown>));
        client.setDiagnosticSink({
            record: (record) => diagnostics.push(record as Record<string, unknown>),
        });
        await client.connect();
        await client.startThread({ model: 'gpt-test' });

        let settled = false;
        const activeTurn = client.sendTurnAndWait('keep running');
        void activeTurn.then(() => { settled = true; });
        await waitFor(() => client.turnId === 'turn-malformed');

        for (const params of [
            { turn: { id: 'turn-malformed', status: 'completed' } },
            { threadId: 'thread-malformed', turn: { status: 'completed' } },
            {
                threadId: 'thread-malformed',
                turn: { id: 'turn-malformed', status: 'inProgress' },
            },
            {
                threadId: 'thread-malformed',
                turn: { id: 'turn-malformed', status: 'futureTerminal' },
            },
        ]) {
            pushJsonLine(proc.stdout, { method: 'turn/completed', params });
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);
        expect(diagnostics.filter((record) => (
            record.event === 'notification'
            && record.phase === 'dropped'
            && record.errorKind === 'protocol'
        ))).toHaveLength(4);
        expect(JSON.stringify(diagnostics)).not.toContain('futureTerminal');

        pushJsonLine(proc.stdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-malformed',
                turn: {
                    id: 'turn-malformed',
                    items: [],
                    status: 'completed',
                    error: null,
                },
            },
        });
        await expect(activeTurn).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    it('ignores the legacy turn timeout option and waits for an authoritative boundary', async () => {
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-long' }, model: 'gpt-test' },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { turn: { id: 'turn-long', items: [], status: 'inProgress', error: null } },
                    }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({ model: 'gpt-test' });

        let settled = false;
        const pending = client.sendTurnAndWait('long task', { turnTimeoutMs: 5 });
        void pending.then(() => { settled = true; });
        await waitFor(() => client.turnId === 'turn-long');
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(settled).toBe(false);

        pushJsonLine(proc.stdout, {
            method: 'thread/status/changed',
            params: { threadId: 'thread-long', status: { type: 'idle' } },
        });
        await expect(pending).resolves.toEqual({ aborted: false });
        await client.disconnect();
    });

    it('keeps a turn pending for two virtual hours without an authoritative boundary', async () => {
        vi.useFakeTimers();
        const proc = createMockProcess({
            initializeDelayMs: 0,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-two-hours' }, model: 'gpt-test' },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            turn: {
                                id: 'turn-two-hours',
                                items: [],
                                status: 'inProgress',
                                error: null,
                            },
                        },
                    }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        try {
            const connecting = client.connect();
            await vi.advanceTimersByTimeAsync(0);
            await connecting;

            const starting = client.startThread({ model: 'gpt-test' });
            await vi.advanceTimersByTimeAsync(0);
            await starting;

            let settled = false;
            const pending = client.sendTurnAndWait('two hour task', { turnTimeoutMs: 1 });
            void pending.then(
                () => { settled = true; },
                () => { settled = true; },
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(client.turnId).toBe('turn-two-hours');

            await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);
            expect(settled).toBe(false);

            pushJsonLine(proc.stdout, {
                method: 'turn/completed',
                params: {
                    threadId: 'thread-two-hours',
                    turn: {
                        id: 'turn-two-hours',
                        items: [],
                        status: 'completed',
                        error: null,
                    },
                },
            });
            await vi.advanceTimersByTimeAsync(0);
            await expect(pending).resolves.toEqual({ aborted: false });
        } finally {
            await client.disconnect();
            vi.useRealTimers();
        }
    });

    it('reconciles an unknown turn/start outcome after an app-server exit', async () => {
        const firstRequests: MockRpcMessage[] = [];
        const secondRequests: MockRpcMessage[] = [];
        const proc1 = createMockProcess({
            pid: 4101,
            onRequest: (msg, stdout) => {
                firstRequests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-recover' }, model: 'gpt-test' },
                    }), 0);
                }
                if (msg.method === 'turn/start') {
                    setTimeout(() => proc1.emit('exit', 1, null), 0);
                }
            },
        });
        const proc2 = createMockProcess({
            pid: 4102,
            onRequest: (msg, stdout) => {
                secondRequests.push(msg);
                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: {
                                id: 'thread-recover',
                                status: { type: 'idle' },
                                turns: [{
                                    id: 'turn-recovered',
                                    items: [],
                                    status: 'completed',
                                    error: null,
                                }],
                            },
                            model: 'gpt-test',
                        },
                    }), 0);
                }
            },
        });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({ model: 'gpt-test' });

        await expect(client.sendTurnAndWait('survive restart')).resolves.toEqual({ aborted: false });
        expect(firstRequests.some((request) => request.method === 'turn/start')).toBe(true);
        expect(secondRequests.some((request) => request.method === 'thread/resume')).toBe(true);
        expect(client.threadId).toBe('thread-recover');
        await client.disconnect();
    });

    it('recovers every active root and child thread without changing selection', async () => {
        const firstRequests: MockRpcMessage[] = [];
        const secondRequests: MockRpcMessage[] = [];
        let startedThreads = 0;
        const proc1 = createMockProcess({
            pid: 4201,
            onRequest: (msg, stdout) => {
                firstRequests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    const threadId = startedThreads++ === 0 ? 'thread-child' : 'thread-root';
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: {
                                id: threadId,
                                status: { type: 'idle' },
                                turns: [],
                            },
                            model: 'gpt-test',
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    const threadId = msg.params.threadId as string;
                    const turnId = threadId === 'thread-root' ? 'turn-root' : 'turn-child';
                    setTimeout(() => {
                        const turn = {
                            id: turnId,
                            items: [],
                            status: 'inProgress',
                            error: null,
                        };
                        pushJsonLine(stdout, { id: msg.id, result: { turn } });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: { threadId, turn },
                        });
                    }, 0);
                }
            },
        });
        const proc2 = createMockProcess({
            pid: 4202,
            onRequest: (msg, stdout) => {
                secondRequests.push(msg);
                if (msg.method === 'thread/resume' && msg.id != null) {
                    const threadId = msg.params.threadId as string;
                    const turnId = threadId === 'thread-root' ? 'turn-root' : 'turn-child';
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: {
                                id: threadId,
                                status: { type: 'active', activeFlags: [] },
                                turns: [{
                                    id: turnId,
                                    items: [],
                                    status: 'inProgress',
                                    error: null,
                                }],
                            },
                            model: 'gpt-test',
                        },
                    }), 0);
                }
                // Reconciliation reads stay pending until disconnect rejects
                // them; no terminal state is invented for either thread.
            },
        });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.startThread({
            model: 'gpt-test',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.startTurnOnThread('thread-child', 'child work');
        await client.startTurnOnThread('thread-root', 'root work');
        expect(firstRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
        expect(client.threadId).toBe('thread-root');

        proc1.emit('exit', 1, null);
        await waitFor(() => (
            secondRequests.filter((request) => request.method === 'thread/resume').length === 2
        ));

        const resumeRequests = secondRequests.filter((request) => request.method === 'thread/resume');
        expect(resumeRequests.map((request) => request.params.threadId).sort()).toEqual([
            'thread-child',
            'thread-root',
        ]);
        for (const request of resumeRequests) {
            expect(request.params).toEqual(expect.objectContaining({
                approvalPolicy: 'on-request',
                sandbox: 'read-only',
            }));
        }
        expect(client.threadId).toBe('thread-root');

        await client.disconnect();
    });

    it('cleans up a pending start after a definitive turn/start error', async () => {
        let turnStarts = 0;
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-error' }, model: 'gpt-test' },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    turnStarts += 1;
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        error: { code: -32602, message: 'invalid turn input' },
                    }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({ model: 'gpt-test' });

        await expect(client.sendTurnAndWait('invalid')).rejects.toThrow('turn/start failed (code=-32602)');
        await expect(client.sendTurnAndWait('invalid again')).rejects.toThrow('turn/start failed (code=-32602)');
        expect(turnStarts).toBe(2);
        await client.disconnect();
    });

    it('lists every visible model page from app-server', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method !== 'model/list' || msg.id == null) return;

                const cursor = msg.params?.cursor ?? null;
                setTimeout(() => {
                    pushJsonLine(stdout, {
                        id: msg.id,
                        result: cursor === null
                            ? {
                                data: [{
                                    id: 'gpt-first',
                                    model: 'gpt-first',
                                    displayName: 'GPT First',
                                    description: 'First model',
                                    hidden: false,
                                    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }],
                                    defaultReasoningEffort: 'low',
                                    isDefault: true,
                                }],
                                nextCursor: 'page-2',
                            }
                            : {
                                data: [{
                                    id: 'gpt-second',
                                    model: 'gpt-second',
                                    displayName: 'GPT Second',
                                    description: 'Second model',
                                    hidden: false,
                                    supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'Ultra' }],
                                    defaultReasoningEffort: 'ultra',
                                    isDefault: false,
                                }],
                                nextCursor: null,
                            },
                    });
                }, 0);
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        await expect(client.listModels({ pageSize: 1 })).resolves.toEqual([
            expect.objectContaining({ id: 'gpt-first' }),
            expect.objectContaining({ id: 'gpt-second' }),
        ]);
        expect(requests.filter((msg) => msg.method === 'model/list').map((msg) => msg.params)).toEqual([
            { cursor: null, limit: 1, includeHidden: false },
            { cursor: 'page-2', limit: 1, includeHidden: false },
        ]);

        await client.disconnect();
    });

    it('rejects a model catalog that never finishes paginating', async () => {
        let page = 0;
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                if (msg.method !== 'model/list' || msg.id == null) return;
                page += 1;
                pushJsonLine(stdout, {
                    id: msg.id,
                    result: {
                        data: [],
                        nextCursor: `page-${page}`,
                    },
                });
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        await expect(client.listModels()).rejects.toThrow('model/list exceeded 100 pages');

        await client.disconnect();
    });

    it('wraps transport when sandbox is enabled', async () => {
        // Dynamic import to ensure mocks are applied
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockInitializeSandbox).toHaveBeenCalledWith(sandboxConfig, process.cwd());
        expect(mockWrapForMcpTransport).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://']);
        expect(mockSpawn).toHaveBeenCalledWith(
            'sh',
            ['-c', 'wrapped codex app-server'],
            expect.objectContaining({
                env: expect.objectContaining({
                    CODEX_SANDBOX: 'seatbelt',
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(true);

        await client.disconnect();
    });

    it('falls back to non-sandbox transport when sandbox initialization fails', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockWrapForMcpTransport).not.toHaveBeenCalled();
        expect(mockSpawn).toHaveBeenCalledWith(
            'codex',
            ['app-server', '--listen', 'stdio://'],
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(false);

        await client.disconnect();
    });

    it('resets sandbox on disconnect', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();
        await client.disconnect();

        expect(mockSandboxCleanup).toHaveBeenCalledTimes(1);
        expect(client.sandboxEnabled).toBe(false);
    });

    it('appends rollout log filter to existing RUST_LOG', async () => {
        process.env.RUST_LOG = 'info,codex_core=warn';
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: 'info,codex_core=warn,codex_core::rollout::list=off',
                }),
            }),
        );

        await client.disconnect();
    });

    it('ignores stale process exit during reconnect initialize', async () => {
        const proc1 = createMockProcess({ pid: 1001, initializeDelayMs: 5 });
        const proc2 = createMockProcess({ pid: 1002, initializeDelayMs: 50 });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.disconnect();

        const reconnect = client.connect();
        setTimeout(() => {
            proc1.emit('exit', 0, null);
        }, 10);

        await expect(reconnect).resolves.toBeUndefined();
        await client.disconnect();
    });

    it('reconnects and resumes the same thread after forced restart timeout', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];
        type CapturedEvent = { type: string; [key: string]: unknown };

        const proc1 = createMockProcess({
            pid: 2001,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-1', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-1',
                                turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2002,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);

                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-1',
                                    path: '/tmp/thread-1',
                                    status: { type: 'idle' },
                                    turns: [{
                                        id: 'turn-1',
                                        items: [],
                                        status: 'interrupted',
                                        error: null,
                                    }],
                                },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-2', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-1',
                                turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-1',
                                turn: { id: 'turn-2', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: CapturedEvent[] = [];
        client.setEventHandler((msg) => {
            events.push(msg as CapturedEvent);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        const pendingTurn = client.sendTurnAndWait('hang forever', { turnTimeoutMs: 5000 });
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));

        const abortResult = await client.abortTurnWithFallback({
            gracePeriodMs: 1,
            forceRestartOnTimeout: true,
        });

        await expect(pendingTurn).resolves.toEqual({ aborted: true });
        expect(abortResult).toEqual({
            hadActiveTurn: true,
            aborted: true,
            forcedRestart: true,
            resumedThread: true,
            statusUnknown: false,
        });
        expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(0);

        const resumeRequest = secondProcessRequests.find((msg) => msg.method === 'thread/resume');
        expect(resumeRequest?.params).toEqual(expect.objectContaining({
            threadId: 'thread-1',
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        }));
        expect(resumeRequest?.params).not.toHaveProperty('persistExtendedHistory');
        expect(client.threadId).toBe('thread-1');

        await expect(client.sendTurnAndWait('follow up after reconnect')).resolves.toEqual({ aborted: false });

        await client.disconnect();
    });

    it('force-restarts promptly when turn interrupt RPC does not respond', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];

        const proc1 = createMockProcess({
            pid: 2101,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-stuck-interrupt', path: '/tmp/thread-stuck-interrupt' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: {
                                    id: 'turn-stuck-interrupt',
                                    items: [],
                                    status: 'inProgress',
                                    error: null,
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-stuck-interrupt',
                                turn: {
                                    id: 'turn-stuck-interrupt',
                                    items: [],
                                    status: 'inProgress',
                                    error: null,
                                },
                            },
                        });
                    }, 0);
                }

                // Deliberately do not respond to turn/interrupt. This used to
                // block abortTurnWithFallback until the generic 30s RPC timeout.
            },
        });

        const proc2 = createMockProcess({
            pid: 2102,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);

                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-stuck-interrupt',
                                    path: '/tmp/thread-stuck-interrupt',
                                    status: { type: 'active', activeFlags: [] },
                                    turns: [{
                                        id: 'turn-stuck-interrupt',
                                        items: [],
                                        status: 'inProgress',
                                        error: null,
                                    }],
                                },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        const pendingTurn = client.sendTurnAndWait('hang on interrupt', { turnTimeoutMs: 5000 });
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));
        await waitFor(() => client.turnId === 'turn-stuck-interrupt');
        let pendingSettled = false;
        void pendingTurn.then(() => { pendingSettled = true; });

        const startedAt = Date.now();
        const abortResult = await client.abortTurnWithFallback({
            gracePeriodMs: 20,
            forceRestartOnTimeout: true,
        });

        expect(Date.now() - startedAt).toBeLessThan(1000);
        expect(pendingSettled).toBe(false);
        expect(firstProcessRequests.some((msg) => msg.method === 'turn/interrupt')).toBe(true);
        expect(abortResult).toEqual({
            hadActiveTurn: true,
            aborted: false,
            forcedRestart: true,
            resumedThread: true,
            statusUnknown: true,
        });
        expect(secondProcessRequests.some((msg) => msg.method === 'thread/resume')).toBe(true);

        pushJsonLine(proc2.stdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-stuck-interrupt',
                turn: {
                    id: 'turn-stuck-interrupt',
                    items: [],
                    status: 'interrupted',
                    error: null,
                },
            },
        });
        await expect(pendingTurn).resolves.toEqual({ aborted: true });

        await client.disconnect();
    });

    it('forks, reads, and rolls back Codex threads through app-server RPC', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2501,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/fork' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    path: '/tmp/thread-forked',
                                    forkedFromId: 'thread-source',
                                    turns: [],
                                },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/read' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    turns: [
                                        { id: 'turn-1', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }] },
                                    ],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/rollback' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    status: { type: 'idle' },
                                    turns: [],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/inject_items' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {},
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const notifications = vi.fn();
        client.setStableNotificationHandler(notifications);

        await client.connect();
        const forked = await client.forkThread({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });
        const read = await client.readThread({ threadId: forked.threadId, includeTurns: true });
        expect(client.turnId).toBe('turn-1');
        notifications.mockClear();
        const rolledBack = await client.rollbackThread({
            threadId: forked.threadId,
            numTurns: 2,
            emitSnapshot: false,
        });
        const injected = await client.injectItems({
            threadId: forked.threadId,
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        expect(forked.threadId).toBe('thread-forked');
        expect(read.thread.turns).toHaveLength(1);
        expect(rolledBack.thread.turns).toHaveLength(0);
        expect(client.turnId).toBeNull();
        expect(notifications).not.toHaveBeenCalled();
        expect(injected).toEqual({});
        expect(requests.find((msg) => msg.method === 'thread/fork')?.params).toEqual(expect.objectContaining({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        }));
        expect(requests.find((msg) => msg.method === 'thread/read')?.params).toEqual({
            threadId: 'thread-forked',
            includeTurns: true,
        });
        expect(requests.find((msg) => msg.method === 'thread/rollback')?.params).toEqual({
            threadId: 'thread-forked',
            numTurns: 2,
        });
        expect(requests.find((msg) => msg.method === 'thread/inject_items')?.params).toEqual({
            threadId: 'thread-forked',
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        await client.disconnect();
    });

    it('falls back to stable thread resume for a complete paginated snapshot', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/read' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        error: {
                            code: -32600,
                            message: 'paginated threads do not support thread/read(includeTurns=true)',
                        },
                    }), 0);
                }
                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: {
                                id: 'thread-paginated',
                                turns: [{
                                    id: 'turn-history',
                                    items: [],
                                    status: 'completed',
                                    error: null,
                                }],
                            },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            instructionSources: [],
                            approvalPolicy: 'on-request',
                            approvalsReviewer: 'user',
                            sandbox: { type: 'readOnly', networkAccess: false },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        const snapshot = await client.readThreadComplete({
            threadId: 'thread-paginated',
            emitSnapshot: false,
        });

        expect(snapshot.thread.turns.map((turn) => turn.id)).toEqual(['turn-history']);
        expect(requests.find((request) => request.method === 'thread/resume')?.params).toEqual({
            threadId: 'thread-paginated',
        });
        expect(client.threadId).toBeNull();
        await client.disconnect();
    });

    it('clears active thread state so the next prompt starts a fresh thread', async () => {
        const requests: MockRpcMessage[] = [];
        let nextThreadNumber = 1;
        const proc = createMockProcess({
            pid: 2601,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    const threadId = `thread-${nextThreadNumber++}`;
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: threadId, path: `/tmp/${threadId}` },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-1');
        expect(client.hasActiveThread()).toBe(true);

        client.clearThreadState();

        expect(client.threadId).toBeNull();
        expect(client.turnId).toBeNull();
        expect(client.hasActiveThread()).toBe(false);

        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-2');
        expect(requests.filter((msg) => msg.method === 'thread/start')).toHaveLength(2);

        await client.disconnect();
    });

    it('sends extra localImage input items and omits empty text for image-only turns', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2801,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-images', path: '/tmp/thread-images' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-images',
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('', {
            extraInputItems: [{ type: 'localImage', path: '/tmp/happy-image.png' }],
        });

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-images',
            input: [{ type: 'localImage', path: '/tmp/happy-image.png' }],
        });

        await client.disconnect();
    });

    it('keeps text-only turn input unchanged when no extra input items are supplied', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2802,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-text', path: '/tmp/thread-text' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-text',
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('hello', {
            model: 'gpt-5.6-sol',
            effort: 'ultra',
        });

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-text',
            input: [{ type: 'text', text: 'hello' }],
            model: 'gpt-5.6-sol',
            effort: 'ultra',
        });

        await client.disconnect();
    });

    it('maps raw item notifications into legacy events and deduplicates turn completion', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3001,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-1', path: '/tmp/thread-raw-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'active', activeFlags: [] } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    status: 'inProgress',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'subAgentActivity',
                                    id: 'activity-1',
                                    kind: 'started',
                                    agentThreadId: 'thread-child-1',
                                    agentPath: 'Auth explorer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'subAgentActivity',
                                    id: 'activity-1',
                                    kind: 'interrupted',
                                    agentThreadId: 'thread-child-1',
                                    agentPath: 'Auth explorer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'subAgentActivity',
                                    id: 'activity-1',
                                    kind: 'started',
                                    agentThreadId: 'thread-child-1',
                                    agentPath: 'Auth explorer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    aggregatedOutput: '/tmp/project\n',
                                    exitCode: 0,
                                    durationMs: 1,
                                    status: 'completed',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'collabAgentToolCall',
                                    id: 'collab-1',
                                    tool: 'spawnAgent',
                                    status: 'inProgress',
                                    senderThreadId: 'thread-raw-1',
                                    receiverThreadIds: ['thread-child-1'],
                                    prompt: 'Inspect auth flow',
                                    model: 'gpt-test',
                                    reasoningEffort: 'medium',
                                    agentsStates: {},
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'collabAgentToolCall',
                                    id: 'collab-1',
                                    tool: 'spawnAgent',
                                    status: 'completed',
                                    senderThreadId: 'thread-raw-1',
                                    receiverThreadIds: ['thread-child-1'],
                                    prompt: 'Inspect auth flow',
                                    model: 'gpt-test',
                                    reasoningEffort: 'medium',
                                    agentsStates: {
                                        'thread-child-1': { status: 'completed', message: 'done' },
                                    },
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'subAgentActivity',
                                    id: 'activity-1',
                                    kind: 'started',
                                    agentThreadId: 'thread-child-1',
                                    agentPath: 'Auth explorer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-1',
                                    text: 'done',
                                    phase: 'final_answer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'idle' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('run pwd')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-1' }),
            expect.objectContaining({ type: 'exec_command_begin', callId: 'thread-raw-1:call-1' }),
            expect.objectContaining({ type: 'exec_command_end', callId: 'thread-raw-1:call-1', output: '/tmp/project\n' }),
            expect.objectContaining({
                type: 'collab_agent_begin',
                callId: 'collab-1',
                tool: 'spawnAgent',
                receiverThreadIds: ['thread-child-1'],
                prompt: 'Inspect auth flow',
            }),
            expect.objectContaining({
                type: 'collab_agent_end',
                callId: 'collab-1',
                status: 'completed',
                receiverThreadIds: ['thread-child-1'],
            }),
            expect.objectContaining({
                type: 'subagent_activity',
                item_id: 'activity-1',
                kind: 'started',
                agentThreadId: 'thread-child-1',
                agentPath: 'Auth explorer',
            }),
            expect.objectContaining({
                type: 'subagent_activity',
                item_id: 'activity-1',
                kind: 'interrupted',
                agentThreadId: 'thread-child-1',
                agentPath: 'Auth explorer',
            }),
            expect.objectContaining({ type: 'agent_message', message: 'done' }),
        ]));
        expect(events.filter((event) => event.type === 'subagent_activity')).toHaveLength(2);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    it('maps raw goal notifications into legacy goal events', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-goal-1', path: '/tmp/thread-goal-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/goal/updated',
                            params: {
                                threadId: 'thread-goal-1',
                                turnId: 'turn-goal-1',
                                goal: {
                                    threadId: 'thread-goal-1',
                                    objective: 'finish the task',
                                    status: 'active',
                                    tokenBudget: null,
                                    tokensUsed: 11,
                                    timeUsedSeconds: 3,
                                    createdAt: 1781680000,
                                    updatedAt: 1781680003,
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/goal/cleared',
                            params: { threadId: 'thread-goal-1' },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await waitFor(() => events.some((event) => event.type === 'thread_goal_cleared'));

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'thread_goal_updated',
                thread_id: 'thread-goal-1',
                threadId: 'thread-goal-1',
                turn_id: 'turn-goal-1',
                turnId: 'turn-goal-1',
                goal: expect.objectContaining({
                    threadId: 'thread-goal-1',
                    objective: 'finish the task',
                    status: 'active',
                }),
            }),
            expect.objectContaining({
                type: 'thread_goal_cleared',
                thread_id: 'thread-goal-1',
                threadId: 'thread-goal-1',
            }),
        ]));

        await client.disconnect();
    });

    it('sends goal set and clear requests through app-server', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/goal/set' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                goal: {
                                    threadId: 'thread-goal-1',
                                    objective: msg.params?.objective,
                                    status: 'active',
                                    tokenBudget: null,
                                    tokensUsed: 0,
                                    timeUsedSeconds: 0,
                                    createdAt: 1781680000,
                                    updatedAt: 1781680001,
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/goal/get' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                goal: {
                                    threadId: 'thread-goal-1',
                                    objective: 'finish the task',
                                    status: 'active',
                                    tokenBudget: null,
                                    tokensUsed: 1,
                                    timeUsedSeconds: 2,
                                    createdAt: 1781680000,
                                    updatedAt: 1781680001,
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/goal/clear' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { cleared: true },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await expect(client.setGoal({
            threadId: 'thread-goal-1',
            objective: 'finish the task',
        })).resolves.toMatchObject({
            goal: {
                threadId: 'thread-goal-1',
                objective: 'finish the task',
                status: 'active',
            },
        });
        await expect(client.clearGoal({
            threadId: 'thread-goal-1',
        })).resolves.toEqual({ cleared: true });
        await expect(client.getGoal({ threadId: 'thread-goal-1' })).resolves.toMatchObject({
            goal: { objective: 'finish the task', status: 'active' },
        });

        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/goal/set',
                params: {
                    threadId: 'thread-goal-1',
                    objective: 'finish the task',
                },
            }),
            expect.objectContaining({
                method: 'thread/goal/get',
                params: { threadId: 'thread-goal-1' },
            }),
            expect.objectContaining({
                method: 'thread/goal/clear',
                params: {
                    threadId: 'thread-goal-1',
                },
            }),
        ]));

        await client.disconnect();
    });

    it('maps raw file change items into legacy patch events', async () => {
        const proc = createMockProcess({
            pid: 3003,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-3', path: '/tmp/thread-raw-3' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'completed',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-3',
                                    text: 'patched',
                                    phase: 'final_answer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turn: { id: 'turn-raw-3', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('patch the file')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'patch_apply_begin',
                callId: 'thread-raw-3:patch-1',
                changes: {
                    'README.md': {
                        diff: '@@ -1 +1 @@',
                        kind: { type: 'update', move_path: null },
                    },
                    'MONETIZATION.md': {
                        kind: { type: 'add', move_path: null },
                        add: { content: '# Monetization\n\nPaid plans.\n' },
                    },
                },
            }),
            expect.objectContaining({
                type: 'patch_apply_end',
                callId: 'thread-raw-3:patch-1',
                status: 'completed',
            }),
        ]));

        await client.disconnect();
    });

    it('hydrates a late v2 file change approval after item completion', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-4', path: '/tmp/thread-raw-4' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-approval-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-approval-1',
                                    status: 'completed',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 99,
                            method: 'item/fileChange/requestApproval',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                itemId: 'patch-approval-1',
                                reason: null,
                                grantRoot: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'patch',
            callId: 'thread-raw-4:patch-approval-1',
            itemId: 'patch-approval-1',
            threadId: 'thread-raw-4',
            turnId: 'turn-raw-4',
            fileChanges: {
                'README.md': {
                    diff: '@@ -1 +1 @@',
                    kind: { type: 'update', move_path: null },
                },
            },
            reason: null,
        }));

        await client.disconnect();
    });

    it('scopes v2 approval IDs and raw file-change metadata by thread', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            pid: 3008,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-a', path: '/tmp/thread-a' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: {
                                threadId: 'thread-a',
                                msg: { type: 'legacy_coverage_probe' },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-a',
                                turnId: 'turn-a',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-shared',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'A.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ A @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-b',
                                turnId: 'turn-b',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-shared',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'B.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ B @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 101,
                            method: 'item/fileChange/requestApproval',
                            params: {
                                threadId: 'thread-a',
                                turnId: 'turn-a',
                                itemId: 'patch-shared',
                                reason: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 102,
                            method: 'item/fileChange/requestApproval',
                            params: {
                                threadId: 'thread-b',
                                turnId: 'turn-b',
                                itemId: 'patch-shared',
                                reason: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 103,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-a',
                                turnId: 'turn-a',
                                itemId: 'cmd-shared',
                                approvalId: 'approval-a',
                                command: 'npm test',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 3);

        expect(approvals).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'patch',
                callId: 'thread-a:patch-shared',
                itemId: 'patch-shared',
                threadId: 'thread-a',
                turnId: 'turn-a',
                fileChanges: {
                    'A.md': expect.objectContaining({ diff: '@@ A @@' }),
                },
            }),
            expect.objectContaining({
                type: 'patch',
                callId: 'thread-b:patch-shared',
                itemId: 'patch-shared',
                threadId: 'thread-b',
                turnId: 'turn-b',
                fileChanges: {
                    'B.md': expect.objectContaining({ diff: '@@ B @@' }),
                },
            }),
            // No approvalId suffix in callId: the app attaches the permission
            // card to its tool call by exact id equality with the scoped
            // exec_command_begin call id.
            expect.objectContaining({
                type: 'exec',
                callId: 'thread-a:cmd-shared',
                itemId: 'cmd-shared',
                threadId: 'thread-a',
                turnId: 'turn-a',
                approvalId: 'approval-a',
                command: ['npm test'],
            }),
        ]));

        await client.disconnect();
    });

    it('does not treat a final answer item as authoritative turn completion', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-2', path: '/tmp/thread-raw-2' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-2',
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-2',
                                turnId: 'turn-raw-2',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-2',
                                    text: 'still works',
                                    phase: 'final_answer',
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        let settled = false;
        const pendingTurn = client.sendTurnAndWait('say hi');
        void pendingTurn.then(() => { settled = true; });
        await waitFor(() => events.some((event) => event.type === 'agent_message'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        pushJsonLine(proc.stdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-raw-2',
                turn: { id: 'turn-raw-2', items: [], status: 'completed', error: null },
            },
        });
        await expect(pendingTurn).resolves.toEqual({ aborted: false });
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-2' }),
            expect.objectContaining({ type: 'agent_message', message: 'still works' }),
            expect.objectContaining({ type: 'task_complete', turn_id: 'turn-raw-2' }),
        ]));

        await client.disconnect();
    });

    it('responds to MCP elicitation requests with an action payload', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3007,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-7', path: '/tmp/thread-raw-7' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'mcpServer/elicitation/request',
                            params: {
                                threadId: 'thread-raw-7',
                                turnId: 'turn-raw-7',
                                serverName: 'happy',
                                mode: 'form',
                                _meta: {
                                    codex_approval_kind: 'mcp_tool_call',
                                    tool_title: 'Change Chat Title',
                                    tool_description: 'Change the title of the current chat session',
                                    tool_params: { title: 'Casual Greeting' },
                                },
                                message: 'Allow the happy MCP server to run tool "change_title"?',
                                requestedSchema: {
                                    type: 'object',
                                    properties: {},
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);
        await waitFor(() => requests.some((msg) => msg.id === 77 && msg.result?.action === 'accept'));

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'mcp',
            callId: 'thread-raw-7:happy:77',
            itemId: 'happy:77',
            threadId: 'thread-raw-7',
            turnId: 'turn-raw-7',
            approvalId: '77',
            toolName: 'change_title',
            input: { title: 'Casual Greeting' },
            serverName: 'happy',
        }));
        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 77,
                result: {
                    action: 'accept',
                    content: {},
                    _meta: null,
                },
            }),
        ]));

        await client.disconnect();
    });

    it('waits for the provider request-resolution notification before delivery ACK', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            onRequest: (msg) => { requests.push(msg); },
        });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const handled: Array<Record<string, unknown>> = [];
        const markResponseSupplied = vi.fn(async () => {});
        const markDelivered = vi.fn(async () => {});
        const markAbandoned = vi.fn(async () => {});
        client.setStableNotificationHandler((notification) => {
            if (
                notification.method === 'serverRequest/resolved'
                && String(notification.params.requestId) === '88'
            ) {
                void markDelivered();
            }
        });
        client.setServerRequestHandler(async (request) => {
            handled.push(request as unknown as Record<string, unknown>);
            return {
                response: { answers: { mode: { answers: ['safe'] } } },
                markResponseSupplied,
                markDelivered,
                markAbandoned,
            };
        });

        await client.connect();
        pushJsonLine(proc.stdout, {
            id: 88,
            method: 'item/tool/requestUserInput',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                itemId: 'item-1',
                questions: [{ id: 'mode', header: 'Mode', question: 'Choose', options: null }],
                autoResolutionMs: null,
            },
        });

        await waitFor(() => handled.length === 1);
        await waitFor(() => requests.some((message) => message.id === 88 && message.result));
        expect(handled[0]).toMatchObject({
            requestId: '88',
            method: 'item/tool/requestUserInput',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
        });
        expect(requests.find((message) => message.id === 88)?.result).toEqual({
            answers: { mode: { answers: ['safe'] } },
        });
        await waitFor(() => markResponseSupplied.mock.calls.length === 1);
        expect(markResponseSupplied).toHaveBeenCalledOnce();
        expect(markDelivered).not.toHaveBeenCalled();
        expect(markAbandoned).not.toHaveBeenCalled();
        pushJsonLine(proc.stdout, {
            method: 'serverRequest/resolved',
            params: { threadId: 'thread-1', requestId: 88 },
        });
        await waitFor(() => markDelivered.mock.calls.length === 1);
        await client.disconnect();
    });

    it('abandons a provider response when stdin reports an asynchronous write failure', async () => {
        const proc = createMockProcess();
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const markResponseSupplied = vi.fn(async () => {});
        const markDelivered = vi.fn(async () => {});
        const markAbandoned = vi.fn(async () => {});
        client.setServerRequestHandler(async () => ({
            response: { decision: 'accept' },
            markResponseSupplied,
            markDelivered,
            markAbandoned,
        }));

        await client.connect();
        const originalWrite = proc.stdin.write.bind(proc.stdin);
        proc.stdin.write = (data: any, ...args: any[]) => {
            const message = JSON.parse(typeof data === 'string' ? data : data.toString()) as MockRpcMessage;
            if (message.id === 89 && message.result) {
                const callback = args.find((value) => typeof value === 'function');
                queueMicrotask(() => callback?.(new Error('simulated EPIPE')));
                return false;
            }
            return originalWrite(data, ...args);
        };
        pushJsonLine(proc.stdout, {
            id: 89,
            method: 'item/fileChange/requestApproval',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
        });

        await waitFor(() => markAbandoned.mock.calls.length === 1);
        expect(markResponseSupplied).not.toHaveBeenCalled();
        expect(markDelivered).not.toHaveBeenCalled();
        await client.disconnect();
    });

    it('never writes a stale provider response into a reconnected transport', async () => {
        const firstRequests: MockRpcMessage[] = [];
        const secondRequests: MockRpcMessage[] = [];
        const first = createMockProcess({ onRequest: (message) => firstRequests.push(message) });
        const second = createMockProcess({ onRequest: (message) => secondRequests.push(message) });
        mockSpawn
            .mockImplementationOnce(() => first)
            .mockImplementationOnce(() => second);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let provideManagedResponse!: () => void;
        const responseGate = new Promise<void>((resolve) => { provideManagedResponse = resolve; });
        const markResponseSupplied = vi.fn(async () => {});
        const markDelivered = vi.fn(async () => {});
        const markAbandoned = vi.fn(async () => {});
        client.setServerRequestHandler(async () => {
            await responseGate;
            return {
                response: { decision: 'accept' },
                markResponseSupplied,
                markDelivered,
                markAbandoned,
            };
        });

        await client.connect();
        pushJsonLine(first.stdout, {
            id: 91,
            method: 'item/fileChange/requestApproval',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        await client.disconnect();
        await client.connect();
        provideManagedResponse();
        await waitFor(() => markAbandoned.mock.calls.length === 1);

        expect(markDelivered).not.toHaveBeenCalled();
        expect(markResponseSupplied).not.toHaveBeenCalled();
        expect(secondRequests.some((message) => message.id === 91)).toBe(false);
        expect(firstRequests.some((message) => message.id === 91 && message.result)).toBe(false);
        await client.disconnect();
    });

    it('ignores duplicate provider request ids within one transport generation', async () => {
        const proc = createMockProcess();
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const handler = vi.fn(async () => ({
            response: { decision: 'decline' },
            markResponseSupplied: vi.fn(async () => {}),
            markDelivered: vi.fn(async () => {}),
            markAbandoned: vi.fn(async () => {}),
        }));
        client.setServerRequestHandler(handler);
        await client.connect();
        const request = {
            id: 92,
            method: 'item/fileChange/requestApproval',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
        };

        pushJsonLine(proc.stdout, request);
        pushJsonLine(proc.stdout, request);
        await waitFor(() => handler.mock.calls.length === 1);
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(handler).toHaveBeenCalledOnce();
        await client.disconnect();
    });

    it('never evicts an active provider request while compacting settled ids', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let releaseResponse!: () => void;
        const responseGate = new Promise<void>((resolve) => {
            releaseResponse = resolve;
        });
        const handler = vi.fn(async () => {
            await responseGate;
            return {
                response: { decision: 'decline' },
                markResponseSupplied: vi.fn(async () => {}),
                markDelivered: vi.fn(async () => {}),
                markAbandoned: vi.fn(async () => {}),
            };
        });
        client.setServerRequestHandler(handler);
        const internals = client as unknown as {
            handleLine(line: string, sourceEpoch?: number): void;
            settleServerRequestId(requestId: number, sourceEpoch: number): void;
            activeServerRequestIds: Set<number>;
            settledServerRequestIds: Set<number>;
        };
        const request = {
            id: 0,
            method: 'item/fileChange/requestApproval',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
        };

        internals.handleLine(JSON.stringify(request), 0);
        await waitFor(() => handler.mock.calls.length === 1);
        for (let requestId = 1; requestId <= 5_000; requestId += 1) {
            internals.settleServerRequestId(requestId, 0);
        }

        expect(internals.activeServerRequestIds.has(0)).toBe(true);
        expect(internals.settledServerRequestIds.size).toBeLessThanOrEqual(4_096);
        internals.handleLine(JSON.stringify(request), 0);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(handler).toHaveBeenCalledOnce();

        releaseResponse();
        await waitFor(() => !internals.activeServerRequestIds.has(0));
    });

    it('returns a payload-free internal error when a managed request handler fails', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({ onRequest: (message) => requests.push(message) });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setServerRequestHandler(async () => {
            throw new Error('sensitive local failure details');
        });
        await client.connect();

        pushJsonLine(proc.stdout, {
            id: 93,
            method: 'item/fileChange/requestApproval',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
        });

        await waitFor(() => requests.some((message) => message.id === 93));
        expect(requests.filter((message) => message.id === 93)).toEqual([{
            id: 93,
            error: { code: -32000, message: 'Server request handler failed' },
        }]);
        expect(JSON.stringify(requests.find((message) => message.id === 93))).not.toContain('sensitive');
        await client.disconnect();
    });

    it('returns method-not-found for an unknown provider request', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({ onRequest: (message) => requests.push(message) });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        pushJsonLine(proc.stdout, {
            id: 94,
            method: 'future/request',
            params: { privatePayload: 'not echoed' },
        });

        await waitFor(() => requests.some((message) => message.id === 94));
        expect(requests.filter((message) => message.id === 94)).toEqual([{
            id: 94,
            error: { code: -32601, message: 'Method not found' },
        }]);
        await client.disconnect();
    });

    it('rejects malformed provider messages without throwing or leaking payloads', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({ onRequest: (message) => requests.push(message) });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        const internals = client as unknown as {
            handleLine(line: string, sourceEpoch?: number): void;
        };

        expect(() => internals.handleLine('null')).not.toThrow();
        expect(() => internals.handleLine('[]')).not.toThrow();
        expect(() => internals.handleLine(JSON.stringify({
            method: { secret: 'notification-prompt-secret' },
        }))).not.toThrow();
        expect(() => internals.handleLine(JSON.stringify({
            id: 196,
            method: { secret: 'request-prompt-secret' },
        }))).not.toThrow();

        await waitFor(() => requests.some((message) => message.id === 196));
        expect(requests.filter((message) => message.id === 196)).toEqual([{
            id: 196,
            error: { code: -32600, message: 'Invalid request' },
        }]);
        const logs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
        expect(logs).not.toContain('notification-prompt-secret');
        expect(logs).not.toContain('request-prompt-secret');
        await client.disconnect();
    });

    it('writes only one overload response for a duplicated provider request', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({ onRequest: (message) => requests.push(message) });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        const internals = client as unknown as {
            handleLine(line: string, sourceEpoch?: number): void;
            activeServerRequestIds: Set<number>;
        };
        for (let requestId = 0; requestId < 4_096; requestId += 1) {
            internals.activeServerRequestIds.add(requestId);
        }
        const overloaded = JSON.stringify({
            id: 5_000,
            method: 'future/request',
            params: {},
        });

        internals.handleLine(overloaded);
        internals.handleLine(overloaded);

        await waitFor(() => requests.some((message) => message.id === 5_000));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(requests.filter((message) => message.id === 5_000)).toEqual([{
            id: 5_000,
            error: { code: -32000, message: 'Too many pending server requests' },
        }]);
        await client.disconnect();
    });

    it('does not send a second response when supplied-state persistence fails', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({ onRequest: (message) => requests.push(message) });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const markAbandoned = vi.fn(async () => {});
        client.setServerRequestHandler(async () => ({
            response: { decision: 'accept' },
            markResponseSupplied: vi.fn(async () => {
                throw new Error('simulated fsync failure');
            }),
            markDelivered: vi.fn(async () => {}),
            markAbandoned,
        }));
        await client.connect();

        pushJsonLine(proc.stdout, {
            id: 95,
            method: 'item/fileChange/requestApproval',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
        });

        await waitFor(() => markAbandoned.mock.calls.length === 1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(requests.filter((message) => message.id === 95)).toEqual([{
            id: 95,
            result: { decision: 'accept' },
        }]);
        await client.disconnect();
    });

    it('uses stable-v2 RPCs for compact, review, skills, and paginated MCP status', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.id == null) return;
                if (msg.method === 'thread/compact/start') {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-1',
                                turnId: 'compact-turn-1',
                                item: { type: 'contextCompaction', id: 'compact-item-1' },
                                startedAtMs: 100,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-1',
                                turnId: 'compact-turn-1',
                                item: { type: 'contextCompaction', id: 'compact-item-1' },
                                completedAtMs: 200,
                            },
                        });
                    }, 0);
                } else if (msg.method === 'review/start') {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            reviewThreadId: 'thread-1',
                            turn: {
                                id: 'review-turn-1',
                                items: [],
                                itemsView: 'full',
                                status: 'inProgress',
                                error: null,
                                startedAt: 100,
                                completedAt: null,
                                durationMs: null,
                            },
                        },
                    }), 0);
                } else if (msg.method === 'skills/list') {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: { data: [{ name: 'test-skill' }] } }), 0);
                } else if (msg.method === 'mcpServerStatus/list') {
                    const cursor = msg.params?.cursor ?? null;
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            data: [{ name: cursor ? 'second' : 'first' }],
                            nextCursor: cursor ? null : 'page-2',
                        },
                    }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        await client.compactThread('thread-1');
        const review = await client.startReview({
            threadId: 'thread-1',
            target: { type: 'uncommittedChanges' },
            delivery: 'inline',
        });
        const skills = await client.listSkills({ cwds: ['/workspace'], forceReload: true });
        const mcp = await client.listMcpServerStatus({ threadId: 'thread-1', pageSize: 1 });

        expect(review).toMatchObject({ reviewThreadId: 'thread-1', turn: { id: 'review-turn-1' } });
        expect(skills.data).toEqual([{ name: 'test-skill' }]);
        expect(mcp).toEqual([{ name: 'first' }, { name: 'second' }]);
        expect(requests.filter((message) => message.method === 'thread/compact/start')).toMatchObject([
            { params: { threadId: 'thread-1' } },
        ]);
        expect(requests.filter((message) => message.method === 'mcpServerStatus/list').map((message) => message.params.cursor))
            .toEqual([null, 'page-2']);
        await client.disconnect();
    });

    it('waits for the matching contextCompaction item after compact RPC acknowledgement', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/compact/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const stableNotifications: string[] = [];
        client.setStableNotificationHandler((notification) => {
            stableNotifications.push(`${notification.method}:${(notification.params as any)?.item?.id ?? ''}`);
        });
        await client.connect();

        let settled = false;
        const compact = client.compactThread('thread-compact').then((result) => {
            settled = true;
            return result;
        });
        await waitFor(() => requests.some((message) => message.method === 'thread/compact/start'));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);

        pushJsonLine(proc.stdout, {
            method: 'item/started',
            params: {
                threadId: 'thread-compact',
                turnId: 'compact-turn',
                item: { type: 'contextCompaction', id: 'compact-item' },
                startedAtMs: 100,
            },
        });
        pushJsonLine(proc.stdout, {
            method: 'item/completed',
            params: {
                threadId: 'thread-compact',
                turnId: 'compact-turn',
                item: { type: 'contextCompaction', id: 'other-item' },
                completedAtMs: 150,
            },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);

        pushJsonLine(proc.stdout, {
            method: 'item/completed',
            params: {
                threadId: 'thread-compact',
                turnId: 'compact-turn',
                item: { type: 'contextCompaction', id: 'compact-item' },
                completedAtMs: 200,
            },
        });

        await expect(compact).resolves.toEqual({});
        expect(stableNotifications.at(-1)).toBe('item/completed:compact-item');
        await client.disconnect();
    });

    it('marks an acknowledged compact result unknown when transport closes before item completion', async () => {
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/compact/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient, CodexRpcOutcomeUnknownError } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        const compact = client.compactThread('thread-compact');
        await new Promise<void>((resolve) => setImmediate(resolve));
        proc.stdout.push(null);

        await expect(compact).rejects.toBeInstanceOf(CodexRpcOutcomeUnknownError);
    });

    it('bounds legacy helper state and redacts hostile protocol labels from ordinary logs', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const internals = client as unknown as {
            handleLine(line: string, sourceEpoch?: number): void;
            emitRawTurnCompletion(
                threadId: string | null,
                turnId: string | null,
                status: string | null,
                error: unknown,
            ): void;
            trackRawFileChangeMetadata(method: string, params: unknown): void;
            handleRawNotification(method: string, params: unknown): boolean;
            settleServerRequestId(requestId: number, sourceEpoch: number): void;
            activeServerRequestIds: Set<number>;
            settledServerRequestIds: Set<number>;
            completedTurnIds: Set<string>;
            rawFileChangesByItemId: Map<string, unknown>;
            rawSubagentActivitySignaturesByItemId: Map<string, Set<string>>;
        };

        internals.handleLine(JSON.stringify({
            id: 0,
            method: 'private/request-prompt-secret',
            params: {},
        }));
        await waitFor(() => internals.activeServerRequestIds.size === 0);
        for (let index = 0; index < 4_097; index += 1) {
            internals.settleServerRequestId(2 + index * 2, 0);
        }
        internals.handleLine(JSON.stringify({
            'private-object-key-prompt-secret': true,
        }));
        internals.handleLine(JSON.stringify({
            method: 'private/notification-prompt-secret',
            params: {},
        }));
        expect(internals.settledServerRequestIds.size).toBeLessThanOrEqual(4_096);

        for (let index = 0; index < 50_001; index += 1) {
            internals.emitRawTurnCompletion('thread', `turn-${index}`, 'completed', null);
        }
        expect(internals.completedTurnIds.size).toBe(50_000);

        for (let index = 0; index < 4_097; index += 1) {
            internals.trackRawFileChangeMetadata('item/started', {
                threadId: 'thread',
                item: {
                    type: 'fileChange',
                    id: `file-${index}`,
                    changes: [{ path: `file-${index}`, kind: { type: 'update' } }],
                },
            });
            internals.handleRawNotification('item/started', {
                threadId: 'thread',
                item: {
                    type: 'subAgentActivity',
                    id: `activity-${index}`,
                    kind: 'started',
                    agentThreadId: `child-${index}`,
                },
            });
        }
        expect(internals.rawFileChangesByItemId.size).toBe(4_096);
        expect(internals.rawSubagentActivitySignaturesByItemId.size).toBe(4_096);

        internals.handleRawNotification('item/completed', {
            threadId: 'thread',
            item: {
                type: 'subAgentActivity',
                id: 'activity-4096',
                kind: 'completed',
                agentThreadId: 'child-4096',
            },
        });
        expect(internals.rawSubagentActivitySignaturesByItemId.get('thread:activity-4096')?.size)
            .toBeLessThanOrEqual(16);

        const logs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
        expect(logs).not.toContain('private/request-prompt-secret');
        expect(logs).not.toContain('private-object-key-prompt-secret');
        expect(logs).not.toContain('private/notification-prompt-secret');
        expect(logs).toMatch(/unknown:[0-9a-f]{24}/);
    });
});
