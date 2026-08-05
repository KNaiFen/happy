import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCodexGatewayOperationLock } from './codexGatewayOperationLock';

const operationId = 'd94231c7-6601-483f-a8f3-92912d759423';

describe('Codex Gateway operation lock', () => {
    let happyHomeDir: string;

    beforeEach(async () => {
        happyHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-operation-lock-'));
    });

    afterEach(async () => {
        await rm(happyHomeDir, { recursive: true, force: true });
    });

    it('serializes concurrent work for the same operation across callers', async () => {
        const entered: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const first = withCodexGatewayOperationLock(operationId, async () => {
            entered.push('first');
            await firstGate;
            return 'first-result';
        }, { happyHomeDir, pollMs: 1 });

        await vi.waitFor(() => expect(entered).toEqual(['first']));
        const second = withCodexGatewayOperationLock(operationId, async () => {
            entered.push('second');
            return 'second-result';
        }, { happyHomeDir, pollMs: 1 });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(entered).toEqual(['first']);

        const operationDir = join(
            happyHomeDir,
            'codex-gateways',
            'operations',
            operationId,
        );
        const claimPath = join(operationDir, 'claim-0.json');
        expect(JSON.parse(await readFile(claimPath, 'utf8'))).toMatchObject({ operationId });
        if (process.platform !== 'win32') {
            expect((await stat(operationDir)).mode & 0o777).toBe(0o700);
            expect((await stat(claimPath)).mode & 0o777).toBe(0o600);
        }

        releaseFirst();
        await expect(Promise.all([first, second])).resolves.toEqual([
            'first-result',
            'second-result',
        ]);
        expect(entered).toEqual(['first', 'second']);
    });

    it('serializes two stale-claim recoverers and a third concurrent caller', async () => {
        const operationDir = join(
            happyHomeDir,
            'codex-gateways',
            'operations',
            operationId,
        );
        await mkdir(operationDir, { recursive: true });
        await writeFile(join(operationDir, 'claim-0.json'), `${JSON.stringify({
            version: 1,
            operationId,
            generation: 0,
            ownerId: randomUUID(),
            pid: 999_999,
            createdAt: Date.now(),
        })}\n`, { mode: 0o600 });

        let active = 0;
        let maxActive = 0;
        const run = async (name: string) => await withCodexGatewayOperationLock(
            operationId,
            async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active -= 1;
                return name;
            },
            {
                happyHomeDir,
                pollMs: 1,
                isProcessAlive: (pid) => pid === process.pid,
            },
        );

        await expect(Promise.all([
            run('first-recoverer'),
            run('second-recoverer'),
            run('third-caller'),
        ])).resolves.toEqual([
            'first-recoverer',
            'second-recoverer',
            'third-caller',
        ]);
        expect(maxActive).toBe(1);
        expect((await readdir(operationDir)).filter((name) => name.startsWith('claim-')))
            .toHaveLength(4);
    });
});
