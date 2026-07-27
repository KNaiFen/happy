import { describe, expect, it, vi } from 'vitest';
import type { CodexRelationEntityV4 } from '@slopus/happy-wire';
import type { ServerNotification, Thread } from './protocol';
import {
    CodexV4ThreadRouter,
    type CodexV4SessionBinding,
} from './codexV4ThreadRouter';

class FakeMapper {
    readonly notifications: ServerNotification[] = [];
    readonly snapshots: Thread[] = [];
    readonly relations: CodexRelationEntityV4[] = [];

    handleNotification(notification: ServerNotification): void {
        this.notifications.push(notification);
    }

    importThread(thread: Thread): void {
        this.snapshots.push(thread);
    }

    async upsertRelation(relation: CodexRelationEntityV4): Promise<void> {
        this.relations.push(relation);
    }

    async prepareMigration(): Promise<void> {}
    async setSyncState(): Promise<void> {}
    async setConnection(): Promise<void> {}
    async flush(): Promise<void> {}
}

function binding(sessionId: string) {
    const mapper = new FakeMapper();
    const requestBroker = { handle: vi.fn(async () => ({ decision: 'accept' })) };
    const close = vi.fn(async () => {});
    const value = {
        sessionId,
        sessionKey: new Uint8Array(32),
        mapper,
        syncClient: { flushOutboundOnce: vi.fn(async () => {}) },
        commandProcessor: {},
        requestBroker,
        close,
    } as unknown as CodexV4SessionBinding;
    return { value, mapper, requestBroker, close };
}

function thread(id: string, parentThreadId: string | null, status: Thread['status'] = { type: 'idle' }): Thread {
    return {
        id,
        sessionId: 'tree-1',
        forkedFromId: null,
        parentThreadId,
        preview: '',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 1,
        updatedAt: 2,
        recencyAt: 2,
        status,
        path: null,
        cwd: '/workspace',
        cliVersion: '0.145.0',
        source: 'appServer' as Thread['source'],
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
    };
}

describe('CodexV4ThreadRouter', () => {
    it('hydrates an unknown child and never projects its lifecycle into the parent mapper', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const snapshots = new Map([
            ['thread-child', thread('thread-child', 'thread-root', { type: 'active', activeFlags: [] })],
        ]);
        const createChildBinding = vi.fn(async () => child.value);
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async (threadId) => snapshots.get(threadId)!,
            createChildBinding,
            now: () => 10_000,
        });
        router.registerRootThread('thread-root');

        const started = {
            method: 'turn/started',
            params: {
                threadId: 'thread-child',
                turn: {
                    id: 'turn-child',
                    items: [],
                    itemsView: 'full',
                    status: 'inProgress',
                    error: null,
                    startedAt: 3,
                    completedAt: null,
                    durationMs: null,
                },
            },
        } as ServerNotification;
        const completed = {
            method: 'turn/completed',
            params: {
                threadId: 'thread-child',
                turn: {
                    id: 'turn-child',
                    items: [],
                    itemsView: 'full',
                    status: 'completed',
                    error: null,
                    startedAt: 3,
                    completedAt: 4,
                    durationMs: 1,
                },
            },
        } as ServerNotification;
        router.handleNotification(started);
        router.handleNotification(completed);
        await router.flush();

        expect(createChildBinding).toHaveBeenCalledOnce();
        expect(child.mapper.snapshots.map((value) => value.id)).toEqual(['thread-child']);
        expect(child.mapper.notifications).toEqual([started, completed]);
        expect(root.mapper.notifications).toEqual([]);
        expect(root.mapper.relations.at(-1)).toMatchObject({
            parentSessionId: 'happy-root',
            childSessionId: 'happy-child',
            parentThreadId: 'thread-root',
            childThreadId: 'thread-child',
            status: 'completed',
        });
    });

    it('routes nested children through their immediate parent session', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const nested = binding('happy-nested');
        const created = new Map([
            ['thread-child', child.value],
            ['thread-nested', nested.value],
        ]);
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async (threadId) => {
                if (threadId === 'thread-child') return thread('thread-child', 'thread-root');
                return thread('thread-nested', 'thread-child');
            },
            createChildBinding: async (route) => created.get(route.thread.id)!,
        });
        router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'thread/started',
            params: { thread: thread('thread-child', 'thread-root') },
        });
        router.handleNotification({
            method: 'thread/started',
            params: { thread: thread('thread-nested', 'thread-child') },
        });
        await router.flush();

        expect(root.mapper.relations).toHaveLength(1);
        expect(child.mapper.relations).toHaveLength(1);
        expect(child.mapper.relations[0]).toMatchObject({
            parentSessionId: 'happy-child',
            childSessionId: 'happy-nested',
            depth: 2,
        });
        expect(nested.mapper.notifications).toHaveLength(1);
    });

    it('routes provider requests to the broker that owns the request thread', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root'),
            createChildBinding: async () => child.value,
        });
        router.registerRootThread('thread-root');

        const request = {
            requestId: 'request-1',
            method: 'item/tool/requestUserInput',
            params: { threadId: 'thread-child', turnId: 'turn-child', itemId: 'item-1', questions: [] },
        } as const;
        await expect(router.handleRequest(request)).resolves.toEqual({ decision: 'accept' });

        expect(root.requestBroker.handle).not.toHaveBeenCalled();
        expect(child.requestBroker.handle).toHaveBeenCalledWith(request);
    });

    it('enriches a child relation when the delegation item arrives after the child lifecycle', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root'),
            createChildBinding: async () => child.value,
            now: () => 20_000,
        });
        router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'turn/started',
            params: {
                threadId: 'thread-child',
                turn: {
                    id: 'turn-child',
                    items: [],
                    itemsView: 'full',
                    status: 'inProgress',
                    error: null,
                    startedAt: 3,
                    completedAt: null,
                    durationMs: null,
                },
            },
        });
        router.handleNotification({
            method: 'item/started',
            params: {
                threadId: 'thread-root',
                turnId: 'turn-root',
                item: {
                    type: 'collabAgentToolCall',
                    id: 'delegate-1',
                    tool: 'spawnAgent',
                    status: 'inProgress',
                    senderThreadId: 'thread-root',
                    receiverThreadIds: ['thread-child'],
                    prompt: 'delegate',
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {},
                },
                startedAtMs: 4_000,
            },
        });
        await router.flush();

        expect(root.mapper.relations.at(-1)).toMatchObject({
            childThreadId: 'thread-child',
            parentTurnId: 'turn-root',
            delegationItemId: 'delegate-1',
        });
    });

    it('deduplicates concurrent child hydration from a notification and provider request', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        let releaseBinding!: () => void;
        const bindingGate = new Promise<void>((resolve) => { releaseBinding = resolve; });
        const createChildBinding = vi.fn(async () => {
            await bindingGate;
            return child.value;
        });
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root'),
            createChildBinding,
        });
        router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'thread/started',
            params: { thread: thread('thread-child', 'thread-root') },
        });
        const requestPromise = router.handleRequest({
            requestId: 'request-1',
            method: 'item/tool/requestUserInput',
            params: { threadId: 'thread-child', turnId: 'turn-child', itemId: 'item-1', questions: [] },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        releaseBinding();
        await requestPromise;
        await router.flush();

        expect(createChildBinding).toHaveBeenCalledOnce();
        expect(root.mapper.relations).toHaveLength(1);
    });
});
