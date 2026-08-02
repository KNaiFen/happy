import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { codexGatewayStateRoot } from './codexGatewayState';

const LeaseSchema = z.object({
    version: z.literal(1),
    gatewayId: z.string().uuid(),
    threadId: z.string().min(1).max(512),
    pid: z.number().int().positive(),
    acquiredAt: z.number().int().nonnegative(),
}).strict();
type Lease = z.infer<typeof LeaseSchema>;

export class CodexGatewayThreadLeaseConflictError extends Error {
    constructor(readonly ownerGatewayId: string) {
        super('The selected Codex thread is already owned by another Happy Gateway');
        this.name = 'CodexGatewayThreadLeaseConflictError';
    }
}

export class CodexGatewayThreadLeaseRegistry {
    private keyPromise: Promise<Buffer> | null = null;

    constructor(
        private readonly options: {
            happyHomeDir?: string;
            pid?: number;
            now?: () => number;
            isProcessAlive?: (pid: number) => boolean;
        } = {},
    ) {}

    async acquire(threadId: string, gatewayId: string): Promise<void> {
        await this.withRegistryLock(async () => {
            const path = await this.leasePath(threadId);
            const current = await this.readLease(path);
            if (current && current.gatewayId !== gatewayId && this.isProcessAlive(current.pid)) {
                throw new CodexGatewayThreadLeaseConflictError(current.gatewayId);
            }
            if (current && current.gatewayId === gatewayId) return;
            if (current) await rm(path, { force: true });
            const lease: Lease = {
                version: 1,
                gatewayId,
                threadId,
                pid: this.options.pid ?? process.pid,
                acquiredAt: Math.max(0, Math.trunc(this.options.now?.() ?? Date.now())),
            };
            await this.writeLease(path, lease);
        });
    }

    async release(threadId: string, gatewayId: string): Promise<boolean> {
        return await this.withRegistryLock(async () => {
            const path = await this.leasePath(threadId);
            const current = await this.readLease(path);
            if (!current || current.gatewayId !== gatewayId) return false;
            await rm(path, { force: true });
            return true;
        });
    }

    async owner(threadId: string): Promise<string | null> {
        return await this.withRegistryLock(async () => {
            const path = await this.leasePath(threadId);
            const current = await this.readLease(path);
            if (!current) return null;
            if (!this.isProcessAlive(current.pid)) {
                await rm(path, { force: true });
                return null;
            }
            return current.gatewayId;
        });
    }

    private root(): string {
        return join(codexGatewayStateRoot(this.options.happyHomeDir), 'leases');
    }

    private async leasePath(threadId: string): Promise<string> {
        if (threadId.length === 0 || threadId.length > 512) throw new Error('Invalid Codex thread ID');
        const key = await this.key();
        const digest = createHmac('sha256', key)
            .update('Happy Codex Gateway Thread Lease v1\0', 'utf8')
            .update(threadId, 'utf8')
            .digest('hex');
        return join(this.root(), `${digest}.json`);
    }

    private key(): Promise<Buffer> {
        if (!this.keyPromise) this.keyPromise = this.readOrCreateKey();
        return this.keyPromise;
    }

    private async readOrCreateKey(): Promise<Buffer> {
        const root = this.root();
        await mkdir(root, { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') await chmod(root, 0o700);
        const path = join(root, 'lease.key');
        try {
            const current = await readFile(path);
            if (current.length !== 32) throw new Error('Invalid Gateway lease key');
            return current;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const key = randomBytes(32);
        try {
            const handle = await open(path, 'wx', 0o600);
            try {
                await handle.writeFile(key);
                await handle.sync();
            } finally {
                await handle.close();
            }
            return key;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const current = await readFile(path);
            if (current.length !== 32) throw new Error('Invalid Gateway lease key');
            return current;
        }
    }

    private async readLease(path: string): Promise<Lease | null> {
        try {
            return LeaseSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            await rm(path, { force: true });
            return null;
        }
    }

    private async writeLease(path: string, lease: Lease): Promise<void> {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(lease)}\n`, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, path);
        if (process.platform !== 'win32') await chmod(path, 0o600);
    }

    private async withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
        const root = this.root();
        await mkdir(root, { recursive: true, mode: 0o700 });
        const lockPath = join(root, 'registry.lock');
        for (let attempt = 0; attempt < 100; attempt += 1) {
            try {
                const handle = await open(lockPath, 'wx', 0o600);
                try {
                    return await operation();
                } finally {
                    await handle.close();
                    await rm(lockPath, { force: true });
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                try {
                    if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) {
                        await rm(lockPath, { force: true });
                    }
                } catch {
                    // The owner may have released the lock between stat and removal.
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        throw new Error('Timed out acquiring the Codex Gateway lease registry');
    }

    private isProcessAlive(pid: number): boolean {
        if (this.options.isProcessAlive) return this.options.isProcessAlive(pid);
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }
}
