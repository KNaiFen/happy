import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerNotification } from '../protocol';
import {
    CodexGatewayJournal,
    CodexGatewayJournalCorruptionError,
    CodexGatewayJournalLeaseError,
} from './codexGatewayJournal';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
        recursive: true,
        force: true,
    })));
});

async function journalPath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'happy-codex-gateway-journal-'));
    temporaryDirectories.push(directory);
    return join(directory, 'gateway.jsonl');
}

function statusNotification(threadId: string, type: 'active' | 'idle'): ServerNotification {
    return {
        method: 'thread/status/changed',
        params: {
            threadId,
            status: type === 'active' ? { type, activeFlags: [] } : { type },
        },
    } as ServerNotification;
}

describe('CodexGatewayJournal', () => {
    it('replays deferred notifications and handoffs in durable insertion order', async () => {
        const path = await journalPath();
        const journal = await CodexGatewayJournal.open({ path, now: () => 100 });
        const first = await journal.enqueueNotification('thread-a', statusNotification('thread-a', 'active'));
        const second = await journal.enqueueNotification('thread-a', statusNotification('thread-a', 'idle'));
        await journal.recordHandoff({
            commandId: 'command-a',
            sourceThreadId: 'thread-source',
            targetThreadId: 'thread-a',
            generation: 2,
            state: 'providerAccepted',
            updatedAt: 100,
        });
        await journal.close();

        const recovered = await CodexGatewayJournal.open({ path, now: () => 200 });
        expect(recovered.pendingEntries().map((entry) => entry.id)).toEqual([
            first?.id,
            second?.id,
        ]);
        expect(recovered.handoff('command-a')).toMatchObject({
            targetThreadId: 'thread-a',
            state: 'providerAccepted',
        });

        await recovered.completeEntry(first!.id);
        await recovered.recordHandoff({
            ...recovered.handoff('command-a')!,
            state: 'bound',
            updatedAt: 200,
        });
        await recovered.close();

        const final = await CodexGatewayJournal.open({ path });
        expect(final.pendingEntries().map((entry) => entry.id)).toEqual([second?.id]);
        expect(final.handoff('command-a')?.state).toBe('bound');
        await final.completeHandoff('command-a');
        await final.close();
    });

    it('repairs a truncated tail without discarding the prior fsynced record', async () => {
        const path = await journalPath();
        const journal = await CodexGatewayJournal.open({ path });
        const entry = await journal.enqueueNotification(
            'thread-a',
            statusNotification('thread-a', 'active'),
        );
        await journal.close();
        await writeFile(path, `${await readFile(path, 'utf8')}{"version":1`, 'utf8');

        const recovered = await CodexGatewayJournal.open({ path });
        expect(recovered.pendingEntries().map((candidate) => candidate.id)).toEqual([entry?.id]);
        await recovered.close();
        expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(true);
    });

    it('rejects corruption before the tail instead of silently skipping it', async () => {
        const path = await journalPath();
        await writeFile(path, '{"broken":true}\n{"also":"broken"}\n', { mode: 0o600 });

        await expect(CodexGatewayJournal.open({ path }))
            .rejects.toBeInstanceOf(CodexGatewayJournalCorruptionError);
    });

    it('never persists raw reasoning text and strips reasoning content from snapshots', async () => {
        const path = await journalPath();
        const journal = await CodexGatewayJournal.open({ path });

        const raw = await journal.enqueueNotification('thread-a', {
            method: 'item/reasoning/textDelta',
            params: {
                threadId: 'thread-a',
                turnId: 'turn-a',
                itemId: 'reasoning-a',
                delta: 'private chain of thought',
                contentIndex: 0,
            },
        } as ServerNotification);
        const snapshot = await journal.enqueueNotification('thread-a', {
            method: 'item/completed',
            params: {
                threadId: 'thread-a',
                turnId: 'turn-a',
                item: {
                    type: 'reasoning',
                    id: 'reasoning-a',
                    summary: ['safe summary'],
                    content: ['private chain of thought'],
                },
            },
        } as ServerNotification);

        expect(raw).toBeNull();
        expect(snapshot?.kind).toBe('notification');
        await journal.close();
        const persisted = await readFile(path, 'utf8');
        expect(persisted).toContain('safe summary');
        expect(persisted).not.toContain('private chain of thought');
    });

    it('replaces oversized payloads with an ordered snapshot marker', async () => {
        const path = await journalPath();
        const journal = await CodexGatewayJournal.open({
            path,
            maxNotificationBytes: 32,
        });

        const entry = await journal.enqueueNotification(
            'thread-a',
            statusNotification('thread-a', 'active'),
        );

        expect(entry).toMatchObject({
            kind: 'snapshotRequired',
            threadId: 'thread-a',
        });
        await journal.close();
    });

    it('keeps an active worker lease exclusive and allows a stale owner to recover', async () => {
        const path = await journalPath();
        const owner = await CodexGatewayJournal.open({
            path,
            pid: 111,
            isProcessAlive: (pid) => pid === 111,
        });
        await expect(CodexGatewayJournal.open({
            path,
            pid: 222,
            isProcessAlive: (pid) => pid === 111,
        })).rejects.toBeInstanceOf(CodexGatewayJournalLeaseError);
        await owner.close();

        const recovered = await CodexGatewayJournal.open({
            path,
            pid: 222,
            isProcessAlive: () => false,
        });
        await recovered.close();
    });

    it('compacts completed records without changing pending FIFO', async () => {
        const path = await journalPath();
        const journal = await CodexGatewayJournal.open({ path, compactionBytes: 1 });
        const first = await journal.enqueueNotification('thread-a', statusNotification('thread-a', 'active'));
        const second = await journal.enqueueNotification('thread-a', statusNotification('thread-a', 'idle'));
        await journal.completeEntry(first!.id);
        await journal.compact();
        await journal.close();

        const recovered = await CodexGatewayJournal.open({ path });
        expect(recovered.pendingEntries().map((entry) => entry.id)).toEqual([second?.id]);
        if (process.platform !== 'win32') {
            expect((await stat(path)).mode & 0o777).toBe(0o600);
        }
        await recovered.close();
    });
});
