import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'minio';

const useLocalStorage = !process.env.S3_HOST;
const dataDir = process.env.DATA_DIR || './data';
const localFilesDir = path.join(dataDir, 'files');

// S3 config (only used when S3_HOST is set)
let s3client: Client | null = null;
let s3bucket: string = '';
let s3host: string = '';

if (!useLocalStorage) {
    const s3Port = process.env.S3_PORT ? parseInt(process.env.S3_PORT, 10) : undefined;
    const s3UseSSL = process.env.S3_USE_SSL ? process.env.S3_USE_SSL === 'true' : true;
    const s3Region = process.env.S3_REGION || 'us-east-1';
    s3client = new Client({
        endPoint: process.env.S3_HOST!,
        port: s3Port,
        useSSL: s3UseSSL,
        accessKey: process.env.S3_ACCESS_KEY!,
        secretKey: process.env.S3_SECRET_KEY!,
        region: s3Region,
    });
    s3bucket = process.env.S3_BUCKET!;
    s3host = process.env.S3_HOST!;
}

export { s3client, s3bucket, s3host };

function getS3Client(): Client {
    if (!s3client) {
        throw new Error('Object storage is not configured');
    }
    return s3client;
}

export async function loadFiles() {
    if (useLocalStorage) {
        fs.mkdirSync(localFilesDir, { recursive: true });
        return;
    }
    await getS3Client().bucketExists(s3bucket);
}

type PublicUrlRequest = {
    headers: Record<string, string | string[] | undefined>;
};

export function getPublicUrl(filePath: string, request?: PublicUrlRequest) {
    // Keep profile objects behind the Server in both storage modes. A direct S3
    // URL cannot be revoked when its account enters deletion, whereas /files
    // checks the account state before it streams the object.
    const baseUrl = resolvePublicBaseUrl(request);
    return `${baseUrl}/files/${filePath}`;
}

function resolvePublicBaseUrl(request?: PublicUrlRequest): string {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
    return `http://localhost:${process.env.PORT || '3005'}`;
}

export function isLocalStorage() {
    return useLocalStorage;
}

export function getLocalFilesDir() {
    return localFilesDir;
}

export async function putLocalFile(filePath: string, data: Buffer) {
    const fullPath = path.join(localFilesDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, data);
}

/** Store an opaque file through the configured backend. */
export async function putFile(filePath: string, data: Buffer): Promise<void> {
    if (useLocalStorage) {
        await putLocalFile(filePath, data);
        return;
    }
    await getS3Client().putObject(s3bucket, filePath, data);
}

export type FileProbeResult = 'present' | 'absent' | 'unknown';

/**
 * Probe one server-generated object key. "unknown" is deliberately distinct
 * from "absent": deletion may only release an upload operation after storage
 * has positively confirmed that no version of the exact key remains.
 */
export async function probeFile(filePath: string): Promise<FileProbeResult> {
    validateStorageKey(filePath);
    try {
        if (useLocalStorage) {
            try {
                await fs.promises.stat(path.join(localFilesDir, filePath));
                return 'present';
            } catch (error: any) {
                if (error?.code === 'ENOENT') return 'absent';
                return 'unknown';
            }
        }
        for await (const object of listS3ObjectVersions(filePath)) {
            if (object.name === filePath) return 'present';
        }
        return 'absent';
    } catch {
        return 'unknown';
    }
}

/** Delete and verify one exact server-generated object key, including S3 versions. */
export async function deleteFile(filePath: string): Promise<void> {
    validateStorageKey(filePath);
    if (useLocalStorage) {
        const fullPath = path.join(localFilesDir, filePath);
        try {
            await fs.promises.unlink(fullPath);
        } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
        }
        return;
    }

    const objects: S3ObjectVersion[] = [];
    for await (const object of listS3ObjectVersions(filePath)) {
        if (object.name === filePath) objects.push(object);
    }
    if (objects.length > 0) {
        const entries = objects.map((object) => ({
            name: object.name,
            ...(object.versionId === undefined ? {} : { versionId: object.versionId }),
        }));
        const failures = await getS3Client().removeObjects(s3bucket, entries);
        if (!Array.isArray(failures) || failures.length > 0) {
            throw new Error('Object storage reported incomplete deletion');
        }
    }
    if (await probeFile(filePath) !== 'absent') {
        throw new Error('Object storage retained exact object after deletion');
    }
}

function validateStorageKey(filePath: string): void {
    if (!filePath || path.isAbsolute(filePath) || filePath.split('/').includes('..')) {
        throw new Error('Invalid storage key');
    }
}

/** Read an opaque file through the configured backend. */
export async function getFileStream(filePath: string): Promise<NodeJS.ReadableStream> {
    if (useLocalStorage) {
        // createReadStream reports ENOENT asynchronously, after Fastify has
        // started the response. Opening first keeps a missing object a normal
        // route-level 404 rather than a streamed 500.
        const file = await fs.promises.open(path.join(localFilesDir, filePath), 'r');
        return file.createReadStream();
    }
    return getS3Client().getObject(s3bucket, filePath);
}

/**
 * Delete all attachments for a session.
 * Local: removes the session attachments directory.
 * S3: deletes all objects with prefix "sessions/{sessionId}/attachments/".
 */
export async function deleteSessionAttachments(sessionId: string): Promise<void> {
    await deleteFilesWithPrefix(`sessions/${sessionId}/attachments/`);
}

/** Delete every local file or S3 object below a server-generated storage prefix. */
export async function deleteFilesWithPrefix(prefix: string): Promise<void> {
    validateStorageKey(prefix);

    if (useLocalStorage) {
        const root = path.resolve(localFilesDir);
        const dir = path.resolve(root, prefix);
        if (dir !== root && !dir.startsWith(root + path.sep)) {
            throw new Error('Storage prefix escapes local files directory');
        }
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        return;
    }

    const removeBatch = async (objects: S3ObjectVersion[]) => {
        const entries = objects.map((object) => ({
            name: object.name,
            ...(object.versionId === undefined ? {} : { versionId: object.versionId }),
        }));
        const failures = await getS3Client().removeObjects(s3bucket, entries);
        // MinIO/S3 multi-object deletion reports per-key failures in a resolved
        // array. Treat those like a rejected request: the account deletion
        // worker must stay pending until every account-owned object is gone.
        if (!Array.isArray(failures) || failures.length > 0) {
            throw new Error('Object storage reported incomplete deletion');
        }
    };

    let batch: S3ObjectVersion[] = [];
    for await (const object of listS3ObjectVersions(prefix)) {
        batch.push(object);
        if (batch.length === 1000) {
            await removeBatch(batch);
            batch = [];
        }
    }
    if (batch.length > 0) {
        await removeBatch(batch);
    }
    // Versioned buckets retain old object versions and delete markers unless
    // each version is addressed explicitly. Re-list to prove this prefix is
    // actually empty before an account deletion can finish.
    for await (const _object of listS3ObjectVersions(prefix)) {
        throw new Error('Object storage retained object versions after deletion');
    }
}

/**
 * Visit historical attachment session IDs in bounded batches. Account deletion
 * uses this through a globally rate-limited GC, so a large bucket never needs
 * to be materialized in one process before orphan cleanup can begin.
 */
export async function forEachSessionAttachmentId(
    visitor: (sessionIds: readonly string[]) => Promise<void>,
): Promise<void> {
    const flush = async (sessionIds: Set<string>) => {
        if (sessionIds.size === 0) return;
        const batch = [...sessionIds];
        sessionIds.clear();
        await visitor(batch);
    };

    if (useLocalStorage) {
        const sessionsDir = path.join(localFilesDir, 'sessions');
        if (!fs.existsSync(sessionsDir)) return;
        const sessionIds = new Set<string>();
        const entries = await fs.promises.opendir(sessionsDir);
        for await (const entry of entries) {
            if (!entry.isDirectory()
                || !fs.existsSync(path.join(sessionsDir, entry.name, 'attachments'))) {
                continue;
            }
            sessionIds.add(entry.name);
            if (sessionIds.size >= 500) await flush(sessionIds);
        }
        await flush(sessionIds);
        return;
    }

    const sessionIds = new Set<string>();
    const stream = getS3Client().listObjects(s3bucket, 'sessions/', true, { IncludeVersion: true });
    for await (const obj of stream as AsyncIterable<{ name?: string }>) {
        const match = /^sessions\/([^/]+)\/attachments\//.exec(obj.name ?? '');
        if (!match) continue;
        sessionIds.add(match[1]);
        if (sessionIds.size >= 500) await flush(sessionIds);
    }
    await flush(sessionIds);
}

type S3ObjectVersion = {
    name: string;
    versionId?: string;
};

async function* listS3ObjectVersions(prefix: string): AsyncGenerator<S3ObjectVersion> {
    const stream = getS3Client().listObjects(s3bucket, prefix, true, { IncludeVersion: true });
    for await (const obj of stream as AsyncIterable<S3ObjectVersion>) {
        if (obj.name) yield { name: obj.name, versionId: obj.versionId };
    }
}

/** Remove all account-owned attachment and profile object prefixes. */
export async function deleteAccountFiles(accountId: string, sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
        await deleteSessionAttachments(sessionId);
    }
    await deleteFilesWithPrefix(`public/users/${accountId}/`);
}

export type ImageRef = {
    width: number;
    height: number;
    thumbhash: string;
    path: string;
}
