import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    descriptors: [] as any[],
    secret: {
        gatewayId: '17a0f951-4db5-44fd-b797-bc48cd4e7195',
        controlToken: 'control-token-that-is-at-least-thirty-two-bytes',
        sessionKeySeed: 'session-key-seed-that-is-at-least-thirty-two-bytes',
        providerToken: null,
        version: 1,
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
vi.mock('./codexGatewayState', () => ({
    codexGatewayPaths: (gatewayId: string) => ({
        descriptorPath: `/state/${gatewayId}/descriptor.json`,
        secretPath: `/state/${gatewayId}/secret.json`,
    }),
    createCodexGatewayFiles: mocks.createFiles,
    listCodexGatewayDescriptors: vi.fn(async () => [...mocks.descriptors]),
    readCodexGatewayDescriptor: vi.fn(async () => mocks.descriptors[0] ?? null),
    readCodexGatewaySecret: vi.fn(async () => mocks.secret),
}));

import {
    ensureCodexGatewayRunning,
    launchCodexGatewayHeadless,
    waitForGatewayReady,
} from './codexGatewayLauncher';

describe('Codex Gateway App bootstrap launcher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.descriptors = [];
        mocks.createFiles.mockImplementation(async (options: { cwd: string; bootstrapOperationId: string }) => {
            const descriptor = {
                version: 1,
                gatewayId: mocks.secret.gatewayId,
                pid: 1234,
                processStartedAt: 1,
                createdAt: 1,
                heartbeatAt: 1,
                cwd: options.cwd,
                origin: 'app',
                bootstrapOperationId: options.bootstrapOperationId,
                state: 'starting',
                terminalState: 'headless',
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
            };
            mocks.descriptors = [descriptor];
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

    it('restarts a stale descriptor with the same gateway identity', async () => {
        const descriptor = {
            gatewayId: mocks.secret.gatewayId,
            cwd: '/workspace/project',
            state: 'recovering',
            controlSocketPath: '/tmp/control.sock',
            controlPort: null,
        } as any;
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
        const descriptor = {
            gatewayId: mocks.secret.gatewayId,
            cwd: '/workspace/project',
            state: 'stopped',
            lastError: 'startup:authentication:unknown',
            controlSocketPath: '/tmp/control.sock',
            controlPort: null,
        } as any;
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
