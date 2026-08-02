import { describe, expect, it, vi } from 'vitest';
import { runCodexGatewayWorkerEntrypoint } from './codexGatewayWorkerEntrypoint';

class ProcessExit extends Error {
    constructor(readonly code: number) {
        super(`process exited with ${code}`);
    }
}

describe('Codex Gateway worker process entrypoint', () => {
    it('exits successfully only after the worker has completed its cleanup', async () => {
        const order: string[] = [];
        const exit = vi.fn((code: number): never => {
            order.push(`exit:${code}`);
            throw new ProcessExit(code);
        });

        await expect(runCodexGatewayWorkerEntrypoint('gateway-a', {
            run: async (gatewayId) => {
                expect(gatewayId).toBe('gateway-a');
                order.push('run');
            },
            exit,
        })).rejects.toMatchObject({ code: 0 });

        expect(order).toEqual(['run', 'exit:0']);
        expect(exit).toHaveBeenCalledOnce();
    });

    it('does not report success when worker cleanup fails', async () => {
        const exit = vi.fn((_code: number): never => {
            throw new Error('exit must not be called');
        });

        await expect(runCodexGatewayWorkerEntrypoint('gateway-a', {
            run: async () => {
                throw new Error('cleanup failed');
            },
            exit,
        })).rejects.toThrow('cleanup failed');

        expect(exit).not.toHaveBeenCalled();
    });
});
