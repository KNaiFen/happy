import type {
    CodexEntityV4,
    CodexPartEntityV4,
    CodexRelationEntityV4,
    SyncMutationOperationV4,
    SyncMutationV4,
} from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';
import type { SyncV4Client, SyncV4PublishEntity } from '@/api/syncV4Client';
import type { ServerNotification, Thread, ThreadItem, Turn } from './protocol';
import { CodexSyncV4Mapper } from './codexSyncV4Mapper';

class RecordingPublisher implements Pick<SyncV4Client, 'publishEntity' | 'publishEntities'> {
    readonly published: CodexEntityV4[] = [];

    async publishEntity(
        entity: CodexEntityV4,
        op: SyncMutationOperationV4 = 'upsert',
    ): Promise<SyncMutationV4> {
        this.published.push(entity);
        return mutationFor(entity, this.published.length, op);
    }

    async publishEntities(entries: SyncV4PublishEntity[]): Promise<SyncMutationV4[]> {
        return entries.map(({ entity, op }) => {
            this.published.push(entity);
            return mutationFor(entity, this.published.length, op ?? 'upsert');
        });
    }

    latest<T extends CodexEntityV4['entityType']>(entityType: T): Array<Extract<CodexEntityV4, { entityType: T }>> {
        const latest = new Map<string, CodexEntityV4>();
        for (const entity of this.published) latest.set(`${entity.entityType}:${entity.providerId}`, entity);
        return [...latest.values()].filter(
            (entity): entity is Extract<CodexEntityV4, { entityType: T }> => entity.entityType === entityType,
        );
    }
}

function mutationFor(
    entity: CodexEntityV4,
    revision: number,
    op: SyncMutationOperationV4,
): SyncMutationV4 {
    return {
        mutationId: `mutation-${revision}`,
        producerId: 'producer-1',
        entityId: `opaque-${revision}`,
        entityType: entity.entityType,
        revision,
        op,
        ciphertext: 'ciphertext',
    };
}

function thread(id: string, turns: Turn[] = []): Thread {
    return {
        id,
        sessionId: `tree-${id}`,
        forkedFromId: null,
        parentThreadId: null,
        preview: '',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_001,
        recencyAt: 1_700_000_001,
        status: { type: 'idle' },
        path: null,
        cwd: '/workspace',
        cliVersion: '0.145.0',
        source: 'appServer' as Thread['source'],
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns,
    };
}

function turn(id: string, status: Turn['status'], items: ThreadItem[] = []): Turn {
    return {
        id,
        items,
        itemsView: 'full',
        status,
        error: null,
        startedAt: 1_700_000_002,
        completedAt: status === 'inProgress' ? null : 1_700_000_003,
        durationMs: status === 'inProgress' ? null : 1_000,
    };
}

function notification(value: ServerNotification): ServerNotification {
    return value;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('CodexSyncV4Mapper', () => {
    it('projects goal updates and clears into the recoverable thread entity', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, {
            codexCliVersion: '0.145.0',
            now: () => 1_800_000_000_000,
        });
        mapper.importThread(thread('thread-goal'));
        mapper.handleNotification(notification({
            method: 'thread/goal/updated',
            params: {
                threadId: 'thread-goal',
                turnId: null,
                goal: {
                    threadId: 'thread-goal',
                    objective: 'finish sync v4',
                    status: 'active',
                    tokenBudget: 10_000,
                    tokensUsed: 500,
                    timeUsedSeconds: 30,
                    createdAt: 1_700_000_000,
                    updatedAt: 1_700_000_010,
                },
            },
        }));
        await mapper.flush();
        expect(publisher.latest('codex.thread')[0].goal).toEqual({
            objective: 'finish sync v4',
            status: 'active',
            tokenBudget: 10_000,
            tokensUsed: 500,
            timeUsedSeconds: 30,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_010_000,
        });

        mapper.handleNotification(notification({
            method: 'thread/goal/cleared',
            params: { threadId: 'thread-goal' },
        }));
        mapper.importGoal('thread-goal', {
            threadId: 'thread-goal',
            objective: 'stale migration goal',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1_600_000_000,
            updatedAt: 1_600_000_001,
        });
        await mapper.flush();
        expect(publisher.latest('codex.thread')[0].goal).toBeNull();
    });

    it('projects lifecycle and streaming deltas into stable in-place entities', async () => {
        const publisher = new RecordingPublisher();
        let now = 1_800_000_000_000;
        const mapper = new CodexSyncV4Mapper(publisher, {
            codexCliVersion: '0.145.0',
            now: () => now++,
        });
        const agent: ThreadItem = {
            type: 'agentMessage',
            id: 'item-1',
            text: '',
            phase: null,
            memoryCitation: null,
        };

        mapper.handleNotification(notification({ method: 'thread/started', params: { thread: thread('thread-1') } }));
        mapper.handleNotification(notification({
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: turn('turn-1', 'inProgress') },
        }));
        mapper.handleNotification(notification({
            method: 'item/started',
            params: { threadId: 'thread-1', turnId: 'turn-1', item: agent, startedAtMs: now },
        }));
        mapper.handleNotification(notification({
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'Hel' },
        }));
        mapper.handleNotification(notification({
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'lo' },
        }));
        mapper.handleNotification(notification({
            method: 'item/reasoning/textDelta',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', contentIndex: 0, delta: 'private' },
        }));
        await mapper.flush();

        expect(publisher.latest('codex.part')).toMatchObject([{
            content: 'Hello',
            final: false,
            kind: 'text',
        }]);
        expect(mapper.diagnostics()).toMatchObject({
            rawReasoningDeltaCount: 1,
            rawReasoningUtf8Bytes: 7,
        });
        expect(publisher.latest('codex.runtime')[0].execution).toEqual({ type: 'active', activeFlags: [] });

        const completedAgent = { ...agent, text: 'Hello' };
        mapper.handleNotification(notification({
            method: 'item/completed',
            params: { threadId: 'thread-1', turnId: 'turn-1', item: completedAgent, completedAtMs: now },
        }));
        mapper.handleNotification(notification({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: turn('turn-1', 'completed', [completedAgent]) },
        }));
        await mapper.flush();

        expect(publisher.latest('codex.part')[0]).toMatchObject({ content: 'Hello', final: true });
        expect(publisher.latest('codex.item')).toHaveLength(1);
        expect(publisher.latest('codex.item')[0]).toMatchObject({ status: 'completed', completedAt: expect.any(Number) });
        expect(publisher.latest('codex.runtime')[0].execution).toEqual({ type: 'idle' });
        await mapper.close();
    });

    it('chunks UTF-8 without splitting code points and never rewrites a frozen chunk', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, { codexCliVersion: '0.145.0' });
        const prefix = 'a'.repeat(64 * 1024 - 1);
        const params = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' };

        mapper.handleNotification(notification({
            method: 'item/commandExecution/outputDelta',
            params: { ...params, delta: `${prefix}\u{1F600}b` },
        }));
        await mapper.flush();
        const firstPublished = publisher.published.filter(
            (entity): entity is CodexPartEntityV4 => entity.entityType === 'codex.part' && entity.chunkIndex === 0,
        );
        expect(firstPublished).toHaveLength(1);
        expect(Buffer.byteLength(firstPublished[0].content, 'utf8')).toBe(64 * 1024 - 1);
        expect(firstPublished[0].final).toBe(true);

        mapper.handleNotification(notification({
            method: 'item/commandExecution/outputDelta',
            params: { ...params, delta: 'c' },
        }));
        mapper.handleNotification(notification({
            method: 'item/completed',
            params: {
                ...params,
                item: {
                    type: 'commandExecution',
                    id: 'item-1',
                    command: 'test',
                    cwd: '/workspace',
                    processId: null,
                    source: 'agent' as never,
                    status: 'completed',
                    commandActions: [],
                    aggregatedOutput: `${prefix}\u{1F600}bc`,
                    exitCode: 0,
                    durationMs: 1,
                },
                completedAtMs: Date.now(),
            },
        }));
        await mapper.flush();

        const chunks = publisher.latest('codex.part').sort((left, right) => left.chunkIndex - right.chunkIndex);
        expect(chunks.map((chunk) => chunk.content)).toEqual([prefix, '\u{1F600}bc']);
        expect(chunks.every((chunk) => Buffer.byteLength(chunk.content, 'utf8') <= 64 * 1024)).toBe(true);
        expect(chunks.every((chunk) => chunk.final)).toBe(true);
        expect(publisher.published.filter(
            (entity) => entity.entityType === 'codex.part' && entity.providerId === chunks[0].providerId,
        )).toHaveLength(1);
        await mapper.close();
    });

    it('coalesces rapid deltas until the 200ms-style flush interval', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, {
            codexCliVersion: '0.145.0',
            flushIntervalMs: 20,
        });
        const params = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' };
        mapper.handleNotification(notification({ method: 'item/agentMessage/delta', params: { ...params, delta: 'A' } }));
        mapper.handleNotification(notification({ method: 'item/agentMessage/delta', params: { ...params, delta: 'B' } }));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(publisher.latest('codex.part')).toHaveLength(0);

        await sleep(35);
        expect(publisher.latest('codex.part')).toMatchObject([{ content: 'AB' }]);
        expect(publisher.published.filter((entity) => entity.entityType === 'codex.part')).toHaveLength(1);
        await mapper.close();
    });

    it('keeps the last execution state unknown across disconnect until an authoritative snapshot arrives', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, { codexCliVersion: '0.145.0' });
        mapper.importThread(thread('thread-1', [turn('turn-1', 'inProgress')]));
        await mapper.flush();

        await mapper.setConnection('disconnected', { statusUnknown: true });
        expect(publisher.latest('codex.runtime')[0]).toMatchObject({
            connection: 'disconnected',
            execution: { type: 'active' },
            statusUnknown: true,
        });

        await mapper.setConnection('connected', { statusUnknown: true });
        expect(publisher.latest('codex.runtime')[0]).toMatchObject({
            connection: 'connected',
            execution: { type: 'active' },
            statusUnknown: true,
        });

        mapper.importThread(thread('thread-1'));
        await mapper.flush();
        expect(publisher.latest('codex.runtime')[0]).toMatchObject({
            connection: 'connected',
            execution: { type: 'idle' },
            statusUnknown: false,
        });
        await mapper.close();
    });

    it('imports only reasoning summaries and keeps parent and child item identities isolated', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, { codexCliVersion: '0.145.0' });
        const reasoning: ThreadItem = {
            type: 'reasoning',
            id: 'item-1',
            summary: ['Visible summary'],
            content: ['raw reasoning must stay local'],
        };
        mapper.importThread(thread('parent', [turn('turn-1', 'completed', [reasoning])]));
        mapper.importThread({ ...thread('child', [turn('turn-1', 'completed', [reasoning])]), parentThreadId: 'parent' });
        await mapper.flush();

        const parts = publisher.latest('codex.part');
        expect(parts).toHaveLength(2);
        expect(parts.map((part) => part.content)).toEqual(['Visible summary', 'Visible summary']);
        expect(parts.every((part) => part.kind === 'reasoningSummary')).toBe(true);
        expect(new Set(parts.map((part) => part.providerId)).size).toBe(2);
        expect(publisher.latest('codex.item').map((item) => item.threadId).sort()).toEqual(['child', 'parent']);
        await mapper.close();
    });

    it('derives active subagent count from isolated relation lifecycle updates', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, { codexCliVersion: '0.145.0' });
        mapper.importThread(thread('parent'));
        await mapper.flush();
        const relation: CodexRelationEntityV4 = {
            schemaVersion: 1,
            entityType: 'codex.relation',
            providerId: 'parent\0relation\0child',
            createdAt: 1_800_000_000_000,
            updatedAt: 1_800_000_000_000,
            parentThreadId: 'parent',
            childThreadId: 'child',
            parentTurnId: 'turn-parent',
            delegationItemId: 'delegate-1',
            parentSessionId: 'happy-parent',
            childSessionId: 'happy-child',
            depth: 1,
            status: 'active',
        };

        await mapper.upsertRelation(relation);
        expect(publisher.latest('codex.runtime')[0].activeSubagentCount).toBe(1);

        await mapper.upsertRelation({ ...relation, status: 'completed', updatedAt: relation.updatedAt + 1 });
        expect(publisher.latest('codex.runtime')[0].activeSubagentCount).toBe(0);
        await mapper.close();
    });
});
