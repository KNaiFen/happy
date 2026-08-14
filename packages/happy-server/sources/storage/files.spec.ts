import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;
let originalDataDir: string | undefined;
let originalS3Host: string | undefined;
let originalPublicUrl: string | undefined;

beforeEach(() => {
    originalDataDir = process.env.DATA_DIR;
    originalS3Host = process.env.S3_HOST;
    originalPublicUrl = process.env.PUBLIC_URL;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-files-'));
    process.env.DATA_DIR = dataDir;
    delete process.env.S3_HOST;
    delete process.env.PUBLIC_URL;
    vi.resetModules();
});

afterEach(() => {
    if (originalDataDir === undefined) {
        delete process.env.DATA_DIR;
    } else {
        process.env.DATA_DIR = originalDataDir;
    }
    if (originalS3Host === undefined) {
        delete process.env.S3_HOST;
    } else {
        process.env.S3_HOST = originalS3Host;
    }
    if (originalPublicUrl === undefined) {
        delete process.env.PUBLIC_URL;
    } else {
        process.env.PUBLIC_URL = originalPublicUrl;
    }
    vi.doUnmock('minio');
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('getPublicUrl', () => {
    it('uses the local server fallback when no explicit public URL is configured', async () => {
        const { getPublicUrl } = await import('./files');

        expect(getPublicUrl('public/users/account-1/avatar.jpg', {
            headers: {
                'x-forwarded-host': 'relay.lan:32405',
                'x-forwarded-proto': 'https',
            },
        })).toBe('http://localhost:3005/files/public/users/account-1/avatar.jpg');
    });
});

describe('local storage platform boundary', () => {
    it('refuses local storage when POSIX UID protections are unavailable', async () => {
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });

        try {
            const { loadFiles } = await import('./files');

            await expect(loadFiles()).rejects.toThrow(
                'Local file storage requires POSIX ownership checks; configure S3_HOST',
            );
            expect(fs.existsSync(path.join(dataDir, 'files'))).toBe(false);
        } finally {
            Object.defineProperty(process, 'platform', platformDescriptor);
        }
    });
});

describe('getFileStream', () => {
    it('rejects a missing local file before a route begins streaming a response', async () => {
        const { getFileStream } = await import('./files');

        await expect(getFileStream('sessions/missing/attachments/blob.enc'))
            .rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects traversal and absolute paths before opening a local file', async () => {
        const { getFileStream } = await import('./files');

        await expect(getFileStream('../outside-secret')).rejects.toThrow('Invalid storage key');
        await expect(getFileStream('..\\outside-secret')).rejects.toThrow('Invalid storage key');
        await expect(getFileStream(path.resolve(dataDir, '..', 'outside-secret')))
            .rejects.toThrow('Invalid storage key');
    });
});

describe('putLocalFile', () => {
    it('cannot write outside the configured local files directory', async () => {
        const { putLocalFile } = await import('./files');
        const outside = path.resolve(dataDir, '..', 'outside-write');

        await expect(putLocalFile('../outside-write', Buffer.from('secret')))
            .rejects.toThrow('Invalid storage key');
        expect(fs.existsSync(outside)).toBe(false);
    });

    it('serializes concurrent parent creation without leaving either write incomplete', async () => {
        const { putLocalFile } = await import('./files');

        await Promise.all([
            putLocalFile('sessions/shared/attachments/first.enc', Buffer.from('first')),
            putLocalFile('sessions/shared/attachments/second.enc', Buffer.from('second')),
        ]);

        expect(fs.readFileSync(path.join(dataDir, 'files/sessions/shared/attachments/first.enc'), 'utf8'))
            .toBe('first');
        expect(fs.readFileSync(path.join(dataDir, 'files/sessions/shared/attachments/second.enc'), 'utf8'))
            .toBe('second');
    });
});

describe('local storage symbolic-link boundary', () => {
    it('rejects a symbolic-link ancestor for read, write, and recursive deletion', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-files-outside-'));
        const outsideAttachments = path.join(outside, 'attachments');
        fs.mkdirSync(outsideAttachments);
        const outsideSecret = path.join(outsideAttachments, 'secret.enc');
        fs.writeFileSync(outsideSecret, 'outside-secret');
        fs.mkdirSync(path.join(dataDir, 'files/sessions'), { recursive: true });
        fs.symlinkSync(outside, path.join(dataDir, 'files/sessions/linked'), 'dir');

        try {
            const { deleteFilesWithPrefix, getFileStream, putLocalFile } = await import('./files');

            await expect(getFileStream('sessions/linked/attachments/secret.enc'))
                .rejects.toThrow('symbolic link');
            await expect(putLocalFile('sessions/linked/attachments/new.enc', Buffer.from('new')))
                .rejects.toThrow('symbolic link');
            await expect(deleteFilesWithPrefix('sessions/linked/attachments/'))
                .rejects.toThrow('symbolic link');
            expect(fs.readFileSync(outsideSecret, 'utf8')).toBe('outside-secret');
            expect(fs.existsSync(path.join(outsideAttachments, 'new.enc'))).toBe(false);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it('never follows a final file link and only unlinks that link during deletion', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-file-outside-'));
        const outsideSecret = path.join(outside, 'secret.enc');
        fs.writeFileSync(outsideSecret, 'outside-secret');
        const localDirectory = path.join(dataDir, 'files/sessions/s1/attachments');
        fs.mkdirSync(localDirectory, { recursive: true });
        const localLink = path.join(localDirectory, 'linked.enc');
        fs.symlinkSync(outsideSecret, localLink, 'file');

        try {
            const { deleteFile, getFileStream, putLocalFile } = await import('./files');

            await expect(getFileStream('sessions/s1/attachments/linked.enc')).rejects.toMatchObject({
                code: 'ELOOP',
            });
            await expect(putLocalFile('sessions/s1/attachments/linked.enc', Buffer.from('overwrite')))
                .rejects.toMatchObject({ code: 'ELOOP' });
            await expect(deleteFile('sessions/s1/attachments/linked.enc')).resolves.toBeUndefined();
            expect(fs.existsSync(localLink)).toBe(false);
            expect(fs.readFileSync(outsideSecret, 'utf8')).toBe('outside-secret');
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it('unlinks descendant links without traversing them during prefix deletion', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-tree-outside-'));
        const outsideSecret = path.join(outside, 'secret.enc');
        fs.writeFileSync(outsideSecret, 'outside-secret');
        const attachments = path.join(dataDir, 'files/sessions/s1/attachments');
        fs.mkdirSync(attachments, { recursive: true });
        fs.symlinkSync(outside, path.join(attachments, 'linked-directory'), 'dir');

        try {
            const { deleteFilesWithPrefix } = await import('./files');

            await expect(deleteFilesWithPrefix('sessions/s1/attachments/')).resolves.toBeUndefined();
            expect(fs.existsSync(attachments)).toBe(false);
            expect(fs.readFileSync(outsideSecret, 'utf8')).toBe('outside-secret');
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});

describe('deleteFilesWithPrefix', () => {
    it('keeps deletion pending when MinIO reports a per-object failure', async () => {
        const removeObjects = vi.fn(async () => [{ key: 'sessions/s1/attachments/a.enc', code: 'AccessDenied' }]);
        const listObjects = vi.fn(() => Readable.from([{ name: 'sessions/s1/attachments/a.enc' }], { objectMode: true }));
        vi.doMock('minio', () => ({
            Client: class {
                listObjects = listObjects;
                removeObjects = removeObjects;
            },
        }));
        process.env.S3_HOST = 'minio.test';
        process.env.S3_ACCESS_KEY = 'access';
        process.env.S3_SECRET_KEY = 'secret';
        process.env.S3_BUCKET = 'happy';
        vi.resetModules();

        const { deleteFilesWithPrefix } = await import('./files');

        await expect(deleteFilesWithPrefix('sessions/s1/attachments/'))
            .rejects.toThrow('Object storage reported incomplete deletion');
        expect(listObjects).toHaveBeenCalledWith('happy', 'sessions/s1/attachments/', true, {
            IncludeVersion: true,
        });
        expect(removeObjects).toHaveBeenCalledWith('happy', [{ name: 'sessions/s1/attachments/a.enc' }]);
    });

    it('removes every S3 object version and delete marker before considering a prefix clean', async () => {
        let listCall = 0;
        const listObjects = vi.fn(() => Readable.from(listCall++ === 0
            ? [
                { name: 'public/users/account-1/avatar.jpg', versionId: 'version-1' },
                { name: 'public/users/account-1/avatar.jpg', versionId: 'delete-marker-2' },
            ]
            : [], { objectMode: true }));
        const removeObjects = vi.fn(async (
            _bucket: string,
            _entries: Array<{ name: string; versionId?: string }>,
        ) => []);
        vi.doMock('minio', () => ({
            Client: class {
                listObjects = listObjects;
                removeObjects = removeObjects;
            },
        }));
        process.env.S3_HOST = 'minio.test';
        process.env.S3_ACCESS_KEY = 'access';
        process.env.S3_SECRET_KEY = 'secret';
        process.env.S3_BUCKET = 'happy';
        vi.resetModules();

        const { deleteFilesWithPrefix } = await import('./files');

        await expect(deleteFilesWithPrefix('public/users/account-1/')).resolves.toBeUndefined();
        expect(removeObjects).toHaveBeenCalledWith('happy', [
            { name: 'public/users/account-1/avatar.jpg', versionId: 'version-1' },
            { name: 'public/users/account-1/avatar.jpg', versionId: 'delete-marker-2' },
        ]);
        expect(listObjects).toHaveBeenCalledTimes(2);
        expect(listObjects).toHaveBeenNthCalledWith(1, 'happy', 'public/users/account-1/', true, {
            IncludeVersion: true,
        });
    });

    it('deletes more than 1000 S3 versions in bounded sequential batches', async () => {
        let listCall = 0;
        const versions = Array.from({ length: 1001 }, (_, index) => ({
            name: `public/users/account-1/avatar-${index}.jpg`,
            versionId: `version-${index}`,
        }));
        const listObjects = vi.fn(() => Readable.from(
            listCall++ === 0 ? versions : [],
            { objectMode: true },
        ));
        const removeObjects = vi.fn(async (
            _bucket: string,
            _entries: Array<{ name: string; versionId?: string }>,
        ) => []);
        vi.doMock('minio', () => ({
            Client: class {
                listObjects = listObjects;
                removeObjects = removeObjects;
            },
        }));
        process.env.S3_HOST = 'minio.test';
        process.env.S3_ACCESS_KEY = 'access';
        process.env.S3_SECRET_KEY = 'secret';
        process.env.S3_BUCKET = 'happy';
        vi.resetModules();

        const { deleteFilesWithPrefix } = await import('./files');

        await expect(deleteFilesWithPrefix('public/users/account-1/')).resolves.toBeUndefined();
        expect(removeObjects).toHaveBeenCalledTimes(2);
        expect(removeObjects.mock.calls[0][1]).toHaveLength(1000);
        expect(removeObjects.mock.calls[1][1]).toEqual([
            { name: 'public/users/account-1/avatar-1000.jpg', versionId: 'version-1000' },
        ]);
        expect(removeObjects.mock.invocationCallOrder[0])
            .toBeLessThan(removeObjects.mock.invocationCallOrder[1]);
    });
});

describe('forEachSessionAttachmentId', () => {
    it('streams local attachment session IDs to bounded visitor batches', async () => {
        const { forEachSessionAttachmentId, putLocalFile } = await import('./files');
        await putLocalFile('sessions/first/attachments/a.enc', Buffer.from('a'));
        await putLocalFile('sessions/second/attachments/b.enc', Buffer.from('b'));

        const batches: string[][] = [];
        await forEachSessionAttachmentId(async (sessionIds) => {
            batches.push([...sessionIds]);
        });

        expect(batches.flat().sort()).toEqual(['first', 'second']);
    });

    it('discovers orphan attachment sessions from noncurrent S3 object versions', async () => {
        const listObjects = vi.fn(() => Readable.from([
            { name: 'sessions/orphan/attachments/a.enc', versionId: 'old-version' },
            { name: 'sessions/orphan/attachments/a.enc', versionId: 'delete-marker' },
        ], { objectMode: true }));
        vi.doMock('minio', () => ({
            Client: class {
                listObjects = listObjects;
            },
        }));
        process.env.S3_HOST = 'minio.test';
        process.env.S3_ACCESS_KEY = 'access';
        process.env.S3_SECRET_KEY = 'secret';
        process.env.S3_BUCKET = 'happy';
        vi.resetModules();

        const { forEachSessionAttachmentId } = await import('./files');
        const batches: string[][] = [];
        await forEachSessionAttachmentId(async (sessionIds) => {
            batches.push([...sessionIds]);
        });

        expect(batches).toEqual([['orphan']]);
        expect(listObjects).toHaveBeenCalledWith('happy', 'sessions/', true, { IncludeVersion: true });
    });
});
