import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@/context';

const {
    state,
    dbMock,
    txMock,
    uploadImage,
    eventRouter,
    logMock,
} = vi.hoisted(() => {
    const state = {
        githubUserId: 'github-old',
        rejectConnectionLock: false,
        deletionRequested: false,
    };
    const uploadImage = vi.fn(async () => ({
        path: 'public/users/user-1/avatars/github.jpg',
        width: 1,
        height: 1,
        thumbhash: 'hash',
    }));
    const eventRouter = { emitUpdate: vi.fn() };
    const logMock = vi.fn();
    const txMock: any = {
        account: {
            updateMany: vi.fn(async (args: any) => {
                if (args.data.updatedAt) {
                    return { count: state.rejectConnectionLock ? 0 : 1 };
                }
                if (args.data.githubUserId === null) {
                    return { count: state.deletionRequested ? 0 : 1 };
                }
                return { count: 1 };
            }),
            findUnique: vi.fn(async () => (
                state.githubUserId ? { githubUserId: state.githubUserId } : null
            )),
            findUniqueOrThrow: vi.fn(async () => ({ githubUserId: state.githubUserId })),
            update: vi.fn(async () => ({ id: 'user-1' })),
        },
        githubUser: {
            upsert: vi.fn(async () => ({ id: 'github-new' })),
            deleteMany: vi.fn(async () => ({ count: 1 })),
        },
    };
    const dbMock: any = {
        account: {
            findFirstOrThrow: vi.fn(async () => ({ githubUserId: state.githubUserId, username: null })),
            findFirst: vi.fn(async () => null),
        },
    };
    return { state, dbMock, txMock, uploadImage, eventRouter, logMock };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/storage/inTx', () => ({
    inTx: async (callback: (tx: unknown) => Promise<unknown>) => callback(txMock),
}));
vi.mock('@/modules/encrypt', () => ({ encryptString: vi.fn(() => Buffer.from('encrypted')) }));
vi.mock('@/storage/uploadImage', () => ({ uploadImage }));
vi.mock('@/utils/separateName', () => ({
    separateName: vi.fn(() => ({ firstName: 'Happy', lastName: 'Coder' })),
}));
vi.mock('@/storage/seq', () => ({ allocateUserSeq: vi.fn(async () => 1) }));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter,
    buildUpdateAccountUpdate: vi.fn(() => ({ type: 'account-update' })),
}));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'key') }));
vi.mock('@/utils/log', () => ({ log: logMock }));

import { githubConnect } from './githubConnect';
import { githubDisconnect } from './githubDisconnect';

const profile = {
    id: 42,
    login: 'happy-coder',
    name: 'Happy Coder',
    avatar_url: 'https://avatars.example/happy.jpg',
} as any;

describe('GitHub account connection lifecycle', () => {
    beforeEach(() => {
        state.githubUserId = 'github-old';
        state.rejectConnectionLock = false;
        state.deletionRequested = false;
        vi.clearAllMocks();
        vi.stubGlobal('fetch', vi.fn(async () => ({
            arrayBuffer: async () => new ArrayBuffer(0),
        })));
    });

    it('does not upsert an OAuth record when account deletion wins before the final connection lock', async () => {
        state.rejectConnectionLock = true;

        await expect(githubConnect(Context.create('user-1'), profile, 'oauth-token'))
            .rejects.toThrow('Account deletion in progress');

        expect(uploadImage).toHaveBeenCalled();
        expect(txMock.githubUser.upsert).not.toHaveBeenCalled();
        expect(txMock.account.update).not.toHaveBeenCalled();
        expect(eventRouter.emitUpdate).not.toHaveBeenCalled();
    });

    it('removes the replaced OAuth record once the new link commits', async () => {
        await githubConnect(Context.create('user-1'), profile, 'oauth-token');

        expect(txMock.account.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: expect.objectContaining({ githubUserId: '42' }),
        });
        expect(txMock.githubUser.deleteMany).toHaveBeenCalledWith({
            where: {
                id: 'github-old',
                Account: { none: {} },
            },
        });
    });

    it('does not clear a GitHub link or emit an update after deletion is marked', async () => {
        state.deletionRequested = true;

        await githubDisconnect(Context.create('user-1'));

        expect(txMock.githubUser.deleteMany).not.toHaveBeenCalled();
        expect(eventRouter.emitUpdate).not.toHaveBeenCalled();
    });

    it('logs only diagnostic hashes when disconnecting hostile account identifiers', async () => {
        const userId = 'prompt-reasoning-tool-output-account-id';
        const githubUserId = 'prompt-reasoning-tool-output-provider-id';
        state.githubUserId = githubUserId;

        await githubDisconnect(Context.create(userId));

        expect(logMock).toHaveBeenCalledWith(expect.objectContaining({
            module: 'github-disconnect',
            userHash: expect.any(String),
            githubUserHash: expect.any(String),
        }), 'Disconnecting GitHub account');
        expect(logMock).toHaveBeenCalledWith(expect.objectContaining({
            module: 'github-disconnect',
            userHash: expect.any(String),
            githubUserHash: expect.any(String),
        }), 'GitHub account disconnected');
        const logs = JSON.stringify(logMock.mock.calls);
        expect(logs).not.toContain(userId);
        expect(logs).not.toContain(githubUserId);
    });
});
