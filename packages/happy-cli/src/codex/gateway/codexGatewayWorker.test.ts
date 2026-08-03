import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexGatewayProxyHooks } from './codexGatewayProxy';
import type { Thread } from '../protocol';

const mocks = vi.hoisted(() => ({
    controlHandlers: null as import('./codexGatewayControl').CodexGatewayControlHandlers | null,
    proxyHooks: null as CodexGatewayProxyHooks | null,
    startThread: vi.fn(async () => ({ threadId: 'thread-app', model: 'gpt-test' })),
    relayAvailable: false,
    credentialsAvailable: true,
    connectAttempts: 0,
    connectFailuresRemaining: 0,
    connectFailureCode: 'ECONNRESET',
    subscribeFailureCode: null as string | null,
    unmaterializedThreads: new Set<string>(),
    materializeOnSubscriptionCall: null as number | null,
    materializedSubscriptionCalls: [] as string[],
    completeSnapshotCalls: [] as string[],
    subscriptionHang: false,
    rejectHungSubscription: null as ((error: Error) => void) | null,
    snapshotHang: false,
    rejectHungSnapshot: null as ((error: Error) => void) | null,
    disconnectCalls: 0,
    providerStopDelayMs: 0,
    providerStartError: null as Error | null,
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
            if (mocks.providerStartError) throw mocks.providerStartError;
            this.currentEpoch += 1;
            this.pid = 123;
            this.options.hooks?.stateChanged?.('starting');
            await this.options.hooks?.ready?.({ epoch: this.currentEpoch, recovered: false });
            this.options.hooks?.stateChanged?.('running');
        }
        async stop() {
            if (mocks.providerStopDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, mocks.providerStopDelayMs));
            }
            this.pid = null;
            this.options.hooks?.stateChanged?.('stopped');
        }
    },
}));
vi.mock('./codexGatewayProxy', () => ({
    CodexGatewayProxy: class {
        private readonly hooks: CodexGatewayProxyHooks;

        constructor(_listen: unknown, _upstream: unknown, hooks: CodexGatewayProxyHooks) {
            this.hooks = hooks;
        }
        async start() { mocks.proxyHooks = this.hooks; }
        async close() {
            if (mocks.proxyHooks === this.hooks) mocks.proxyHooks = null;
        }
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
                    code: mocks.connectFailureCode,
                });
            }
            this.connected = true;
            this.connectionHandler?.({ connection: 'connected', statusUnknown: false, error: null });
        }
        async disconnect() {
            this.connected = false;
            mocks.disconnectCalls += 1;
            mocks.rejectHungSubscription?.(Object.assign(
                new Error('observer transport closed during subscription'),
                { code: 'ECONNRESET' },
            ));
            mocks.rejectHungSubscription = null;
            mocks.rejectHungSnapshot?.(Object.assign(
                new Error('observer transport closed during snapshot'),
                { code: 'ECONNRESET' },
            ));
            mocks.rejectHungSnapshot = null;
        }
        async reconnectExternalTransportPreservingThreads() {}
        setStableNotificationHandler() {}
        setServerRequestHandler() {}
        setConnectionHandler(handler: ((event: unknown) => void) | null) { this.connectionHandler = handler; }
        async subscribeThread(threadId: string) {
            if (mocks.subscribeFailureCode) {
                throw Object.assign(new Error('provider payload must stay private'), {
                    code: mocks.subscribeFailureCode,
                });
            }
            return { threadId, model: 'gpt-test', thread: thread(threadId) };
        }
        async subscribeThreadIfMaterialized(threadId: string) {
            mocks.materializedSubscriptionCalls.push(threadId);
            if (mocks.subscriptionHang) {
                return await new Promise<never>((_resolve, reject) => {
                    mocks.rejectHungSubscription = reject;
                });
            }
            if (
                mocks.materializeOnSubscriptionCall !== null
                && mocks.materializedSubscriptionCalls.length >= mocks.materializeOnSubscriptionCall
            ) {
                mocks.unmaterializedThreads.delete(threadId);
            }
            if (mocks.unmaterializedThreads.has(threadId)) return null;
            return await this.subscribeThread(threadId);
        }
        async readThread(options: { threadId: string }) {
            if (mocks.subscribeFailureCode) {
                throw Object.assign(new Error('provider payload must stay private'), {
                    code: mocks.subscribeFailureCode,
                });
            }
            return { thread: thread(options.threadId) };
        }
        async readThreadComplete(options: { threadId: string }) {
            mocks.completeSnapshotCalls.push(options.threadId);
            if (mocks.snapshotHang) {
                return await new Promise<never>((_resolve, reject) => {
                    mocks.rejectHungSnapshot = reject;
                });
            }
            return { thread: thread(options.threadId) };
        }
        adoptThreadSnapshot() {}
        async startThread() { return await mocks.startThread(); }
    },
}));

import {
    CodexGatewaySocketPathTooLongError,
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
    mocks.connectFailureCode = 'ECONNRESET';
    mocks.subscribeFailureCode = null;
    mocks.unmaterializedThreads.clear();
    mocks.materializeOnSubscriptionCall = null;
    mocks.materializedSubscriptionCalls.length = 0;
    mocks.completeSnapshotCalls.length = 0;
    mocks.subscriptionHang = false;
    mocks.rejectHungSubscription = null;
    mocks.snapshotHang = false;
    mocks.rejectHungSnapshot = null;
    mocks.disconnectCalls = 0;
    mocks.providerStopDelayMs = 0;
    mocks.providerStartError = null;
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

    it('persists an explicit diagnostic when the provider socket path is too long', async () => {
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
        mocks.providerStartError = new CodexGatewaySocketPathTooLongError();

        await expect(runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
        })).rejects.toThrow(CodexGatewaySocketPathTooLongError);

        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toMatchObject({
            state: 'stopped',
            lastError: 'startup:provider:socketPathTooLong',
        });
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

    it('atomically persists the startup stage before exposing a stopped descriptor', async () => {
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
        mocks.connectFailuresRemaining = 1;
        mocks.connectFailureCode = 'EACCES';
        mocks.providerStopDelayMs = 200;

        const outcome = runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
        }).then(() => null, (error: unknown) => error);
        await vi.waitFor(async () => expect(
            (await readCodexGatewayDescriptor(created.paths.descriptorPath))?.state,
        ).toBe('stopped'));

        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toMatchObject({
            lastError: 'startup:bridge:unknown',
        });
        await expect(outcome).resolves.toBeInstanceOf(Error);
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

    it('retries a terminal-started subscription after the root RPC is bound', async () => {
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
        mocks.unmaterializedThreads.add('thread-a');

        const worker = runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
            heartbeatMs: 60_000,
        });
        await vi.waitFor(() => expect(mocks.proxyHooks).not.toBeNull());
        await mocks.proxyHooks!.rootBound?.({
            connectionId: 'connection-a',
            requestId: 1,
            method: 'thread/start',
            requestedThreadId: null,
            threadId: 'thread-a',
        });

        await vi.waitFor(() => expect(mocks.materializedSubscriptionCalls).toEqual(['thread-a']));

        mocks.unmaterializedThreads.delete('thread-a');
        mocks.subscribeFailureCode = 'ECONNRESET';
        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toMatchObject({
            lastError: null,
        });
        await vi.waitFor(async () => expect(
            (await readCodexGatewayDescriptor(created.paths.descriptorPath))?.lastError,
        ).toBe('observerRetry:network'));
        expect(mocks.completeSnapshotCalls).toContain('thread-a');

        mocks.subscribeFailureCode = null;
        await vi.waitFor(async () => expect(
            await readCodexGatewayDescriptor(created.paths.descriptorPath),
        ).toMatchObject({
            current: expect.objectContaining({ threadId: 'thread-a' }),
            lastError: null,
        }));
        expect(mocks.materializedSubscriptionCalls.length).toBeGreaterThanOrEqual(3);

        const callsAfterSubscription = mocks.materializedSubscriptionCalls.length;
        await mocks.proxyHooks!.threadMaterialized?.('thread-a');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(mocks.materializedSubscriptionCalls).toHaveLength(callsAfterSubscription);

        await mocks.controlHandlers!.stop({ force: true });
        await worker;
    }, 5_000);

    it('uses the successful terminal root snapshot while observer retries stay non-fatal', async () => {
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
        mocks.subscribeFailureCode = 'ECONNRESET';

        const worker = runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
            heartbeatMs: 60_000,
        });
        await vi.waitFor(() => expect(mocks.proxyHooks).not.toBeNull());

        await expect(mocks.proxyHooks!.rootBound?.({
            connectionId: 'connection-a',
            requestId: 1,
            method: 'thread/start',
            requestedThreadId: null,
            threadId: 'thread-a',
            providerSnapshot: thread('thread-a'),
        })).resolves.toBeUndefined();
        await vi.waitFor(async () => expect(
            await readCodexGatewayDescriptor(created.paths.descriptorPath),
        ).toMatchObject({
            current: expect.objectContaining({ threadId: 'thread-a' }),
            lastError: 'observerRetry:network',
        }));

        mocks.subscribeFailureCode = null;
        await vi.waitFor(async () => expect(
            (await readCodexGatewayDescriptor(created.paths.descriptorPath))?.lastError,
        ).toBeNull());

        await mocks.controlHandlers!.stop({ force: true });
        await worker;
    }, 5_000);

    it('starts terminal root reconciliation even when no provider activity can be parsed', async () => {
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
        mocks.unmaterializedThreads.add('thread-a');
        mocks.materializeOnSubscriptionCall = 2;

        const worker = runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
            heartbeatMs: 60_000,
        });
        await vi.waitFor(() => expect(mocks.proxyHooks).not.toBeNull());

        await mocks.proxyHooks!.rootBound?.({
            connectionId: 'connection-a',
            requestId: 1,
            method: 'thread/start',
            requestedThreadId: null,
            threadId: 'thread-a',
        });
        await vi.waitFor(() => expect(
            mocks.materializedSubscriptionCalls,
        ).toHaveLength(2));
        expect(mocks.completeSnapshotCalls).toContain('thread-a');

        const callsAfterSubscription = mocks.materializedSubscriptionCalls.length;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(mocks.materializedSubscriptionCalls).toHaveLength(callsAfterSubscription);

        await mocks.controlHandlers!.stop({ force: true });
        await worker;
    }, 5_000);

    it('continues terminal root reconciliation beyond the former bounded retry budget', async () => {
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
        mocks.unmaterializedThreads.add('thread-a');
        mocks.materializeOnSubscriptionCall = 7;

        const worker = runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
            heartbeatMs: 60_000,
        });
        await vi.waitFor(() => expect(mocks.proxyHooks).not.toBeNull());
        await mocks.proxyHooks!.rootBound?.({
            connectionId: 'connection-a',
            requestId: 1,
            method: 'thread/start',
            requestedThreadId: null,
            threadId: 'thread-a',
        });
        await vi.waitFor(() => expect(
            mocks.materializedSubscriptionCalls,
        ).toHaveLength(7), { timeout: 6_000 });

        const callsAfterSubscription = mocks.materializedSubscriptionCalls.length;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(mocks.materializedSubscriptionCalls).toHaveLength(callsAfterSubscription);

        await mocks.controlHandlers!.stop({ force: true });
        await worker;
    }, 8_000);

    it('cancels a hung pending subscription before taking the coordinator stop lock', async () => {
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
        mocks.subscriptionHang = true;

        const worker = runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
            heartbeatMs: 60_000,
        });
        await vi.waitFor(() => expect(mocks.proxyHooks).not.toBeNull());
        await mocks.proxyHooks!.rootBound?.({
            connectionId: 'connection-a',
            requestId: 1,
            method: 'thread/start',
            requestedThreadId: null,
            threadId: 'thread-a',
        });
        await vi.waitFor(() => expect(mocks.materializedSubscriptionCalls).toEqual(['thread-a']));

        await mocks.controlHandlers!.stop({ force: true });
        await expect(worker).resolves.toBeUndefined();
        expect(mocks.disconnectCalls).toBeGreaterThanOrEqual(1);
    }, 5_000);

    it('does not persist an observer snapshot cancellation as a root binding failure', async () => {
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
        mocks.unmaterializedThreads.add('thread-a');
        mocks.snapshotHang = true;

        const worker = runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
            heartbeatMs: 60_000,
        });
        await vi.waitFor(() => expect(mocks.proxyHooks).not.toBeNull());
        await mocks.proxyHooks!.rootBound?.({
            connectionId: 'connection-a',
            requestId: 1,
            method: 'thread/start',
            requestedThreadId: null,
            threadId: 'thread-a',
        });
        await vi.waitFor(() => expect(mocks.completeSnapshotCalls).toEqual(['thread-a']));

        await mocks.controlHandlers!.stop({ force: true });
        await worker;
        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toMatchObject({
            state: 'stopped',
            lastError: null,
        });
    }, 5_000);

    it('persists a payload-free root binding stage before closing the TUI transport', async () => {
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
        mocks.subscribeFailureCode = 'ECONNRESET';

        const worker = runCodexGatewayWorker({
            gatewayId: created.descriptor.gatewayId,
            happyHomeDir,
            runtimeRoot,
            heartbeatMs: 10,
        });
        await vi.waitFor(() => expect(mocks.proxyHooks).not.toBeNull());

        await expect(mocks.proxyHooks!.rootBound?.({
            connectionId: 'connection-a',
            requestId: 1,
            method: 'thread/start',
            requestedThreadId: null,
            threadId: 'thread-a',
        })).rejects.toThrow('providerSnapshot');
        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toMatchObject({
            state: 'running',
            lastError: 'rootBinding:providerSnapshot:network',
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toMatchObject({
            lastError: 'rootBinding:providerSnapshot:network',
        });

        mocks.subscribeFailureCode = null;
        await mocks.proxyHooks!.rootBound?.({
            connectionId: 'connection-b',
            requestId: 2,
            method: 'thread/start',
            requestedThreadId: null,
            threadId: 'thread-b',
        });
        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toMatchObject({
            current: expect.objectContaining({ threadId: 'thread-b' }),
            lastError: null,
        });

        await mocks.controlHandlers!.stop({ force: true });
        await worker;
    });

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

function thread(id: string): Thread {
    return {
        id,
        parentThreadId: null,
        status: { type: 'idle' },
        turns: [],
        cwd: '/workspace/project',
    } as unknown as Thread;
}
