import type { AgentState, Metadata } from '@/api/types';
import { describe, expect, it, vi } from 'vitest';
import { createOfflineSessionStub } from './offlineSessionStub';

function metadataFixture(): Metadata {
    return {
        path: '/tmp/project',
        host: 'test-host',
        homeDir: '/tmp/home',
        happyHomeDir: '/tmp/home/.happy',
        happyLibDir: '/tmp/home/.happy/lib',
        happyToolsDir: '/tmp/home/.happy/tools',
        flavor: 'codex',
    };
}

describe('createOfflineSessionStub', () => {
    it('implements the runtime surface used by Codex while the relay is offline', async () => {
        const session = createOfflineSessionStub('codex-session', metadataFixture(), {});
        const onFileEvent = vi.fn();
        const onUserMessage = vi.fn();

        expect(session.isOffline).toBe(true);
        expect(session.sessionId).toBe('offline-codex-session');
        expect(() => session.onFileEvent(onFileEvent)).not.toThrow();
        expect(() => session.onUserMessage(onUserMessage)).not.toThrow();
        expect(() => session.sendCodexMessage({ type: 'agent_message', message: 'offline' })).not.toThrow();
        expect(() => session.keepAlive(true, 'local')).not.toThrow();
        expect(() => session.rpcHandlerManager.registerHandler('permission', async () => undefined))
            .not.toThrow();

        session.updateMetadata((metadata) => ({ ...metadata, name: 'offline title' }));
        session.updateAgentState((state) => ({ ...state, controlledByUser: true }));
        expect(session.getMetadata()?.name).toBe('offline title');
        expect(session.getAgentState()?.controlledByUser).toBe(true);

        const attachment = {
            data: new Uint8Array([1, 2, 3]),
            mimeType: 'image/png',
            name: 'offline.png',
        };
        session.trackAttachmentDownload(Promise.resolve(attachment));
        await expect(session.drainAttachmentsForUserMessage()).resolves.toEqual([attachment]);
        await expect(session.downloadAndDecryptAttachment('offline-ref')).resolves.toBeNull();
        await expect(session.enableSyncV4(() => async () => undefined)).rejects.toThrow(
            'Sync v4 is unavailable',
        );
        expect(() => session.syncV4SessionKey).toThrow('Sync v4 is unavailable');

        await expect(session.flush()).resolves.toBeUndefined();
        await expect(session.close()).resolves.toBeUndefined();
    });

    it('preserves local agent state independently of the caller objects', () => {
        const metadata = metadataFixture();
        const state: AgentState = {};
        const session = createOfflineSessionStub('stateful', metadata, state);

        session.updateMetadata((current) => ({ ...current, lifecycleState: 'running' }));
        session.updateAgentState((current) => ({
            ...current,
            codexMessageQueue: {
                revision: 1,
                messages: [],
            },
        }));

        expect(session.getMetadata()?.lifecycleState).toBe('running');
        expect(session.getAgentState()?.codexMessageQueue?.revision).toBe(1);
    });

    it('replays callbacks, RPC handlers, and outbound operations in order on attach', async () => {
        const source = createOfflineSessionStub('source', metadataFixture(), {});
        const target = createOfflineSessionStub('target', metadataFixture(), {});
        const onUserMessage = vi.fn();
        const onFileEvent = vi.fn();
        const onArchived = vi.fn();
        const onMessageOnce = vi.fn();
        const sendCodexMessage = vi.spyOn(target, 'sendCodexMessage');
        const sendSessionEvent = vi.spyOn(target, 'sendSessionEvent');
        const targetOnUserMessage = vi.spyOn(target, 'onUserMessage');
        const targetOnFileEvent = vi.spyOn(target, 'onFileEvent');

        source.onUserMessage(onUserMessage);
        source.onFileEvent(onFileEvent);
        source.on('archived', onArchived);
        source.once('message', onMessageOnce);
        source.rpcHandlerManager.registerHandler('permission', async () => undefined);
        source.sendCodexMessage({ sequence: 1 });
        source.sendSessionEvent({ type: 'message', message: 'sequence-2' });
        await Promise.resolve();

        await source.attach(target);

        expect(targetOnUserMessage).toHaveBeenCalledWith(onUserMessage);
        expect(targetOnFileEvent).toHaveBeenCalledWith(onFileEvent);
        expect(target.rpcHandlerManager.hasHandler('permission')).toBe(true);
        expect(sendCodexMessage).toHaveBeenCalledWith({ sequence: 1 });
        expect(sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'sequence-2',
        }, undefined);
        expect(sendCodexMessage.mock.invocationCallOrder[0]).toBeLessThan(
            sendSessionEvent.mock.invocationCallOrder[0],
        );
        target.emit('archived');
        target.emit('message', { sequence: 3 });
        target.emit('message', { sequence: 4 });
        expect(onArchived).toHaveBeenCalledOnce();
        expect(onMessageOnce).toHaveBeenCalledOnce();
        expect(onMessageOnce).toHaveBeenCalledWith({ sequence: 3 });
    });

    it('keeps the failed FIFO tail and can attach again after a partial replay', async () => {
        const source = createOfflineSessionStub('source-retry', metadataFixture(), {});
        const rejectedTarget = createOfflineSessionStub(
            'target-rejected',
            metadataFixture(),
            {},
        );
        const acceptedTarget = createOfflineSessionStub(
            'target-accepted',
            metadataFixture(),
            {},
        );
        const rejectedSend = vi.spyOn(rejectedTarget, 'sendCodexMessage').mockImplementation(
            (body) => {
                if ((body as { sequence?: number }).sequence === 2) {
                    throw new Error('sensitive transport failure');
                }
            },
        );
        const acceptedSend = vi.spyOn(acceptedTarget, 'sendCodexMessage');
        source.sendCodexMessage({ sequence: 1 });
        source.sendCodexMessage({ sequence: 2 });
        source.sendCodexMessage({ sequence: 3 });

        await expect(source.attach(rejectedTarget)).rejects.toThrow(
            'Deferred offline session output could not be replayed',
        );
        expect(rejectedSend).toHaveBeenCalledTimes(2);
        expect(rejectedSend).toHaveBeenNthCalledWith(1, { sequence: 1 });
        expect(rejectedSend).toHaveBeenNthCalledWith(2, { sequence: 2 });

        await expect(source.attach(acceptedTarget)).resolves.toBeUndefined();

        expect(acceptedSend).toHaveBeenCalledTimes(2);
        expect(acceptedSend).toHaveBeenNthCalledWith(1, { sequence: 2 });
        expect(acceptedSend).toHaveBeenNthCalledWith(2, { sequence: 3 });
    });

    it('drains a large FIFO without changing its order', async () => {
        const source = createOfflineSessionStub('source-large', metadataFixture(), {});
        const target = createOfflineSessionStub('target-large', metadataFixture(), {});
        const acceptedSequences: number[] = [];
        vi.spyOn(target, 'sendCodexMessage').mockImplementation((body) => {
            acceptedSequences.push((body as { sequence: number }).sequence);
        });
        for (let sequence = 0; sequence < 10_000; sequence += 1) {
            source.sendCodexMessage({ sequence });
        }

        await source.attach(target);

        expect(acceptedSequences).toHaveLength(10_000);
        expect(acceptedSequences[0]).toBe(0);
        expect(acceptedSequences[9_999]).toBe(9_999);
        expect(acceptedSequences.every((sequence, index) => sequence === index)).toBe(true);
    });

    it('keeps a background send rejection for an explicit flush retry', async () => {
        const source = createOfflineSessionStub('source-background', metadataFixture(), {});
        const target = createOfflineSessionStub('target-background', metadataFixture(), {});
        const send = vi.spyOn(target, 'sendCodexMessage')
            .mockImplementationOnce(() => {
                throw new Error('sensitive transport failure');
            })
            .mockImplementation(() => undefined);
        await source.attach(target);

        expect(() => source.sendCodexMessage({ sequence: 1 })).not.toThrow();
        await new Promise(resolve => setTimeout(resolve, 0));
        await expect(source.flush()).resolves.toBeUndefined();

        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenNthCalledWith(1, { sequence: 1 });
        expect(send).toHaveBeenNthCalledWith(2, { sequence: 1 });
    });
});
