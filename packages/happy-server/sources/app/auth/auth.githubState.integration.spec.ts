import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, findAccountMock } = vi.hoisted(() => {
    const state = { deletionRequestedAt: null as Date | null };
    return {
        state,
        findAccountMock: vi.fn(async () => ({
            deletionRequestedAt: state.deletionRequestedAt,
        })),
    };
});

vi.mock('@/storage/db', () => ({
    db: {
        account: { findUnique: findAccountMock },
        terminalAuthRequest: { findUnique: vi.fn() },
    },
}));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { AuthModule } from './auth';

describe('GitHub OAuth signed state integration', () => {
    const originalSecret = process.env.HANDY_MASTER_SECRET;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
        process.env.HANDY_MASTER_SECRET = 'github-state-integration-test-secret';
        state.deletionRequestedAt = null;
        findAccountMock.mockClear();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        if (originalSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
        else process.env.HANDY_MASTER_SECRET = originalSecret;
    });

    it('round-trips the purpose and durable admission through privacy-kit extras', async () => {
        const auth = new AuthModule();
        await auth.init();

        const token = await auth.createGithubToken('account-1', 'admission-1');

        await expect(auth.verifyGithubToken(token)).resolves.toEqual({
            userId: 'account-1',
            admissionId: 'admission-1',
        });
        state.deletionRequestedAt = new Date();
        await expect(auth.verifyGithubToken(token)).resolves.toBeNull();
    });
});
