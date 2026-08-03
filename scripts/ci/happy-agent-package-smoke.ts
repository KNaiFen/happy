import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'socket.io';
import {
    decodeBase64,
    decryptLegacy,
    encodeBase64,
    encryptLegacy,
} from '../../packages/happy-agent/src/encryption';

type CommandResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code) => {
            resolve({ exitCode: code ?? 1, stdout, stderr });
        });
    });
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address();
    assert(address && typeof address !== 'string', 'fake relay did not bind a TCP port');
    return address.port;
}

async function close(server: ReturnType<typeof createServer>, io: Server): Promise<void> {
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function main(): Promise<void> {
    const binPath = process.argv[2];
    assert(binPath, 'Usage: happy-agent-package-smoke.ts <installed-bin-path>');

    const homeDir = await mkdtemp(join(tmpdir(), 'happy-agent-package-smoke-'));
    const secret = new Uint8Array(randomBytes(32));
    const token = 'packed-happy-agent-smoke-token';
    const machineId = 'packed-agent-machine';
    const machineMetadata = { homeDir: '/workspace' };
    const rawMachine = {
        id: machineId,
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active: true,
        activeAt: Date.now(),
        metadata: encodeBase64(encryptLegacy(machineMetadata, secret)),
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey: null,
    };

    let rpcPayload: Record<string, unknown> | null = null;
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/v1/machines' && request.method === 'GET') {
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify([rawMachine]));
            return;
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'not found' }));
    });
    const io = new Server(server, {
        path: '/v1/updates',
        transports: ['websocket'],
        serveClient: false,
    });
    io.use((socket, next) => {
        try {
            assert.equal(socket.handshake.auth.token, token);
            next();
        } catch (error) {
            next(error as Error);
        }
    });
    io.on('connection', (socket) => {
        socket.on('rpc-call', (request: { method?: unknown; params?: unknown }, acknowledge) => {
            try {
                assert.equal(request.method, `${machineId}:spawn-happy-session`);
                if (typeof request.params !== 'string') {
                    throw new TypeError('RPC parameters must be encoded text');
                }
                const decrypted = decryptLegacy(decodeBase64(request.params), secret);
                assert(decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted));
                rpcPayload = decrypted as Record<string, unknown>;
                acknowledge({
                    ok: true,
                    result: encodeBase64(encryptLegacy({ type: 'success', sessionId: 'packed-agent-session' }, secret)),
                });
            } catch (error) {
                acknowledge({ ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        });
    });

    try {
        await mkdir(homeDir, { recursive: true, mode: 0o700 });
        await writeFile(
            join(homeDir, 'agent.key'),
            JSON.stringify({ token, secret: encodeBase64(secret) }),
            { mode: 0o600 },
        );
        const port = await listen(server);
        const env = {
            ...process.env,
            HAPPY_HOME_DIR: homeDir,
            HAPPY_SERVER_URL: `http://127.0.0.1:${port}`,
        };

        const spawnResult = await runCommand(process.execPath, [
            '--no-warnings',
            '--no-deprecation',
            binPath,
            'spawn',
            '--machine', machineId,
            '--path', '/workspace',
            '--json',
        ], env);
        assert.equal(spawnResult.exitCode, 0, spawnResult.stderr);
        const output = JSON.parse(spawnResult.stdout) as { agent?: unknown; sessionId?: unknown };
        assert.equal(output.agent, 'codex');
        assert.equal(output.sessionId, 'packed-agent-session');
        assert.deepEqual(rpcPayload, {
            type: 'spawn-in-directory',
            directory: '/workspace',
            approvedNewDirectoryCreation: false,
            agent: 'codex',
        });

        const removedAgentResult = await runCommand(process.execPath, [
            '--no-warnings',
            '--no-deprecation',
            binPath,
            'spawn',
            '--machine', machineId,
            '--agent', 'claude',
        ], env);
        assert.notEqual(removedAgentResult.exitCode, 0);
        assert.match(removedAgentResult.stderr, /unknown option '--agent'/);
        console.log('happy-agent packaged Codex spawn and removed-agent rejection passed');
    } finally {
        await close(server, io);
        await rm(homeDir, { recursive: true, force: true });
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
