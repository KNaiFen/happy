import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findManyMock, buildProfileMock } = vi.hoisted(() => ({
    findManyMock: vi.fn(),
    buildProfileMock: vi.fn(() => ({
        id: 'active-user',
        firstName: 'Active',
        lastName: null,
        avatar: null,
        username: 'active',
        bio: null,
        status: 'friend',
    })),
}));

vi.mock('@/storage/db', () => ({ db: { userRelationship: { findMany: findManyMock } } }));
vi.mock('./type', () => ({ buildUserProfile: buildProfileMock }));

import { friendList } from './friendList';

describe('friendList deletion visibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findManyMock.mockResolvedValue([
            {
                status: 'friend',
                toUser: {
                    id: 'active-user',
                    firstName: 'Active',
                    lastName: null,
                    username: 'active',
                    avatar: null,
                    githubUser: null,
                },
            },
        ]);
    });

    it('filters deletion-pending relationship targets in the database query', async () => {
        await expect(friendList({ uid: 'viewer' } as any)).resolves.toHaveLength(1);
        expect(findManyMock).toHaveBeenCalledWith({
            where: {
                fromUserId: 'viewer',
                toUser: { is: { deletionRequestedAt: null } },
                status: { in: ['friend', 'pending', 'requested'] },
            },
            include: { toUser: { include: { githubUser: true } } },
        });
    });
});
