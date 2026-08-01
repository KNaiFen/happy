import { describe, expect, it, vi } from 'vitest';

import {
    CodexThreadOpenCoordinator,
    resolveCodexBoundThreadLaunchDecision,
} from './codexThreadOpenCoordinator';
import type { CodexThreadHistorySummary } from './codexThreadHistory';

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
});

describe('resolveCodexBoundThreadLaunchDecision', () => {
    it('never starts a second writer while Happy or an external provider turn is active', () => {
        expect(resolveCodexBoundThreadLaunchDecision({
            providerStatus: 'idle',
            happySessionActive: true,
            happyProcessAlive: true,
        })).toBe('existing-active');
        expect(resolveCodexBoundThreadLaunchDecision({
            providerStatus: 'idle',
            happySessionActive: false,
            happyProcessAlive: true,
        })).toBe('process-transition');
        expect(resolveCodexBoundThreadLaunchDecision({
            providerStatus: 'active',
            happySessionActive: true,
            happyProcessAlive: false,
        })).toBe('external-active');
        expect(resolveCodexBoundThreadLaunchDecision({
            providerStatus: 'idle',
            happySessionActive: false,
            happyProcessAlive: false,
        })).toBe('resume');
    });
});
