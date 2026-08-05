import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SyncMutationV4 } from '@slopus/happy-wire';
import {
    OperationReceiptConflictError,
    OperationReceiptStore,
    normalizeOperationId,
    sendOperationRequestHash,
    spawnOperationRequestHash,
} from './operationReceipts';

const operationId = 'd94231c7-6601-483f-a8f3-92912d759423';

function mutation(id = operationId): SyncMutationV4 {
    return {
        mutationId: id,
        producerId: `happy-agent-${id}`,
        entityId: 'opaque-command-id',
        entityType: 'codex.command',
        revision: 1,
        op: 'upsert',
        ciphertext: 'encrypted-command',
    };
}

describe('OperationReceiptStore', () => {
    let homeDir: string;
    let receiptDir: string;

    beforeEach(() => {
        homeDir = mkdtempSync(join(tmpdir(), 'happy-agent-receipts-'));
        receiptDir = join(homeDir, 'agent-operations');
    });

    afterEach(() => {
        rmSync(homeDir, { recursive: true, force: true });
    });

    it('persists an exact encrypted send mutation with private permissions', () => {
        const store = new OperationReceiptStore(receiptDir);
        const requestHash = sendOperationRequestHash({
            sessionId: 'session-1',
            message: 'do not persist this plaintext',
        });

        const receipt = store.claimSend(requestHash, operationId, () => mutation());
        const raw = readFileSync(join(receiptDir, `${operationId}.json`), 'utf8');
        const restored = new OperationReceiptStore(receiptDir).resolveSend(
            requestHash,
            operationId,
        );

        expect(receipt.mutation).toEqual(mutation());
        expect(restored?.mutation).toEqual(mutation());
        expect(raw).not.toContain('do not persist this plaintext');
        expect(statSync(receiptDir).mode & 0o777).toBe(0o700);
        expect(statSync(join(receiptDir, `${operationId}.json`)).mode & 0o777).toBe(0o600);
    });

    it('automatically reuses one pending request across store instances', () => {
        const requestHash = sendOperationRequestHash({
            sessionId: 'session-1',
            message: 'retry me',
            permissionMode: 'yolo',
        });
        new OperationReceiptStore(receiptDir).claimSend(
            requestHash,
            operationId,
            () => mutation(),
        );

        const restored = new OperationReceiptStore(receiptDir).resolveSend(requestHash);

        expect(restored?.operationId).toBe(operationId);
        expect(restored?.status).toBe('pending');
    });

    it('rechecks the pending receipt while claiming after a snapshot delay', () => {
        const requestHash = sendOperationRequestHash({
            sessionId: 'session-1',
            message: 'claim once',
        });
        const first = new OperationReceiptStore(receiptDir).claimSend(
            requestHash,
            undefined,
            (claimedOperationId) => mutation(claimedOperationId),
        );
        let secondFactoryCalled = false;
        const second = new OperationReceiptStore(receiptDir).claimSend(
            requestHash,
            undefined,
            () => {
                secondFactoryCalled = true;
                return mutation('f24d3f6c-1ee8-4098-9cc0-a273c3b04f65');
            },
        );

        expect(second.operationId).toBe(first.operationId);
        expect(second.mutation).toEqual(first.mutation);
        expect(secondFactoryCalled).toBe(false);
    });

    it('takes over a crashed receipt lock without deleting its immutable claim', () => {
        const requestHash = sendOperationRequestHash({
            sessionId: 'session-1',
            message: 'recover the claim',
        });
        const lockName = `request-send-${requestHash}`;
        const lockDirectory = join(receiptDir, '.locks', lockName);
        mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
        writeFileSync(join(lockDirectory, 'claim-0.json'), `${JSON.stringify({
            version: 1,
            name: lockName,
            generation: 0,
            ownerId: '92d2f5d5-34ba-4f34-a832-f03fdd15bba1',
            pid: 2_147_483_647,
            createdAt: Date.now(),
        })}\n`, { mode: 0o600 });

        const receipt = new OperationReceiptStore(receiptDir).claimSend(
            requestHash,
            undefined,
            (claimedOperationId) => mutation(claimedOperationId),
        );

        expect(receipt.requestHash).toBe(requestHash);
        expect(readdirSync(lockDirectory).sort()).toEqual([
            'claim-0.json',
            'claim-1.json',
            'done-1.json',
        ]);
    });

    it('starts a new automatic operation after visible success is acknowledged', () => {
        const requestHash = sendOperationRequestHash({
            sessionId: 'session-1',
            message: 'repeat intentionally',
        });
        const store = new OperationReceiptStore(receiptDir);
        store.claimSend(requestHash, operationId, () => mutation());
        store.markAcknowledged(operationId);

        const next = new OperationReceiptStore(receiptDir).claimSend(
            requestHash,
            undefined,
            (nextOperationId) => mutation(nextOperationId),
        );

        expect(next.operationId).not.toBe(operationId);
        expect(next.status).toBe('pending');
    });

    it('rejects reusing an operation ID for different content or operation kinds', () => {
        const store = new OperationReceiptStore(receiptDir);
        const firstHash = sendOperationRequestHash({
            sessionId: 'session-1',
            message: 'first',
        });
        store.claimSend(firstHash, operationId, () => mutation());

        expect(() => store.resolveSend(sendOperationRequestHash({
            sessionId: 'session-1',
            message: 'second',
        }), operationId)).toThrow(OperationReceiptConflictError);
        expect(() => store.claimSpawn(spawnOperationRequestHash({
            machineId: 'machine-1',
            directory: '/workspace',
            agent: 'codex',
        }), operationId)).toThrow(OperationReceiptConflictError);
    });

    it('persists a spawn result before acknowledgement and reuses it', () => {
        const requestHash = spawnOperationRequestHash({
            machineId: 'machine-1',
            directory: '/workspace',
            agent: 'codex',
        });
        const store = new OperationReceiptStore(receiptDir);
        store.claimSpawn(requestHash, operationId);
        store.recordSpawnSuccess(operationId, 'session-created-once');

        const restored = new OperationReceiptStore(receiptDir).claimSpawn(
            requestHash,
            operationId,
        );

        expect(restored.sessionId).toBe('session-created-once');
        expect(restored.status).toBe('pending');
    });

    it('prunes acknowledged receipts after 7 days but never deletes pending work', () => {
        const store = new OperationReceiptStore(receiptDir);
        const sendHash = sendOperationRequestHash({
            sessionId: 'session-1',
            message: 'acknowledged',
        });
        store.claimSend(sendHash, operationId, () => mutation());
        store.markAcknowledged(operationId);

        const pendingId = 'f24d3f6c-1ee8-4098-9cc0-a273c3b04f65';
        store.claimSpawn(spawnOperationRequestHash({
            machineId: 'machine-1',
            directory: '/pending',
            agent: 'codex',
        }), pendingId);

        const eightDaysLater = Date.now() + 8 * 24 * 60 * 60 * 1_000;
        expect(store.pruneExpired(eightDaysLater)).toBe(1);
        expect(() => store.markAcknowledged(operationId)).toThrow('was not found');
        expect(store.claimSpawn(spawnOperationRequestHash({
            machineId: 'machine-1',
            directory: '/pending',
            agent: 'codex',
        }), pendingId).sessionId).toBeNull();

        const thirtyOneDaysLater = Date.now() + 31 * 24 * 60 * 60 * 1_000;
        expect(store.pruneExpired(thirtyOneDaysLater)).toBe(0);
        expect(store.claimSpawn(spawnOperationRequestHash({
            machineId: 'machine-1',
            directory: '/pending',
            agent: 'codex',
        }), pendingId).operationId).toBe(pendingId);
    });

    it('normalizes valid UUIDs and rejects invalid operation IDs', () => {
        expect(normalizeOperationId(operationId.toUpperCase())).toBe(operationId);
        expect(() => normalizeOperationId('../not-a-uuid')).toThrow('must be a UUID');
    });

    it('fails closed when an on-disk receipt is invalid', () => {
        const store = new OperationReceiptStore(receiptDir);
        const requestHash = sendOperationRequestHash({
            sessionId: 'session-1',
            message: 'do not duplicate after corruption',
        });
        store.claimSend(requestHash, operationId, () => mutation());
        writeFileSync(join(receiptDir, 'corrupt.json'), '{not json', 'utf8');

        expect(() => store.resolveSend(requestHash)).toThrow('corrupt.json is invalid');
    });
});
