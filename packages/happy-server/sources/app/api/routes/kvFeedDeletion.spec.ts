import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';

const {
    acquireAccountRead,
    kvGet,
    kvList,
    kvBulkGet,
    kvMutate,
    feedGet,
    logMock,
} = vi.hoisted(() => ({
    acquireAccountRead: vi.fn(),
    kvGet: vi.fn(),
    kvList: vi.fn(),
    kvBulkGet: vi.fn(),
    kvMutate: vi.fn(),
    feedGet: vi.fn(),
    logMock: vi.fn(),
}));

vi.mock('@/app/account/accountWriteGate', () => ({
    acquireAccountRead,
    acquireAccountWrite: vi.fn(),
    AccountWriteBlockedError: class AccountWriteBlockedError extends Error {},
}));
vi.mock('@/storage/inTx', () => ({
    inTx: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('@/app/kv/kvGet', () => ({ kvGet }));
vi.mock('@/app/kv/kvList', () => ({ kvList }));
vi.mock('@/app/kv/kvBulkGet', () => ({ kvBulkGet }));
vi.mock('@/app/kv/kvMutate', () => ({ kvMutate }));
vi.mock('@/app/feed/feedGet', () => ({ feedGet }));
vi.mock('@/context', () => ({ Context: { create: vi.fn(() => ({ uid: 'account-1' })) } }));
vi.mock('@/utils/log', () => ({ log: logMock }));

import { kvRoutes } from './kvRoutes';
import { feedRoutes } from './feedRoutes';

async function createApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'account-1';
    });
    kvRoutes(typed);
    feedRoutes(typed);
    await typed.ready();
    return typed;
}

describe('account deletion read gates for KV and feed', () => {
    let app: Fastify;

    beforeEach(() => {
        vi.clearAllMocks();
        acquireAccountRead.mockResolvedValue(false);
        logMock.mockReset();
    });

    afterEach(async () => {
        await app?.close();
    });

    it.each([
        ['KV get', { method: 'GET' as const, url: '/v1/kv/example' }, kvGet],
        ['KV list', { method: 'GET' as const, url: '/v1/kv' }, kvList],
        ['KV bulk', { method: 'POST' as const, url: '/v1/kv/bulk', payload: { keys: ['example'] } }, kvBulkGet],
        ['feed', { method: 'GET' as const, url: '/v1/feed' }, feedGet],
    ])('rejects %s before querying account data', async (_name, request, helper) => {
        app = await createApp();
        const response = await app.inject(request);

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'Account deletion in progress' });
        expect(helper).not.toHaveBeenCalled();
    });

    it('keeps KV failure logs free of hostile exception text', async () => {
        acquireAccountRead.mockResolvedValue(true);
        kvGet.mockRejectedValueOnce(new Error('kv-hostile-sentinel'));
        app = await createApp();

        const response = await app.inject({ method: 'GET', url: '/v1/kv/secret-key' });

        expect(response.statusCode).toBe(500);
        expect(JSON.stringify(logMock.mock.calls)).not.toContain('kv-hostile-sentinel');
    });
});
