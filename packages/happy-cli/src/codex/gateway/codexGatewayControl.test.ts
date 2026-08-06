import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CodexGatewayControlOperationError,
    callCodexGatewayControl,
    startCodexGatewayControlServer,
} from './codexGatewayControl';
import type { CodexGatewayDescriptor } from './codexGatewayState';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex Gateway control endpoint', () => {
    it('does not fall back to an unrelated default TCP port before Windows startup publishes one', async () => {
        await expect(callCodexGatewayControl({
            descriptor: {
                controlSocketPath: null,
                controlPort: null,
            } as CodexGatewayDescriptor,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            path: '/status',
        })).rejects.toThrow('control endpoint is unavailable');
    });

    it('requires the capability token and validates normal-exit input', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-control-'));
        roots.push(root);
        const socketPath = join(root, 'control.sock');
        const normalExit = vi.fn(() => ({ accepted: true }));
        const terminalAttached = vi.fn(() => ({ attached: true }));
        const presenceReconcile = vi.fn(() => ({ reconciled: true }));
        const cancelRoot = vi.fn(() => ({ cancelled: true }));
        const openRoot = vi.fn(async () => ({
            gatewayId: 'gateway-1',
            threadId: 'thread-1',
            sessionId: 'session-1',
            generation: 1,
        }));
        const server = await startCodexGatewayControlServer({
            socketPath,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            handlers: {
                status: () => ({ state: 'running' }),
                normalExit,
                stop: () => ({ stopping: true }),
                terminalAttached,
                presenceReconcile,
                cancelRoot,
                openRoot,
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
        await expect(callCodexGatewayControl<{ reconciled: boolean }>({
            descriptor,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            path: '/presence/reconcile',
            body: { sessionId: 'session-1' },
        })).resolves.toEqual({ reconciled: true });
        expect(presenceReconcile).toHaveBeenCalledWith({ sessionId: 'session-1' });
        await expect(callCodexGatewayControl({
            descriptor,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            path: '/root/open',
            body: {
                operationId: 'f5f2824d-9e74-4470-b39c-39e65936b777',
                action: 'start',
                threadId: null,
                cwd: '/workspace',
                model: null,
                permissionMode: 'default',
                effortLevel: 'max',
                parentSessionId: null,
                forkedFromMessageId: null,
                isSideChat: false,
            },
        })).resolves.toMatchObject({ sessionId: 'session-1', generation: 1 });
        await expect(callCodexGatewayControl({
            descriptor,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            path: '/root/open',
            body: {
                operationId: 'f5f2824d-9e74-4470-b39c-39e65936b777',
                action: 'resume',
                threadId: null,
                cwd: null,
                model: null,
                permissionMode: 'default',
                effortLevel: null,
                parentSessionId: null,
                forkedFromMessageId: null,
                isSideChat: false,
            },
        })).resolves.toMatchObject({ sessionId: 'session-1', generation: 1 });
        await expect(callCodexGatewayControl({
            descriptor,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            path: '/root/cancel',
            body: { operationId: 'f5f2824d-9e74-4470-b39c-39e65936b777' },
        })).resolves.toEqual({ cancelled: true });
        expect(cancelRoot).toHaveBeenCalledWith({
            operationId: 'f5f2824d-9e74-4470-b39c-39e65936b777',
        });
        await expect(callCodexGatewayControl({
            descriptor,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            path: '/root/open',
            body: {
                operationId: 'f5f2824d-9e74-4470-b39c-39e65936b777',
                action: 'resume',
                threadId: null,
                cwd: null,
                model: null,
                permissionMode: 'default',
                effortLevel: null,
                parentSessionId: null,
                forkedFromMessageId: null,
                isSideChat: false,
                happySessionId: 'must-not-cross-control',
                dataEncryptionKey: 'must-not-cross-control',
            },
        })).rejects.toThrow('(400)');
        expect(openRoot).toHaveBeenCalledTimes(2);
        await server.close();
    });

    it('keeps request validation distinct from thread, conflict, and provider failures', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-gateway-control-'));
        roots.push(root);
        const socketPath = join(root, 'control.sock');
        let failure: 'threadUnavailable' | 'conflict' | 'operationFailed' | 'outcomeUnknown' | 'raw' | null = null;
        const sensitiveCanary = 'provider-secret /private/workspace thread-sensitive';
        const server = await startCodexGatewayControlServer({
            socketPath,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            handlers: {
                status: () => ({ state: 'running' }),
                normalExit: () => ({ accepted: true }),
                stop: () => ({ stopping: true }),
                terminalAttached: () => ({ attached: true }),
                presenceReconcile: () => ({ reconciled: true }),
                cancelRoot: () => ({ cancelled: true }),
                openRoot: async () => {
                    if (failure === 'raw') throw new Error(sensitiveCanary);
                    if (failure) throw new CodexGatewayControlOperationError(failure);
                    return { gatewayId: 'gateway-1', threadId: 'thread-1', sessionId: 'session-1', generation: 1 };
                },
            },
        });
        const descriptor = { controlSocketPath: socketPath, controlPort: null } as CodexGatewayDescriptor;
        const request = {
            operationId: 'f5f2824d-9e74-4470-b39c-39e65936b777',
            action: 'start' as const,
            threadId: null,
            cwd: '/workspace',
            model: null,
            permissionMode: 'default' as const,
            effortLevel: null,
            parentSessionId: null,
            forkedFromMessageId: null,
            isSideChat: false,
        };

        await expect(callCodexGatewayControl({
            descriptor,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            path: '/root/open',
            body: { ...request, unexpected: true },
        })).rejects.toMatchObject({
            code: 'invalidRequest',
            status: 400,
        });

        failure = 'threadUnavailable';
        await expect(callCodexGatewayControl({
            descriptor,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            path: '/root/open',
            body: request,
        })).rejects.toMatchObject({
            code: 'threadUnavailable',
            status: 404,
        });

        failure = 'conflict';
        await expect(callCodexGatewayControl({
            descriptor,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            path: '/root/open',
            body: request,
        })).rejects.toMatchObject({
            code: 'conflict',
            status: 409,
        });

        failure = 'operationFailed';
        await expect(callCodexGatewayControl({
            descriptor,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            path: '/root/open',
            body: request,
        })).rejects.toMatchObject({
            code: 'operationFailed',
            status: 502,
        });

        failure = 'raw';
        const sanitized = await callCodexGatewayControl({
            descriptor,
            token: 'control-token-that-is-at-least-thirty-two-bytes',
            path: '/root/open',
            body: request,
        }).catch((error: unknown) => error);
        expect(sanitized).toMatchObject({ code: 'operationFailed', status: 502 });
        expect(String(sanitized)).not.toContain(sensitiveCanary);
        await server.close();
    });
});
