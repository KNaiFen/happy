import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    assertPrivateFile,
    codexGatewayPaths,
    createCodexGatewayFiles,
    listCodexGatewayDescriptors,
    readCodexGatewayDescriptor,
    readCodexGatewaySecret,
    removeCodexGatewayFiles,
    writeCodexGatewayDescriptor,
} from './codexGatewayState';

const roots: string[] = [];

afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex Gateway state', () => {
    it('writes private atomic descriptor and secret files and scans them after restart', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-state-'));
        roots.push(root);
        const happyHomeDir = join(root, 'happy');
        const runtimeRoot = join(root, 'runtime');
        const created = await createCodexGatewayFiles({
            cwd: '/workspace/project',
            origin: 'terminal',
            happyHomeDir,
            runtimeRoot,
            now: 100,
        });
        const running = {
            ...created.descriptor,
            pid: 123,
            state: 'running' as const,
            heartbeatAt: 150,
        };
        await writeCodexGatewayDescriptor(created.paths, running);

        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toEqual(running);
        expect(await readCodexGatewaySecret(created.paths.secretPath)).toEqual(created.secret);
        expect(await listCodexGatewayDescriptors({ happyHomeDir })).toEqual([running]);
        expect(JSON.parse(await readFile(created.paths.secretPath, 'utf8'))).not.toHaveProperty('threadId');
        if (process.platform !== 'win32') {
            await assertPrivateFile(created.paths.descriptorPath);
            await assertPrivateFile(created.paths.secretPath);
            expect((await stat(created.paths.gatewayDir)).mode & 0o777).toBe(0o700);
        }

        await removeCodexGatewayFiles(created.paths);
        expect(await readCodexGatewayDescriptor(created.paths.descriptorPath)).toBeNull();
    });

    it('uses short runtime paths independent of a long Happy home path', () => {
        const paths = codexGatewayPaths('a55de6bf-ec6b-4f37-940d-792b86365abc', {
            happyHomeDir: `/very/${'long/'.repeat(30)}profile`,
            runtimeRoot: '/tmp/happy-codex-test',
        });
        expect(paths.providerSocketPath.length).toBeLessThan(100);
        expect(paths.providerSocketPath).toBe('/tmp/happy-codex-test/a55de6bfec6b4f37/provider.sock');
    });
});
