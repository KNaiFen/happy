import { describe, expect, it, vi } from 'vitest';

import { resolveCodexResumeSyncStrategy, resumeExistingThread } from './resumeExistingThread';

const resumedThread = {
    id: '019ccca2-1a77-7481-9873-de72f3464372',
    turns: [],
} as never;

describe('resumeExistingThread', () => {
    it.each([
        [false, undefined, {
            emitLegacySnapshot: true,
            emitLegacyAnnouncement: true,
            migrateToSyncV4: false,
            finalizeSyncV4Activation: false,
        }],
        [true, undefined, {
            emitLegacySnapshot: false,
            emitLegacyAnnouncement: false,
            migrateToSyncV4: true,
            finalizeSyncV4Activation: false,
        }],
        [true, 'importing' as const, {
            emitLegacySnapshot: false,
            emitLegacyAnnouncement: false,
            migrateToSyncV4: true,
            finalizeSyncV4Activation: false,
        }],
        [true, 'activating' as const, {
            emitLegacySnapshot: false,
            emitLegacyAnnouncement: false,
            migrateToSyncV4: false,
            finalizeSyncV4Activation: true,
        }],
        [true, 'ready' as const, {
            emitLegacySnapshot: false,
            emitLegacyAnnouncement: false,
            migrateToSyncV4: false,
            finalizeSyncV4Activation: false,
        }],
    ])('keeps v3 snapshots and v4 migration mutually exclusive when enabled=%s, state=%s', (enabled, state, expected) => {
        expect(resolveCodexResumeSyncStrategy(enabled, state)).toEqual(expected);
    });

    it.each([true, false])('resumes the thread and updates session metadata with announce=%s', async (announce) => {
        const client = {
            resumeThread: vi.fn().mockResolvedValue({
                threadId: '019ccca2-1a77-7481-9873-de72f3464372',
                model: 'gpt-5.4',
                thread: resumedThread,
            }),
        };
        const metadataHandlers: Array<(metadata: any) => any> = [];
        const session = {
            updateMetadata: vi.fn((handler) => metadataHandlers.push(handler)),
            sendSessionEvent: vi.fn(),
        };
        const messageBuffer = {
            addMessage: vi.fn(),
        };

        const result = await resumeExistingThread({
            client,
            session,
            messageBuffer,
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            cwd: '/tmp/project',
            mcpServers: { happy: { command: 'happy-mcp' } },
            announce,
        });

        expect(result).toEqual({
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            model: 'gpt-5.4',
            thread: resumedThread,
        });
        expect(client.resumeThread).toHaveBeenCalledWith({
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            cwd: '/tmp/project',
            mcpServers: { happy: { command: 'happy-mcp' } },
            emitSnapshot: undefined,
        });
        expect(metadataHandlers).toHaveLength(1);
        expect(metadataHandlers[0]({ existing: true })).toEqual({
            existing: true,
            codexThreadId: '019ccca2-1a77-7481-9873-de72f3464372',
        });
        expect(messageBuffer.addMessage).toHaveBeenCalledWith(expect.stringContaining('Resumed thread'), 'status');
        if (announce) {
            expect(session.sendSessionEvent).toHaveBeenCalledWith({
                type: 'message',
                message: 'Resumed Codex thread 019ccca2-1a77-7481-9873-de72f3464372',
            });
        } else {
            expect(session.sendSessionEvent).not.toHaveBeenCalled();
        }
    });

    it('wraps backend resume errors with the thread ID', async () => {
        const client = {
            resumeThread: vi.fn().mockRejectedValue(new Error('thread not found')),
        };
        const session = {
            updateMetadata: vi.fn(),
            sendSessionEvent: vi.fn(),
        };
        const messageBuffer = {
            addMessage: vi.fn(),
        };

        await expect(
            resumeExistingThread({
                client,
                session,
                messageBuffer,
                threadId: 'thread-404',
                cwd: '/tmp/project',
                mcpServers: {},
                announce: false,
            }),
        ).rejects.toThrow('Failed to resume Codex thread thread-404: thread not found');
    });
});
