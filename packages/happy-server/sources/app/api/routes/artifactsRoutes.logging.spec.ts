import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';

const {
    txMock,
    logMock,
    acquireAccountWriteMock,
    allocateArtifactMutationMock,
    emitUpdateMock,
} = vi.hoisted(() => ({
    txMock: {
        account: {
            findUnique: vi.fn(),
        },
        artifact: {
            findUnique: vi.fn(),
            findFirst: vi.fn(),
            findMany: vi.fn(),
            create: vi.fn(),
            updateMany: vi.fn(),
            delete: vi.fn(),
        },
        callbacks: [] as Array<() => void | Promise<void>>,
    },
    logMock: vi.fn(),
    acquireAccountWriteMock: vi.fn(async () => true),
    allocateArtifactMutationMock: vi.fn(async () => ({ seq: 1, artifactRevision: 1 })),
    emitUpdateMock: vi.fn(),
}));

vi.mock('@/storage/db', () => ({ db: {} }));
vi.mock('@/storage/inTx', () => ({
    inTx: vi.fn(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock)),
    afterTx: vi.fn((_tx: unknown, callback: () => void | Promise<void>) => callback()),
}));
vi.mock('@/app/account/accountWriteGate', () => ({
    acquireAccountRead: vi.fn(async () => true),
    acquireAccountWrite: acquireAccountWriteMock,
}));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitUpdate: emitUpdateMock },
    buildNewArtifactUpdate: vi.fn(),
    buildUpdateArtifactUpdate: vi.fn(),
    buildDeleteArtifactUpdate: vi.fn(),
}));
vi.mock('@/storage/seq', () => ({ allocateArtifactMutation: allocateArtifactMutationMock }));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'key') }));
vi.mock('@/utils/log', () => ({ log: logMock }));

import { artifactsRoutes } from './artifactsRoutes';

const hostileUserId = 'prompt-reasoning-tool-output-artifact-user';

async function createApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = hostileUserId;
    });
    artifactsRoutes(typed);
    await typed.ready();
    return typed;
}

describe('artifact payload-free logging', () => {
    let app: Fastify;

    beforeEach(() => {
        process.env.HANDY_MASTER_SECRET = 'artifact-cursor-test-secret';
        vi.clearAllMocks();
        acquireAccountWriteMock.mockResolvedValue(true);
        allocateArtifactMutationMock.mockResolvedValue({ seq: 1, artifactRevision: 1 });
        txMock.artifact.findUnique.mockResolvedValue(null);
        txMock.artifact.findFirst.mockResolvedValue(null);
        txMock.artifact.findMany.mockReset();
        txMock.account.findUnique.mockResolvedValue({ seq: 73, artifactRevision: 9 });
        txMock.artifact.create.mockReset();
        txMock.artifact.updateMany.mockReset();
        txMock.artifact.delete.mockReset();
    });

    afterEach(async () => {
        await app?.close();
    });

    it('does not log artifact payloads, keys, identifiers, or storage errors', async () => {
        const artifactId = '123e4567-e89b-12d3-a456-426614174000';
        const rawHeader = 'prompt-reasoning-tool-output-artifact-header';
        const rawBody = 'prompt-reasoning-tool-output-artifact-body';
        const rawDataKey = 'prompt-reasoning-tool-output-artifact-data-key';
        const providerError = 'prompt-reasoning-tool-output-artifact-provider-error';
        const header = Buffer.from(rawHeader).toString('base64');
        const body = Buffer.from(rawBody).toString('base64');
        const dataEncryptionKey = Buffer.from(rawDataKey).toString('base64');
        txMock.artifact.create.mockRejectedValueOnce(new Error(providerError));
        app = await createApp();

        const response = await app.inject({
            method: 'POST',
            url: '/v1/artifacts',
            payload: { id: artifactId, header, body, dataEncryptionKey },
        });

        expect(response.statusCode).toBe(500);
        expect(logMock).toHaveBeenCalledWith(expect.objectContaining({
            module: 'api',
            level: 'error',
            operation: 'artifact.create',
            userHash: expect.any(String),
            artifactHash: expect.any(String),
        }), 'Artifact operation failed');
        const logs = JSON.stringify(logMock.mock.calls);
        for (const hostile of [
            hostileUserId,
            artifactId,
            rawHeader,
            rawBody,
            rawDataKey,
            header,
            body,
            dataEncryptionKey,
            providerError,
        ]) {
            expect(logs).not.toContain(hostile);
        }
    });
});

describe('artifact REST response contracts', () => {
    let app: Fastify;
    const artifactId = '123e4567-e89b-12d3-a456-426614174000';
    const encoded = Buffer.from('encrypted-artifact-field').toString('base64');
    const artifact = {
        id: artifactId,
        accountId: hostileUserId,
        header: Buffer.from('header'),
        headerVersion: 1,
        body: Buffer.from('body'),
        bodyVersion: 1,
        dataEncryptionKey: Buffer.from('data-key'),
        seq: 0,
        updateSeq: 73,
        createdAt: new Date('2026-08-14T00:00:00.000Z'),
        updatedAt: new Date('2026-08-14T00:00:00.000Z'),
    };

    beforeEach(async () => {
        process.env.HANDY_MASTER_SECRET = 'artifact-cursor-test-secret';
        vi.clearAllMocks();
        acquireAccountWriteMock.mockResolvedValue(true);
        allocateArtifactMutationMock.mockResolvedValue({ seq: 73, artifactRevision: 9 });
        txMock.account.findUnique.mockResolvedValue({ seq: 73, artifactRevision: 9 });
        txMock.artifact.findUnique.mockResolvedValue(null);
        txMock.artifact.findFirst.mockResolvedValue(artifact);
        txMock.artifact.findMany.mockResolvedValue([]);
        txMock.artifact.create.mockResolvedValue(artifact);
        txMock.artifact.updateMany.mockResolvedValue({ count: 1 });
        txMock.artifact.delete.mockResolvedValue(artifact);
        app = await createApp();
    });

    afterEach(async () => {
        await app.close();
    });

    it('serializes the authoritative update sequence for create', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v1/artifacts',
            payload: { id: artifactId, header: encoded, body: encoded, dataEncryptionKey: encoded },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ id: artifactId, seq: 0, updateSeq: 73 });
    });

    it('keeps duplicate create idempotent without allocating a sequence or emitting an event', async () => {
        txMock.artifact.findUnique.mockResolvedValueOnce(artifact);

        const response = await app.inject({
            method: 'POST',
            url: '/v1/artifacts',
            payload: { id: artifactId, header: encoded, body: encoded, dataEncryptionKey: encoded },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ id: artifactId, updateSeq: 73 });
        expect(txMock.artifact.create).not.toHaveBeenCalled();
        expect(allocateArtifactMutationMock).not.toHaveBeenCalled();
        expect(txMock.artifact.updateMany).not.toHaveBeenCalled();
        expect(emitUpdateMock).not.toHaveBeenCalled();
    });

    it('serializes the authoritative update sequence for update', async () => {
        const response = await app.inject({
            method: 'POST',
            url: `/v1/artifacts/${artifactId}`,
            payload: { header: encoded, expectedHeaderVersion: 1 },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ success: true, updateSeq: 73, headerVersion: 2 });
    });

    it('serializes the authoritative update sequence for delete', async () => {
        const response = await app.inject({
            method: 'DELETE',
            url: `/v1/artifacts/${artifactId}`,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ success: true, updateSeq: 73 });
    });

    it('returns a stable, account-sequenced snapshot cursor', async () => {
        const second = { ...artifact, id: '223e4567-e89b-12d3-a456-426614174000' };
        const third = { ...artifact, id: '323e4567-e89b-12d3-a456-426614174000' };
        txMock.artifact.findMany
            .mockResolvedValueOnce([artifact, second, third])
            .mockResolvedValueOnce([third]);

        const first = await app.inject({ method: 'GET', url: '/v1/artifacts?limit=2' });
        expect(first.statusCode).toBe(200);
        const firstBody = first.json();
        expect(firstBody).toMatchObject({ highWatermark: 73 });
        expect(firstBody.artifacts).toHaveLength(2);
        expect(firstBody.nextCursor).toEqual(expect.any(String));
        expect(txMock.artifact.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: expect.objectContaining({ updateSeq: { lte: 73 } }),
            orderBy: { id: 'asc' },
            take: 3,
        }));

        const secondPage = await app.inject({
            method: 'GET',
            url: `/v1/artifacts?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
        });
        expect(secondPage.statusCode).toBe(200);
        expect(secondPage.json()).toMatchObject({
            highWatermark: 73,
            nextCursor: null,
            artifacts: [{ id: third.id, updateSeq: 73 }],
        });
        expect(txMock.artifact.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: expect.objectContaining({ id: { gt: second.id }, updateSeq: { lte: 73 } }),
        }));
    });

    it('continues a snapshot when only the unrelated account sequence changes', async () => {
        const firstPageRows = [artifact, { ...artifact, id: '223e4567-e89b-12d3-a456-426614174000' }];
        txMock.artifact.findMany.mockResolvedValueOnce(firstPageRows);
        const first = await app.inject({ method: 'GET', url: '/v1/artifacts?limit=1' });
        const cursor = first.json().nextCursor;
        txMock.account.findUnique.mockResolvedValueOnce({ seq: 74, artifactRevision: 9 });
        txMock.artifact.findMany.mockResolvedValueOnce([]);

        const response = await app.inject({
            method: 'GET',
            url: `/v1/artifacts?cursor=${encodeURIComponent(cursor)}`,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ highWatermark: 73, nextCursor: null });
        expect(txMock.artifact.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
            where: expect.objectContaining({ updateSeq: { lte: 73 } }),
        }));
    });

    it('rejects a continued snapshot after an artifact mutation', async () => {
        const firstPageRows = [artifact, { ...artifact, id: '223e4567-e89b-12d3-a456-426614174000' }];
        txMock.artifact.findMany.mockResolvedValueOnce(firstPageRows);
        const first = await app.inject({ method: 'GET', url: '/v1/artifacts?limit=1' });
        const cursor = first.json().nextCursor;
        txMock.account.findUnique.mockResolvedValueOnce({ seq: 74, artifactRevision: 10 });
        txMock.artifact.findMany.mockClear();

        const response = await app.inject({ method: 'GET', url: `/v1/artifacts?cursor=${encodeURIComponent(cursor)}` });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'Artifact snapshot changed' });
        expect(txMock.artifact.findMany).not.toHaveBeenCalled();
    });

    it('rejects a tampered snapshot cursor', async () => {
        const firstPageRows = [artifact, { ...artifact, id: '223e4567-e89b-12d3-a456-426614174000' }];
        txMock.artifact.findMany.mockResolvedValueOnce(firstPageRows);
        const first = await app.inject({ method: 'GET', url: '/v1/artifacts?limit=1' });
        const cursor = first.json().nextCursor as string;
        const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;

        const response = await app.inject({ method: 'GET', url: `/v1/artifacts?cursor=${encodeURIComponent(tampered)}` });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'Invalid artifact snapshot cursor' });
    });
});
