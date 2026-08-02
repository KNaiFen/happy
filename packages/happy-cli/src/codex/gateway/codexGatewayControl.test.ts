import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callCodexGatewayControl, startCodexGatewayControlServer } from './codexGatewayControl';
import type { CodexGatewayDescriptor } from './codexGatewayState';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex Gateway control endpoint', () => {
    it('requires the capability token and validates normal-exit input', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-control-'));
        roots.push(root);
        const socketPath = join(root, 'control.sock');
        const normalExit = vi.fn(() => ({ accepted: true }));
        const server = await startCodexGatewayControlServer({
            socketPath,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            handlers: {
                status: () => ({ state: 'running' }),
                normalExit,
                stop: () => ({ stopping: true }),
                terminalAttached: () => ({ attached: true }),
            },
        });
        const descriptor = { controlSocketPath: socketPath, controlPort: null } as CodexGatewayDescriptor;

        await expect(callCodexGatewayControl({
            descriptor,
            token: 'wrong-token-that-is-at-least-thirty-two-bytes',
            path: '/status',
        })).rejects.toThrow('(401)');
        await expect(callCodexGatewayControl<{ accepted: boolean }>({
            descriptor,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            path: '/normal-exit',
            body: { nonce: 'normal-exit-nonce-that-is-at-least-thirty-two-bytes' },
        })).resolves.toEqual({ accepted: true });
        expect(normalExit).toHaveBeenCalledOnce();
        await server.close();
    });
});
