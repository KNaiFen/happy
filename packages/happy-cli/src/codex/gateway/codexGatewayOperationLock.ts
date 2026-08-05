import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { codexGatewayStateRoot } from './codexGatewayState';

const DEFAULT_WAIT_MS = 90_000;
const DEFAULT_POLL_MS = 25;
const INVALID_CLAIM_GRACE_MS = 120_000;
const CLAIM_FILE_PATTERN = /^claim-(\d+)\.json$/;

const OperationIdSchema = z.string().uuid();
const ClaimSchema = z.object({
    version: z.literal(1),
    operationId: OperationIdSchema,
    generation: z.number().int().nonnegative(),
    ownerId: z.string().uuid(),
    pid: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
}).strict();
const CompletionSchema = z.object({
    version: z.literal(1),
    operationId: OperationIdSchema,
    generation: z.number().int().nonnegative(),
    ownerId: z.string().uuid(),
    completedAt: z.number().int().nonnegative(),
}).strict();

type OperationClaim = z.infer<typeof ClaimSchema>;

interface ClaimSnapshot {
    generation: number;
    claim: OperationClaim | null;
    mtimeMs: number;
}

export interface CodexGatewayOperationLockOptions {
    happyHomeDir?: string;
    timeoutMs?: number;
    pollMs?: number;
    invalidClaimGraceMs?: number;
    pid?: number;
    now?: () => number;
    isProcessAlive?: (pid: number) => boolean;
}

export function normalizeCodexGatewayOperationId(value: string): string {
    return OperationIdSchema.parse(value.trim().toLowerCase());
}

export async function withCodexGatewayOperationLock<T>(
    operationId: string,
    operation: () => Promise<T>,
    options: CodexGatewayOperationLockOptions = {},
): Promise<T> {
    const normalizedOperationId = normalizeCodexGatewayOperationId(operationId);
    const now = options.now ?? Date.now;
    const operationDir = join(
        codexGatewayStateRoot(options.happyHomeDir),
        'operations',
        normalizedOperationId,
    );
    const deadline = now() + (options.timeoutMs ?? DEFAULT_WAIT_MS);

    await mkdir(operationDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(operationDir, 0o700);

    let ownedClaim: OperationClaim | null = null;
    while (!ownedClaim) {
        const latest = await readLatestClaim(operationDir);
        if (latest && !await claimMayAdvance(operationDir, latest, options, now())) {
            if (now() >= deadline) {
                throw new Error(`Timed out waiting for Codex Gateway operation ${normalizedOperationId}`);
            }
            await delay(options.pollMs ?? DEFAULT_POLL_MS);
            continue;
        }

        const generation = (latest?.generation ?? -1) + 1;
        const candidate = ClaimSchema.parse({
            version: 1,
            operationId: normalizedOperationId,
            generation,
            ownerId: randomUUID(),
            pid: options.pid ?? process.pid,
            createdAt: Math.max(0, Math.trunc(now())),
        });
        if (await writeNewJson(claimPath(operationDir, generation), candidate)) {
            ownedClaim = candidate;
            break;
        }
    }

    try {
        return await operation();
    } finally {
        await completeClaim(operationDir, ownedClaim, now());
    }
}

async function claimMayAdvance(
    operationDir: string,
    snapshot: ClaimSnapshot,
    options: CodexGatewayOperationLockOptions,
    now: number,
): Promise<boolean> {
    if (!snapshot.claim) {
        return now - snapshot.mtimeMs >= (options.invalidClaimGraceMs ?? INVALID_CLAIM_GRACE_MS);
    }
    if (await claimIsCompleted(operationDir, snapshot.claim)) return true;
    return !(options.isProcessAlive ?? isProcessAlive)(snapshot.claim.pid);
}

async function readLatestClaim(operationDir: string): Promise<ClaimSnapshot | null> {
    const entries = await readdir(operationDir, { withFileTypes: true });
    let generation = -1;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const match = CLAIM_FILE_PATTERN.exec(entry.name);
        if (!match) continue;
        const candidate = Number(match[1]);
        if (Number.isSafeInteger(candidate) && candidate > generation) generation = candidate;
    }
    if (generation < 0) return null;

    const path = claimPath(operationDir, generation);
    const [raw, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    let claim: OperationClaim | null = null;
    try {
        const parsed = ClaimSchema.parse(JSON.parse(raw));
        if (parsed.generation === generation) claim = parsed;
    } catch {
        // A partial or corrupt claim blocks takeover until the grace period expires.
    }
    return { generation, claim, mtimeMs: metadata.mtimeMs };
}

async function claimIsCompleted(
    operationDir: string,
    claim: OperationClaim,
): Promise<boolean> {
    try {
        const completion = CompletionSchema.parse(JSON.parse(
            await readFile(completionPath(operationDir, claim.generation), 'utf8'),
        ));
        return completion.operationId === claim.operationId
            && completion.generation === claim.generation
            && completion.ownerId === claim.ownerId;
    } catch (error) {
        if (isNodeError(error, 'ENOENT')) return false;
        return false;
    }
}

async function completeClaim(
    operationDir: string,
    claim: OperationClaim,
    now: number,
): Promise<void> {
    const completion = CompletionSchema.parse({
        version: 1,
        operationId: claim.operationId,
        generation: claim.generation,
        ownerId: claim.ownerId,
        completedAt: Math.max(0, Math.trunc(now)),
    });
    const path = completionPath(operationDir, claim.generation);
    if (await writeNewJson(path, completion)) return;

    const existing = CompletionSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (
        existing.operationId !== completion.operationId
        || existing.generation !== completion.generation
        || existing.ownerId !== completion.ownerId
    ) {
        throw new Error(`Codex Gateway operation claim ${claim.generation} changed ownership`);
    }
}

async function writeNewJson(path: string, value: unknown): Promise<boolean> {
    let handle;
    try {
        handle = await open(path, 'wx', 0o600);
    } catch (error) {
        if (isNodeError(error, 'EEXIST')) return false;
        throw error;
    }
    try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    if (process.platform !== 'win32') await chmod(path, 0o600);
    return true;
}

function claimPath(operationDir: string, generation: number): string {
    return join(operationDir, `claim-${generation}.json`);
}

function completionPath(operationDir: string, generation: number): string {
    return join(operationDir, `done-${generation}.json`);
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
