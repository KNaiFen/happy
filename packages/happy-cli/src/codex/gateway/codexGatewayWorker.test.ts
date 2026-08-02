import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexGatewayProxyHooks } from './codexGatewayProxy';

const mocks = vi.hoisted(() => ({
    controlHandlers: null as import('./codexGatewayControl').CodexGatewayControlHandlers | null,
    proxyHooks: null as CodexGatewayProxyHooks | null,
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
vi.mock('@/daemon/run', () => ({ initialMachineMetadata: { host: 'test' } }));
vi.mock('@/persistence', () => ({
    readCredentials: vi.fn(async () => ({
        token: 'token',
        encryption: { type: 'dataKey', publicKey: new Uint8Array(32) },
    })),
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
        async tryCreate() { return null; }
    },
}));
vi.mock('./codexGatewayProvider', () => ({
    CodexGatewayProvider: class {
        constructor(private readonly options: { hooks?: {
            stateChanged?(state: string): void;
            ready?(event: { epoch: number; recovered: boolean }): Promise<void>;
        } }) {}
        async start() {
            this.options.hooks?.stateChanged?.('starting');
            await this.options.hooks?.ready?.({ epoch: 1, recovered: false });
            this.options.hooks?.stateChanged?.('running');
        }
        async stop() { this.options.hooks?.stateChanged?.('stopped'); }
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
        async connect() { this.connectionHandler?.({ connection: 'connected', statusUnknown: false, error: null }); }
        async disconnect() {}
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
    },
}));

import { createCodexGatewayFiles, readCodexGatewayDescriptor } from './codexGatewayState';
import { createCodexGatewayAttachmentCredentials } from './codexGatewayAttachment';
import { runCodexGatewayWorker } from './codexGatewayWorker';

const roots: string[] = [];

afterEach(async () => {
    mocks.controlHandlers = null;
    mocks.proxyHooks = null;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex Gateway worker composition', () => {
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
