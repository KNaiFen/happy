import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    dbMock,
    putFile,
    beginUploadOperation,
    settleUploadOperation,
    processImage,
} = vi.hoisted(() => ({
    dbMock: {
        uploadedFile: {
            findFirst: vi.fn(async () => null),
            create: vi.fn(async () => ({})),
        },
    },
    putFile: vi.fn(async () => {}),
    beginUploadOperation: vi.fn(async () => 'upload-operation-1'),
    settleUploadOperation: vi.fn(async () => {}),
    processImage: vi.fn(async () => ({
        format: 'png',
        width: 32,
        height: 24,
        thumbhash: 'thumbhash',
    })),
}));

vi.mock('./db', () => ({ db: dbMock }));
vi.mock('./files', () => ({ putFile, getPublicUrl: (path: string) => `http://server/files/${path}` }));
vi.mock('./processImage', () => ({ processImage }));
vi.mock('@/app/account/accountDeletion', () => ({
    beginAccountDeletionUpload: beginUploadOperation,
    settleAccountDeletionUpload: settleUploadOperation,
}));
vi.mock('@/utils/randomKey', () => ({ randomKey: () => 'image-key' }));

import { resolveImageUrl, uploadImage } from './uploadImage';

describe('uploadImage account-deletion gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMock.uploadedFile.findFirst.mockResolvedValue(null);
        beginUploadOperation.mockResolvedValue('upload-operation-1');
        putFile.mockResolvedValue(undefined);
        settleUploadOperation.mockResolvedValue(undefined);
    });

    it('holds the account upload operation through object and database writes', async () => {
        const source = Buffer.from('image');

        await expect(uploadImage('account-1', 'avatars', 'github', 'https://example/avatar', source))
            .resolves.toEqual({
                path: 'public/users/account-1/avatars/image-key.png',
                width: 32,
                height: 24,
                thumbhash: 'thumbhash',
            });

        expect(beginUploadOperation).toHaveBeenCalledWith(
            'account-1',
            'public/users/account-1/avatars/image-key.png',
        );
        expect(putFile).toHaveBeenCalledWith('public/users/account-1/avatars/image-key.png', source);
        expect(dbMock.uploadedFile.create).toHaveBeenCalledTimes(1);
        expect(settleUploadOperation).toHaveBeenCalledWith('upload-operation-1');
        expect(resolveImageUrl('public/users/account-1/avatars/image-key.png'))
            .toBe('http://server/files/public/users/account-1/avatars/image-key.png');
    });

    it('does not reuse an avatar object from another account', async () => {
        (dbMock.uploadedFile.findFirst as any).mockImplementation(async ({ where }: any) => (
            where.accountId === 'account-1'
                ? null
                : {
                    path: 'public/users/account-2/avatars/image-key.png',
                    width: 32,
                    height: 24,
                    thumbhash: 'foreign-thumbhash',
                }
        ));
        const source = Buffer.from('image');

        await expect(uploadImage('account-1', 'avatars', 'github', 'https://example/avatar', source))
            .resolves.toMatchObject({ path: 'public/users/account-1/avatars/image-key.png' });

        expect(dbMock.uploadedFile.findFirst).toHaveBeenCalledWith({
            where: {
                accountId: 'account-1',
                reuseKey: 'image-url:https://example/avatar',
            },
        });
        expect(putFile).toHaveBeenCalledWith('public/users/account-1/avatars/image-key.png', source);
    });

    it('keeps the upload operation pending when object storage reports an unknown write result', async () => {
        putFile.mockRejectedValueOnce(new Error('connection reset'));

        await expect(uploadImage('account-1', 'avatars', 'github', 'https://example/avatar', Buffer.from('image')))
            .rejects.toThrow('connection reset');

        expect(settleUploadOperation).not.toHaveBeenCalled();
        expect(dbMock.uploadedFile.create).not.toHaveBeenCalled();
    });

    it('does not write an avatar once account deletion has acquired the gate', async () => {
        beginUploadOperation.mockResolvedValueOnce(null as never);

        await expect(uploadImage('account-1', 'avatars', 'github', 'https://example/avatar', Buffer.from('image')))
            .rejects.toThrow('Account deletion in progress');

        expect(putFile).not.toHaveBeenCalled();
        expect(dbMock.uploadedFile.create).not.toHaveBeenCalled();
        expect(settleUploadOperation).not.toHaveBeenCalled();
    });
});
