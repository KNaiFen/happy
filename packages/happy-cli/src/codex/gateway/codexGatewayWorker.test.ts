import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexGatewayProxyHooks } from './codexGatewayProxy';

const mocks = vi.hoisted(() => ({
    controlHandlers: null as import('./codexGatewayControl').CodexGatewayControlHandlers | null,
    proxyHooks: null as CodexGatewayProxyHooks | null,
    startThread: vi.fn(async () => ({ threadId: 'thread-app', model: 'gpt-test' })),
    relayAvailable: false,
    credentialsAvailable: true,
    connectAttempts: 0,
    connectFailuresRemaining: 0,
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({
            getOrCreateMachine: vi.fn(async () => null),
            getOrCreateSession: vi.fn(async () => null),
            unarchiveSession: vi.fn(async () => false),
            sessionSyncClient: vi.fn(),
            archiveSessionV4: vi.fn(async () => true),
        })),
    },
}));
vi.mock('@/daemon/initialMachineMetadata', () => ({ initialMachineMetadata: { host: 'test' } }));
vi.mock('@/persistence', () => ({
    readCredentials: vi.fn(async () => mocks.credentialsAvailable ? ({
        token: 'token',
        encryption: { type: 'dataKey', publicKey: new Uint8Array(32) },
    }) : null),
    readSettings: vi.fn(async () => ({ machineId: 'machine-a' })),
}));
vi.mock('@/ui/auth', () => ({
    scopeCredentialsToCurrentRelay: vi.fn(async (credentials) => credentials),
}));
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('@/configuration', () => ({
    configuration: {
        happyHomeDir: '/unused',
        serverUrl: 'https://relay.test',
        currentCliVersion: 'test',
    },
}));
vi.mock('../codexCliVersion', () => ({
    readCodexCliVersion: vi.fn(() => ({ major: 0, minor: 145, patch: 0 })),
    assertMinimumCodexCliVersion: vi.fn((version) => version),
}));
vi.mock('../codexModelCapabilities', () => ({
    loadCodexModelCapabilities: vi.fn(async () => []),
}));
vi.mock('../codexSkills', () => ({ discoverCodexSkillCommands: vi.fn(async () => []) }));
vi.mock('./codexGatewayRuntimeFactory', () => ({
    CodexGatewayRuntimeFactory: class {
        async tryCreate(options: { threadId: string }) {
            if (!mocks.relayAvailable) return null;
            return {
                sessionId: `session-${options.threadId}`,
                handleNotification: async () => undefined,
                handleRequest: async () => null,
                setConnection: () => undefined,
                activate: async () => undefined,
                reconcile: async () => undefined,
                updateBinding: async () => undefined,
                setGatewayLifecycle: async () => undefined,
                setTerminalState: async () => undefined,
                ownsThread: (threadId: string) => threadId === options.threadId,
                isDrained: async () => true,
                flush: async () => undefined,
                close: async () => undefined,
            };
        }
    },
}));
vi.mock('./codexGatewayProvider', () => ({
    CodexGatewayProvider: class {
        currentEpoch = 0;
        pid: number | null = null;

        constructor(private readonly options: { hooks?: {
            stateChanged?(state: string): void;
            ready?(event: { epoch: number; recovered: boolean }): Promise<void>;
        } }) {}
        async start() {
            this.currentEpoch += 1;
            this.pid = 123;
            this.options.hooks?.stateChanged?.('starting');
            await this.options.hooks?.ready?.({ epoch: this.currentEpoch, recovered: false });
            this.options.hooks?.stateChanged?.('running');
        }
        async stop() {
            this.pid = null;
            this.options.hooks?.stateChanged?.('stopped');
        }
    },
}));
vi.mock('./codexGatewayProxy', () => ({
    CodexGatewayProxy: class {
        constructor(_listen: unknown, _upstream: unknown, hooks: CodexGatewayProxyHooks) {
            mocks.proxyHooks = hooks;
        }
        async start() {}
        async close() {}
    },
}));
vi.mock('./codexGatewayControl', () => ({
    startCodexGatewayControlServer: vi.fn(async (options: {
        handlers: import('./codexGatewayControl').CodexGatewayControlHandlers;
        socketPath?: string;
    }) => {
        mocks.controlHandlers = options.handlers;
        return {
            socketPath: options.socketPath ?? null,
            port: null,
            close: async () => undefined,
        };
    }),
}));
vi.mock('../codexAppServerClient', () => ({
    CodexAppServerClient: class {
        private connectionHandler: ((event: unknown) => void) | null = null;
        private connected = false;
        async connect() {
            if (this.connected) return;
            mocks.connectAttempts += 1;
            if (mocks.connectFailuresRemaining > 0) {
                mocks.connectFailuresRemaining -= 1;
                throw Object.assign(new Error('transient provider connection failure'), {
                    code: 'ECONNRESET',
                });
            }
            this.connected = true;
            this.connectionHandler?.({ connection: 'connected', statusUnknown: false, error: null });
        }
        async disconnect() { this.connected = false; }
        async reconnectExternalTransportPreservingThreads() {}
        setStableNotificationHandler() {}
        setServerRequestHandler() {}
        setConnectionHandler(handler: ((event: unknown) => void) | null) { this.connectionHandler = handler; }
        async subscribeThread(threadId: string) {
            return { threadId, model: 'gpt-test', thread: thread(threadId) };
        }
        async readThreadComplete(options: { threadId: string }) {
            return { thread: thread(options.threadId) };
        }
        async startThread() { return await mocks.startThread(); }
    },
}));

import {
    createCodexGatewayFiles,
    readCodexGatewayDescriptor,
    writeCodexGatewayDescriptor,
} from './codexGatewayState';
import { createCodexGatewayAttachmentCredentials } from './codexGatewayAttachment';
import { CodexGatewayJournal } from './codexGatewayJournal';
import { runCodexGatewayWorker } from './codexGatewayWorker';

const roots: string[] = [];

afterEach(async () => {
    mocks.controlHandlers = null;
    mocks.proxyHooks = null;
    mocks.startThread.mockClear();
    mocks.relayAvailable = false;
    mocks.credentialsAvailable = true;
    mocks.connectAttempts = 0;
    mocks.connectFailuresRemaining = 0;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex Gateway worker composition', () => {
    it('persists a payload-free stage when startup fails before the control server', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-worker-'));
        roots.push(root);
        const happyHomeDir = join(root, 'happy');
        const runtimeRoot = join(root, 'runtime');
        const created = await createCodexGatewayFiles({
            cwd: '/workspace/project',
            origin: 'terminal',
            happyHomeDir,
            runtimeRoot,
        });
        mocks.credentialsAvailable = false;

        await expect(runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
        })).rejects.toThrow('Happy authentication is required');

        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toMatchObject({
            state: 'stopped',
            lastError: 'startup:authentication:unknown',
        });
        expect(mocks.controlHandlers).toBeNull();

        const reopenedJournal = await CodexGatewayJournal.open({
            path: created.paths.journalPath,
        });
        await reopenedJournal.close();
    });

    it('retries a transient initial provider bridge failure in the same worker', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-worker-'));
        roots.push(root);
        const happyHomeDir = join(root, 'happy');
        const runtimeRoot = join(root, 'runtime');
        const created = await createCodexGatewayFiles({
            cwd: '/workspace/project',
            origin: 'app',
            happyHomeDir,
            runtimeRoot,
        });
        mocks.connectFailuresRemaining = 1;

        const worker = runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
            heartbeatMs: 60_000,
        });
        await vi.waitFor(async () => expect(
            (await readCodexGatewayDescriptor(created.paths.descriptorPath))?.state,
        ).toBe('running'));

        expect(mocks.connectAttempts).toBe(2);
        await mocks.controlHandlers!.stop({ force: true });
        await worker;
    });

    it('persists an offline root and exits only after the matching terminal confirms normal exit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-worker-'));
        roots.push(root);
        const happyHomeDir = join(root, 'happy');
        const runtimeRoot = join(root, 'runtime');
        const created = await createCodexGatewayFiles({
            cwd: '/workspace/project',
            origin: 'terminal',
            happyHomeDir,
            runtimeRoot,
        });

        const worker = runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
            heartbeatMs: 60_000,
        });
        await vi.waitFor(() => expect(mocks.controlHandlers).not.toBeNull());
        await vi.waitFor(() => expect(mocks.proxyHooks).not.toBeNull());
        await vi.waitFor(async () => expect(
            (await readCodexGatewayDescriptor(created.paths.descriptorPath))?.state,
        ).toBe('running'));

        const attachment = createCodexGatewayAttachmentCredentials();
        expect(mocks.controlHandlers!.terminalAttached(attachment)).toEqual({ accepted: true });
        expect(mocks.proxyHooks!.claimTerminal?.('connection-a', attachment.connectionToken)).toBe(true);
        await mocks.proxyHooks!.rootBound?.({
            connectionId: 'connection-a',
            requestId: 1,
            method: 'thread/start',
            requestedThreadId: null,
            threadId: 'thread-a',
        });
        await vi.waitFor(async () => expect(
            (await readCodexGatewayDescriptor(created.paths.descriptorPath))?.current,
        ).toMatchObject({
            threadId: 'thread-a',
            sessionId: null,
            generation: 1,
            role: 'current',
        }));

        await mocks.proxyHooks!.terminalDisconnected?.('connection-a');
        await vi.waitFor(async () => expect(
            (await readCodexGatewayDescriptor(created.paths.descriptorPath))?.terminalState,
        ).toBe('pendingDetach'));
        mocks.relayAvailable = true;
        expect(await mocks.controlHandlers!.normalExit({
            attachmentId: attachment.attachmentId,
            nonce: attachment.normalExitNonce,
        })).toEqual({ accepted: true, action: 'stop' });

        await worker;
        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toMatchObject({
            state: 'stopped',
            current: null,
        });
    }, 5_000);

    it('does not repeat an App thread/start after provider acceptance while relay materialization is pending', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-worker-'));
        roots.push(root);
        const happyHomeDir = join(root, 'happy');
        const runtimeRoot = join(root, 'runtime');
        const created = await createCodexGatewayFiles({
            cwd: '/workspace/project',
            origin: 'app',
            happyHomeDir,
            runtimeRoot,
        });

        const worker = runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
            heartbeatMs: 60_000,
        });
        await vi.waitFor(() => expect(mocks.controlHandlers).not.toBeNull());
        await vi.waitFor(async () => expect(
            (await readCodexGatewayDescriptor(created.paths.descriptorPath))?.state,
        ).toBe('running'));
        const input = {
            operationId: '706be38c-ece9-42eb-a562-abf685a26d8c',
            action: 'start' as const,
            threadId: null,
            cwd: '/workspace/project',
            model: null,
            permissionMode: 'default' as const,
            effortLevel: 'max',
            parentSessionId: null,
            forkedFromMessageId: null,
            isSideChat: false,
            happySessionId: null,
            dataEncryptionKey: null,
        };

        await expect(mocks.controlHandlers!.openRoot(input))
            .rejects.toThrow('relay is unavailable');
        await expect(mocks.controlHandlers!.openRoot(input))
            .rejects.toThrow('relay is unavailable');
        expect(mocks.startThread).toHaveBeenCalledOnce();
        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toMatchObject({
            current: {
                threadId: 'thread-app',
                sessionId: null,
                generation: 1,
            },
        });

        await mocks.controlHandlers!.stop({ force: true });
        await worker;
    }, 5_000);

    it('keeps a normal stop recoverable until the relay session can be archived', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-worker-'));
        roots.push(root);
        const happyHomeDir = join(root, 'happy');
        const runtimeRoot = join(root, 'runtime');
        const created = await createCodexGatewayFiles({
            cwd: '/workspace/project',
            origin: 'app',
            happyHomeDir,
            runtimeRoot,
        });

        const worker = runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
            heartbeatMs: 60_000,
        });
        let settled = false;
        void worker.finally(() => { settled = true; });
        await vi.waitFor(() => expect(mocks.controlHandlers).not.toBeNull());
        await vi.waitFor(async () => expect(
            (await readCodexGatewayDescriptor(created.paths.descriptorPath))?.state,
        ).toBe('running'));
        const input = {
            operationId: '4c0c281e-627a-4cd8-b41f-88a3207331b7',
            action: 'start' as const,
            threadId: null,
            cwd: '/workspace/project',
            model: null,
            permissionMode: 'default' as const,
            effortLevel: 'max',
            parentSessionId: null,
            forkedFromMessageId: null,
            isSideChat: false,
            happySessionId: null,
            dataEncryptionKey: null,
        };
        await expect(mocks.controlHandlers!.openRoot(input)).rejects.toThrow('relay is unavailable');

        await mocks.controlHandlers!.stop({ force: false });
        await vi.waitFor(async () => expect(
            (await readCodexGatewayDescriptor(created.paths.descriptorPath))?.state,
        ).toBe('stopping'));
        expect(settled).toBe(false);

        mocks.relayAvailable = true;
        await mocks.controlHandlers!.stop({ force: false });
        await worker;
        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toMatchObject({
            state: 'stopped',
            current: null,
        });
    }, 5_000);

    it('continues a durable graceful stop after the worker itself restarts', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-worker-'));
        roots.push(root);
        const happyHomeDir = join(root, 'happy');
        const runtimeRoot = join(root, 'runtime');
        const created = await createCodexGatewayFiles({
            cwd: '/workspace/project',
            origin: 'app',
            happyHomeDir,
            runtimeRoot,
        });
        await writeCodexGatewayDescriptor(created.paths, {
            ...created.descriptor,
            state: 'stopping',
        });
        mocks.relayAvailable = true;

        await runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
            heartbeatMs: 60_000,
        });

        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toMatchObject({
            state: 'stopped',
        });
    }, 5_000);
});

function thread(id: string) {
    return {
        id,
        parentThreadId: null,
        status: { type: 'idle' },
        turns: [],
        cwd: '/workspace/project',
    };
}
