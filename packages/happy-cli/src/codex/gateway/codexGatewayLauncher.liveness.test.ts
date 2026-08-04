import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    descriptors: [] as any[],
    secret: null as any,
    status: null as any,
    workerIdentity: 'expected' as 'expected' | 'unexpected' | 'absent' | 'unverified',
    providerIdentity: 'expected' as 'expected' | 'unexpected' | 'absent' | 'unverified',
    callControl: vi.fn(),
}));

vi.mock('@/daemon/ensureDaemonRunning', () => ({ ensureDaemonRunning: vi.fn() }));
vi.mock('@/daemon/sessionEnvironment', () => ({
    sanitizeSessionEnvironment: (env: NodeJS.ProcessEnv) => env,
}));
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: vi.fn() }));
vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: vi.fn() }));
vi.mock('../codexCliVersion', () => ({ assertMinimumCodexCliVersion: vi.fn() }));
vi.mock('./codexGatewayControl', () => ({ callCodexGatewayControl: mocks.callControl }));
vi.mock('./codexGatewayProcessIdentity', () => ({
    inspectCodexGatewayWorkerProcess: vi.fn(() => mocks.workerIdentity),
    inspectCodexGatewayProviderProcess: vi.fn(() => mocks.providerIdentity),
}));
vi.mock('./codexGatewayState', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./codexGatewayState')>();
    return {
        ...actual,
        listCodexGatewayDescriptors: vi.fn(async () => mocks.descriptors),
        readCodexGatewayDescriptor: vi.fn(async () => mocks.descriptors[0] ?? null),
        readCodexGatewaySecret: vi.fn(async () => mocks.secret),
    };
});

import { inspectVerifiedGatewayForSession } from './codexGatewayLauncher';

const gatewayId = '17a0f951-4db5-44fd-b797-bc48cd4e7195';

function descriptor(state: 'running' | 'recovering' = 'running') {
    return {
        version: 1,
        gatewayId,
        pid: 4321,
        providerPid: 5432,
        processStartedAt: 10,
        createdAt: 5,
        heartbeatAt: 20,
        cwd: '/workspace/project',
        origin: 'app' as const,
        bootstrapOperationId: 'd94231c7-6601-483f-a8f3-92912d759423',
        state,
        terminalState: 'headless' as const,
        terminalDetachedAt: null,
        providerSocketPath: '/tmp/provider.sock',
        tuiSocketPath: '/tmp/tui.sock',
        providerPort: null,
        tuiPort: null,
        controlSocketPath: '/tmp/control.sock',
        controlPort: null,
        current: {
            threadId: 'thread-a',
            sessionId: 'session-a',
            generation: 3,
            role: 'current' as const,
            title: null,
            changedAt: 15,
        },
        draining: [],
        lastError: null,
        lifecycle: {
            controlledStartedAt: 10,
            normalExitedAt: null,
            signalStoppedAt: null,
            providerExitedAt: null,
            controlChannelErrorAt: null,
            lastHeartbeatAt: 20,
        },
    };
}

describe('verified Codex Gateway liveness', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.descriptors = [descriptor()];
        mocks.secret = {
            version: 1,
            gatewayId,
            controlToken: 'control-token-that-is-at-least-thirty-two-bytes',
            sessionKeySeed: 'session-key-seed-that-is-at-least-thirty-two-bytes',
            providerToken: null,
            resumeBootstrap: null,
        };
        mocks.status = descriptor();
        mocks.workerIdentity = 'expected';
        mocks.providerIdentity = 'expected';
        mocks.callControl.mockImplementation(async () => mocks.status);
    });

    it('requires status, identities, and the exact session/thread binding', async () => {
        await expect(inspectVerifiedGatewayForSession({
            sessionId: 'session-a',
            threadId: 'thread-a',
        })).resolves.toMatchObject({
            state: 'live',
            gateway: { descriptor: { gatewayId } },
        });
    });

    it('does not treat a reused PID with unrelated worker argv as live', async () => {
        mocks.workerIdentity = 'unexpected';
        await expect(inspectVerifiedGatewayForSession({
            sessionId: 'session-a',
            threadId: 'thread-a',
        })).resolves.toEqual({ state: 'missing', gateway: null });
    });

    it('classifies a verified transitional Gateway as recovering', async () => {
        mocks.descriptors = [descriptor('recovering')];
        mocks.status = descriptor('recovering');
        await expect(inspectVerifiedGatewayForSession({
            sessionId: 'session-a',
            threadId: 'thread-a',
        })).resolves.toMatchObject({ state: 'recovering' });
    });

    it('treats a matching Gateway with unavailable control as recovering', async () => {
        mocks.callControl.mockRejectedValue(new Error('control unavailable'));
        await expect(inspectVerifiedGatewayForSession({
            sessionId: 'session-a',
            threadId: 'thread-a',
        })).resolves.toMatchObject({ state: 'recovering' });
    });

    it('treats an unverifiable matching worker as recovering', async () => {
        mocks.workerIdentity = 'unverified';
        await expect(inspectVerifiedGatewayForSession({
            sessionId: 'session-a',
            threadId: 'thread-a',
        })).resolves.toMatchObject({ state: 'recovering' });
    });

    it('blocks a second writer when control identity does not match a verified disk binding', async () => {
        mocks.status = {
            ...descriptor(),
            gatewayId: '70f76a5f-6e58-44e0-b2a9-27cbe9b53a40',
        };
        await expect(inspectVerifiedGatewayForSession({
            sessionId: 'session-a',
            threadId: 'thread-a',
        })).resolves.toMatchObject({ state: 'recovering' });
    });
});
