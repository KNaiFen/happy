import { beforeEach, describe, expect, it, vi } from 'vitest';

const { acquireAccountReadMock } = vi.hoisted(() => ({
    acquireAccountReadMock: vi.fn(async () => true),
}));

vi.mock('@/storage/inTx', () => ({
    inTx: async (callback: (tx: object) => Promise<unknown>) => callback({}),
}));
vi.mock('@/app/account/accountWriteGate', () => ({
    acquireAccountRead: acquireAccountReadMock,
}));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));
vi.mock('prom-client', () => ({
    Counter: class { inc() {} },
    Histogram: class { observe() {} },
    register: {},
}));

import { rpcHandler } from './rpcHandler';

function createSocket(data: Record<string, unknown> = { clientType: 'user-scoped' }) {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const socket = {
        id: 'caller-socket',
        data,
        on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
            handlers.set(event, handler);
        }),
        emit: vi.fn(),
        join: vi.fn(),
        leave: vi.fn(),
    };
    return { socket, handlers };
}

describe('RPC account deletion admission', () => {
    beforeEach(() => {
        acquireAccountReadMock.mockReset();
        acquireAccountReadMock.mockResolvedValue(true);
    });

    it('does not register a provider after deletion begins', async () => {
        acquireAccountReadMock.mockResolvedValue(false);
        const { socket, handlers } = createSocket({
            clientType: 'machine-scoped',
            credentialId: 'credential-1',
            machineId: 'machine-1',
        });
        const io = { in: vi.fn() };
        rpcHandler('user-1', socket as any, io as any);

        await handlers.get('rpc-register')?.({ method: 'machine-1:spawn-happy-session' });

        expect(socket.join).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', {
            type: 'register',
            error: 'Account deletion in progress',
        });
    });

    it('does not look up or dispatch a call after deletion begins', async () => {
        acquireAccountReadMock.mockResolvedValue(false);
        const { socket, handlers } = createSocket();
        const io = { in: vi.fn() };
        const callback = vi.fn();
        rpcHandler('user-1', socket as any, io as any);

        await handlers.get('rpc-call')?.(
            { method: 'machine-1:spawn-happy-session', params: {} },
            callback,
        );

        expect(io.in).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: 'Account deletion in progress',
        });
    });
});
