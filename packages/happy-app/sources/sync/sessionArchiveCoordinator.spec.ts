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

function gatewaySession(overrides: Record<string, unknown> = {}) {
    return session({
        metadata: {
            flavor: 'codex',
            codexSyncVersion: 4,
            machineId: 'machine-1',
            codexGatewayBinding: {
                gatewayId: 'gateway-1',
                generation: 2,
                origin: 'app',
                role: 'current',
                terminal: 'unattached',
                changedAt: 10,
            },
        },
        ...overrides,
    });
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

    it('keeps a Gateway visible until graceful stop is accepted, then archives it', async () => {
        current = gatewaySession();
        mocks.getState.mockImplementation(() => ({ sessions: { 'session-1': current }, applySessions }));
        let acceptStop!: (result: { success: boolean; message: string }) => void;
        mocks.sessionKill.mockImplementationOnce(() => new Promise((resolve) => {
            acceptStop = resolve;
        }));

        const pending = archiveSession('session-1');
        await Promise.resolve();
        expect(current.active).toBe(true);
        expect(mocks.sessionArchive).not.toHaveBeenCalled();

        acceptStop({ success: true, message: 'stopping' });
        await pending;

        expect(mocks.sessionKill).toHaveBeenCalledWith('session-1', { timeoutMs: 5_000 });
        expect(mocks.sessionKill.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.sessionArchive.mock.invocationCallOrder[0],
        );
        expect(current).toMatchObject({ active: false, activeAt: 100 });
    });

    it('does not hide or archive a Gateway when graceful stop is rejected', async () => {
        current = gatewaySession();
        mocks.getState.mockImplementation(() => ({ sessions: { 'session-1': current }, applySessions }));
        mocks.sessionKill.mockResolvedValueOnce({ success: false, message: 'gateway unavailable' });

        await expect(archiveSession('session-1')).rejects.toThrow('gateway unavailable');

        expect(current.active).toBe(true);
        expect(applySessions).not.toHaveBeenCalled();
        expect(mocks.sessionArchive).not.toHaveBeenCalled();
        expect(isSessionArchivePending('session-1')).toBe(false);
    });

    it('restores Gateway visibility when stop was accepted but relay archive fails', async () => {
        current = gatewaySession();
        mocks.getState.mockImplementation(() => ({ sessions: { 'session-1': current }, applySessions }));
        mocks.sessionArchive.mockResolvedValueOnce({ success: false, message: 'relay unavailable' });

        await expect(archiveSession('session-1')).rejects.toThrow('relay unavailable');

        expect(mocks.sessionKill).toHaveBeenCalledOnce();
        expect(applySessions).toHaveBeenCalledTimes(2);
        expect(current.active).toBe(true);
    });

    it('archives inactive Gateway history without trying to stop a missing worker', async () => {
        const inactive = gatewaySession();
        inactive.metadata.codexGatewayBinding.role = 'inactive';
        current = inactive;
        mocks.getState.mockImplementation(() => ({ sessions: { 'session-1': current }, applySessions }));

        await archiveSession('session-1');

        expect(mocks.sessionKill).not.toHaveBeenCalled();
        expect(mocks.sessionArchive).toHaveBeenCalledOnce();
        expect(current).toMatchObject({ active: false, activeAt: 100 });
    });
});
