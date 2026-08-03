import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexGatewayAttachmentManager } from './codexGatewayAttachment';

afterEach(() => {
    vi.useRealTimers();
});

function registration() {
    return {
        attachmentId: randomUUID(),
        connectionToken: randomUUID(),
        normalExitNonce: randomUUID(),
    };
}

describe('Codex Gateway terminal attachments', () => {
    it('keeps the attachment active until every authenticated connection disconnects', () => {
        const manager = new CodexGatewayAttachmentManager({ origin: 'terminal' });
        const attached = registration();
        manager.register(attached);

        expect(manager.claim('primary', attached.connectionToken)).toBe(true);
        expect(manager.claim('picker', attached.connectionToken)).toBe(true);
        manager.disconnect('picker');

        expect(manager.state).toBe('attached');
        expect(manager.normalExit({
            attachmentId: attached.attachmentId,
            nonce: attached.normalExitNonce,
        })).toEqual({ accepted: false, reason: 'notPending' });

        manager.disconnect('primary');
        expect(manager.state).toBe('pendingDetach');
    });

    it('allows the same attachment to reconnect during the detach grace period', async () => {
        vi.useFakeTimers();
        const manager = new CodexGatewayAttachmentManager({
            origin: 'terminal',
            detachGraceMs: 10_000,
        });
        const attached = registration();
        manager.register(attached);
        manager.claim('connection-1', attached.connectionToken);
        manager.disconnect('connection-1');

        expect(manager.claim('connection-2', attached.connectionToken)).toBe(true);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(manager.state).toBe('attached');

        manager.disconnect('connection-2');
        expect(manager.state).toBe('pendingDetach');
    });

    it('keeps an abnormal disconnect pending before marking it detached', async () => {
        vi.useFakeTimers();
        const states: string[] = [];
        const manager = new CodexGatewayAttachmentManager({
            origin: 'terminal',
            detachGraceMs: 10_000,
            now: () => 100,
            onStateChanged: (state) => states.push(state),
        });
        const attached = registration();
        expect(manager.register(attached)).toEqual({ accepted: true });
        expect(manager.claim('connection-1', attached.connectionToken)).toBe(true);
        manager.disconnect('connection-1');
        expect(manager.state).toBe('pendingDetach');

        await vi.advanceTimersByTimeAsync(9_999);
        expect(manager.state).toBe('pendingDetach');
        await vi.advanceTimersByTimeAsync(1);
        expect(manager.state).toBe('detached');
        expect(states).toEqual(['attached', 'pendingDetach', 'detached']);
    });

    it('accepts a normal exit only after the matching attachment disconnects', () => {
        const actions: string[] = [];
        const manager = new CodexGatewayAttachmentManager({
            origin: 'terminal',
            onNormalExit: (action) => actions.push(action),
        });
        const attached = registration();
        manager.register(attached);
        manager.claim('connection-1', attached.connectionToken);
        expect(manager.normalExit({
            attachmentId: attached.attachmentId,
            nonce: attached.normalExitNonce,
        })).toEqual({ accepted: false, reason: 'notPending' });

        manager.disconnect('connection-1');
        expect(manager.normalExit({
            attachmentId: attached.attachmentId,
            nonce: attached.normalExitNonce,
        })).toEqual({ accepted: true, action: 'stop' });
        expect(actions).toEqual(['stop']);
    });

    it('rejects a stale launcher after a new attachment has registered and connected', () => {
        const manager = new CodexGatewayAttachmentManager({ origin: 'terminal' });
        const oldAttachment = registration();
        manager.register(oldAttachment);
        manager.claim('old-connection', oldAttachment.connectionToken);
        manager.disconnect('old-connection');

        const replacement = registration();
        expect(manager.register(replacement)).toEqual({ accepted: true });
        expect(manager.claim('stale-picker', oldAttachment.connectionToken)).toBe(false);
        expect(manager.claim('new-connection', replacement.connectionToken)).toBe(true);
        expect(manager.normalExit({
            attachmentId: oldAttachment.attachmentId,
            nonce: oldAttachment.normalExitNonce,
        })).toEqual({ accepted: false, reason: 'staleAttachment' });
        expect(manager.state).toBe('attached');
    });

    it('returns an App-origin gateway to headless after a normal attached TUI exits', () => {
        const manager = new CodexGatewayAttachmentManager({ origin: 'app' });
        const attached = registration();
        manager.register(attached);
        manager.claim('connection-1', attached.connectionToken);
        manager.disconnect('connection-1');
        expect(manager.normalExit({
            attachmentId: attached.attachmentId,
            nonce: attached.normalExitNonce,
        })).toEqual({ accepted: true, action: 'headless' });
        expect(manager.state).toBe('headless');
    });
});
