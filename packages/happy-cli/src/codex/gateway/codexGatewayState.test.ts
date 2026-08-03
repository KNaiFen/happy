import { mkdir, mkdtemp, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    assertPrivateFile,
    assertCodexGatewayUnixSocketPath,
    codexGatewayPaths,
    codexGatewayRuntimeRoot,
    CodexGatewaySocketPathTooLongError,
    createCodexGatewayFiles,
    listCodexGatewayDescriptors,
    MAX_CODEX_GATEWAY_UNIX_SOCKET_PATH_BYTES,
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
            bootstrapOperationId: '6e997fc4-bf4c-4ca0-a36d-c59e2f79ba37',
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
        expect(created.secret).not.toHaveProperty('normalExitNonce');
        expect(created.secret.sessionKeySeed).toHaveLength(43);
        expect(created.descriptor.bootstrapOperationId).toBe('6e997fc4-bf4c-4ca0-a36d-c59e2f79ba37');
        expect(created.descriptor.providerPid).toBeNull();
        expect(created.paths.journalPath).toBe(join(created.paths.gatewayDir, 'gateway.jsonl'));
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
        expect(Buffer.byteLength(paths.providerSocketPath, 'utf8')).toBeLessThan(100);
        expect(paths.providerSocketPath).toBe('/tmp/happy-codex-test/a55de6bfec6b4f37/provider.sock');
    });

    it('keeps the default POSIX provider endpoint within the conservative limit', () => {
        if (process.platform === 'win32') return;
        const paths = codexGatewayPaths('a55de6bf-ec6b-4f37-940d-792b86365abc', {
            happyHomeDir: '/Users/example/.happy',
        });

        expect(Buffer.byteLength(paths.providerSocketPath, 'utf8'))
            .toBeLessThanOrEqual(MAX_CODEX_GATEWAY_UNIX_SOCKET_PATH_BYTES);
    });

    it('falls back to a private short root when the macOS temp path is too long', () => {
        const happyHomeDir = '/Users/example/.happy';
        const longSystemTmpDir = join('/private/var/folders', '\u76ee\u5f55'.repeat(24), 'T');
        const runtimeRoot = codexGatewayRuntimeRoot(happyHomeDir, longSystemTmpDir, 'darwin');
        const paths = codexGatewayPaths('a55de6bf-ec6b-4f37-940d-792b86365abc', {
            happyHomeDir,
            runtimeRoot,
        });

        expect(runtimeRoot).toMatch(/^\/tmp\/happy-codex-[0-9a-f]{12}$/);
        expect(Buffer.byteLength(paths.providerSocketPath, 'utf8'))
            .toBeLessThanOrEqual(MAX_CODEX_GATEWAY_UNIX_SOCKET_PATH_BYTES);
    });

    it('keeps a macOS temp root when the complete provider path fits', () => {
        expect(codexGatewayRuntimeRoot('/Users/example/.happy', '/private/tmp', 'darwin'))
            .toMatch(/^\/private\/tmp\/happy-codex-[0-9a-f]{12}$/);
    });

    it('checks Unix socket limits in UTF-8 bytes including the null terminator boundary', () => {
        const maximumPath = `/${'a'.repeat(MAX_CODEX_GATEWAY_UNIX_SOCKET_PATH_BYTES - 1)}`;
        const oversizedPath = `${maximumPath}a`;

        expect(Buffer.byteLength(maximumPath, 'utf8')).toBe(103);
        expect(() => assertCodexGatewayUnixSocketPath(maximumPath, 'darwin')).not.toThrow();
        expect(Buffer.byteLength(oversizedPath, 'utf8')).toBe(104);
        expect(() => assertCodexGatewayUnixSocketPath(oversizedPath, 'darwin'))
            .toThrow(CodexGatewaySocketPathTooLongError);
        expect(() => assertCodexGatewayUnixSocketPath(`/${'\u76ee\u5f55'.repeat(18)}`, 'darwin'))
            .toThrow(CodexGatewaySocketPathTooLongError);
    });

    it('rejects a pre-created symlink for the private runtime root', async () => {
        if (process.platform === 'win32') return;
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-state-'));
        roots.push(root);
        const runtimeTarget = join(root, 'runtime-target');
        const runtimeRoot = join(root, 'runtime-link');
        await mkdir(runtimeTarget);
        await symlink(runtimeTarget, runtimeRoot, 'dir');

        await expect(createCodexGatewayFiles({
            cwd: '/workspace/project',
            origin: 'terminal',
            happyHomeDir: join(root, 'happy'),
            runtimeRoot,
        })).rejects.toThrow('private directory is not a directory');
    });
});
