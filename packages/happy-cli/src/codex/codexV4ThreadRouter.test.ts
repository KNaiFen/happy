import { describe, expect, it, vi } from 'vitest';
import type {
    CodexRelationEntityV4,
    SyncV4DiagnosticInput,
} from '@slopus/happy-wire';
import type {
    SyncV4CodexNotification,
    SyncV4CodexThreadRoute,
    SyncV4MigrationJournalState,
    SyncV4PendingCodexNotification,
} from '@/api/syncV4Journal';
import type { ServerNotification, Thread, ThreadGoal, ThreadItem } from './protocol';
import type { CodexV4ChildThreadRoute } from './codexV4Migration';
import {
    CodexV4NotificationRoutingError,
    CodexV4ThreadRouter,
    type CodexV4SessionBinding,
} from './codexV4ThreadRouter';

class FakeMapper {
    readonly order: string[] = [];
    readonly notifications: ServerNotification[] = [];
    readonly snapshots: Thread[] = [];
    readonly stateSnapshots: Thread[] = [];
    readonly rollbackSnapshots: Thread[] = [];
    readonly relations: CodexRelationEntityV4[] = [];
    readonly goals: Array<{ threadId: string; goal: ThreadGoal | null }> = [];
    readonly connections: Array<{
        connection: string;
        options: { statusUnknown?: boolean; error?: string | null } | undefined;
    }> = [];
    readonly migrationBarriers = new Set<string>();
    syncStateFailure: Error | null = null;
    notificationFailure: Error | null = null;
    flushFailure: Error | null = null;
    flushCount = 0;

    async handleNotification(notification: ServerNotification): Promise<void> {
        if (this.notificationFailure) {
            const error = this.notificationFailure;
            this.notificationFailure = null;
            throw error;
        }
        this.order.push('orphan.notification');
        this.notifications.push(notification);
    }

    importThread(thread: Thread): void {
        this.snapshots.push(thread);
    }

    importThreadState(thread: Thread): void {
        this.stateSnapshots.push(thread);
    }

    async reconcileRollbackSnapshot(thread: Thread): Promise<void> {
        this.order.push('rollback.snapshot');
        this.rollbackSnapshots.push(thread);
    }

    importGoal(threadId: string, goal: ThreadGoal | null): void {
        this.goals.push({ threadId, goal });
    }

    async upsertRelation(relation: CodexRelationEntityV4): Promise<void> {
        this.relations.push(relation);
    }

    async prepareMigration(threadId: string): Promise<void> {
        this.migrationBarriers.add(threadId);
    }
    prepareSnapshotBarrier(threadId: string): void {
        this.migrationBarriers.add(threadId);
    }
    isMigrationBarrierActive(threadId: string): boolean {
        return this.migrationBarriers.has(threadId);
    }
    async releaseMigrationBarrier(threadId: string): Promise<void> {
        this.migrationBarriers.delete(threadId);
    }
    async setSyncState(): Promise<void> {
        if (!this.syncStateFailure) return;
        const error = this.syncStateFailure;
        this.syncStateFailure = null;
        throw error;
    }
    async setConnection(
        connection: string,
        options?: { statusUnknown?: boolean; error?: string | null },
    ): Promise<void> {
        this.connections.push({ connection, options });
    }
    async flush(): Promise<void> {
        this.flushCount += 1;
        if (this.flushFailure) {
            const error = this.flushFailure;
            this.flushFailure = null;
            throw error;
        }
        this.order.push('mapper.flush');
    }
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
    const recover = vi.fn(async () => {});
    let migrationState = initialMigrationState;
    let orphanSequence = 0;
    const pendingCodexNotifications: SyncV4PendingCodexNotification[] = [];
    const codexThreadRoutes = new Map<string, SyncV4CodexThreadRoute>();
    const persistCodexThreadRoute = vi.fn(async (route: SyncV4CodexThreadRoute) => {
        codexThreadRoutes.set(route.threadId, route);
    });
    const persistCodexOrphan = vi.fn(async (threadId: string, notification: ServerNotification) => {
        orphanSequence += 1;
        const pending = {
            notificationId: `00000000-0000-4000-8000-${orphanSequence.toString().padStart(12, '0')}`,
            threadId,
            notification,
            receivedAt: orphanSequence,
        } as unknown as SyncV4PendingCodexNotification;
        pendingCodexNotifications.push(pending);
        return pending;
    });
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
            getPendingCodexNotifications: vi.fn(() => [...pendingCodexNotifications]),
            getCodexThreadRoutes: vi.fn(() => new Map(codexThreadRoutes)),
            persistCodexOrphan,
            completeCodexOrphan: vi.fn(async (notificationId: string) => {
                const index = pendingCodexNotifications.findIndex((entry) => entry.notificationId === notificationId);
                if (index >= 0) pendingCodexNotifications.splice(index, 1);
            }),
            persistCodexThreadRoute,
        },
        commandProcessor: {},
        requestBroker,
        recover,
        close,
    } as unknown as CodexV4SessionBinding;
    return {
        value,
        mapper,
        requestBroker,
        recover,
        close,
        pendingCodexNotifications,
        codexThreadRoutes,
        persistCodexThreadRoute,
        persistCodexOrphan,
    };
}

function thread(id: string, parentThreadId: string | null, status: Thread['status'] = { type: 'idle' }): Thread {
    return {
        id,
        sessionId: 'tree-1',
        forkedFromId: null,
        parentThreadId,
        preview: '',
        ephemeral: false,
        section: null,
        sectionEnteredAt: null,
        modelProvider: 'openai',
        createdAt: 1,
        updatedAt: 2,
        recencyAt: 2,
        status,
        path: null,
        cwd: '/workspace',
        cliVersion: '0.145.0',
        source: parentThreadId
            ? { subAgent: { thread_spawn: {
                parent_thread_id: parentThreadId,
                depth: 1,
                agent_path: null,
                agent_nickname: null,
                agent_role: null,
            } } }
            : 'appServer',
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
    };
}

describe('CodexV4ThreadRouter', () => {
    it('journals a root notification that arrives before registration and replays it once', async () => {
        const root = binding('happy-root');
        const onError = vi.fn();
        const snapshot = thread('thread-root', null);
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => snapshot,
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
            onError,
        });
        const started = {
            method: 'thread/started',
            params: { thread: snapshot },
        } as ServerNotification;

        router.handleNotification(started);
        await router.flush();
        expect(root.pendingCodexNotifications).toHaveLength(1);
        expect(root.mapper.notifications).toEqual([]);
        expect(onError).not.toHaveBeenCalled();

        await router.registerRootThread('thread-root');
        await router.flush();
        expect(root.pendingCodexNotifications).toEqual([]);
        expect(root.mapper.notifications).toEqual([started]);
        expect(onError).not.toHaveBeenCalled();
    });

    it('journals notifications while root route durability is pending', async () => {
        const root = binding('happy-root');
        const snapshot = thread('thread-root', null);
        let persistStarted!: () => void;
        let releasePersist!: () => void;
        const startedPersisting = new Promise<void>((resolve) => { persistStarted = resolve; });
        const persistGate = new Promise<void>((resolve) => { releasePersist = resolve; });
        root.persistCodexThreadRoute.mockImplementationOnce(async (route) => {
            persistStarted();
            await persistGate;
            root.codexThreadRoutes.set(route.threadId, route);
        });
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => snapshot,
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
            routeRegistrationWaitMs: 100,
        });
        const registration = router.registerRootThread('thread-root');
        await startedPersisting;
        const started = {
            method: 'thread/started',
            params: { thread: snapshot },
        } as ServerNotification;
        router.handleNotification(started);
        await router.flush();
        expect(root.pendingCodexNotifications).toHaveLength(1);
        expect(root.mapper.notifications).toEqual([]);

        const request = router.handleRequest({
            requestId: 'request-during-persist',
            method: 'item/tool/requestUserInput',
            params: { threadId: 'thread-root' },
        });
        await Promise.resolve();
        expect(root.requestBroker.handle).not.toHaveBeenCalled();

        releasePersist();
        await registration;
        await expect(request).resolves.toMatchObject({ response: { decision: 'accept' } });
        await router.flush();
        expect(root.pendingCodexNotifications).toEqual([]);
        expect(root.mapper.notifications).toEqual([started]);
    });

    it('rolls back a provisional root route and preserves notifications after persistence fails', async () => {
        const root = binding('happy-root');
        const snapshot = thread('thread-root', null);
        root.persistCodexThreadRoute.mockRejectedValueOnce(new Error('journal unavailable'));
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => snapshot,
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
        });

        await expect(router.registerRootThread('thread-root')).rejects.toThrow('journal unavailable');
        router.handleNotification({
            method: 'thread/started',
            params: { thread: snapshot },
        } as ServerNotification);
        await router.flush();
        expect(root.mapper.notifications).toEqual([]);
        expect(root.pendingCodexNotifications).toHaveLength(1);

        await router.registerRootThread('thread-root');
        await router.flush();
        expect(root.pendingCodexNotifications).toEqual([]);
        expect(root.mapper.notifications).toHaveLength(1);
    });

    it('restores an existing root active turn when a route update cannot be persisted', async () => {
        const root = binding('happy-root');
        root.codexThreadRoutes.set('thread-root', {
            threadId: 'thread-root',
            kind: 'root',
            parentThreadId: null,
            parentTurnId: null,
            delegationItemId: null,
            depth: 0,
            activeTurnId: 'turn-active',
        });
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-root', null),
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
        });
        root.persistCodexThreadRoute.mockRejectedValueOnce(new Error('journal unavailable'));

        await expect(router.registerRootThread('thread-root', 'command-1'))
            .rejects.toThrow('journal unavailable');

        const state = router as unknown as {
            activeTurnByThread: Map<string, string>;
        };
        expect(state.activeTurnByThread.get('thread-root')).toBe('turn-active');
    });

    it('updates and flushes the root binding before any thread route exists', async () => {
        const root = binding('happy-root');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => {
                throw new Error('unexpected read');
            },
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
        });

        router.setConnection({
            connection: 'disconnected',
            statusUnknown: true,
            error: 'relay unavailable',
        });
        await router.flush();

        expect(root.mapper.connections).toEqual([{
            connection: 'disconnected',
            options: {
                statusUnknown: true,
                error: 'relay unavailable',
            },
        }]);
        expect(root.requestBroker.failPending).toHaveBeenCalledWith('transportDisconnected');
        expect(root.mapper.flushCount).toBe(1);
    });

    it('waits for a concurrently persisted root route before handling a provider request', async () => {
        const root = binding('happy-root');
        const snapshot = thread('thread-root', null);
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => snapshot,
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
            routeRegistrationWaitMs: 100,
        });
        const request = {
            requestId: 'request-1',
            method: 'item/tool/requestUserInput',
            params: { threadId: 'thread-root' },
        } as const;

        const pending = router.handleRequest(request);
        await Promise.resolve();
        expect(root.requestBroker.handle).not.toHaveBeenCalled();

        await router.registerRootThread('thread-root');
        await expect(pending).resolves.toMatchObject({
            response: { decision: 'accept' },
        });
        expect(root.requestBroker.handle).toHaveBeenCalledWith(request);
    });

    it('returns an error when an unknown root never receives an authoritative route', async () => {
        const root = binding('happy-root');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-unknown', null),
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
            routeRegistrationWaitMs: 0,
        });

        await expect(router.handleRequest({
            requestId: 'request-unknown',
            method: 'item/tool/requestUserInput',
            params: { threadId: 'thread-unknown' },
        })).rejects.toThrow('before authoritative route registration');
        expect(root.requestBroker.handle).not.toHaveBeenCalled();
    });

    it('migrates a root thread that started before the Happy relay became available', async () => {
        const root = binding('happy-root');
        const snapshot = thread('thread-root', null);
        const readThread = vi.fn(async () => snapshot);
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread,
            readGoal: async () => ({
                threadId: 'thread-root',
                objective: 'finish offline work',
                status: 'active',
                tokenBudget: null,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: 1,
                updatedAt: 1,
            }),
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
        });

        await router.registerRootThread('thread-root');
        await router.migrateRootSnapshot('thread-root');

        expect(readThread).toHaveBeenCalledWith('thread-root');
        expect(root.mapper.snapshots).toEqual([snapshot]);
        expect(root.mapper.goals).toMatchObject([{
            threadId: 'thread-root',
            goal: { objective: 'finish offline work' },
        }]);
        expect(root.mapper.migrationBarriers.has('thread-root')).toBe(false);
        expect(root.value.syncClient.setMigrationState).toHaveBeenLastCalledWith(
            'thread-root',
            'ready',
        );
    });

    it('migrates an acquired live root snapshot without reading the provider twice', async () => {
        const root = binding('happy-root');
        const snapshot = thread('thread-root', null);
        const readThread = vi.fn(async () => {
            throw new Error('unexpected duplicate provider read');
        });
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread,
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
        });

        await router.registerRootThread('thread-root');
        await router.migrateRootSnapshot('thread-root', snapshot);

        expect(readThread).not.toHaveBeenCalled();
        expect(root.mapper.snapshots).toEqual([snapshot]);
        expect(root.value.syncClient.setMigrationState).toHaveBeenLastCalledWith(
            'thread-root',
            'ready',
        );
    });

    it('serializes an authoritative rollback snapshot through the root mapper and flushes it', async () => {
        const root = binding('happy-root');
        const snapshot = thread('thread-root', null);
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => snapshot,
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
        });

        await router.registerRootThread('thread-root');
        root.mapper.notificationFailure = new Error('persist before rollback');
        await expect(router.handleNotificationAsync({
            method: 'thread/tokenUsage/updated',
            params: {
                threadId: 'thread-root',
                turnId: 'turn-stale',
                tokenUsage: {
                    total: {
                        totalTokens: 8,
                        inputTokens: 5,
                        cachedInputTokens: 0,
                        cacheWriteInputTokens: 0,
                        outputTokens: 3,
                        reasoningOutputTokens: 0,
                    },
                    last: {
                        totalTokens: 8,
                        inputTokens: 5,
                        cachedInputTokens: 0,
                        cacheWriteInputTokens: 0,
                        outputTokens: 3,
                        reasoningOutputTokens: 0,
                    },
                    modelContextWindow: 200_000,
                },
            },
        } as ServerNotification)).rejects.toMatchObject({
            name: 'CodexV4NotificationRoutingError',
            durablyQueued: true,
            diagnosticCause: expect.objectContaining({ message: 'persist before rollback' }),
        });
        expect(root.pendingCodexNotifications).toHaveLength(1);
        root.mapper.order.length = 0;

        await router.reconcileRollbackSnapshot('thread-root', snapshot);

        expect(root.mapper.order).toEqual([
            'orphan.notification',
            'mapper.flush',
            'rollback.snapshot',
            'mapper.flush',
        ]);
        expect(root.pendingCodexNotifications).toEqual([]);
        expect(root.mapper.rollbackSnapshots).toEqual([snapshot]);
        expect(root.mapper.flushCount).toBe(2);
        await expect(router.reconcileRollbackSnapshot('thread-other', snapshot))
            .rejects.toThrow('did not match');
    });

    it('does not apply a rollback snapshot when persisted orphan replay fails', async () => {
        const root = binding('happy-root');
        const snapshot = thread('thread-root', null);
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => snapshot,
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
        });
        await router.registerRootThread('thread-root');
        root.mapper.notificationFailure = new Error('initial route failure');
        await expect(router.handleNotificationAsync({
            method: 'thread/started',
            params: { thread: snapshot },
        } as ServerNotification)).rejects.toMatchObject({
            name: 'CodexV4NotificationRoutingError',
            durablyQueued: true,
            diagnosticCause: expect.objectContaining({ message: 'initial route failure' }),
        });
        root.mapper.notificationFailure = new Error('orphan replay failure');

        await expect(router.reconcileRollbackSnapshot('thread-root', snapshot)).rejects.toMatchObject({
            name: 'CodexV4NotificationRoutingError',
            durablyQueued: true,
            diagnosticCause: expect.objectContaining({ message: 'orphan replay failure' }),
        });
        expect(root.mapper.rollbackSnapshots).toEqual([]);
        expect(root.mapper.flushCount).toBe(0);
        expect(root.pendingCodexNotifications).toHaveLength(1);
    });

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
        await router.registerRootThread('thread-root');

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
        expect(root.codexThreadRoutes.get('thread-child')).toMatchObject({
            status: 'completed',
            activeTurnId: null,
        });
        expect(child.close).toHaveBeenCalledOnce();
    });

    it('relinquishes only the superseded child binding and ignores later provider traffic for it', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const snapshot = thread('thread-child', 'thread-root', { type: 'active', activeFlags: [] });
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => snapshot,
            createChildBinding: async () => child.value,
        });
        await router.registerRootThread('thread-root');
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
        await router.handleNotificationAsync(started);

        await router.relinquishChildSession('happy-child', 'thread-child');
        await router.handleNotificationAsync(started);

        expect(child.close).toHaveBeenCalledOnce();
        expect(router.hasActiveChildWork()).toBe(false);
        expect(child.mapper.notifications).toEqual([started]);
        expect(root.value.close).not.toHaveBeenCalled();
        await expect(router.handleRequest({
            id: 1,
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-child' },
        } as never)).rejects.toThrow('owned by another Gateway');
    });

    it('does not let an older completed turn finish a child relation with a newer active turn', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root', {
                type: 'active',
                activeFlags: [],
            }),
            createChildBinding: async () => child.value,
        });
        await router.registerRootThread('thread-root');
        router.handleNotification({
            method: 'thread/started',
            params: {
                thread: thread('thread-child', 'thread-root', {
                    type: 'active',
                    activeFlags: [],
                }),
            },
        });
        router.handleNotification({
            method: 'turn/started',
            params: {
                threadId: 'thread-child',
                turn: {
                    id: 'turn-new',
                    items: [],
                    itemsView: 'full',
                    status: 'inProgress',
                    error: null,
                    startedAt: 2,
                    completedAt: null,
                    durationMs: null,
                },
            },
        });
        router.handleNotification({
            method: 'turn/completed',
            params: {
                threadId: 'thread-child',
                turn: {
                    id: 'turn-old',
                    items: [],
                    itemsView: 'full',
                    status: 'completed',
                    error: null,
                    startedAt: 0,
                    completedAt: 1,
                    durationMs: 1,
                },
            },
        });
        await router.flush();

        expect(root.mapper.relations.at(-1)).toMatchObject({
            childThreadId: 'thread-child',
            status: 'active',
        });

        router.handleNotification({
            method: 'turn/completed',
            params: {
                threadId: 'thread-child',
                turn: {
                    id: 'turn-new',
                    items: [],
                    itemsView: 'full',
                    status: 'completed',
                    error: null,
                    startedAt: 2,
                    completedAt: 3,
                    durationMs: 1,
                },
            },
        });
        await router.flush();

        expect(root.mapper.relations.at(-1)).toMatchObject({
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
        await router.registerRootThread('thread-root');

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
        await router.registerRootThread('thread-root');

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
        await router.registerRootThread('thread-root');
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

    it('keeps a terminal parent binding until its active nested child completes', async () => {
        const diagnostics: SyncV4DiagnosticInput[] = [];
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
                { type: 'active', activeFlags: [] },
            ),
            createChildBinding: async (route) => bindings.get(route.thread.id)!,
            diagnostics: { record: (input) => diagnostics.push(input) },
            diagnosticSessionHash: 'opaque_session_123',
            softwareVersion: '1.4.5',
            codexVersion: '0.145.0',
            transportSecurity: 'insecureHttp',
        });
        await router.registerRootThread('thread-root');

        const started = (threadId: string, turnId: string): ServerNotification => ({
            method: 'turn/started',
            params: {
                threadId,
                turn: {
                    id: turnId,
                    items: [],
                    itemsView: 'full',
                    status: 'inProgress',
                    error: null,
                    startedAt: 1,
                    completedAt: null,
                    durationMs: null,
                },
            },
        });
        const completed = (threadId: string, turnId: string): ServerNotification => ({
            method: 'turn/completed',
            params: {
                threadId,
                turn: {
                    id: turnId,
                    items: [],
                    itemsView: 'full',
                    status: 'completed',
                    error: null,
                    startedAt: 1,
                    completedAt: 2,
                    durationMs: 1,
                },
            },
        });

        router.handleNotification(started('thread-child', 'turn-child'));
        router.handleNotification(started('thread-nested', 'turn-nested'));
        await router.flush();

        router.handleNotification(completed('thread-child', 'turn-child'));
        await router.flush();
        expect(child.close).not.toHaveBeenCalled();
        expect(nested.close).not.toHaveBeenCalled();

        router.handleNotification(completed('thread-nested', 'turn-nested'));
        await router.flush();
        expect(nested.close).toHaveBeenCalledOnce();
        expect(child.close).toHaveBeenCalledOnce();
        expect(root.codexThreadRoutes.get('thread-child')).toMatchObject({ status: 'completed' });
        expect(root.codexThreadRoutes.get('thread-nested')).toMatchObject({ status: 'completed' });
        expect(diagnostics.filter((record) => (
            record.event === 'relation' && record.phase === 'completed'
        ))).toEqual([
            expect.objectContaining({
                state: 'stopped',
                childThreadHash: expect.stringMatching(/^[0-9a-f]{16}$/),
                sessionHash: 'opaque_session_123',
                softwareVersion: '1.4.5',
                codexVersion: '0.145.0',
                transportSecurity: 'insecureHttp',
            }),
            expect.objectContaining({
                state: 'stopped',
                childThreadHash: expect.stringMatching(/^[0-9a-f]{16}$/),
            }),
        ]);
    });

    it('records a payload-free degraded lifecycle when terminal child cleanup fails', async () => {
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const onError = vi.fn();
        const root = binding('happy-root');
        const child = binding('happy-child');
        child.close.mockRejectedValueOnce(new Error('prompt-reasoning-tool-output-secret'));
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root'),
            createChildBinding: async () => child.value,
            diagnostics: { record: (input) => diagnostics.push(input) },
            diagnosticSessionHash: 'opaque_session_123',
            onError,
        });
        await router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'thread/started',
            params: { thread: thread('thread-child', 'thread-root') },
        });
        await router.flush();

        expect(child.close).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledOnce();
        expect(diagnostics).toContainEqual(expect.objectContaining({
            component: 'cli.gateway',
            event: 'relation',
            phase: 'failed',
            state: 'degraded',
            errorKind: 'unknown',
            childThreadHash: expect.stringMatching(/^[0-9a-f]{16}$/),
        }));
        expect(JSON.stringify(diagnostics)).not.toContain('prompt-reasoning-tool-output-secret');
    });

    it('reopens a terminal child only long enough to project a late notification', async () => {
        const root = binding('happy-root');
        const firstChild = binding('happy-child-first');
        const lateChild = binding('happy-child-late', 'ready');
        const createChildBinding = vi.fn()
            .mockResolvedValueOnce(firstChild.value)
            .mockResolvedValueOnce(lateChild.value);
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root'),
            createChildBinding,
        });
        await router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'thread/started',
            params: { thread: thread('thread-child', 'thread-root') },
        });
        await router.flush();
        expect(firstChild.close).toHaveBeenCalledOnce();

        const late = {
            method: 'thread/name/updated',
            params: {
                threadId: 'thread-child',
                threadName: 'late metadata',
            },
        } as ServerNotification;
        router.handleNotification(late);
        await router.flush();

        expect(createChildBinding).toHaveBeenCalledTimes(2);
        expect(lateChild.mapper.notifications).toEqual([late]);
        expect(lateChild.close).toHaveBeenCalledOnce();
        expect(root.codexThreadRoutes.get('thread-child')).toMatchObject({
            kind: 'providerChild',
            parentThreadId: 'thread-root',
            status: 'completed',
        });
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
        await router.registerRootThread('thread-root');

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
        await router.registerRootThread('thread-root');

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
        await router.registerRootThread('thread-root');

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
        await router.registerRootThread('thread-root');

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

    it('merges concurrent source and spawn routes without losing delegation lineage', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root'),
            createChildBinding: async () => child.value,
        });
        await router.registerRootThread('thread-root');

        let firstChildRouteStarted!: () => void;
        let releaseFirstChildRoute!: () => void;
        const routeStarted = new Promise<void>((resolve) => { firstChildRouteStarted = resolve; });
        const routeGate = new Promise<void>((resolve) => { releaseFirstChildRoute = resolve; });
        let firstChildRoute = true;
        vi.mocked(root.value.syncClient.persistCodexThreadRoute).mockImplementation(async (route) => {
            if (route.threadId === 'thread-child' && firstChildRoute) {
                firstChildRoute = false;
                firstChildRouteStarted();
                await routeGate;
            }
            root.codexThreadRoutes.set(route.threadId, route);
        });

        router.handleNotification({
            method: 'thread/started',
            params: { thread: thread('thread-child', 'thread-root') },
        });
        await routeStarted;
        router.handleNotification({
            method: 'item/completed',
            params: {
                threadId: 'thread-root',
                turnId: 'turn-root',
                completedAtMs: 10,
                item: {
                    type: 'collabAgentToolCall',
                    id: 'spawn-child',
                    tool: 'spawnAgent',
                    status: 'completed',
                    senderThreadId: 'thread-root',
                    receiverThreadIds: ['thread-child'],
                    prompt: 'delegate',
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {},
                },
            },
        } as ServerNotification);
        releaseFirstChildRoute();
        await router.flush();

        expect(root.codexThreadRoutes.get('thread-child')).toMatchObject({
            kind: 'providerChild',
            parentThreadId: 'thread-root',
            parentTurnId: 'turn-root',
            delegationItemId: 'spawn-child',
            depth: 1,
        });
    });

    it('serializes first relation publication with a concurrent delegation update', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        let relationPublishStarted!: () => void;
        let releaseRelationPublish!: () => void;
        const relationStarted = new Promise<void>((resolve) => { relationPublishStarted = resolve; });
        const relationGate = new Promise<void>((resolve) => { releaseRelationPublish = resolve; });
        const publishRelation = root.mapper.upsertRelation.bind(root.mapper);
        let firstRelation = true;
        vi.spyOn(root.mapper, 'upsertRelation').mockImplementation(async (relation) => {
            if (firstRelation) {
                firstRelation = false;
                relationPublishStarted();
                await relationGate;
            }
            await publishRelation(relation);
        });
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root'),
            createChildBinding: async () => child.value,
        });
        await router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'thread/started',
            params: { thread: thread('thread-child', 'thread-root') },
        });
        await relationStarted;
        router.handleNotification({
            method: 'item/completed',
            params: {
                threadId: 'thread-root',
                turnId: 'turn-root',
                completedAtMs: 10,
                item: {
                    type: 'collabAgentToolCall',
                    id: 'spawn-child',
                    tool: 'spawnAgent',
                    status: 'completed',
                    senderThreadId: 'thread-root',
                    receiverThreadIds: ['thread-child'],
                    prompt: 'delegate',
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {},
                },
            },
        } as ServerNotification);
        releaseRelationPublish();
        await router.flush();

        expect(root.mapper.relations.at(-1)).toMatchObject({
            childThreadId: 'thread-child',
            parentTurnId: 'turn-root',
            delegationItemId: 'spawn-child',
        });
    });

    it('serializes delegation enrichment with child completion status', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root', {
                type: 'active',
                activeFlags: [],
            }),
            createChildBinding: async () => child.value,
        });
        await router.registerRootThread('thread-root');
        router.handleNotification({
            method: 'thread/started',
            params: {
                thread: thread('thread-child', 'thread-root', {
                    type: 'active',
                    activeFlags: [],
                }),
            },
        });
        await router.flush();

        let enrichmentStarted!: () => void;
        let releaseEnrichment!: () => void;
        const started = new Promise<void>((resolve) => { enrichmentStarted = resolve; });
        const gate = new Promise<void>((resolve) => { releaseEnrichment = resolve; });
        const publishRelation = root.mapper.upsertRelation.bind(root.mapper);
        let blockEnrichment = true;
        vi.spyOn(root.mapper, 'upsertRelation').mockImplementation(async (relation) => {
            if (blockEnrichment && relation.delegationItemId === 'spawn-child') {
                blockEnrichment = false;
                enrichmentStarted();
                await gate;
            }
            await publishRelation(relation);
        });

        router.handleNotification({
            method: 'item/completed',
            params: {
                threadId: 'thread-root',
                turnId: 'turn-root',
                completedAtMs: 10,
                item: {
                    type: 'collabAgentToolCall',
                    id: 'spawn-child',
                    tool: 'spawnAgent',
                    status: 'completed',
                    senderThreadId: 'thread-root',
                    receiverThreadIds: ['thread-child'],
                    prompt: 'delegate',
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {},
                },
            },
        } as ServerNotification);
        await started;
        router.handleNotification({
            method: 'turn/completed',
            params: {
                threadId: 'thread-child',
                turn: {
                    id: 'turn-child',
                    items: [],
                    itemsView: 'full',
                    status: 'completed',
                    error: null,
                    startedAt: 1,
                    completedAt: 2,
                    durationMs: 1,
                },
            },
        });
        releaseEnrichment();
        await router.flush();

        expect(root.mapper.relations.at(-1)).toMatchObject({
            childThreadId: 'thread-child',
            parentTurnId: 'turn-root',
            delegationItemId: 'spawn-child',
            status: 'completed',
        });
    });

    it('rejects a child snapshot whose official parent conflicts with its persisted spawn route', async () => {
        const root = binding('happy-root');
        const createChildBinding = vi.fn(async () => binding('happy-child').value);
        const errors: unknown[] = [];
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-other-parent'),
            createChildBinding,
            onError: (error) => errors.push(error),
        });
        await router.registerRootThread('thread-root');
        router.handleNotification({
            method: 'item/completed',
            params: {
                threadId: 'thread-root',
                turnId: 'turn-root',
                completedAtMs: 10,
                item: {
                    type: 'collabAgentToolCall',
                    id: 'spawn-child',
                    tool: 'spawnAgent',
                    status: 'completed',
                    senderThreadId: 'thread-root',
                    receiverThreadIds: ['thread-child'],
                    prompt: 'delegate',
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {},
                },
            },
        } as ServerNotification);
        await router.flush();

        router.handleNotification({
            method: 'thread/started',
            params: { thread: thread('thread-child', 'thread-other-parent') },
        });
        await router.flush();

        expect(createChildBinding).not.toHaveBeenCalled();
        expect(root.pendingCodexNotifications).toHaveLength(1);
        expect(errors).toHaveLength(1);
        await router.close();
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
        await router.registerRootThread('thread-root');

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
        await router.recoverPendingNotifications();
        await router.flush();

        expect(createChildBinding).toHaveBeenCalledTimes(2);
        expect(recoveredChild.mapper.notifications.map((notification) => notification.method)).toEqual([
            'thread/started',
            'thread/status/changed',
        ]);
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
        await router.registerRootThread('thread-root');

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
        await router.registerRootThread('thread-root');
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
        await router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'serverRequest/resolved',
            params: { threadId: 'thread-root', requestId: 42 },
        });
        await router.flush();

        expect(root.requestBroker.markProviderResolved).toHaveBeenCalledWith('thread-root', '42');
    });

    it('replays a failed child orphan from the persisted route after router restart', async () => {
        const root = binding('happy-root');
        const firstRouter = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root'),
            createChildBinding: async () => {
                throw new Error('relay unavailable');
            },
        });
        await firstRouter.registerRootThread('thread-root');
        const notification = {
            method: 'thread/status/changed',
            params: { threadId: 'thread-child', status: { type: 'active', activeFlags: [] } },
        } as ServerNotification;

        firstRouter.handleNotification(notification);
        await firstRouter.flush();
        expect(root.pendingCodexNotifications).toHaveLength(1);
        expect(root.codexThreadRoutes.get('thread-child')).toMatchObject({
            kind: 'providerChild',
            parentThreadId: 'thread-root',
        });
        await firstRouter.close();

        const child = binding('happy-child');
        const secondRouter = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root'),
            createChildBinding: async () => child.value,
        });
        await secondRouter.recoverPendingNotifications();
        await secondRouter.flush();

        expect(root.pendingCodexNotifications).toHaveLength(0);
        expect(child.mapper.notifications).toEqual([notification]);
    });

    it('recovers only persisted active child routes and refreshes their authoritative status', async () => {
        const root = binding('happy-root');
        await root.value.syncClient.persistCodexThreadRoute({
            threadId: 'thread-active',
            kind: 'providerChild',
            parentThreadId: 'thread-root',
            parentTurnId: 'turn-root',
            delegationItemId: 'spawn-active',
            depth: 1,
            status: 'active',
            activeTurnId: 'turn-active',
        });
        await root.value.syncClient.persistCodexThreadRoute({
            threadId: 'thread-history',
            kind: 'providerChild',
            parentThreadId: 'thread-root',
            parentTurnId: 'turn-root',
            delegationItemId: 'spawn-history',
            depth: 1,
            status: 'completed',
            activeTurnId: null,
        });
        const child = binding('happy-child');
        const readThread = vi.fn(async (threadId: string) => thread(threadId, 'thread-root'));
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread,
            createChildBinding: async () => child.value,
        });
        await router.registerRootThread('thread-root');

        await router.recoverActiveThreads();
        await router.flush();

        expect(readThread).toHaveBeenCalledOnce();
        expect(readThread).toHaveBeenCalledWith('thread-active');
        expect(root.codexThreadRoutes.get('thread-active')).toMatchObject({
            status: 'completed',
            activeTurnId: null,
        });
        expect(root.mapper.relations.at(-1)).toMatchObject({
            childThreadId: 'thread-active',
            status: 'completed',
        });
    });

    it('recovers a starting child route after a parent spawn without an orphan notification', async () => {
        const root = binding('happy-root');
        const firstRouter = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => {
                throw new Error('unexpected child read before restart');
            },
            createChildBinding: async () => {
                throw new Error('unexpected child binding before restart');
            },
        });
        await firstRouter.registerRootThread('thread-root');
        firstRouter.handleNotification({
            method: 'item/completed',
            params: {
                threadId: 'thread-root',
                turnId: 'turn-root',
                completedAtMs: 10,
                item: {
                    type: 'collabAgentToolCall',
                    id: 'spawn-child',
                    tool: 'spawnAgent',
                    status: 'completed',
                    senderThreadId: 'thread-root',
                    receiverThreadIds: ['thread-child'],
                    prompt: 'inspect',
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {},
                },
            },
        } as ServerNotification);
        await firstRouter.flush();

        expect(root.codexThreadRoutes.get('thread-child')).toMatchObject({
            kind: 'providerChild',
            status: 'starting',
            activeTurnId: null,
        });
        expect(root.pendingCodexNotifications).toHaveLength(0);
        await firstRouter.close();

        const child = binding('happy-child');
        const readThread = vi.fn(async () => thread(
            'thread-child',
            'thread-root',
            { type: 'active', activeFlags: [] },
        ));
        const secondRouter = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread,
            createChildBinding: async () => child.value,
        });
        await secondRouter.recoverActiveThreads();
        await secondRouter.flush();

        expect(readThread).toHaveBeenCalledWith('thread-child');
        expect(child.recover).toHaveBeenCalledOnce();
        expect(root.codexThreadRoutes.get('thread-child')).toMatchObject({
            status: 'active',
        });
        await secondRouter.close();
    });

    it('clears a persisted active turn when the authoritative child snapshot has no active turn', async () => {
        const root = binding('happy-root');
        await root.value.syncClient.persistCodexThreadRoute({
            threadId: 'thread-child',
            kind: 'providerChild',
            parentThreadId: 'thread-root',
            parentTurnId: 'turn-root',
            delegationItemId: 'spawn-child',
            depth: 1,
            status: 'active',
            activeTurnId: 'turn-stale',
        });
        const child = binding('happy-child');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root', {
                type: 'active',
                activeFlags: [],
            }),
            createChildBinding: async () => child.value,
        });
        await router.registerRootThread('thread-root');
        await router.recoverActiveThreads();

        router.handleNotification({
            method: 'turn/completed',
            params: {
                threadId: 'thread-child',
                turn: {
                    id: 'turn-authoritative',
                    items: [],
                    itemsView: 'full',
                    status: 'completed',
                    error: null,
                    startedAt: 1,
                    completedAt: 2,
                    durationMs: 1,
                },
            },
        });
        await router.flush();

        expect(root.codexThreadRoutes.get('thread-child')).toMatchObject({
            status: 'completed',
            activeTurnId: null,
        });
        expect(root.mapper.relations.at(-1)).toMatchObject({
            childThreadId: 'thread-child',
            status: 'completed',
        });
    });

    it('persists a bound notification as an orphan when relation projection fails', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const errors: unknown[] = [];
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root'),
            createChildBinding: async () => child.value,
            onError: (error) => errors.push(error),
        });
        await router.registerRootThread('thread-root');
        router.handleNotification({
            method: 'thread/started',
            params: { thread: thread('thread-child', 'thread-root') },
        });
        await router.flush();
        vi.spyOn(root.mapper, 'upsertRelation').mockRejectedValue(new Error('projection unavailable'));

        const notification = {
            method: 'thread/status/changed',
            params: {
                threadId: 'thread-child',
                status: { type: 'active', activeFlags: [] },
            },
        } as ServerNotification;
        await expect(router.handleNotificationAsync(notification)).rejects.toMatchObject({
            name: 'CodexV4NotificationRoutingError',
            durablyQueued: true,
            diagnosticCause: expect.objectContaining({ message: 'projection unavailable' }),
        });

        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(CodexV4NotificationRoutingError);
        expect(root.pendingCodexNotifications).toHaveLength(1);
        expect(root.pendingCodexNotifications[0].notification).toEqual(notification);
        await router.close();
    });

    it('marks a bound notification unrecoverable when orphan persistence fails', async () => {
        const root = binding('happy-root');
        const errors: unknown[] = [];
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-root', null),
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
            onError: (error) => errors.push(error),
        });
        await router.registerRootThread('thread-root');
        root.mapper.notificationFailure = new Error('projection unavailable');
        root.persistCodexOrphan.mockRejectedValueOnce(new Error('orphan journal unavailable'));

        const notification = {
            method: 'thread/name/updated',
            params: {
                threadId: 'thread-root',
                threadName: 'lost name',
            },
        } as ServerNotification;

        await expect(router.handleNotificationAsync(notification)).rejects.toMatchObject({
            name: 'CodexV4NotificationRoutingError',
            durablyQueued: false,
            diagnosticCause: expect.objectContaining({ message: 'orphan journal unavailable' }),
            routingCause: expect.objectContaining({ message: 'projection unavailable' }),
        });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(CodexV4NotificationRoutingError);
        expect(root.pendingCodexNotifications).toHaveLength(0);
        await router.close();
    });

    it('persists a bound notification as an orphan when mapper outbox projection fails', async () => {
        const root = binding('happy-root');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-root', null),
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
        });
        await router.registerRootThread('thread-root');
        root.mapper.notificationFailure = new Error('outbox unavailable');
        const notification = {
            method: 'thread/name/updated',
            params: {
                threadId: 'thread-root',
                threadName: 'durable name',
            },
        } as ServerNotification;

        router.handleNotification(notification);
        await router.flush();

        expect(root.pendingCodexNotifications).toHaveLength(1);
        expect(root.pendingCodexNotifications[0].notification).toEqual(notification);
        await router.close();
    });

    it('keeps later live notifications behind an earlier durable orphan for the same thread', async () => {
        const root = binding('happy-root');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-root', null),
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
        });
        await router.registerRootThread('thread-root');
        root.mapper.notificationFailure = new Error('first projection unavailable');
        const first = {
            method: 'thread/name/updated',
            params: {
                threadId: 'thread-root',
                threadName: 'first',
            },
        } as ServerNotification;
        const second = {
            method: 'thread/status/changed',
            params: {
                threadId: 'thread-root',
                status: { type: 'active', activeFlags: [] },
            },
        } as ServerNotification;

        router.handleNotification(first);
        router.handleNotification(second);
        await router.flush();
        await router.recoverPendingNotifications();
        await router.flush();

        expect(root.mapper.notifications).toEqual([first, second]);
        expect(root.pendingCodexNotifications).toHaveLength(0);
        await router.close();
    });

    it('keeps an active route recoverable when terminal relation projection fails', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root', {
                type: 'active',
                activeFlags: [],
            }),
            createChildBinding: async () => child.value,
        });
        await router.registerRootThread('thread-root');
        router.handleNotification({
            method: 'thread/started',
            params: {
                thread: thread('thread-child', 'thread-root', {
                    type: 'active',
                    activeFlags: [],
                }),
            },
        });
        await router.flush();
        vi.spyOn(root.mapper, 'upsertRelation').mockRejectedValue(
            new Error('terminal projection unavailable'),
        );

        router.handleNotification({
            method: 'thread/status/changed',
            params: {
                threadId: 'thread-child',
                status: { type: 'idle' },
            },
        });
        await router.flush();

        expect(root.codexThreadRoutes.get('thread-child')).toMatchObject({
            status: 'active',
        });
        expect(root.pendingCodexNotifications).toHaveLength(1);
        await router.close();
    });

    it('closes child bindings even when a mapper flush fails', async () => {
        const root = binding('happy-root');
        const child = binding('happy-child');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root', {
                type: 'active',
                activeFlags: [],
            }),
            createChildBinding: async () => child.value,
        });
        await router.registerRootThread('thread-root');
        router.handleNotification({
            method: 'thread/started',
            params: {
                thread: thread('thread-child', 'thread-root', {
                    type: 'active',
                    activeFlags: [],
                }),
            },
        });
        await router.flush();
        child.mapper.flushFailure = new Error('child flush failed');

        await expect(router.close()).rejects.toThrow('child flush failed');

        expect(child.close).toHaveBeenCalledOnce();
    });

    it('reports child close failures while still completing router cleanup', async () => {
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const onError = vi.fn();
        const root = binding('happy-root');
        const child = binding('happy-child');
        child.close.mockRejectedValueOnce(new Error('child close prompt secret'));
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-child', 'thread-root', {
                type: 'active',
                activeFlags: [],
            }),
            createChildBinding: async () => child.value,
            diagnostics: { record: (input) => diagnostics.push(input) },
            onError,
        });
        await router.registerRootThread('thread-root');
        router.handleNotification({
            method: 'thread/started',
            params: {
                thread: thread('thread-child', 'thread-root', {
                    type: 'active',
                    activeFlags: [],
                }),
            },
        });
        await router.flush();

        await expect(router.close()).rejects.toThrow('child close prompt secret');

        expect(child.close).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledOnce();
        expect(diagnostics).toContainEqual(expect.objectContaining({
            component: 'cli.gateway',
            event: 'relation',
            phase: 'failed',
            state: 'degraded',
            childThreadHash: expect.stringMatching(/^[0-9a-f]{16}$/),
        }));
        expect(JSON.stringify(diagnostics)).not.toContain('child close prompt secret');
    });

    it('does not guess an unknown parentless thread as root and drains it after explicit ownership', async () => {
        const root = binding('happy-root');
        const createChildBinding = vi.fn(async () => {
            throw new Error('unexpected child');
        });
        const unknown = thread('thread-new-root', null);
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => unknown,
            createChildBinding,
        });
        const notification = {
            method: 'thread/started',
            params: { thread: unknown },
        } as ServerNotification;

        router.handleNotification(notification);
        await router.flush();
        expect(root.mapper.notifications).toEqual([]);
        expect(root.pendingCodexNotifications).toHaveLength(1);

        await router.registerRootThread('thread-new-root');
        await router.flush();
        expect(root.pendingCodexNotifications).toHaveLength(0);
        expect(root.mapper.notifications).toEqual([notification]);
        expect(createChildBinding).not.toHaveBeenCalled();
    });

    it('keeps recovered root orphans pending until the migration barrier is released', async () => {
        const root = binding('happy-root');
        const notification = {
            method: 'thread/status/changed',
            params: { threadId: 'thread-root', status: { type: 'active', activeFlags: [] } },
        } as ServerNotification;
        await root.value.syncClient.persistCodexOrphan(
            'thread-root',
            notification as unknown as SyncV4CodexNotification,
        );
        await root.mapper.prepareMigration('thread-root');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-root', null),
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
        });

        await router.registerRootThread('thread-root');
        await router.flush();

        expect(root.mapper.notifications).toEqual([]);
        expect(root.pendingCodexNotifications).toHaveLength(1);

        await root.mapper.releaseMigrationBarrier('thread-root');
        await router.recoverPendingNotifications();
        await router.flush();

        expect(root.mapper.notifications).toEqual([notification]);
        expect(root.pendingCodexNotifications).toHaveLength(0);
        await router.close();
    });

    it('keeps a user fork in the writable root session and routes a detached review to a side session', async () => {
        const root = binding('happy-root');
        const review = binding('happy-review');
        const fork = { ...thread('thread-fork', null), forkedFromId: 'thread-root' };
        const reviewThread = {
            ...thread('thread-review', null),
            source: { subAgent: 'review' } as Thread['source'],
        };
        const createChildBinding = vi.fn(async () => review.value);
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async (threadId) => threadId === fork.id ? fork : reviewThread,
            createChildBinding,
        });
        await router.registerRootThread('thread-root');
        const forkNotification = {
            method: 'thread/started',
            params: { thread: fork },
        } as ServerNotification;
        const reviewNotification = {
            method: 'turn/started',
            params: {
                threadId: reviewThread.id,
                turn: {
                    id: 'turn-review',
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

        router.handleNotification(forkNotification);
        router.handleNotification(reviewNotification);
        await router.flush();
        await router.registerUserFork(fork.id, 'thread-root');
        await router.registerDetachedReview(reviewThread.id, 'thread-root');
        await router.flush();

        expect(root.mapper.notifications).toEqual([forkNotification]);
        expect(review.mapper.notifications).toEqual([reviewNotification]);
        expect(createChildBinding).toHaveBeenCalledOnce();
        expect(root.mapper.relations.at(-1)).toMatchObject({
            parentThreadId: 'thread-root',
            childThreadId: 'thread-review',
        });
    });

    it('does not create child routes for sibling collaboration or activity notifications', async () => {
        const root = binding('happy-root');
        const createChildBinding = vi.fn(async () => {
            throw new Error('unexpected child');
        });
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => thread('thread-root', null),
            createChildBinding,
        });
        await router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'item/completed',
            params: {
                threadId: 'thread-root',
                turnId: 'turn-root',
                completedAtMs: 10,
                item: {
                    type: 'collabAgentToolCall',
                    id: 'send-input',
                    tool: 'sendInput',
                    status: 'completed',
                    senderThreadId: 'thread-root',
                    receiverThreadIds: ['thread-sibling'],
                    prompt: 'continue',
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {},
                },
            },
        } as ServerNotification);
        router.handleNotification({
            method: 'item/completed',
            params: {
                threadId: 'thread-root',
                turnId: 'turn-root',
                completedAtMs: 11,
                item: {
                    type: 'subAgentActivity',
                    id: 'activity',
                    kind: 'interacted',
                    agentThreadId: 'thread-sibling',
                    agentPath: 'sibling',
                },
            },
        } as ServerNotification);
        await router.flush();

        expect(createChildBinding).not.toHaveBeenCalled();
        expect(root.codexThreadRoutes.has('thread-sibling')).toBe(false);
    });

    it('never persists raw reasoning and strips it from canonical orphan snapshots', async () => {
        const root = binding('happy-root');
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => {
                throw new Error('binding unavailable');
            },
            createChildBinding: async () => {
                throw new Error('binding unavailable');
            },
        });
        await router.registerRootThread('thread-root');

        router.handleNotification({
            method: 'item/reasoning/textDelta',
            params: {
                threadId: 'thread-child',
                turnId: 'turn-child',
                itemId: 'reasoning',
                contentIndex: 0,
                delta: 'raw-secret-delta',
            },
        });
        await router.flush();
        expect(root.pendingCodexNotifications).toHaveLength(0);

        router.handleNotification({
            method: 'item/completed',
            params: {
                threadId: 'thread-child',
                turnId: 'turn-child',
                completedAtMs: 10,
                item: {
                    type: 'reasoning',
                    id: 'reasoning',
                    summary: ['safe summary'],
                    content: ['raw-secret-snapshot'],
                    futureRawContent: 'raw-secret-future-field',
                } as unknown as ThreadItem,
            },
        });
        await router.flush();

        expect(root.pendingCodexNotifications).toHaveLength(1);
        expect(JSON.stringify(root.pendingCodexNotifications)).toContain('safe summary');
        expect(JSON.stringify(root.pendingCodexNotifications)).not.toContain('raw-secret');
    });

    it('hydrates a user fork snapshot before replaying its first durable delta', async () => {
        const root = binding('happy-root');
        const fork = { ...thread('thread-fork', null), forkedFromId: 'thread-root' };
        const router = new CodexV4ThreadRouter({
            rootBinding: root.value,
            readThread: async () => fork,
            createChildBinding: async () => {
                throw new Error('unexpected child');
            },
        });
        await router.registerRootThread('thread-root');
        const delta = {
            method: 'item/agentMessage/delta',
            params: {
                threadId: 'thread-fork',
                turnId: 'turn-fork',
                itemId: 'item-fork',
                delta: 'continued',
            },
        } as ServerNotification;

        router.handleNotification(delta);
        await router.flush();
        await router.registerUserFork('thread-fork', 'thread-root');
        await router.flush();

        expect(root.mapper.snapshots.map((snapshot) => snapshot.id)).toEqual(['thread-fork']);
        expect(root.mapper.notifications).toEqual([delta]);
        expect(root.pendingCodexNotifications).toHaveLength(0);
    });
});
