import {
    chmodSync,
    linkSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
    SyncMutationV4Schema,
    type SyncMutationV4,
} from '@slopus/happy-wire';

const RECEIPT_VERSION = 1;
const ACKNOWLEDGED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const LOCK_WAIT_MS = 15_000;
const INVALID_LOCK_CLAIM_GRACE_MS = 10_000;
const LOCK_POLL_MS = 10;
const LOCK_WAIT_SIGNAL = new Int32Array(new SharedArrayBuffer(4));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_HASH_PATTERN = /^[0-9a-f]{64}$/;
const LOCK_CLAIM_FILE_PATTERN = /^claim-(\d+)\.json$/;

type ReceiptStatus = 'pending' | 'acknowledged';

interface OperationReceiptBase {
    version: typeof RECEIPT_VERSION;
    kind: 'send' | 'spawn';
    operationId: string;
    requestHash: string;
    status: ReceiptStatus;
    createdAt: number;
    acknowledgedAt: number | null;
}

export interface SendOperationReceipt extends OperationReceiptBase {
    kind: 'send';
    mutation: SyncMutationV4;
}

export interface SpawnOperationReceipt extends OperationReceiptBase {
    kind: 'spawn';
    sessionId: string | null;
}

type OperationReceipt = SendOperationReceipt | SpawnOperationReceipt;

interface ReceiptLockClaim {
    version: 1;
    name: string;
    generation: number;
    ownerId: string;
    pid: number;
    createdAt: number;
}

interface ReceiptLockClaimSnapshot {
    generation: number;
    claim: ReceiptLockClaim | null;
    mtimeMs: number;
}

interface ReceiptLockCompletion {
    version: 1;
    name: string;
    generation: number;
    ownerId: string;
    completedAt: number;
}

export class OperationReceiptConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OperationReceiptConflictError';
    }
}

export function normalizeOperationId(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (!UUID_PATTERN.test(normalized)) {
        throw new Error('Operation ID must be a UUID');
    }
    return normalized;
}

export function sendOperationRequestHash(input: {
    sessionId: string;
    message: string;
    permissionMode?: string;
}): string {
    return operationRequestHash([
        'send',
        input.sessionId,
        input.message,
        input.permissionMode ?? null,
    ]);
}

export function spawnOperationRequestHash(input: {
    machineId: string;
    directory: string;
    agent: 'codex';
}): string {
    return operationRequestHash([
        'spawn',
        input.machineId,
        input.directory,
        input.agent,
    ]);
}

export function pendingOperationError(operationId: string, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = /[.!?]$/.test(message) ? message : `${message}.`;
    return new Error(
        `${prefix} Operation ${operationId} remains pending; retry the same request or pass --operation-id ${operationId}.`,
        { cause: error },
    );
}

export class OperationReceiptStore {
    constructor(private readonly directory: string) {}

    resolveSend(
        requestHash: string,
        requestedOperationId?: string,
    ): SendOperationReceipt | null {
        return this.resolve('send', requestHash, requestedOperationId) as SendOperationReceipt | null;
    }

    claimSend(
        requestHash: string,
        requestedOperationId: string | undefined,
        createMutation: (operationId: string) => SyncMutationV4,
    ): SendOperationReceipt {
        this.assertRequestHash(requestHash);
        this.pruneExpired();
        if (requestedOperationId) {
            const operationId = normalizeOperationId(requestedOperationId);
            return this.withLock(`operation-${operationId}`, () => {
                const existing = this.read(operationId);
                if (existing) {
                    this.assertMatches(existing, 'send', requestHash);
                    return existing as SendOperationReceipt;
                }
                return this.createSendReceipt(operationId, requestHash, createMutation);
            });
        }

        return this.withLock(`request-send-${requestHash}`, () => {
            const existing = this.findPending('send', requestHash);
            if (existing) return existing as SendOperationReceipt;
            return this.createSendReceipt(randomUUID(), requestHash, createMutation);
        });
    }

    claimSpawn(
        requestHash: string,
        requestedOperationId?: string,
    ): SpawnOperationReceipt {
        this.assertRequestHash(requestHash);
        this.pruneExpired();
        if (requestedOperationId) {
            const operationId = normalizeOperationId(requestedOperationId);
            return this.withLock(`operation-${operationId}`, () => {
                const existing = this.read(operationId);
                if (existing) {
                    this.assertMatches(existing, 'spawn', requestHash);
                    return existing as SpawnOperationReceipt;
                }
                return this.createSpawnReceipt(operationId, requestHash);
            });
        }

        return this.withLock(`request-spawn-${requestHash}`, () => {
            const existing = this.findPending('spawn', requestHash);
            if (existing) return existing as SpawnOperationReceipt;
            return this.createSpawnReceipt(randomUUID(), requestHash);
        });
    }

    private createSpawnReceipt(operationId: string, requestHash: string): SpawnOperationReceipt {
        const receipt: SpawnOperationReceipt = {
            version: RECEIPT_VERSION,
            kind: 'spawn',
            operationId,
            requestHash,
            status: 'pending',
            createdAt: Date.now(),
            acknowledgedAt: null,
            sessionId: null,
        };
        const persisted = this.writeNew(receipt);
        this.assertMatches(persisted, 'spawn', requestHash);
        return persisted as SpawnOperationReceipt;
    }

    recordSpawnSuccess(operationId: string, sessionId: string): SpawnOperationReceipt {
        const normalizedOperationId = normalizeOperationId(operationId);
        if (sessionId.trim().length === 0) throw new Error('Spawn session ID must not be empty');
        return this.withLock(`operation-${normalizedOperationId}`, () => {
            const receipt = this.requireReceipt(normalizedOperationId);
            if (receipt.kind !== 'spawn') {
                throw new OperationReceiptConflictError(
                    `Operation ${receipt.operationId} belongs to send, not spawn`,
                );
            }
            if (receipt.sessionId && receipt.sessionId !== sessionId) {
                throw new OperationReceiptConflictError(
                    `Operation ${receipt.operationId} returned a different session`,
                );
            }
            if (receipt.sessionId === sessionId) return receipt;
            const updated = { ...receipt, sessionId };
            this.replace(updated);
            return updated;
        });
    }

    markAcknowledged(operationId: string): void {
        const normalizedOperationId = normalizeOperationId(operationId);
        this.withLock(`operation-${normalizedOperationId}`, () => {
            const receipt = this.requireReceipt(normalizedOperationId);
            if (receipt.status === 'acknowledged') return;
            this.replace({
                ...receipt,
                status: 'acknowledged',
                acknowledgedAt: Date.now(),
            });
        });
    }

    pruneExpired(now = Date.now()): number {
        let removed = 0;
        for (const receipt of this.readAll()) {
            if (receipt.status !== 'acknowledged') continue;
            this.withLock(`operation-${receipt.operationId}`, () => {
                const current = this.read(receipt.operationId);
                if (
                    !current
                    || current.status !== 'acknowledged'
                    || now - (current.acknowledgedAt ?? current.createdAt) <= ACKNOWLEDGED_RETENTION_MS
                ) {
                    return;
                }
                rmSync(this.receiptPath(current.operationId), { force: true });
                removed += 1;
            });
        }
        return removed;
    }

    private resolve(
        kind: OperationReceipt['kind'],
        requestHash: string,
        requestedOperationId?: string,
    ): OperationReceipt | null {
        this.assertRequestHash(requestHash);
        this.pruneExpired();
        if (requestedOperationId) {
            const operationId = normalizeOperationId(requestedOperationId);
            const receipt = this.read(operationId);
            if (receipt) this.assertMatches(receipt, kind, requestHash);
            return receipt;
        }

        return this.findPending(kind, requestHash);
    }

    private findPending(
        kind: OperationReceipt['kind'],
        requestHash: string,
    ): OperationReceipt | null {
        const pending = this.readAll().filter((receipt) => (
            receipt.kind === kind
            && receipt.requestHash === requestHash
            && receipt.status === 'pending'
        ));
        if (pending.length > 1) {
            throw new OperationReceiptConflictError(
                `Multiple pending ${kind} operations match this request; pass --operation-id explicitly`,
            );
        }
        if (pending[0]) {
            return pending[0];
        }
        return null;
    }

    private createSendReceipt(
        operationId: string,
        requestHash: string,
        createMutation: (operationId: string) => SyncMutationV4,
    ): SendOperationReceipt {
        const mutation = SyncMutationV4Schema.parse(createMutation(operationId));
        this.assertSendMutationIdentity(operationId, mutation);
        const receipt: SendOperationReceipt = {
            version: RECEIPT_VERSION,
            kind: 'send',
            operationId,
            requestHash,
            status: 'pending',
            createdAt: Date.now(),
            acknowledgedAt: null,
            mutation,
        };
        const persisted = this.writeNew(receipt);
        this.assertMatches(persisted, 'send', requestHash);
        return persisted as SendOperationReceipt;
    }

    private writeNew(receipt: OperationReceipt): OperationReceipt {
        this.ensureDirectory();
        const destination = this.receiptPath(receipt.operationId);
        const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(temporary, this.serialize(receipt), {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        try {
            linkSync(temporary, destination);
            chmodSync(destination, 0o600);
            return receipt;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                return this.requireReceipt(receipt.operationId);
            }
            throw error;
        } finally {
            rmSync(temporary, { force: true });
        }
    }

    private replace(receipt: OperationReceipt): void {
        this.ensureDirectory();
        const destination = this.receiptPath(receipt.operationId);
        const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(temporary, this.serialize(receipt), {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        try {
            renameSync(temporary, destination);
            chmodSync(destination, 0o600);
        } finally {
            rmSync(temporary, { force: true });
        }
    }

    private requireReceipt(operationId: string): OperationReceipt {
        const normalizedOperationId = normalizeOperationId(operationId);
        const receipt = this.read(normalizedOperationId);
        if (!receipt) throw new Error(`Operation receipt ${normalizedOperationId} was not found`);
        return receipt;
    }

    private read(operationId: string): OperationReceipt | null {
        let raw: string;
        try {
            raw = readFileSync(this.receiptPath(operationId), 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
        try {
            return this.parse(raw);
        } catch (error) {
            throw new Error(`Operation receipt ${operationId} is invalid`, { cause: error });
        }
    }

    private readAll(): OperationReceipt[] {
        let entries;
        try {
            entries = readdirSync(this.directory, { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
        const receipts: OperationReceipt[] = [];
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            try {
                receipts.push(this.parse(readFileSync(join(this.directory, entry.name), 'utf8')));
            } catch (error) {
                throw new Error(`Operation receipt ${entry.name} is invalid`, { cause: error });
            }
        }
        return receipts;
    }

    private parse(raw: string): OperationReceipt {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new SyntaxError('Invalid operation receipt');
        }
        const value = parsed as Record<string, unknown>;
        if (
            value.version !== RECEIPT_VERSION
            || (value.kind !== 'send' && value.kind !== 'spawn')
            || typeof value.operationId !== 'string'
            || normalizeOperationId(value.operationId) !== value.operationId
            || typeof value.requestHash !== 'string'
            || !REQUEST_HASH_PATTERN.test(value.requestHash)
            || (value.status !== 'pending' && value.status !== 'acknowledged')
            || typeof value.createdAt !== 'number'
            || !Number.isSafeInteger(value.createdAt)
            || value.createdAt < 0
            || (value.status === 'pending' && value.acknowledgedAt !== null)
            || (value.status === 'acknowledged' && value.acknowledgedAt === null)
            || (value.acknowledgedAt !== null && (
                typeof value.acknowledgedAt !== 'number'
                || !Number.isSafeInteger(value.acknowledgedAt)
                || value.acknowledgedAt < 0
            ))
        ) {
            throw new SyntaxError('Invalid operation receipt');
        }
        const base = value as unknown as OperationReceiptBase;
        if (base.kind === 'send') {
            try {
                const mutation = SyncMutationV4Schema.parse(value.mutation);
                this.assertSendMutationIdentity(base.operationId, mutation);
                return {
                    ...base,
                    kind: 'send',
                    mutation,
                };
            } catch {
                throw new SyntaxError('Invalid send operation receipt');
            }
        }
        if (
            value.sessionId !== null
            && (typeof value.sessionId !== 'string' || value.sessionId.trim().length === 0)
        ) {
            throw new SyntaxError('Invalid spawn operation receipt');
        }
        return {
            ...base,
            kind: 'spawn',
            sessionId: value.sessionId as string | null,
        };
    }

    private assertMatches(
        receipt: OperationReceipt,
        kind: OperationReceipt['kind'],
        requestHash: string,
    ): void {
        if (receipt.kind !== kind || receipt.requestHash !== requestHash) {
            throw new OperationReceiptConflictError(
                `Operation ${receipt.operationId} is already bound to a different request`,
            );
        }
    }

    private assertRequestHash(requestHash: string): void {
        if (!REQUEST_HASH_PATTERN.test(requestHash)) {
            throw new Error('Operation request hash is invalid');
        }
    }

    private assertSendMutationIdentity(operationId: string, mutation: SyncMutationV4): void {
        if (
            mutation.mutationId !== operationId
            || mutation.producerId !== `happy-agent-${operationId}`
        ) {
            throw new Error(`Send mutation does not match operation ${operationId}`);
        }
    }

    private ensureDirectory(): void {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        chmodSync(this.directory, 0o700);
    }

    private withLock<T>(name: string, action: () => T): T {
        this.ensureDirectory();
        const lockDirectory = join(this.directory, '.locks', name);
        mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
        chmodSync(lockDirectory, 0o700);
        const deadline = Date.now() + LOCK_WAIT_MS;
        let ownedClaim: ReceiptLockClaim | null = null;
        while (!ownedClaim) {
            const latest = this.readLatestLockClaim(lockDirectory, name);
            if (latest && !this.lockClaimMayAdvance(lockDirectory, name, latest)) {
                if (Date.now() >= deadline) {
                    throw new Error(`Timed out waiting for operation receipt lock ${name}`);
                }
                Atomics.wait(LOCK_WAIT_SIGNAL, 0, 0, LOCK_POLL_MS);
                continue;
            }

            const candidate: ReceiptLockClaim = {
                version: 1,
                name,
                generation: (latest?.generation ?? -1) + 1,
                ownerId: randomUUID(),
                pid: process.pid,
                createdAt: Date.now(),
            };
            if (this.writeNewLockRecord(
                this.lockClaimPath(lockDirectory, candidate.generation),
                candidate,
            )) {
                ownedClaim = candidate;
            }
        }
        try {
            return action();
        } finally {
            this.completeLockClaim(lockDirectory, ownedClaim);
        }
    }

    private readLatestLockClaim(
        lockDirectory: string,
        name: string,
    ): ReceiptLockClaimSnapshot | null {
        let generation = -1;
        for (const entry of readdirSync(lockDirectory, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const match = LOCK_CLAIM_FILE_PATTERN.exec(entry.name);
            if (!match) continue;
            const candidate = Number(match[1]);
            if (Number.isSafeInteger(candidate) && candidate > generation) generation = candidate;
        }
        if (generation < 0) return null;

        const path = this.lockClaimPath(lockDirectory, generation);
        let claim: ReceiptLockClaim | null = null;
        try {
            claim = this.parseLockClaim(readFileSync(path, 'utf8'), name, generation);
        } catch {
            // Partial or corrupt claims block takeover until their grace period expires.
        }
        return { generation, claim, mtimeMs: statSync(path).mtimeMs };
    }

    private lockClaimMayAdvance(
        lockDirectory: string,
        name: string,
        snapshot: ReceiptLockClaimSnapshot,
    ): boolean {
        if (!snapshot.claim) {
            return Date.now() - snapshot.mtimeMs >= INVALID_LOCK_CLAIM_GRACE_MS;
        }
        if (this.lockClaimIsCompleted(lockDirectory, name, snapshot.claim)) return true;
        return !this.isProcessAlive(snapshot.claim.pid);
    }

    private lockClaimIsCompleted(
        lockDirectory: string,
        name: string,
        claim: ReceiptLockClaim,
    ): boolean {
        try {
            const completion = this.parseLockCompletion(
                readFileSync(this.lockCompletionPath(lockDirectory, claim.generation), 'utf8'),
                name,
                claim.generation,
            );
            return completion.ownerId === claim.ownerId;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            return false;
        }
    }

    private completeLockClaim(lockDirectory: string, claim: ReceiptLockClaim): void {
        const completion: ReceiptLockCompletion = {
            version: 1,
            name: claim.name,
            generation: claim.generation,
            ownerId: claim.ownerId,
            completedAt: Date.now(),
        };
        const path = this.lockCompletionPath(lockDirectory, claim.generation);
        if (this.writeNewLockRecord(path, completion)) return;
        const existing = this.parseLockCompletion(
            readFileSync(path, 'utf8'),
            claim.name,
            claim.generation,
        );
        if (existing.ownerId !== claim.ownerId) {
            throw new Error(`Operation receipt lock ${claim.name} changed ownership`);
        }
    }

    private writeNewLockRecord(path: string, value: unknown): boolean {
        try {
            writeFileSync(path, `${JSON.stringify(value)}\n`, {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600,
            });
            chmodSync(path, 0o600);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
            throw error;
        }
    }

    private parseLockClaim(raw: string, name: string, generation: number): ReceiptLockClaim {
        const value = JSON.parse(raw) as Partial<ReceiptLockClaim>;
        if (
            value.version !== 1
            || value.name !== name
            || value.generation !== generation
            || typeof value.ownerId !== 'string'
            || !UUID_PATTERN.test(value.ownerId)
            || typeof value.pid !== 'number'
            || !Number.isInteger(value.pid)
            || value.pid <= 0
            || typeof value.createdAt !== 'number'
            || !Number.isSafeInteger(value.createdAt)
            || value.createdAt < 0
        ) {
            throw new SyntaxError('Invalid operation receipt lock claim');
        }
        return value as ReceiptLockClaim;
    }

    private parseLockCompletion(
        raw: string,
        name: string,
        generation: number,
    ): ReceiptLockCompletion {
        const value = JSON.parse(raw) as Partial<ReceiptLockCompletion>;
        if (
            value.version !== 1
            || value.name !== name
            || value.generation !== generation
            || typeof value.ownerId !== 'string'
            || !UUID_PATTERN.test(value.ownerId)
            || typeof value.completedAt !== 'number'
            || !Number.isSafeInteger(value.completedAt)
            || value.completedAt < 0
        ) {
            throw new SyntaxError('Invalid operation receipt lock completion');
        }
        return value as ReceiptLockCompletion;
    }

    private isProcessAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    private lockClaimPath(lockDirectory: string, generation: number): string {
        return join(lockDirectory, `claim-${generation}.json`);
    }

    private lockCompletionPath(lockDirectory: string, generation: number): string {
        return join(lockDirectory, `done-${generation}.json`);
    }

    private receiptPath(operationId: string): string {
        return join(this.directory, `${normalizeOperationId(operationId)}.json`);
    }

    private serialize(receipt: OperationReceipt): string {
        return `${JSON.stringify(receipt)}\n`;
    }
}

function operationRequestHash(parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
