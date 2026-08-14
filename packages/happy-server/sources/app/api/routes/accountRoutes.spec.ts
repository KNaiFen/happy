import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';

const {
    createChallenge,
    confirmDeletion,
    AccountDeletionError,
    resetState,
    dbMock,
    acquireAccountRead,
    acquireAccountWrite,
    logMock,
} = vi.hoisted(() => {
    class AccountDeletionError extends Error {
        constructor(public readonly code:
            | 'invalid-proof'
            | 'expired-challenge'
            | 'deletion-in-progress'
            | 'legacy-upload-capability-cutoff-unconfirmed') {
            super(code);
        }
    }
    const createChallenge = vi.fn(async () => ({
        challengeId: 'challenge-1',
        challenge: Buffer.alloc(32, 7).toString('base64'),
        expiresAt: Date.now() + 60_000,
    }));
    const confirmDeletion = vi.fn(async () => 'pending' as const);
    const dbMock = {
        account: {
            findUnique: vi.fn(),
            updateMany: vi.fn(),
        },
        serviceAccountToken: {
            findMany: vi.fn(),
        },
        session: {
            findFirst: vi.fn(),
        },
        usageReport: {
            findMany: vi.fn(),
        },
        callbacks: [] as Array<() => void | Promise<void>>,
    };
    const acquireAccountRead = vi.fn(async () => true);
    const acquireAccountWrite = vi.fn(async () => true);
    const logMock = vi.fn();
    const resetState = () => {
        createChallenge.mockClear();
        confirmDeletion.mockClear();
        confirmDeletion.mockResolvedValue('pending');
        dbMock.account.findUnique.mockReset();
        dbMock.account.updateMany.mockReset();
        dbMock.serviceAccountToken.findMany.mockReset();
        dbMock.session.findFirst.mockReset();
        dbMock.usageReport.findMany.mockReset();
        dbMock.callbacks = [];
        acquireAccountRead.mockReset();
        acquireAccountRead.mockResolvedValue(true);
        acquireAccountWrite.mockReset();
        acquireAccountWrite.mockResolvedValue(true);
        logMock.mockReset();
    };
    return { createChallenge, confirmDeletion, AccountDeletionError, resetState, dbMock, acquireAccountRead, acquireAccountWrite, logMock };
});

vi.mock('@/app/account/accountDeletion', () => ({
    AccountDeletionError,
    createAccountDeletionChallenge: createChallenge,
    confirmAccountDeletion: confirmDeletion,
}));
vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/storage/inTx', () => ({
    inTx: vi.fn(async (fn) => fn(dbMock)),
    afterTx: vi.fn((_tx, callback) => callback()),
}));
vi.mock('@/app/account/accountWriteGate', () => ({ acquireAccountRead, acquireAccountWrite }));
vi.mock('@/storage/files', () => ({ getPublicUrl: vi.fn() }));
vi.mock('@/app/events/eventRouter', () => ({ eventRouter: { emitUpdate: vi.fn() }, buildUpdateAccountUpdate: vi.fn() }));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn() }));
vi.mock('@/storage/seq', () => ({ allocateUserSeq: vi.fn() }));
vi.mock('@/utils/log', () => ({ log: logMock }));

import { accountRoutes } from './accountRoutes';

async function createApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'account-1';
        if (request.headers['x-terminal-credential'] === 'true') {
            request.authCredentialId = 'credential-1';
        }
    });
    accountRoutes(typed);
    await typed.ready();
    return typed;
}

describe('account deletion routes', () => {
    let app: Fastify;

    beforeEach(() => {
        resetState();
    });

    afterEach(async () => {
        await app?.close();
    });

    it('rejects terminal credentials before creating a deletion challenge', async () => {
        app = await createApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/deletion-challenge',
            headers: { 'x-terminal-credential': 'true' },
        });

        expect(response.statusCode).toBe(403);
        expect(createChallenge).not.toHaveBeenCalled();
    });

    it('forwards only an account credential proof and reports queued deletion', async () => {
        app = await createApp();
        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/account',
            payload: {
                challengeId: 'challenge-1',
                challenge: 'challenge',
                publicKey: 'public-key',
                signature: 'signature',
            },
        });

        expect(response.statusCode).toBe(202);
        expect(confirmDeletion).toHaveBeenCalledWith({
            accountId: 'account-1',
            challengeId: 'challenge-1',
            challenge: 'challenge',
            publicKey: 'public-key',
            signature: 'signature',
        });
    });

    it('maps a replayed or expired challenge to a conflict without running cleanup', async () => {
        app = await createApp();
        confirmDeletion.mockRejectedValueOnce(new AccountDeletionError('expired-challenge'));

        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/account',
            payload: {
                challengeId: 'challenge-1',
                challenge: 'challenge',
                publicKey: 'public-key',
                signature: 'signature',
            },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'Account deletion confirmation expired' });
    });

    it('returns a bounded payload error before forwarding an oversized proof', async () => {
        app = await createApp();
        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/account',
            payload: {
                challengeId: 'challenge-1',
                challenge: 'a'.repeat(129),
                publicKey: 'public-key',
                signature: 'signature',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(confirmDeletion).not.toHaveBeenCalled();
    });

    it('reports an unconfirmed legacy-upload cutoff without consuming a proof', async () => {
        app = await createApp();
        createChallenge.mockRejectedValueOnce(new AccountDeletionError('legacy-upload-capability-cutoff-unconfirmed'));

        const response = await app.inject({ method: 'POST', url: '/v1/account/deletion-challenge' });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: 'Account deletion is temporarily unavailable while legacy uploads drain' });
    });

    it('rejects a settings write after the account deletion gate is closed', async () => {
        app = await createApp();
        acquireAccountWrite.mockResolvedValueOnce(false);

        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/settings',
            payload: { settings: 'encrypted-settings', expectedVersion: 3 },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
            success: false,
            error: 'Failed to update account settings',
        });
        expect(dbMock.account.updateMany).not.toHaveBeenCalled();
    });

    it('keeps settings failure logs free of hostile exception text', async () => {
        app = await createApp();
        dbMock.account.updateMany.mockRejectedValueOnce(new Error('settings-hostile-sentinel'));

        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/settings',
            payload: { settings: 'encrypted-settings', expectedVersion: 3 },
        });

        expect(response.statusCode).toBe(500);
        expect(JSON.stringify(logMock.mock.calls)).not.toContain('settings-hostile-sentinel');
    });

    it.each([
        ['profile', { method: 'GET' as const, url: '/v1/account/profile' }],
        ['settings', { method: 'GET' as const, url: '/v1/account/settings' }],
        ['usage', { method: 'POST' as const, url: '/v1/usage/query', payload: {} }],
    ])('rejects %s reads after the account deletion gate is closed', async (_name, request) => {
        app = await createApp();
        acquireAccountRead.mockResolvedValueOnce(false);

        const response = await app.inject(request);

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'Account deletion in progress' });
        expect(dbMock.serviceAccountToken.findMany).not.toHaveBeenCalled();
        expect(dbMock.session.findFirst).not.toHaveBeenCalled();
        expect(dbMock.usageReport.findMany).not.toHaveBeenCalled();
    });
});
