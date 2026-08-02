import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    CodexGatewayThreadLeaseConflictError,
    CodexGatewayThreadLeaseRegistry,
} from './codexGatewayLease';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex Gateway thread leases', () => {
    it('prevents two live Gateways from owning one provider thread', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happy-gateway-lease-'));
        roots.push(happyHomeDir);
        const registry = new CodexGatewayThreadLeaseRegistry({
            happyHomeDir,
            pid: 10,
            isProcessAlive: () => true,
        });
        const first = '3257e096-5eb3-46ca-a4f7-c55136c3ab07';
        const second = '0de7bbdc-dd58-4724-9e61-b5ad3664c003';
        await registry.acquire('provider-thread-1', first);
        await expect(registry.acquire('provider-thread-1', second))
            .rejects.toBeInstanceOf(CodexGatewayThreadLeaseConflictError);
        expect(await registry.owner('provider-thread-1')).toBe(first);
        expect(await registry.release('provider-thread-1', second)).toBe(false);
        expect(await registry.release('provider-thread-1', first)).toBe(true);
        expect(await registry.owner('provider-thread-1')).toBeNull();
    });

    it('reclaims a lease only after its recorded process is dead', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happy-gateway-lease-'));
        roots.push(happyHomeDir);
        let alive = true;
        const first = new CodexGatewayThreadLeaseRegistry({
            happyHomeDir,
            pid: 10,
            isProcessAlive: () => alive,
        });
        await first.acquire('provider-thread-1', '3257e096-5eb3-46ca-a4f7-c55136c3ab07');
        alive = false;
        const replacement = new CodexGatewayThreadLeaseRegistry({
            happyHomeDir,
            pid: 11,
            isProcessAlive: (pid) => pid === 11,
        });
        await replacement.acquire('provider-thread-1', '0de7bbdc-dd58-4724-9e61-b5ad3664c003');
        expect(await replacement.owner('provider-thread-1'))
            .toBe('0de7bbdc-dd58-4724-9e61-b5ad3664c003');
    });
});
