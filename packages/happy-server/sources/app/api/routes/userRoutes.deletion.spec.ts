import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';

const { dbMock, profileMock } = vi.hoisted(() => ({
    dbMock: {
        account: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
            updateMany: vi.fn(),
        },
        userRelationship: {
            findFirst: vi.fn(),
        },
    },
    profileMock: vi.fn(() => ({
        id: 'target',
        firstName: 'Target',
        lastName: null,
        avatar: null,
        username: 'target',
        bio: null,
        status: 'none',
    })),
}));

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/storage/inTx', () => ({
    inTx: vi.fn(async (callback: (tx: typeof dbMock) => Promise<unknown>) => callback(dbMock)),
}));
vi.mock('@/app/account/accountWriteGate', () => ({
    acquireAccountRead: vi.fn(async () => true),
}));
vi.mock('@/app/social/friendAdd', () => ({ friendAdd: vi.fn() }));
vi.mock('@/app/social/friendRemove', () => ({ friendRemove: vi.fn() }));
vi.mock('@/app/social/friendList', () => ({ friendList: vi.fn(async () => []) }));
vi.mock('@/app/social/type', () => ({ buildUserProfile: profileMock }));

import { userRoutes } from './userRoutes';

async function createApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'viewer';
    });
    userRoutes(typed);
    await typed.ready();
    return typed;
}

describe('user routes hide accounts pending deletion', () => {
    let app: Fastify;

    beforeEach(() => {
        vi.clearAllMocks();
        dbMock.account.findFirst.mockResolvedValue(null);
        dbMock.account.findMany.mockResolvedValue([]);
        dbMock.userRelationship.findFirst.mockResolvedValue(null);
        dbMock.account.updateMany.mockResolvedValue({ count: 1 });
    });

    afterEach(async () => {
        await app?.close();
    });

    it('returns 404 for a profile that has entered deletion', async () => {
        app = await createApp();
        const response = await app.inject({ method: 'GET', url: '/v1/user/deleting-user' });

        expect(response.statusCode).toBe(404);
        expect(dbMock.account.findFirst).toHaveBeenCalledWith({
            where: { id: 'deleting-user', deletionRequestedAt: null },
            include: { githubUser: true },
        });
        expect(profileMock).not.toHaveBeenCalled();
    });

    it('filters deletion-pending accounts before search results are built', async () => {
        dbMock.account.findMany.mockResolvedValue([
            {
                id: 'active-user',
                firstName: 'Active',
                lastName: null,
                username: 'alex-active',
                avatar: null,
                githubUser: null,
            },
        ]);
        app = await createApp();
        const response = await app.inject({ method: 'GET', url: '/v1/user/search?query=alex' });

        expect(response.statusCode).toBe(200);
        expect(dbMock.account.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                deletionRequestedAt: null,
                username: { startsWith: 'alex', mode: 'insensitive' },
            },
        }));
    });
});
