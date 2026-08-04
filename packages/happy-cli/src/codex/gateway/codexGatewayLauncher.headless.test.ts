import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    descriptors: [] as any[],
    secret: {
        gatewayId: '17a0f951-4db5-44fd-b797-bc48cd4e7195',
        controlToken: 'control-token-that-is-at-least-thirty-two-bytes',
        sessionKeySeed: 'session-key-seed-that-is-at-least-thirty-two-bytes',
        providerToken: null,
        resumeBootstrap: null as any,
        version: 1 as const,
    },
    createFiles: vi.fn(),
    spawnHappyCLI: vi.fn(() => ({ pid: 1234, unref: vi.fn() })),
    callControl: vi.fn(),
}));

vi.mock('@/daemon/ensureDaemonRunning', () => ({ ensureDaemonRunning: vi.fn() }));
vi.mock('@/daemon/sessionEnvironment', () => ({
    sanitizeSessionEnvironment: (env: NodeJS.ProcessEnv) => env,
}));
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: vi.fn() }));
vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: mocks.spawnHappyCLI }));
vi.mock('../codexCliVersion', () => ({ assertMinimumCodexCliVersion: vi.fn() }));
vi.mock('./codexGatewayControl', () => ({ callCodexGatewayControl: mocks.callControl }));
vi.mock('./codexGatewayState', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./codexGatewayState')>();
    return {
        ...actual,
        codexGatewayPaths: (gatewayId: string) => ({
            descriptorPath: `/state/${gatewayId}/descriptor.json`,
            secretPath: `/state/${gatewayId}/secret.json`,
        }),
        createCodexGatewayFiles: mocks.createFiles,
        listCodexGatewayDescriptors: vi.fn(async () => [...mocks.descriptors]),
        readCodexGatewayDescriptor: vi.fn(async () => mocks.descriptors[0] ?? null),
        readCodexGatewaySecret: vi.fn(async () => mocks.secret),
    };
});

import {
    ensureCodexGatewayRunning,
    launchCodexGatewayHeadless,
    waitForGatewayReady,
} from './codexGatewayLauncher';

function descriptorFixture(overrides: Record<string, unknown> = {}) {
    return {
        version: 1 as const,
        gatewayId: mocks.secret.gatewayId,
        pid: 1234,
        providerPid: null,
        processStartedAt: 1,
        createdAt: 1,
        heartbeatAt: 1,
        cwd: '/workspace/project',
        origin: 'app' as const,
        bootstrapOperationId: null,
        state: 'starting' as const,
        terminalState: 'headless' as const,
        terminalDetachedAt: null,
        providerSocketPath: '/tmp/provider.sock',
        tuiSocketPath: '/tmp/tui.sock',
        providerPort: null,
        tuiPort: null,
        controlSocketPath: '/tmp/control.sock',
        controlPort: null,
        current: null,
        draining: [],
        lastError: null,
        lifecycle: {
            controlledStartedAt: 1,
            normalExitedAt: null,
            signalStoppedAt: null,
            providerExitedAt: null,
            controlChannelErrorAt: null,
            lastHeartbeatAt: 1,
        },
        ...overrides,
    };
}

describe('Codex Gateway App bootstrap launcher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.descriptors = [];
        mocks.secret.resumeBootstrap = null;
        mocks.createFiles.mockImplementation(async (options: {
            cwd: string;
            bootstrapOperationId: string;
            resumeBootstrap?: any;
        }) => {
            const descriptor = descriptorFixture({
                cwd: options.cwd,
                bootstrapOperationId: options.bootstrapOperationId,
            });
            mocks.descriptors = [descriptor];
            mocks.secret.resumeBootstrap = options.resumeBootstrap ?? null;
            return {
                descriptor,
                secret: mocks.secret,
                paths: { descriptorPath: '/state/descriptor.json' },
            };
        });
        mocks.callControl.mockImplementation(async (options: { path: string; body?: any }) => {
            if (options.path === '/status') {
                return { ...mocks.descriptors[0], state: 'running', pid: 1234 };
            }
            if (options.path === '/root/open') {
                return {
                    gatewayId: mocks.secret.gatewayId,
                    threadId: 'thread-a',
                    sessionId: 'session-a',
                    generation: 1,
                };
            }
            if (options.path === '/root/cancel') return { cancelled: true };
            if (options.path === '/stop') return { stopping: true };
            throw new Error(`Unexpected control path ${options.path}`);
        });
    });

    it('reuses the same worker and provider operation after a lost App response', async () => {
        const options = {
            operationId: 'd94231c7-6601-483f-a8f3-92912d759423',
            cwd: '/workspace/project',
            env: {},
            action: 'start' as const,
        };

        await expect(launchCodexGatewayHeadless(options)).resolves.toMatchObject({
            gatewayId: mocks.secret.gatewayId,
            sessionId: 'session-a',
        });
        await expect(launchCodexGatewayHeadless(options)).resolves.toMatchObject({
            gatewayId: mocks.secret.gatewayId,
            sessionId: 'session-a',
        });

        expect(mocks.createFiles).toHaveBeenCalledOnce();
        expect(mocks.spawnHappyCLI).toHaveBeenCalledOnce();
        const opens = mocks.callControl.mock.calls
            .map(([request]) => request)
            .filter((request) => request.path === '/root/open');
        expect(opens).toHaveLength(2);
        expect(opens.map((request) => request.body.operationId)).toEqual([
            options.operationId,
            options.operationId,
        ]);
    });

    it('rejects parameter drift for a reused App operation before provider work', async () => {
        mocks.descriptors = [{
            gatewayId: mocks.secret.gatewayId,
            origin: 'app',
            bootstrapOperationId: 'd94231c7-6601-483f-a8f3-92912d759423',
            cwd: '/workspace/original',
            state: 'running',
        }];

        await expect(launchCodexGatewayHeadless({
            operationId: 'd94231c7-6601-483f-a8f3-92912d759423',
            cwd: '/workspace/changed',
            env: {},
            action: 'start',
        })).rejects.toThrow('changed its working directory');
        expect(mocks.spawnHappyCLI).not.toHaveBeenCalled();
        expect(mocks.callControl).not.toHaveBeenCalled();
    });

    it('keeps an existing-session resume bootstrap out of the control request', async () => {
        const resumeBootstrap = {
            happySessionId: 'session-private',
            dataEncryptionKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
            threadId: 'thread-private',
            cwd: '/workspace/project',
            model: 'gpt-5.6-sol',
            permissionMode: 'read-only' as const,
            effortLevel: 'max',
        };

        await launchCodexGatewayHeadless({
            operationId: 'd94231c7-6601-483f-a8f3-92912d759423',
            cwd: '/workspace/project',
            env: {},
            action: 'resume',
            resumeBootstrap,
        });

        expect(mocks.createFiles).toHaveBeenCalledWith(expect.objectContaining({
            resumeBootstrap,
        }));
        const request = mocks.callControl.mock.calls
            .map(([value]) => value)
            .find((value) => value.path === '/root/open');
        expect(request.body).toEqual({
            operationId: 'd94231c7-6601-483f-a8f3-92912d759423',
            action: 'resume',
            threadId: null,
            cwd: null,
            model: null,
            permissionMode: 'default',
            effortLevel: null,
            parentSessionId: null,
            forkedFromMessageId: null,
            isSideChat: false,
        });
        expect(JSON.stringify(request.body)).not.toContain('session-private');
        expect(JSON.stringify(request.body)).not.toContain('thread-private');
        expect(JSON.stringify(request.body)).not.toContain(resumeBootstrap.dataEncryptionKey);
    });

    it('cancels an uncertain root open before stopping the Gateway', async () => {
        mocks.callControl.mockImplementation(async (options: { path: string }) => {
            if (options.path === '/status') {
                return { ...mocks.descriptors[0], state: 'running', pid: 1234 };
            }
            if (options.path === '/root/open') throw new Error('Gateway control request timed out');
            if (options.path === '/root/cancel') return { cancelled: true };
            if (options.path === '/stop') return { stopping: true };
            throw new Error(`Unexpected control path ${options.path}`);
        });

        await expect(launchCodexGatewayHeadless({
            operationId: 'd94231c7-6601-483f-a8f3-92912d759423',
            cwd: '/workspace/project',
            env: {},
            action: 'start',
        })).rejects.toThrow('timed out');

        expect(mocks.callControl.mock.calls.map(([request]) => request.path)).toEqual([
            '/status',
            '/root/open',
            '/root/cancel',
            '/stop',
        ]);
    });

    it('restarts a stale descriptor with the same gateway identity', async () => {
        const descriptor = descriptorFixture({
            cwd: '/workspace/project',
            state: 'recovering',
        });
        mocks.descriptors = [descriptor];
        mocks.callControl
            .mockRejectedValueOnce(new Error('stale control socket'))
            .mockResolvedValueOnce({ ...descriptor, state: 'running', pid: 4321 });

        await expect(ensureCodexGatewayRunning({
            descriptor,
            secret: mocks.secret as any,
            env: {},
        })).resolves.toMatchObject({
            gatewayId: mocks.secret.gatewayId,
            state: 'running',
            pid: 4321,
        });
        expect(mocks.spawnHappyCLI).toHaveBeenCalledOnce();
        expect(mocks.spawnHappyCLI).toHaveBeenCalledWith(
            ['__codex-gateway-worker', mocks.secret.gatewayId],
            expect.objectContaining({ cwd: '/workspace/project', detached: true }),
        );
    });

    it('surfaces a persisted startup failure without calling a dead control endpoint', async () => {
        const descriptor = descriptorFixture({
            cwd: '/workspace/project',
            state: 'stopped',
            lastError: 'startup:authentication:unknown',
        });
        mocks.descriptors = [descriptor];

        await expect(waitForGatewayReady(
            descriptor,
            mocks.secret as any,
            { timeoutMs: 20, pollMs: 1 },
        )).rejects.toThrow(
            'Codex Gateway stopped during startup (startup:authentication:unknown)',
        );
        expect(mocks.callControl).not.toHaveBeenCalled();
    });
});
