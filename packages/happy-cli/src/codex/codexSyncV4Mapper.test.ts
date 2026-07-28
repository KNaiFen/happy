import type {
    CodexEntityV4,
    CodexPartEntityV4,
    CodexRelationEntityV4,
    CodexRequestEntityV4,
    SyncMutationOperationV4,
    SyncMutationV4,
} from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';
import type { SyncV4Client, SyncV4PublishEntity } from '@/api/syncV4Client';
import type { ServerNotification, Thread, ThreadItem, Turn } from './protocol';
import { CodexSyncV4Mapper } from './codexSyncV4Mapper';

class RecordingPublisher implements Pick<
    SyncV4Client,
    | 'publishEntity'
    | 'publishEntities'
    | 'publishProviderRequestTransition'
    | 'persistProviderRequestTransition'
> {
    readonly published: CodexEntityV4[] = [];
    readonly persistedProviderResponses: Array<{
        state: 'responseReady' | 'responseSupplied';
        response: CodexRequestEntityV4['response'];
    }> = [];

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

    async publishProviderRequestTransition(request: CodexRequestEntityV4): Promise<SyncMutationV4> {
        return await this.publishEntity(request);
    }

    async persistProviderRequestTransition(
        _request: CodexRequestEntityV4,
        state: 'responseReady' | 'responseSupplied',
        response: CodexRequestEntityV4['response'],
    ): Promise<void> {
        this.persistedProviderResponses.push({ state, response });
    }

    latest<T extends CodexEntityV4['entityType']>(entityType: T): Array<Extract<CodexEntityV4, { entityType: T }>> {
        const latest = new Map<string, CodexEntityV4>();
        for (const entity of this.published) latest.set(`${entity.entityType}:${entity.providerId}`, entity);
        return [...latest.values()].filter(
            (entity): entity is Extract<CodexEntityV4, { entityType: T }> => entity.entityType === entityType,
        );
    }
}

class FailOncePublisher extends RecordingPublisher {
    private failed = false;

    constructor(private readonly failingType: CodexEntityV4['entityType']) {
        super();
    }

    override async publishEntity(
        entity: CodexEntityV4,
        op: SyncMutationOperationV4 = 'upsert',
    ): Promise<SyncMutationV4> {
        if (!this.failed && entity.entityType === this.failingType) {
            this.failed = true;
            throw new Error(`failed ${this.failingType}`);
        }
        return await super.publishEntity(entity, op);
    }

    override async publishEntities(entries: SyncV4PublishEntity[]): Promise<SyncMutationV4[]> {
        if (!this.failed && entries.some(({ entity }) => entity.entityType === this.failingType)) {
            this.failed = true;
            throw new Error(`failed ${this.failingType}`);
        }
        return await super.publishEntities(entries);
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
    it('refreshes an authoritative resumed thread state without replaying historical turns', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, {
            codexCliVersion: '0.145.0',
            initialSyncState: 'ready',
        });
        mapper.importThreadState(thread('thread-resumed', [turn('historical-turn', 'completed')]));
        await mapper.flush();

        expect(publisher.latest('codex.thread')).toHaveLength(1);
        expect(publisher.latest('codex.runtime')).toHaveLength(1);
        expect(publisher.latest('codex.turn')).toHaveLength(0);
    });

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

    it('replays live notifications after an older migration snapshot', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, {
            codexCliVersion: '0.145.0',
            now: () => 1_800_000_000_000,
        });
        await mapper.prepareMigration('thread-barrier');
        mapper.handleNotification(notification({
            method: 'thread/goal/updated',
            params: {
                threadId: 'thread-barrier',
                turnId: null,
                goal: {
                    threadId: 'thread-barrier',
                    objective: 'live goal',
                    status: 'active',
                    tokenBudget: null,
                    tokensUsed: 1,
                    timeUsedSeconds: 1,
                    createdAt: 1_700_000_010,
                    updatedAt: 1_700_000_011,
                },
            },
        }));
        mapper.importThread(thread('thread-barrier'));
        mapper.importGoal('thread-barrier', {
            threadId: 'thread-barrier',
            objective: 'stale snapshot goal',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1_700_000_000,
            updatedAt: 1_700_000_001,
        });
        await mapper.releaseMigrationBarrier('thread-barrier');
        await mapper.flush();

        expect(publisher.latest('codex.thread')[0].goal?.objective).toBe('live goal');
        await mapper.close();
    });

    it('uses a snapshot-only barrier when a ready runtime refreshes after reconnect', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, {
            codexCliVersion: '0.145.0',
            initialSyncState: 'ready',
        });
        mapper.prepareSnapshotBarrier('thread-ready');
        mapper.handleNotification({
            method: 'thread/name/updated',
            params: {
                threadId: 'thread-ready',
                threadName: 'live name',
            },
        });
        mapper.importThreadState({
            ...thread('thread-ready'),
            name: 'stale snapshot name',
        });
        await mapper.releaseMigrationBarrier('thread-ready');
        await mapper.flush();

        expect(publisher.latest('codex.thread').at(-1)).toMatchObject({
            threadId: 'thread-ready',
            name: 'live name',
        });
        await mapper.close();
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

    it('keeps canonical runtime active when late thread-started metadata reports idle', async () => {
        const publisher = new RecordingPublisher();
        let now = 1_800_000_000_000;
        const mapper = new CodexSyncV4Mapper(publisher, {
            codexCliVersion: '0.145.0',
            now: () => now++,
        });

        mapper.handleNotification(notification({
            method: 'turn/started',
            params: {
                threadId: 'thread-late',
                turn: turn('turn-late', 'inProgress'),
            },
        }));
        mapper.handleNotification(notification({
            method: 'thread/started',
            params: { thread: thread('thread-late') },
        }));
        await mapper.flush();

        expect(publisher.latest('codex.thread')[0].status).toEqual({
            type: 'active',
            activeFlags: [],
        });
        expect(publisher.latest('codex.runtime')[0].execution).toEqual({
            type: 'active',
            activeFlags: [],
        });

        mapper.handleNotification(notification({
            method: 'turn/completed',
            params: {
                threadId: 'thread-late',
                turn: turn('turn-late', 'completed'),
            },
        }));
        await mapper.flush();

        expect(publisher.latest('codex.runtime')[0].execution).toEqual({ type: 'idle' });
        await mapper.close();
    });

    it('does not let thread-started metadata overwrite an authoritative system error', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, {
            codexCliVersion: '0.145.0',
        });

        mapper.handleNotification(notification({
            method: 'thread/started',
            params: { thread: thread('thread-error') },
        }));
        mapper.handleNotification(notification({
            method: 'thread/status/changed',
            params: {
                threadId: 'thread-error',
                status: { type: 'systemError' },
            },
        }));
        mapper.handleNotification(notification({
            method: 'thread/started',
            params: { thread: thread('thread-error') },
        }));
        await mapper.flush();

        expect(publisher.latest('codex.thread')[0].status).toEqual({ type: 'systemError' });
        expect(publisher.latest('codex.runtime')[0].execution).toEqual({ type: 'systemError' });
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

    it('commits part publication markers only after the durable publisher succeeds', async () => {
        const publisher = new FailOncePublisher('codex.part');
        const mapper = new CodexSyncV4Mapper(publisher, { codexCliVersion: '0.145.0' });
        const params = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' };
        mapper.handleNotification(notification({
            method: 'item/agentMessage/delta',
            params: { ...params, delta: 'durable text' },
        }));

        await expect(mapper.flush()).rejects.toThrow('failed codex.part');
        await expect(mapper.flush()).rejects.toThrow('failed codex.part');

        expect(publisher.latest('codex.part')).toMatchObject([{
            content: 'durable text',
            final: false,
        }]);
        await mapper.close();
    });

    it('releases finalized stream content after the final part is durable', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, { codexCliVersion: '0.145.0' });
        const item: ThreadItem = {
            type: 'agentMessage',
            id: 'item-final',
            text: 'finished',
            phase: null,
            memoryCitation: null,
        };
        mapper.handleNotification(notification({
            method: 'item/completed',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item,
                completedAtMs: Date.now(),
            },
        }));
        await mapper.flush();

        expect(publisher.latest('codex.part')).toMatchObject([{ content: 'finished', final: true }]);
        expect(mapper.diagnostics()).toMatchObject({
            activeStreamCount: 0,
            finalizedStreamCount: 1,
        });
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

    it('does not reopen completed turns or items when started notifications arrive late', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, { codexCliVersion: '0.145.0' });
        const completedItem = {
            type: 'agentMessage' as const,
            id: 'item-late',
            text: 'done',
            phase: null,
            memoryCitation: null,
        };
        mapper.handleNotification(notification({
            method: 'turn/completed',
            params: { threadId: 'thread-late', turn: turn('turn-late', 'completed', [completedItem]) },
        }));
        mapper.handleNotification(notification({
            method: 'item/started',
            params: {
                threadId: 'thread-late',
                turnId: 'turn-late',
                item: { ...completedItem, text: '' },
                startedAtMs: 1_700_000_001_000,
            },
        }));
        mapper.handleNotification(notification({
            method: 'turn/started',
            params: { threadId: 'thread-late', turn: turn('turn-late', 'inProgress') },
        }));
        await mapper.flush();

        expect(publisher.latest('codex.turn')[0].status).toBe('completed');
        expect(publisher.latest('codex.item')[0]).toMatchObject({
            status: 'completed',
            completedAt: expect.any(Number),
        });
        await mapper.close();
    });

    it('projects thread metadata and MCP startup lifecycle without unknown-method noise', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, { codexCliVersion: '0.145.0' });
        mapper.importThread(thread('thread-meta'));
        mapper.handleNotification(notification({
            method: 'thread/name/updated',
            params: { threadId: 'thread-meta', threadName: 'Stable name' },
        }));
        mapper.handleNotification(notification({
            method: 'model/rerouted',
            params: {
                threadId: 'thread-meta',
                turnId: 'turn-meta',
                fromModel: 'gpt-old',
                toModel: 'gpt-new',
                reason: 'highRiskCyberActivity' as never,
            },
        }));
        mapper.handleNotification(notification({
            method: 'mcpServer/startupStatus/updated',
            params: {
                threadId: 'thread-meta',
                name: 'happy',
                status: 'starting',
                error: null,
                failureReason: null,
            },
        }));
        mapper.handleNotification(notification({
            method: 'mcpServer/startupStatus/updated',
            params: {
                threadId: 'thread-meta',
                name: 'happy',
                status: 'ready',
                error: null,
                failureReason: null,
            },
        }));
        mapper.handleNotification(notification({
            method: 'process/exited',
            params: {
                processHandle: 'excluded',
                exitCode: 0,
                stdout: '',
                stdoutCapReached: false,
                stderr: '',
                stderrCapReached: false,
            },
        }));
        await mapper.flush();

        expect(publisher.latest('codex.thread')[0]).toMatchObject({ name: 'Stable name', model: 'gpt-new' });
        expect(publisher.latest('codex.item').find((item) => item.itemType === 'mcpStartup')).toMatchObject({
            status: 'completed',
            server: 'happy',
        });
        expect(publisher.latest('codex.part').find((part) => part.kind === 'mcpProgress')).toMatchObject({
            final: true,
            content: expect.stringContaining('"status":"ready"'),
        });
        expect(mapper.diagnostics().unknownNotificationMethods).toEqual({});
        await mapper.close();
    });

    it('projects every stable-v2 ThreadItem and UserInput variant without raw reasoning text', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, { codexCliVersion: '0.145.0' });
        const items: ThreadItem[] = [
            {
                type: 'userMessage',
                id: 'user',
                clientId: 'client-1',
                content: [
                    { type: 'text', text: 'hello', text_elements: [] },
                    { type: 'image', url: 'https://example.test/image.png' },
                    { type: 'localImage', path: '/tmp/image.png' },
                    { type: 'audio', url: 'https://example.test/audio.wav' },
                    { type: 'localAudio', path: '/tmp/audio.wav' },
                    { type: 'skill', name: 'inspect', path: '/skills/inspect' },
                    { type: 'mention', name: 'file', path: '/workspace/file.ts' },
                ],
            },
            { type: 'hookPrompt', id: 'hook', fragments: [{ text: 'hook text', hookRunId: 'hook-1' }] },
            { type: 'agentMessage', id: 'agent', text: 'answer', phase: null, memoryCitation: null },
            { type: 'plan', id: 'plan', text: 'plan text' },
            { type: 'reasoning', id: 'reasoning', summary: ['summary'], content: ['raw-secret-reasoning'] },
            {
                type: 'commandExecution',
                id: 'command',
                command: 'echo ok',
                cwd: '/workspace',
                processId: 'process-1',
                source: 'agent',
                status: 'completed',
                commandActions: [],
                aggregatedOutput: 'ok',
                exitCode: 0,
                durationMs: 1,
            },
            { type: 'fileChange', id: 'file', changes: [], status: 'completed' },
            {
                type: 'mcpToolCall',
                id: 'mcp',
                server: 'server',
                tool: 'tool',
                status: 'completed',
                arguments: { query: 'value' },
                appContext: null,
                pluginId: null,
                result: null,
                error: null,
                durationMs: 1,
            },
            {
                type: 'dynamicToolCall',
                id: 'dynamic',
                namespace: 'namespace',
                tool: 'tool',
                arguments: { input: true },
                status: 'completed',
                contentItems: null,
                success: true,
                durationMs: 1,
            },
            {
                type: 'collabAgentToolCall',
                id: 'collab',
                tool: 'spawnAgent',
                status: 'completed',
                senderThreadId: 'thread-all',
                receiverThreadIds: ['thread-child'],
                prompt: 'delegate',
                model: null,
                reasoningEffort: null,
                agentsStates: {},
            },
            {
                type: 'subAgentActivity',
                id: 'activity',
                kind: 'started',
                agentThreadId: 'thread-child',
                agentPath: 'child',
            },
            { type: 'webSearch', id: 'search', query: 'query', action: null, results: [{ title: 'result' }] },
            { type: 'imageView', id: 'view', path: '/tmp/view.png' },
            { type: 'sleep', id: 'sleep', durationMs: 10 },
            {
                type: 'imageGeneration',
                id: 'image-generation',
                status: 'completed',
                revisedPrompt: 'revised',
                result: 'generated-image',
                savedPath: '/tmp/generated.png',
            },
            { type: 'enteredReviewMode', id: 'review-enter', review: 'review started' },
            { type: 'exitedReviewMode', id: 'review-exit', review: 'review finished' },
            { type: 'contextCompaction', id: 'compact' },
        ];

        mapper.importThread(thread('thread-all', [turn('turn-all', 'completed', items)]));
        await mapper.flush();

        expect(new Set(publisher.latest('codex.item').map((item) => item.itemType))).toEqual(new Set([
            'userMessage',
            'hookPrompt',
            'agentMessage',
            'plan',
            'reasoning',
            'commandExecution',
            'fileChange',
            'mcpToolCall',
            'dynamicToolCall',
            'collabAgentToolCall',
            'subAgentActivity',
            'webSearch',
            'imageView',
            'sleep',
            'imageGeneration',
            'enteredReviewMode',
            'exitedReviewMode',
            'contextCompaction',
        ]));
        expect(
            publisher.latest('codex.part')
                .filter((part) => part.itemId === 'user' && part.kind === 'userInput'),
        ).toHaveLength(7);
        expect(JSON.stringify(publisher.published)).not.toContain('raw-secret-reasoning');
        expect(JSON.stringify(publisher.published)).not.toContain('rawReasoning');
        expect(mapper.diagnostics().unknownStableVariants).toEqual({});
        await mapper.close();
    });

    it('emits a controlled diagnostic for an unknown runtime stable variant', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, {
            codexCliVersion: '0.145.0',
            diagnosticId: () => 'unknown-variant',
        });
        mapper.importThread(thread('thread-unknown'));
        mapper.handleNotification({
            method: 'item/completed',
            params: {
                threadId: 'thread-unknown',
                turnId: 'turn-unknown',
                completedAtMs: 1,
                item: { type: 'futureItem', id: 'future', sensitive: 'do-not-project' } as unknown as ThreadItem,
            },
        } as ServerNotification);
        await mapper.flush();

        expect(publisher.latest('codex.item').some((item) => item.itemId === 'future')).toBe(false);
        expect(publisher.latest('codex.item').find((item) => item.itemType === 'warning')).toMatchObject({
            itemId: '__warning_unknown-variant__',
            arguments: {
                category: 'unknownStableVariant',
                union: 'ThreadItem',
                variant: 'futureItem',
            },
        });
        expect(JSON.stringify(publisher.published)).not.toContain('do-not-project');
        expect(mapper.diagnostics().unknownStableVariants).toEqual({ 'ThreadItem:futureItem': 1 });
        await mapper.close();
    });

    it('preserves structured provider errors under restart-safe diagnostic IDs', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, {
            codexCliVersion: '0.145.0',
            diagnosticId: () => 'process-b-error',
        });
        mapper.importThread(thread('thread-error'));
        mapper.handleNotification({
            method: 'error',
            params: {
                threadId: 'thread-error',
                turnId: 'turn-error',
                willRetry: true,
                error: {
                    message: 'provider failed',
                    codexErrorInfo: 'internalServerError',
                    additionalDetails: 'retrying upstream',
                },
            },
        });
        await mapper.flush();

        expect(publisher.latest('codex.item').find((item) => item.itemType === 'error')).toMatchObject({
            itemId: '__error_process-b-error__',
            arguments: {
                message: 'provider failed',
                code: 'internalServerError',
                details: 'retrying upstream',
                willRetry: true,
            },
        });
        expect(publisher.latest('codex.part').find((part) => part.kind === 'error')).toMatchObject({
            contentType: 'json',
            content: expect.stringContaining('"willRetry":true'),
            final: true,
        });
        await mapper.close();
    });

    it('derives the same diagnostic entity ID when a durable notification is replayed after restart', async () => {
        const notification = {
            method: 'guardianWarning',
            params: {
                threadId: 'thread-warning',
                message: 'check permissions',
            },
        } as const satisfies ServerNotification;
        const providerIds: string[] = [];
        for (const localId of ['process-a', 'process-b']) {
            const publisher = new RecordingPublisher();
            const mapper = new CodexSyncV4Mapper(publisher, {
                codexCliVersion: '0.145.0',
                diagnosticId: () => localId,
            });
            mapper.importThread(thread('thread-warning'));
            mapper.handleNotification(notification, 'durable-notification-id');
            await mapper.flush();
            providerIds.push(
                publisher.latest('codex.item').find((item) => item.itemType === 'warning')!.providerId,
            );
            await mapper.close();
        }

        expect(providerIds[0]).toBe(providerIds[1]);
        expect(providerIds[0]).not.toContain('process-a');
        expect(providerIds[0]).not.toContain('process-b');
    });

    it('bounds finalized stream markers and avoids repeated thread/runtime publication per snapshot turn', async () => {
        const publisher = new RecordingPublisher();
        const mapper = new CodexSyncV4Mapper(publisher, {
            codexCliVersion: '0.145.0',
            finalizedStreamMarkerLimit: 1,
        });
        mapper.importThread(thread('thread-batch', [
            turn('turn-1', 'completed', [{ type: 'agentMessage', id: 'item-1', text: 'one', phase: null, memoryCitation: null }]),
            turn('turn-2', 'completed', [{ type: 'agentMessage', id: 'item-2', text: 'two', phase: null, memoryCitation: null }]),
            turn('turn-3', 'completed'),
        ]));
        await mapper.flush();

        expect(publisher.published.filter((entity) => entity.entityType === 'codex.thread')).toHaveLength(1);
        expect(publisher.published.filter((entity) => entity.entityType === 'codex.runtime')).toHaveLength(1);
        expect(mapper.diagnostics()).toMatchObject({
            activeStreamCount: 0,
            finalizedStreamCount: 1,
        });
        await mapper.close();
    });
});
