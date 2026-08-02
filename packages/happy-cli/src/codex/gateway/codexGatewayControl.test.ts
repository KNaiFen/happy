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
        const terminalAttached = vi.fn(() => ({ attached: true }));
        const server = await startCodexGatewayControlServer({
            socketPath,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            handlers: {
                status: () => ({ state: 'running' }),
                normalExit,
                stop: () => ({ stopping: true }),
                terminalAttached,
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
            body: {
                attachmentId: '980bb4f1-ae97-4143-8c47-10929dcf93e2',
                nonce: 'normal-exit-nonce-that-is-at-least-thirty-two-bytes',
            },
        })).resolves.toEqual({ accepted: true });
        expect(normalExit).toHaveBeenCalledOnce();
        await expect(callCodexGatewayControl<{ attached: boolean }>({
            descriptor,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            path: '/terminal-attached',
            body: {
                attachmentId: 'f766a089-2df3-449d-a37c-ae058fef7b1c',
                connectionToken: 'connection-token-that-is-at-least-thirty-two-bytes',
                normalExitNonce: 'another-exit-nonce-that-is-at-least-thirty-two-bytes',
            },
        })).resolves.toEqual({ attached: true });
        expect(terminalAttached).toHaveBeenCalledOnce();
        await server.close();
    });
});
