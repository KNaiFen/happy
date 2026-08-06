import { describe, expect, it, vi } from 'vitest';

import {
    CodexThreadOpenCoordinator,
    resolveCodexBoundThreadLaunchDecision,
} from './codexThreadOpenCoordinator';
import {
    CodexThreadUnavailableError,
    type CodexThreadHistorySummary,
} from './codexThreadHistory';
import { CodexRpcOutcomeUnknownError } from './codexAppServerClient';

function summary(status: CodexThreadHistorySummary['status'] = 'idle'): CodexThreadHistorySummary {
    return {
        threadId: 'thread-1',
        title: 'Thread',
        preview: 'Prompt',
        cwd: '/tmp/project',
        createdAt: 1,
        updatedAt: 2,
        recencyAt: 2,
        source: 'cli',
        status,
    };
}

describe('CodexThreadOpenCoordinator', () => {
    it('coalesces concurrent opens for the same provider thread', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const inspect = vi.fn(async () => {
            await gate;
            return summary();
        });
        const createExternal = vi.fn().mockResolvedValue({
            type: 'success',
            disposition: 'created',
            sessionId: 'happy-1',
        });
        const coordinator = new CodexThreadOpenCoordinator({
            inspect,
            openExisting: vi.fn(),
            createExternal,
        });
        const request = {
            directory: '/tmp/project',
            threadId: 'thread-1',
            externalDataEncryptionKey: 'key',
            defaults: {
                permissionMode: 'yolo',
                modelMode: 'gpt-5.5',
                effortLevel: 'medium',
            },
        };

        const first = coordinator.open(request);
        const second = coordinator.open(request);
        release();

        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ sessionId: 'happy-1' }),
            expect.objectContaining({ sessionId: 'happy-1' }),
        ]);
        expect(inspect).toHaveBeenCalledOnce();
        expect(createExternal).toHaveBeenCalledOnce();
    });

    it('blocks an active external thread but allows an existing Happy binding', async () => {
        const openExisting = vi.fn().mockResolvedValue({
            type: 'success',
            disposition: 'existing-active',
            sessionId: 'happy-1',
        });
        const coordinator = new CodexThreadOpenCoordinator({
            inspect: vi.fn().mockResolvedValue(summary('active')),
            openExisting,
            createExternal: vi.fn(),
        });

        await expect(coordinator.open({
            directory: '/tmp/project',
            threadId: 'thread-1',
            externalDataEncryptionKey: 'key',
        })).resolves.toMatchObject({ type: 'blocked', reason: 'externalThreadActive' });

        await expect(coordinator.open({
            directory: '/tmp/project',
            threadId: 'thread-1',
            binding: { sessionId: 'happy-1' },
        })).resolves.toMatchObject({ type: 'success', disposition: 'existing-active' });
        expect(openExisting).toHaveBeenCalledOnce();
    });

    it('requires an independent key before creating an external Happy session', async () => {
        const createExternal = vi.fn();
        const coordinator = new CodexThreadOpenCoordinator({
            inspect: vi.fn().mockResolvedValue(summary()),
            openExisting: vi.fn(),
            createExternal,
        });

        await expect(coordinator.open({
            directory: '/tmp/project',
            threadId: 'thread-1',
        })).resolves.toMatchObject({ type: 'error' });
        expect(createExternal).not.toHaveBeenCalled();
    });

    it('requires explicit App defaults before attaching an external thread', async () => {
        const createExternal = vi.fn();
        const coordinator = new CodexThreadOpenCoordinator({
            inspect: vi.fn().mockResolvedValue(summary()),
            openExisting: vi.fn(),
            createExternal,
        });

        await expect(coordinator.open({
            directory: '/tmp/project',
            threadId: 'thread-1',
            externalDataEncryptionKey: 'key',
        })).resolves.toMatchObject({ type: 'error' });
        expect(createExternal).not.toHaveBeenCalled();
    });

    it('exposes missing threads and indeterminate provider outcomes as stable results', async () => {
        const unavailable = new CodexThreadOpenCoordinator({
            inspect: vi.fn().mockRejectedValue(new CodexThreadUnavailableError()),
            openExisting: vi.fn(),
            createExternal: vi.fn(),
        });
        await expect(unavailable.open({
            directory: '/tmp/project',
            threadId: 'thread-1',
            binding: { sessionId: 'happy-1' },
        })).resolves.toEqual(expect.objectContaining({
            type: 'blocked',
            reason: 'threadUnavailable',
        }));

        const unknown = new CodexThreadOpenCoordinator({
            inspect: vi.fn().mockRejectedValue(new CodexRpcOutcomeUnknownError('thread/read', 'lost response')),
            openExisting: vi.fn(),
            createExternal: vi.fn(),
        });
        await expect(unknown.open({
            directory: '/tmp/project',
            threadId: 'thread-2',
            binding: { sessionId: 'happy-2' },
        })).resolves.toEqual(expect.objectContaining({
            type: 'error',
            errorCode: 'outcomeUnknown',
        }));
    });
});

describe('resolveCodexBoundThreadLaunchDecision', () => {
    it('never starts a second writer while Happy or an external provider turn is active', () => {
        expect(resolveCodexBoundThreadLaunchDecision({
            providerStatus: 'idle',
            gatewayState: 'live',
        })).toBe('existing-active');
        expect(resolveCodexBoundThreadLaunchDecision({
            providerStatus: 'idle',
            gatewayState: 'recovering',
        })).toBe('process-transition');
        expect(resolveCodexBoundThreadLaunchDecision({
            providerStatus: 'active',
            gatewayState: 'missing',
        })).toBe('external-active');
        expect(resolveCodexBoundThreadLaunchDecision({
            providerStatus: 'idle',
            gatewayState: 'missing',
        })).toBe('resume');
    });
});
