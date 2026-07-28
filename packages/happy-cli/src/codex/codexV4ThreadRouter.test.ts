import { describe, expect, it, vi } from 'vitest';
import type { CodexRelationEntityV4 } from '@slopus/happy-wire';
import type { SyncV4MigrationJournalState } from '@/api/syncV4Journal';
import type { ServerNotification, Thread, ThreadGoal } from './protocol';
import type { CodexV4ChildThreadRoute } from './codexV4Migration';
import {
    CodexV4ThreadRouter,
    type CodexV4SessionBinding,
} from './codexV4ThreadRouter';

class FakeMapper {
    readonly notifications: ServerNotification[] = [];
    readonly snapshots: Thread[] = [];
    readonly stateSnapshots: Thread[] = [];
    readonly relations: CodexRelationEntityV4[] = [];
    readonly goals: Array<{ threadId: string; goal: ThreadGoal | null }> = [];
    syncStateFailure: Error | null = null;

    handleNotification(notification: ServerNotification): void {
        this.notifications.push(notification);
    }

    importThread(thread: Thread): void {
        this.snapshots.push(thread);
    }

    importThreadState(thread: Thread): void {
        this.stateSnapshots.push(thread);
    }

    importGoal(threadId: string, goal: ThreadGoal | null): void {
        this.goals.push({ threadId, goal });
    }

    async upsertRelation(relation: CodexRelationEntityV4): Promise<void> {
        this.relations.push(relation);
    }

    async prepareMigration(): Promise<void> {}
    async releaseMigrationBarrier(): Promise<void> {}
    async setSyncState(): Promise<void> {
        if (!this.syncStateFailure) return;
        const error = this.syncStateFailure;
        this.syncStateFailure = null;
        throw error;
    }
    async setConnection(): Promise<void> {}
    async flush(): Promise<void> {}
}

function binding(sessionId: string, initialMigrationState?: SyncV4MigrationJournalState) {
    const mapper = new FakeMapper();
    const requestBroker = {
        handle: vi.fn(async () => ({
            response: { decision: 'accept' },
            markResponseSupplied: vi.fn(async () => {}),
            markDelivered: vi.fn(async () => {}),
            markAbandoned: vi.fn(async () => {}),
        })),
        failPending: vi.fn(async () => {}),
        markProviderResolved: vi.fn(async () => {}),
    };
    const close = vi.fn(async () => {});
    let migrationState = initialMigrationState;
    const value = {
        sessionId,
        sessionKey: new Uint8Array(32),
        mapper,
        syncClient: {
            flushOutboundOnce: vi.fn(async () => {}),
            getMigrationState: vi.fn(() => migrationState),
            setMigrationState: vi.fn(async (_threadId: string, state: SyncV4MigrationJournalState) => {
                migrationState = state;
            }),
        },
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

    it('hydrates the immediate parent when a nested child notification arrives first', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const nested = binding('happy-nested');
        const createChildBinding = vi.fn(async (
            route: CodexV4ChildThreadRoute,
            parentBinding: CodexV4SessionBinding,
        ) => {
            if (route.thread.id === 'thread-child') {
                expect(parentBinding.sessionId).toBe('happy-root');
                return child.value;
            }
            expect(parentBinding.sessionId).toBe('happy-child');
            return nested.value;
        });
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async (threadId) => {
                if (threadId === 'thread-child') return thread('thread-child', 'thread-root');
                throw new Error(`unexpected read for ${threadId}`);
            },
            createChildBinding,
        });
        router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'thread/started',
            params: { thread: thread('thread-nested', 'thread-child') },
        });
        await router.flush();

        expect(createChildBinding).toHaveBeenCalledTimes(2);
        expect(root.mapper.relations.map((relation) => relation.childThreadId)).toEqual(['thread-child']);
        expect(child.mapper.relations.map((relation) => relation.childThreadId)).toEqual(['thread-nested']);
        expect(root.mapper.relations.some((relation) => relation.childThreadId === 'thread-nested')).toBe(false);
        expect(nested.mapper.notifications).toHaveLength(1);
    });

    it('keeps nested and direct-child completion updates on their immediate parent relation', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const nested = binding('happy-nested');
        const bindings = new Map([
            ['thread-child', child.value],
            ['thread-nested', nested.value],
        ]);
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async (threadId) => thread(
                threadId,
                threadId === 'thread-child' ? 'thread-root' : 'thread-child',
            ),
            createChildBinding: async (route) => bindings.get(route.thread.id)!,
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

        const activeTurn = (threadId: string, turnId: string): ServerNotification => ({
            method: 'turn/started',
            params: {
                threadId,
                turn: {
                    id: turnId,
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
        const completedTurn = (threadId: string, turnId: string): ServerNotification => ({
            method: 'turn/completed',
            params: {
                threadId,
                turn: {
                    id: turnId,
                    items: [],
                    itemsView: 'full',
                    status: 'completed',
                    error: null,
                    startedAt: 3,
                    completedAt: 4,
                    durationMs: 1,
                },
            },
        });

        router.handleNotification(activeTurn('thread-child', 'turn-child'));
        router.handleNotification(activeTurn('thread-nested', 'turn-nested'));
        await router.flush();
        expect(root.mapper.relations.at(-1)).toMatchObject({ childThreadId: 'thread-child', status: 'active' });
        expect(child.mapper.relations.at(-1)).toMatchObject({ childThreadId: 'thread-nested', status: 'active' });

        router.handleNotification(completedTurn('thread-nested', 'turn-nested'));
        await router.flush();
        expect(child.mapper.relations.at(-1)).toMatchObject({ childThreadId: 'thread-nested', status: 'completed' });
        expect(root.mapper.relations.at(-1)).toMatchObject({ childThreadId: 'thread-child', status: 'active' });

        router.handleNotification(completedTurn('thread-child', 'turn-child'));
        await router.flush();
        expect(root.mapper.relations.at(-1)).toMatchObject({ childThreadId: 'thread-child', status: 'completed' });
    });

    it('refreshes a previously migrated child without replaying its historical items', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child', 'ready');
        const childThread = thread('thread-child', 'thread-root');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => childThread,
            createChildBinding: async () => child.value,
        });
        router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'thread/started',
            params: { thread: childThread },
        });
        await router.flush();

        expect(child.mapper.snapshots).toEqual([]);
        expect(child.mapper.stateSnapshots).toEqual([childThread]);
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
        await expect(router.handleRequest(request)).resolves.toMatchObject({
            response: { decision: 'accept' },
        });

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

    it('closes a failed child activation and retries with a fresh binding', async () => {
        const root = binding('happy-root');
        const failedChild = binding('happy-child-failed');
        const recoveredChild = binding('happy-child-recovered');
        failedChild.mapper.syncStateFailure = new Error('activation failed');
        const createChildBinding = vi.fn()
            .mockResolvedValueOnce(failedChild.value)
            .mockResolvedValueOnce(recoveredChild.value);
        const errors: unknown[] = [];
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root'),
            createChildBinding,
            onError: (error) => errors.push(error),
        });
        router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'thread/started',
            params: { thread: thread('thread-child', 'thread-root') },
        });
        await router.flush();

        expect(failedChild.close).toHaveBeenCalledOnce();
        expect(errors).toHaveLength(1);

        const recoveredNotification = {
            method: 'thread/status/changed',
            params: { threadId: 'thread-child', status: { type: 'idle' } },
        } as ServerNotification;
        router.handleNotification(recoveredNotification);
        await router.flush();

        expect(createChildBinding).toHaveBeenCalledTimes(2);
        expect(recoveredChild.mapper.notifications).toEqual([recoveredNotification]);
    });

    it('does not block root notifications while a child binding is being created', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        let childBindingStarted!: () => void;
        let releaseChildBinding!: () => void;
        const started = new Promise<void>((resolve) => { childBindingStarted = resolve; });
        const gate = new Promise<void>((resolve) => { releaseChildBinding = resolve; });
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async (threadId) => thread(threadId, 'thread-root'),
            createChildBinding: async () => {
                childBindingStarted();
                await gate;
                return child.value;
            },
        });
        router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'thread/started',
            params: { thread: thread('thread-child', 'thread-root') },
        });
        await started;
        const rootNotification = {
            method: 'thread/status/changed',
            params: { threadId: 'thread-root', status: { type: 'active', activeFlags: [] } },
        } as ServerNotification;
        router.handleNotification(rootNotification);
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(root.mapper.notifications).toEqual([rootNotification]);
        expect(child.mapper.notifications).toEqual([]);

        releaseChildBinding();
        await router.flush();
        expect(child.mapper.notifications).toHaveLength(1);
    });

    it('expires pending requests in every thread binding when the transport disconnects', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root'),
            createChildBinding: async () => child.value,
        });
        router.registerRootThread('thread-root');
        await router.handleRequest({
            requestId: 'request-1',
            method: 'item/tool/requestUserInput',
            params: { threadId: 'thread-child', turnId: 'turn-child', itemId: 'item-1', questions: [] },
        });

        router.setConnection({ connection: 'disconnected', statusUnknown: true, error: null });
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(root.requestBroker.failPending).toHaveBeenCalledWith('transportDisconnected');
        expect(child.requestBroker.failPending).toHaveBeenCalledWith('transportDisconnected');
    });

    it('routes provider-side request completion to the owning broker', async () => {
        const root = binding('happy-root');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-root', null),
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
        });
        router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'serverRequest/resolved',
            params: { threadId: 'thread-root', requestId: 42 },
        });
        await router.flush();

        expect(root.requestBroker.markProviderResolved).toHaveBeenCalledWith('thread-root', '42');
    });
});
