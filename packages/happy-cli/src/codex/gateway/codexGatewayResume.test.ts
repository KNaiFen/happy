import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    unarchiveSession: vi.fn(),
    inspect: vi.fn(),
    reconcile: vi.fn(),
    launchHeadless: vi.fn(),
    launchTui: vi.fn(),
    attach: vi.fn(),
    auth: vi.fn(),
    ensureDaemon: vi.fn(),
}));

vi.mock('@/api/api', () => ({
    ApiClient: { create: vi.fn(async () => ({ unarchiveSession: mocks.unarchiveSession })) },
}));
vi.mock('@/daemon/ensureDaemonRunning', () => ({
    ensureDaemonRunning: mocks.ensureDaemon,
}));
vi.mock('@/ui/auth', () => ({
    authAndSetupMachineIfNeeded: mocks.auth,
}));
vi.mock('../codexCliVersion', () => ({ assertMinimumCodexCliVersion: vi.fn() }));
vi.mock('./codexGatewayLauncher', () => ({
    attachVerifiedCodexGateway: mocks.attach,
    inspectVerifiedGatewayForSession: mocks.inspect,
    launchCodexGatewayHeadless: mocks.launchHeadless,
    launchCodexGatewayResumeTui: mocks.launchTui,
    reconcileVerifiedGatewayPresence: mocks.reconcile,
}));

import {
    resumeCodexGatewayHeadless,
    resumeCodexGatewayTui,
} from './codexGatewayResume';

const bootstrap = {
    happySessionId: 'session-a',
    dataEncryptionKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
    threadId: 'thread-a',
    cwd: '/workspace/project',
    model: 'gpt-5.6-sol',
    permissionMode: 'read-only' as const,
    effortLevel: 'max',
};

const descriptor = {
    gatewayId: '17a0f951-4db5-44fd-b797-bc48cd4e7195',
    pid: 1234,
    current: {
        threadId: 'thread-a',
        sessionId: 'session-a',
        generation: 3,
    },
};
const secret = { gatewayId: descriptor.gatewayId };

describe('Codex Gateway unified resume', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.unarchiveSession.mockResolvedValue(true);
        mocks.reconcile.mockResolvedValue(undefined);
        mocks.auth.mockResolvedValue({ credentials: { token: 'token' }, machineId: 'machine-a' });
        mocks.ensureDaemon.mockResolvedValue(undefined);
        mocks.attach.mockResolvedValue(0);
        mocks.launchTui.mockResolvedValue(0);
        mocks.launchHeadless.mockResolvedValue({
            gatewayId: descriptor.gatewayId,
            threadId: 'thread-a',
            sessionId: 'session-a',
            generation: 1,
            pid: 1234,
            descriptor,
        });
    });

    it('unarchives and reconciles a verified live Gateway before reporting success', async () => {
        mocks.inspect.mockResolvedValue({
            state: 'live',
            gateway: { descriptor, secret },
        });

        await expect(resumeCodexGatewayHeadless({
            api: { unarchiveSession: mocks.unarchiveSession } as any,
            bootstrap,
            env: {},
        })).resolves.toMatchObject({ sessionId: 'session-a', generation: 3 });

        expect(mocks.unarchiveSession).toHaveBeenCalledWith('session-a');
        expect(mocks.reconcile).toHaveBeenCalledWith({
            gateway: { descriptor, secret },
            sessionId: 'session-a',
        });
        expect(mocks.launchHeadless).not.toHaveBeenCalled();
    });

    it('does not report a live resume when Presence reconciliation fails', async () => {
        mocks.inspect.mockResolvedValue({
            state: 'live',
            gateway: { descriptor, secret },
        });
        mocks.reconcile.mockRejectedValue(new Error('reconcile failed'));

        await expect(resumeCodexGatewayHeadless({
            api: { unarchiveSession: mocks.unarchiveSession } as any,
            bootstrap,
            env: {},
        })).rejects.toThrow('reconcile failed');
        expect(mocks.launchHeadless).not.toHaveBeenCalled();
    });

    it('launches a missing Gateway with resume material only in the private bootstrap', async () => {
        mocks.inspect.mockResolvedValue({ state: 'missing', gateway: null });

        await resumeCodexGatewayHeadless({
            api: { unarchiveSession: mocks.unarchiveSession } as any,
            bootstrap,
            env: { PATH: '/bin' },
            operationId: 'd94231c7-6601-483f-a8f3-92912d759423',
        });

        expect(mocks.launchHeadless).toHaveBeenCalledWith({
            operationId: 'd94231c7-6601-483f-a8f3-92912d759423',
            cwd: '/workspace/project',
            env: { PATH: '/bin' },
            action: 'resume',
            resumeBootstrap: bootstrap,
        });
    });

    it('blocks a second writer while a verified Gateway is recovering', async () => {
        mocks.inspect.mockResolvedValue({
            state: 'recovering',
            gateway: { descriptor, secret },
        });
        await expect(resumeCodexGatewayHeadless({
            api: { unarchiveSession: mocks.unarchiveSession } as any,
            bootstrap,
            env: {},
        })).rejects.toThrow('still recovering');
        expect(mocks.launchHeadless).not.toHaveBeenCalled();
    });

    it('uses the official terminal resume path when no verified Gateway exists', async () => {
        mocks.inspect.mockResolvedValue({ state: 'missing', gateway: null });
        await expect(resumeCodexGatewayTui(bootstrap)).resolves.toBe(0);
        expect(mocks.ensureDaemon).toHaveBeenCalledOnce();
        expect(mocks.launchTui).toHaveBeenCalledWith(bootstrap);
        expect(mocks.attach).not.toHaveBeenCalled();
    });

    it('reconciles a live Gateway before attaching the official terminal resume', async () => {
        mocks.inspect.mockResolvedValue({
            state: 'live',
            gateway: { descriptor, secret },
        });

        await expect(resumeCodexGatewayTui(bootstrap)).resolves.toBe(0);

        expect(mocks.reconcile).toHaveBeenCalledWith({
            gateway: { descriptor, secret },
            sessionId: 'session-a',
        });
        expect(mocks.attach).toHaveBeenCalledWith({
            descriptor,
            secret,
            threadId: 'thread-a',
        });
        expect(mocks.launchTui).not.toHaveBeenCalled();
    });

    it('does not attach the terminal when live Presence reconciliation fails', async () => {
        mocks.inspect.mockResolvedValue({
            state: 'live',
            gateway: { descriptor, secret },
        });
        mocks.reconcile.mockRejectedValue(new Error('reconcile failed'));

        await expect(resumeCodexGatewayTui(bootstrap)).rejects.toThrow('reconcile failed');
        expect(mocks.attach).not.toHaveBeenCalled();
        expect(mocks.launchTui).not.toHaveBeenCalled();
    });
});
