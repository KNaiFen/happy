import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
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
