import { beforeEach, describe, expect, it, vi } from 'vitest';

const { delayMock, warnMock } = vi.hoisted(() => ({
    delayMock: vi.fn(async () => undefined),
    warnMock: vi.fn(),
}));

vi.mock('./delay', () => ({ delay: delayMock }));
vi.mock('./log', () => ({ warn: warnMock }));

import { createBackoff } from './backoff';

describe('createBackoff payload-free logging', () => {
    beforeEach(() => vi.clearAllMocks());

    it('does not serialize retry errors or stacks', async () => {
        const hostile = 'prompt-reasoning-tool-output-backoff';
        const callback = vi.fn()
            .mockRejectedValueOnce(new Error(hostile))
            .mockResolvedValueOnce('ok');

        await expect(createBackoff({ minDelay: 0, maxDelay: 0 })(callback)).resolves.toBe('ok');

        expect(warnMock).toHaveBeenCalledWith({
            module: 'backoff',
            level: 'warn',
            retry: 1,
        }, 'Retrying operation');
        expect(JSON.stringify(warnMock.mock.calls)).not.toContain(hostile);
    });
});
