import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
    buildCodexGatewayProviderArgs,
    CodexGatewayProvider,
} from './codexGatewayProvider';

describe('Codex Gateway provider supervisor', () => {
    it('builds official Unix and authenticated loopback app-server arguments', () => {
        expect(buildCodexGatewayProviderArgs({ socketPath: '/tmp/provider.sock' })).toEqual([
            'app-server',
            '--listen',
            'unix:///tmp/provider.sock',
        ]);
        expect(buildCodexGatewayProviderArgs(
            { url: 'ws://127.0.0.1:4500', bearerToken: 'a'.repeat(32) },
            '/tmp/provider-token',
        )).toEqual([
            'app-server',
            '--listen',
            'ws://127.0.0.1:4500',
            '--ws-auth',
            'capability-token',
            '--ws-token-file',
            '/tmp/provider-token',
        ]);
    });

    it('hands a bound Unix listener to the real client for protocol initialization', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-provider-test-'));
        const socketPath = join(root, 'provider.sock');
        const processHandle = fakeProcess(151, true);
        const server = createServer((socket) => socket.destroy());
        const ready = vi.fn();
        const provider = new CodexGatewayProvider({
            cwd: '/workspace',
            endpoint: { socketPath },
            codexCliVersion: { major: 0, minor: 145, patch: 0 },
            spawn: () => {
                server.listen(socketPath);
                return processHandle;
            },
            hooks: { ready },
        });

        await provider.start();
        expect(ready).toHaveBeenCalledWith({ epoch: 1, recovered: false });

        await provider.stop();
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
        await rm(root, { recursive: true, force: true });
    });

    it('restarts an unexpectedly exited owned provider with capped backoff', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-provider-test-'));
        const socketPath = join(root, 'provider.sock');
        const processes = [fakeProcess(101), fakeProcess(102)];
        const spawn = vi.fn(() => processes.shift()!);
        const states: Array<[string, number]> = [];
        const ready = vi.fn();
        const sleep = vi.fn(async () => undefined);
        const provider = new CodexGatewayProvider({
            cwd: '/workspace',
            endpoint: { socketPath },
            codexCliVersion: { major: 0, minor: 145, patch: 0 },
            spawn,
            waitUntilReady: async () => undefined,
            recoveryDelaysMs: [10, 20],
            sleep,
            hooks: {
                stateChanged: (state, attempt) => states.push([state, attempt]),
                ready,
            },
        });

        await provider.start();
        expect(provider.pid).toBe(101);
        expect(spawn).toHaveBeenCalledWith(
            'codex',
            ['app-server', '--listen', `unix://${socketPath}`],
            expect.objectContaining({ cwd: '/workspace', stdio: ['ignore', 'ignore', 'pipe'] }),
        );
        (spawn.mock.results[0]!.value as ChildProcess).emit('exit', 1, null);
        await vi.waitFor(() => expect(provider.pid).toBe(102));

        expect(sleep).toHaveBeenCalledWith(10);
        expect(ready).toHaveBeenNthCalledWith(1, { epoch: 1, recovered: false });
        expect(ready).toHaveBeenNthCalledWith(2, { epoch: 2, recovered: true });
        expect(states).toContainEqual(['recovering', 1]);

        const current = spawn.mock.results[1]!.value as ChildProcess;
        const stopped = provider.stop();
        await vi.waitFor(() => expect(current.kill).toHaveBeenCalledWith('SIGTERM'));
        current.emit('exit', 0, 'SIGTERM');
        await stopped;
        await rm(root, { recursive: true, force: true });
        expect(provider.currentState).toBe('stopped');
        expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('rejects unauthenticated or non-loopback TCP listeners', () => {
        expect(() => new CodexGatewayProvider({
            cwd: '/workspace',
            endpoint: { url: 'ws://0.0.0.0:4500' },
        })).toThrow('loopback');
        expect(() => new CodexGatewayProvider({
            cwd: '/workspace',
            endpoint: { url: 'ws://127.0.0.1:4500' },
        })).toThrow('capability-token');
    });

    it('terminates the owned child when post-listen initialization fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-provider-test-'));
        const processHandle = fakeProcess(201, true);
        const provider = new CodexGatewayProvider({
            cwd: '/workspace',
            endpoint: { socketPath: join(root, 'provider.sock') },
            codexCliVersion: { major: 0, minor: 145, patch: 0 },
            spawn: () => processHandle,
            waitUntilReady: async () => undefined,
            stopTimeoutMs: 50,
            hooks: {
                ready: () => { throw new Error('bridge initialization failed'); },
            },
        });

        await expect(provider.start()).rejects.toThrow('bridge initialization failed');
        expect(processHandle.kill).toHaveBeenCalledWith('SIGTERM');
        expect(provider.pid).toBeNull();
        expect(provider.currentState).toBe('stopped');
        await rm(root, { recursive: true, force: true });
    });

    it('terminates the owned child when persisting its PID fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-provider-test-'));
        const processHandle = fakeProcess(211, true);
        const processChanged = vi.fn(async ({ pid }: { pid: number | null }) => {
            if (pid !== null) throw new Error('descriptor write failed');
        });
        const provider = new CodexGatewayProvider({
            cwd: '/workspace',
            endpoint: { socketPath: join(root, 'provider.sock') },
            codexCliVersion: { major: 0, minor: 145, patch: 0 },
            spawn: () => processHandle,
            waitUntilReady: async () => undefined,
            hooks: { processChanged },
        });

        await expect(provider.start()).rejects.toThrow('descriptor write failed');
        expect(processHandle.kill).toHaveBeenCalledWith('SIGTERM');
        expect(processChanged).toHaveBeenLastCalledWith({ pid: null, adopted: false });
        expect(provider.pid).toBeNull();
        await rm(root, { recursive: true, force: true });
    });

    it('adopts a verified reachable app-server after the worker restarts', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-provider-test-'));
        const processChanged = vi.fn();
        const ready = vi.fn();
        const terminate = vi.fn(async () => undefined);
        const spawn = vi.fn(() => fakeProcess(302));
        const provider = new CodexGatewayProvider({
            cwd: '/workspace',
            endpoint: { socketPath: join(root, 'provider.sock') },
            codexCliVersion: { major: 0, minor: 145, patch: 0 },
            spawn,
            waitUntilReady: async () => undefined,
            adoptExisting: {
                pid: 301,
                inspect: () => 'expected',
                terminate,
                pollIntervalMs: 60_000,
            },
            hooks: { processChanged, ready },
        });

        await provider.start();
        expect(provider.pid).toBe(301);
        expect(spawn).not.toHaveBeenCalled();
        expect(processChanged).toHaveBeenCalledWith({ pid: 301, adopted: true });
        expect(ready).toHaveBeenCalledWith({ epoch: 1, recovered: true });

        await provider.stop();
        expect(terminate).toHaveBeenCalledWith(301);
        expect(processChanged).toHaveBeenLastCalledWith({ pid: null, adopted: false });
        await rm(root, { recursive: true, force: true });
    });

    it('terminates a verified but unreachable orphan before starting one replacement', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-provider-test-'));
        const replacement = fakeProcess(402);
        const spawn = vi.fn(() => replacement);
        const terminate = vi.fn(async () => undefined);
        let readinessAttempt = 0;
        const provider = new CodexGatewayProvider({
            cwd: '/workspace',
            endpoint: { socketPath: join(root, 'provider.sock') },
            codexCliVersion: { major: 0, minor: 145, patch: 0 },
            spawn,
            waitUntilReady: async () => {
                readinessAttempt += 1;
                if (readinessAttempt === 1) throw new Error('orphan endpoint unavailable');
            },
            adoptExisting: {
                pid: 401,
                inspect: () => 'expected',
                terminate,
            },
        });

        await provider.start();
        expect(terminate).toHaveBeenCalledWith(401);
        expect(spawn).toHaveBeenCalledOnce();
        expect(provider.pid).toBe(402);

        const stopped = provider.stop();
        await vi.waitFor(() => expect(replacement.kill).toHaveBeenCalledWith('SIGTERM'));
        replacement.emit('exit', 0, 'SIGTERM');
        await stopped;
        await rm(root, { recursive: true, force: true });
    });

    it('releases rather than kills an adopted provider when bridge recovery fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-provider-test-'));
        const terminate = vi.fn(async () => undefined);
        const provider = new CodexGatewayProvider({
            cwd: '/workspace',
            endpoint: { socketPath: join(root, 'provider.sock') },
            codexCliVersion: { major: 0, minor: 145, patch: 0 },
            waitUntilReady: async () => undefined,
            adoptExisting: {
                pid: 501,
                inspect: () => 'expected',
                terminate,
                pollIntervalMs: 60_000,
            },
            hooks: {
                ready: () => { throw new Error('bridge recovery failed'); },
            },
        });

        await expect(provider.start()).rejects.toThrow('bridge recovery failed');
        expect(provider.isAdopted).toBe(true);
        expect(provider.currentState).toBe('recovering');
        provider.releaseAdopted();
        expect(provider.pid).toBeNull();
        expect(terminate).not.toHaveBeenCalled();
        await rm(root, { recursive: true, force: true });
    });

    it('preserves the endpoint when a live provider PID cannot be verified', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-provider-test-'));
        const terminate = vi.fn(async () => undefined);
        const spawn = vi.fn(() => fakeProcess(602));
        const provider = new CodexGatewayProvider({
            cwd: '/workspace',
            endpoint: { socketPath: join(root, 'provider.sock') },
            codexCliVersion: { major: 0, minor: 145, patch: 0 },
            spawn,
            adoptExisting: {
                pid: 601,
                inspect: () => 'unverified',
                terminate,
            },
        });

        await expect(provider.start()).rejects.toThrow('ownership cannot be verified');
        expect(provider.currentState).toBe('recovering');
        expect(provider.requiresConservativeRecovery).toBe(true);
        expect(spawn).not.toHaveBeenCalled();
        expect(terminate).not.toHaveBeenCalled();
        provider.releaseForWorkerRecovery();
        await rm(root, { recursive: true, force: true });
    });

    it('does not replace an absent recorded PID while its private endpoint remains reachable', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-provider-test-'));
        const spawn = vi.fn(() => fakeProcess(702));
        const provider = new CodexGatewayProvider({
            cwd: '/workspace',
            endpoint: { socketPath: join(root, 'provider.sock') },
            codexCliVersion: { major: 0, minor: 145, patch: 0 },
            spawn,
            waitUntilReady: async () => undefined,
            adoptExisting: {
                pid: 701,
                inspect: () => 'absent',
                terminate: vi.fn(async () => undefined),
            },
        });

        await expect(provider.start()).rejects.toThrow('ownership cannot be verified');
        expect(provider.currentState).toBe('recovering');
        expect(spawn).not.toHaveBeenCalled();
        provider.releaseForWorkerRecovery();
        await rm(root, { recursive: true, force: true });
    });
});

function fakeProcess(
    pid: number,
    exitOnKill = false,
): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
    const processHandle = new EventEmitter() as ChildProcess & { kill: ReturnType<typeof vi.fn> };
    Object.assign(processHandle, {
        pid,
        stdin: null,
        stdout: null,
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        kill: vi.fn((signal: NodeJS.Signals) => {
            if (exitOnKill) queueMicrotask(() => processHandle.emit('exit', 0, signal));
            return true;
        }),
    });
    return processHandle;
}
