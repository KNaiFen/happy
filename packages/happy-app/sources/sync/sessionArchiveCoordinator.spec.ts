import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    sessionArchive: vi.fn(),
    sessionKill: vi.fn(),
    getState: vi.fn(),
}));

vi.mock('./ops', () => ({
    sessionArchive: mocks.sessionArchive,
    sessionKill: mocks.sessionKill,
}));

vi.mock('./storage', () => ({
    storage: { getState: mocks.getState },
}));

import { archiveSession } from './sessionArchiveCoordinator';
import { isSessionArchivePending } from './sessionArchiveState';

function session(overrides: Record<string, unknown> = {}) {
    return {
        id: 'session-1',
        active: true,
        activeAt: 10,
        presence: 'online',
        metadata: { flavor: 'codex', machineId: 'machine-1' },
        ...overrides,
    } as any;
}

describe('session archive coordinator', () => {
    let current: ReturnType<typeof session>;
    let applySessions: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        current = session();
        applySessions = vi.fn((updates: any[]) => {
            current = updates[0];
        });
        mocks.getState.mockImplementation(() => ({
            sessions: { 'session-1': current },
            applySessions,
        }));
        mocks.sessionArchive.mockResolvedValue({ success: true, archivedAt: 100 });
        mocks.sessionKill.mockResolvedValue({ success: true });
    });

    it('deduplicates clicks, hides immediately, and cleans up before background kill', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const beforeStop = vi.fn(async () => undefined);
        mocks.sessionArchive.mockImplementationOnce(async () => {
            await gate;
            return { success: true, archivedAt: 100 };
        });

        const first = archiveSession('session-1', { beforeStop });
        const second = archiveSession('session-1');
        expect(first).toBe(second);
        expect(isSessionArchivePending('session-1')).toBe(true);
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({ active: false }),
        ]);
        expect(mocks.sessionKill).not.toHaveBeenCalled();

        release();
        await first;
        await Promise.resolve();
        expect(mocks.sessionArchive).toHaveBeenCalledOnce();
        expect(current).toMatchObject({ active: false, activeAt: 100 });
        expect(isSessionArchivePending('session-1')).toBe(false);
        expect(beforeStop).toHaveBeenCalledOnce();
        expect(mocks.sessionKill).toHaveBeenCalledWith('session-1', { timeoutMs: 5_000 });
        expect(beforeStop.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.sessionKill.mock.invocationCallOrder[0],
        );
    });

    it('rolls back the optimistic hide and preserves the relay error', async () => {
        mocks.sessionArchive.mockResolvedValueOnce({ success: false, message: 'relay unavailable' });

        await expect(archiveSession('session-1')).rejects.toThrow('relay unavailable');
        expect(applySessions).toHaveBeenCalledTimes(2);
        expect(applySessions.mock.calls[1][0]).toEqual([expect.objectContaining({ active: true })]);
        expect(mocks.sessionKill).not.toHaveBeenCalled();
    });

    it('does not send a kill RPC for read-only child sessions', async () => {
        current = session({ metadata: { flavor: 'codex', codexReadOnly: true } });
        mocks.getState.mockImplementation(() => ({ sessions: { 'session-1': current }, applySessions }));

        await archiveSession('session-1');
        await Promise.resolve();
        expect(mocks.sessionArchive).toHaveBeenCalledOnce();
        expect(mocks.sessionKill).not.toHaveBeenCalled();
    });
});
