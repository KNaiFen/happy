import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    workerIdentity: vi.fn(() => 'expected'),
    happyHomeDir: '',
}));

vi.mock('@/daemon/ensureDaemonRunning', () => ({ ensureDaemonRunning: vi.fn() }));
vi.mock('@/daemon/sessionEnvironment', () => ({
    sanitizeSessionEnvironment: (env: NodeJS.ProcessEnv) => env,
}));
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: vi.fn() }));
vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: mocks.spawnHappyCLI }));
vi.mock('../codexCliVersion', () => ({ assertMinimumCodexCliVersion: vi.fn() }));
vi.mock('./codexGatewayControl', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./codexGatewayControl')>()),
    callCodexGatewayControl: mocks.callControl,
}));
vi.mock('./codexGatewayProcessIdentity', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./codexGatewayProcessIdentity')>()),
    inspectCodexGatewayWorkerProcess: mocks.workerIdentity,
}));
vi.mock('./codexGatewayState', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./codexGatewayState')>();
    return {
        ...actual,
        codexGatewayStateRoot: () => `${mocks.happyHomeDir}/codex-gateways`,
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
import { CodexGatewayControlRequestError } from './codexGatewayControl';

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
        mocks.happyHomeDir = mkdtempSync(join(tmpdir(), 'happy-gateway-launcher-'));
        mocks.descriptors = [];
        mocks.secret.resumeBootstrap = null;
        mocks.workerIdentity.mockReturnValue('expected');
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
                const result = {
                    gatewayId: mocks.secret.gatewayId,
                    threadId: 'thread-a',
                    sessionId: 'session-a',
                    generation: 1,
                };
                mocks.descriptors = [{
                    ...mocks.descriptors[0],
                    state: 'running',
                    current: {
                        threadId: result.threadId,
                        sessionId: result.sessionId,
                        generation: result.generation,
                        role: 'current',
                        title: null,
                        changedAt: 2,
                    },
                }];
                return result;
            }
            if (options.path === '/root/cancel') return { cancelled: true };
            if (options.path === '/stop') return { stopping: true };
            throw new Error(`Unexpected control path ${options.path}`);
        });
    });

    afterEach(() => {
        rmSync(mocks.happyHomeDir, { recursive: true, force: true });
    });

    it('reuses the same worker and provider operation after a lost App response', async () => {
        const options = {
            operationId: 'd94231c7-6601-483f-a8f3-92912d759423',
            cwd: '/workspace/project',
            env: {},
            action: 'start' as const,
        };

        await expect(launchCodexGatewayHeadless({
            ...options,
            operationId: options.operationId.toUpperCase(),
        })).resolves.toMatchObject({
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
        expect(opens).toHaveLength(1);
        expect(opens.map((request) => request.body.operationId)).toEqual([
            options.operationId,
        ]);
    });

    it('serializes concurrent spawn retries before checking or creating a Gateway', async () => {
        const options = {
            operationId: 'd94231c7-6601-483f-a8f3-92912d759423',
            cwd: '/workspace/project',
            env: {},
            action: 'start' as const,
        };

        const [first, second] = await Promise.all([
            launchCodexGatewayHeadless(options),
            launchCodexGatewayHeadless(options),
        ]);

        expect(first.sessionId).toBe('session-a');
        expect(second.sessionId).toBe(first.sessionId);
        expect(mocks.createFiles).toHaveBeenCalledOnce();
        expect(mocks.spawnHappyCLI).toHaveBeenCalledOnce();
        expect(mocks.callControl.mock.calls
            .map(([request]) => request)
            .filter((request) => request.path === '/root/open')).toHaveLength(1);
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

    it('leaves an indeterminate new root running for an idempotent retry', async () => {
        let statusAttempts = 0;
        mocks.callControl.mockImplementation(async (options: { path: string }) => {
            if (options.path === '/status') {
                statusAttempts += 1;
                return {
                    ...mocks.descriptors[0],
                    state: 'running',
                    pid: 1234,
                    current: statusAttempts >= 3 ? mocks.descriptors[0]?.current ?? null : null,
                };
            }
            if (options.path === '/root/open') {
                mocks.descriptors = [{
                    ...mocks.descriptors[0],
                    state: 'running',
                    current: {
                        threadId: 'thread-a',
                        sessionId: 'session-a',
                        generation: 1,
                        role: 'current',
                        title: null,
                        changedAt: 2,
                    },
                }];
                throw new CodexGatewayControlRequestError('outcomeUnknown', 0);
            }
            throw new Error(`Unexpected control path ${options.path}`);
        });

        const options = {
            operationId: 'd94231c7-6601-483f-a8f3-92912d759423',
            cwd: '/workspace/project',
            env: {},
            action: 'start' as const,
        };
        await expect(launchCodexGatewayHeadless(options)).rejects.toMatchObject({
            code: 'outcomeUnknown',
        });
        await expect(launchCodexGatewayHeadless(options)).resolves.toMatchObject({
            gatewayId: mocks.secret.gatewayId,
            sessionId: 'session-a',
        });

        expect(mocks.callControl.mock.calls.map(([request]) => request.path)).toEqual([
            '/status',
            '/root/open',
            '/status',
            '/status',
        ]);
        expect(mocks.createFiles).toHaveBeenCalledOnce();
        expect(mocks.spawnHappyCLI).toHaveBeenCalledOnce();
    });

    it('reconciles a lost private resume response from the durable Gateway binding', async () => {
        const resumeBootstrap = {
            happySessionId: 'session-private',
            dataEncryptionKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
            threadId: 'thread-private',
            cwd: '/workspace/project',
            model: null,
            permissionMode: 'default' as const,
            effortLevel: null,
        };
        mocks.callControl.mockImplementation(async (options: { path: string }) => {
            if (options.path === '/status') {
                return {
                    ...mocks.descriptors[0],
                    state: 'running',
                    current: {
                        threadId: 'thread-private',
                        sessionId: 'session-private',
                        generation: 4,
                        role: 'current',
                        title: null,
                        changedAt: 2,
                    },
                };
            }
            if (options.path === '/root/open') {
                throw new CodexGatewayControlRequestError('outcomeUnknown', 0);
            }
            throw new Error(`Unexpected control path ${options.path}`);
        });

        await expect(launchCodexGatewayHeadless({
            operationId: 'd94231c7-6601-483f-a8f3-92912d759423',
            cwd: '/workspace/project',
            env: {},
            action: 'resume',
            resumeBootstrap,
        })).resolves.toMatchObject({
            sessionId: 'session-private',
            threadId: 'thread-private',
            generation: 4,
        });
        expect(mocks.callControl.mock.calls.map(([request]) => request.path)).toEqual([
            '/status',
            '/root/open',
            '/status',
        ]);
    });

    it('keeps a lost private resume outcome unknown when the status snapshot cannot be verified', async () => {
        const resumeBootstrap = {
            happySessionId: 'session-private',
            dataEncryptionKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
            threadId: 'thread-private',
            cwd: '/workspace/project',
            model: null,
            permissionMode: 'default' as const,
            effortLevel: null,
        };
        mocks.callControl.mockImplementation(async (options: { path: string }) => {
            if (options.path === '/status') {
                if (mocks.callControl.mock.calls.filter(([request]) => request.path === '/status').length === 1) {
                    return { ...mocks.descriptors[0], state: 'running', pid: 1234 };
                }
                throw new CodexGatewayControlRequestError('outcomeUnknown', 0);
            }
            if (options.path === '/root/open') {
                mocks.descriptors = [{
                    ...mocks.descriptors[0],
                    current: {
                        threadId: 'thread-private',
                        sessionId: 'session-private',
                        generation: 4,
                        role: 'current',
                        title: null,
                        changedAt: 2,
                    },
                }];
                throw new CodexGatewayControlRequestError('outcomeUnknown', 0);
            }
            throw new Error(`Unexpected control path ${options.path}`);
        });

        await expect(launchCodexGatewayHeadless({
            operationId: 'd94231c7-6601-483f-a8f3-92912d759423',
            cwd: '/workspace/project',
            env: {},
            action: 'resume',
            resumeBootstrap,
        })).rejects.toMatchObject({ code: 'outcomeUnknown' });
        expect(mocks.callControl.mock.calls.map(([request]) => request.path)).toEqual([
            '/status',
            '/root/open',
            '/status',
        ]);
    });

    it('cancels and stops only a newly-created Gateway after an explicit root-open failure', async () => {
        mocks.callControl.mockImplementation(async (options: { path: string }) => {
            if (options.path === '/status') {
                return { ...mocks.descriptors[0], state: 'running', pid: 1234 };
            }
            if (options.path === '/root/open') {
                throw new CodexGatewayControlRequestError('threadUnavailable', 404);
            }
            if (options.path === '/root/cancel') return { cancelled: true };
            if (options.path === '/stop') return { stopping: true };
            throw new Error(`Unexpected control path ${options.path}`);
        });

        await expect(launchCodexGatewayHeadless({
            operationId: 'd94231c7-6601-483f-a8f3-92912d759423',
            cwd: '/workspace/project',
            env: {},
            action: 'start',
        })).rejects.toMatchObject({ code: 'threadUnavailable', status: 404 });
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
