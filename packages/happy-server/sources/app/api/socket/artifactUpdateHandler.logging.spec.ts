import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    acquireAccountReadMock,
    acquireAccountWriteMock,
    logMock,
    handlers,
    txMock,
    allocateArtifactMutationMock,
    emitUpdateMock,
} = vi.hoisted(() => ({
    acquireAccountReadMock: vi.fn(),
    acquireAccountWriteMock: vi.fn(),
    logMock: vi.fn(),
    handlers: new Map<string, (...args: any[]) => unknown>(),
    txMock: {
        artifact: {
            findUnique: vi.fn(),
            create: vi.fn(),
            updateMany: vi.fn(),
        },
    },
    allocateArtifactMutationMock: vi.fn(async () => ({ seq: 1, artifactRevision: 1 })),
    emitUpdateMock: vi.fn(),
}));

vi.mock('@/app/monitoring/metrics2', () => ({
    getMetricsLabelsFromSocket: vi.fn(() => ({})),
    websocketEventsCounter: { inc: vi.fn() },
}));
vi.mock('@/app/events/eventRouter', () => ({
    buildNewArtifactUpdate: vi.fn(),
    buildUpdateArtifactUpdate: vi.fn(),
    buildDeleteArtifactUpdate: vi.fn(),
    eventRouter: { emitUpdate: emitUpdateMock },
}));
vi.mock('@/storage/db', () => ({ db: {} }));
vi.mock('@/storage/inTx', () => ({
    inTx: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback(txMock)),
    afterTx: vi.fn((_tx: unknown, callback: () => void) => callback()),
}));
vi.mock('@/storage/seq', () => ({ allocateArtifactMutation: allocateArtifactMutationMock }));
vi.mock('@/utils/log', () => ({ log: logMock }));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'key') }));
vi.mock('@/app/account/accountWriteGate', () => ({
    acquireAccountRead: acquireAccountReadMock,
    acquireAccountWrite: acquireAccountWriteMock,
}));
vi.mock('privacy-kit', () => ({
    encodeBase64: vi.fn(() => 'encoded'),
    decodeBase64: vi.fn(() => new Uint8Array([1])),
}));

import { artifactUpdateHandler } from './artifactUpdateHandler';

const hostileUserId = 'prompt-reasoning-tool-output-socket-user';
const hostileError = new Error('prompt-reasoning-tool-output-socket-provider-error');
const hostileHeader = 'prompt-reasoning-tool-output-socket-header';
const hostileBody = 'prompt-reasoning-tool-output-socket-body';
const hostileKey = 'prompt-reasoning-tool-output-socket-data-key';

function createSocket() {
    handlers.clear();
    const socket = {
        on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
            handlers.set(event, handler);
        }),
    } as any;
    artifactUpdateHandler(hostileUserId, socket);
    return socket;
}

describe('artifact socket payload-free logging', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        acquireAccountReadMock.mockResolvedValue(true);
        acquireAccountWriteMock.mockResolvedValue(true);
        txMock.artifact.findUnique.mockResolvedValue(null);
    });

    it.each([
        ['artifact-read', { artifactId: 'prompt-reasoning-tool-output-artifact-read' }, 'artifact.read', 'read'],
        ['artifact-update', {
            artifactId: 'prompt-reasoning-tool-output-artifact-update',
            header: { data: hostileHeader, expectedVersion: 1 },
        }, 'artifact.update', 'write'],
        ['artifact-create', {
            id: 'prompt-reasoning-tool-output-artifact-create',
            header: hostileHeader,
            body: hostileBody,
            dataEncryptionKey: hostileKey,
        }, 'artifact.create', 'write'],
        ['artifact-delete', { artifactId: 'prompt-reasoning-tool-output-artifact-delete' }, 'artifact.delete', 'write'],
    ])('does not serialize errors for %s', async (event, payload, operation, gate) => {
        const socket = createSocket();
        const callback = vi.fn();
        const gateMock = gate === 'read' ? acquireAccountReadMock : acquireAccountWriteMock;
        gateMock.mockRejectedValueOnce(hostileError);

        await handlers.get(event)!(payload, callback);

        expect(callback).toHaveBeenCalledWith({ result: 'error', message: 'Internal error' });
        expect(logMock).toHaveBeenCalledWith(expect.objectContaining({
            module: 'websocket',
            level: 'error',
            operation,
            userHash: expect.any(String),
            artifactHash: expect.any(String),
        }), 'Artifact socket operation failed');
        const logs = JSON.stringify(logMock.mock.calls);
        expect(logs).not.toContain(hostileUserId);
        expect(logs).not.toContain(hostileError.message);
        expect(logs).not.toContain(JSON.stringify(payload));
        expect(logs).not.toContain(hostileHeader);
        expect(logs).not.toContain(hostileBody);
        expect(logs).not.toContain(hostileKey);
        expect(socket.on).toHaveBeenCalled();
    });

    it('keeps duplicate create idempotent without allocating a sequence or emitting an event', async () => {
        const artifact = {
            id: '123e4567-e89b-12d3-a456-426614174000',
            accountId: hostileUserId,
            header: new Uint8Array([1]),
            headerVersion: 1,
            body: new Uint8Array([2]),
            bodyVersion: 1,
            dataEncryptionKey: new Uint8Array([3]),
            seq: 0,
            updateSeq: 41,
            createdAt: new Date(0),
            updatedAt: new Date(0),
        };
        txMock.artifact.findUnique.mockResolvedValueOnce(artifact);
        createSocket();
        const callback = vi.fn();

        await handlers.get('artifact-create')!({
            id: artifact.id,
            header: hostileHeader,
            body: hostileBody,
            dataEncryptionKey: hostileKey,
        }, callback);

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            result: 'success',
            artifact: expect.objectContaining({ id: artifact.id, updateSeq: 41 }),
        }));
        expect(txMock.artifact.create).not.toHaveBeenCalled();
        expect(allocateArtifactMutationMock).not.toHaveBeenCalled();
        expect(txMock.artifact.updateMany).not.toHaveBeenCalled();
        expect(emitUpdateMock).not.toHaveBeenCalled();
    });
});
