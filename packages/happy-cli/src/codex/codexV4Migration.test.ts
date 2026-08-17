import { describe, expect, it, vi } from 'vitest';
import type { CodexRuntimeEntityV4 } from '@slopus/happy-wire';
import type { SyncV4MigrationJournalState } from '@/api/syncV4Journal';
import type { Thread, ThreadGoal, ThreadItem, Turn } from './protocol';
import {
    childThreadReferences,
    CodexV4Migrator,
    type CodexV4MigrationSink,
} from './codexV4Migration';

function thread(id: string, turns: Turn[] = [], parentThreadId: string | null = null): Thread {
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

function turn(id: string, items: ThreadItem[]): Turn {
    return {
        id,
        items,
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
    };
}

function collab(id: string, receiverThreadIds: string[]): ThreadItem {
    return {
        type: 'collabAgentToolCall',
        id,
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: 'parent',
        receiverThreadIds,
        prompt: 'delegate',
        model: null,
        reasoningEffort: null,
        agentsStates: {},
    } as ThreadItem;
}

function activity(id: string, agentThreadId: string): ThreadItem {
    return {
        type: 'subAgentActivity',
        id,
        kind: 'started',
        agentThreadId,
        agentPath: 'child',
    } as ThreadItem;
}

class FakeSink implements CodexV4MigrationSink {
    private readonly migrationStates = new Map<string, SyncV4MigrationJournalState>();

    constructor(readonly name: string, private readonly events: string[]) {}

    async prepareMigration(threadId: string): Promise<void> {
        this.events.push(`${this.name}:prepare:${threadId}`);
    }

    async releaseMigrationBarrier(threadId: string): Promise<void> {
        this.events.push(`${this.name}:release:${threadId}`);
    }

    importThread(value: Thread): void {
        this.events.push(`${this.name}:import:${value.id}`);
    }

    importGoal(threadId: string, goal: ThreadGoal | null): void {
        this.events.push(`${this.name}:goal:${threadId}:${goal?.objective ?? 'none'}`);
    }

    async setSyncState(state: CodexRuntimeEntityV4['syncState']): Promise<void> {
        this.events.push(`${this.name}:state:${state}`);
    }

    async flush(): Promise<void> {
        this.events.push(`${this.name}:flush`);
    }

    async flushOutboundOnce(): Promise<void> {
        this.events.push(`${this.name}:ack`);
    }

    getMigrationState(threadId: string): SyncV4MigrationJournalState | undefined {
        return this.migrationStates.get(threadId);
    }

    async setMigrationState(threadId: string, state: SyncV4MigrationJournalState): Promise<void> {
        this.migrationStates.set(threadId, state);
        this.events.push(`${this.name}:migration:${threadId}:${state}`);
    }
}

describe('CodexV4Migrator', () => {
    it('imports nested child snapshots into routed sessions before activating any projection', async () => {
        const events: string[] = [];
        const rootSink = new FakeSink('root', events);
        const childSink = new FakeSink('child', events);
        const nestedSink = new FakeSink('nested', events);
        const root = thread('root', [turn('turn-root', [collab('delegate-1', ['child'])])]);
        const child = thread('child', [turn('turn-child', [collab('delegate-2', ['nested'])])], 'root');
        const nested = thread('nested', [], 'child');
        const snapshots = new Map([[child.id, child], [nested.id, nested]]);
        const routes: string[] = [];
        const migrator = new CodexV4Migrator({
            rootSink,
            readGoal: async (threadId) => ({
                threadId,
                objective: `goal-${threadId}`,
                status: 'active',
                tokenBudget: null,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: 1,
                updatedAt: 2,
            }),
            readThread: async (threadId) => snapshots.get(threadId)!,
            resolveChildSink: async (route) => {
                routes.push([
                    route.thread.id,
                    route.parentThreadId,
                    route.parentTurnId,
                    route.delegationItemId,
                    String(route.depth),
                ].join(':'));
                return route.thread.id === 'child' ? childSink : nestedSink;
            },
        });

        await migrator.prepareRoot(root.id);
        await migrator.migrate(root);

        expect(routes).toEqual([
            'child:root:turn-root:delegate-1:1',
            'nested:child:turn-child:delegate-2:2',
        ]);
        expect(events).toContain('root:import:root');
        expect(events).toContain('child:import:child');
        expect(events).toContain('nested:import:nested');
        expect(events).toContain('root:goal:root:goal-root');
        expect(events).toContain('child:goal:child:goal-child');
        expect(events).toContain('nested:goal:nested:goal-nested');
        const firstReady = events.findIndex((event) => event.endsWith(':state:ready'));
        const lastImport = Math.max(...events.map((event, index) => event.includes(':import:') ? index : -1));
        expect(firstReady).toBeGreaterThan(lastImport);
        expect(events.indexOf('root:state:ready')).toBeGreaterThan(events.indexOf('nested:state:ready'));
        expect(events.indexOf('root:state:ready')).toBeGreaterThan(events.indexOf('child:state:ready'));
        for (const name of ['root', 'child', 'nested']) {
            expect(events).toContain(`${name}:state:importing`);
            expect(events).toContain(`${name}:migration:${name}:activating`);
            const readyIndex = events.indexOf(`${name}:state:ready`);
            expect(events[readyIndex + 1]).toBe(`${name}:flush`);
            expect(events[readyIndex + 2]).toBe(`${name}:ack`);
            expect(events[readyIndex + 3]).toBe(`${name}:migration:${name}:ready`);
        }
    });

    it('recovers an activating migration without replaying the snapshot', async () => {
        const events: string[] = [];
        const rootSink = new FakeSink('root', events);
        await rootSink.setMigrationState('root', 'activating');
        events.length = 0;
        const root = thread('root');
        const migrator = new CodexV4Migrator({
            rootSink,
            readThread: vi.fn(),
            resolveChildSink: vi.fn(),
        });

        await migrator.prepareRoot(root.id);
        await migrator.migrate(root);

        expect(events).not.toContain('root:import:root');
        expect(events).toContain('root:state:ready');
        const readyState = events.indexOf('root:state:ready');
        const readyMigration = events.indexOf('root:migration:root:ready');
        expect(events[readyState + 1]).toBe('root:flush');
        expect(events[readyState + 2]).toBe('root:ack');
        expect(readyMigration).toBeGreaterThan(readyState + 2);
    });

    it('keeps the projection inactive and records an error when a child snapshot cannot be read', async () => {
        const events: string[] = [];
        const rootSink = new FakeSink('root', events);
        const root = thread('root', [turn('turn-root', [collab('delegate-1', ['missing'])])]);
        const migrator = new CodexV4Migrator({
            rootSink,
            readThread: vi.fn().mockRejectedValue(new Error('thread/read failed')),
            resolveChildSink: vi.fn(),
        });

        await migrator.prepareRoot(root.id);
        await expect(migrator.migrate(root)).rejects.toThrow('thread/read failed');

        expect(events).toContain('root:state:error');
        expect(events).toContain('root:migration:root:error');
        expect(events).not.toContain('root:state:ready');
        expect(events.slice(-3)).toEqual([
            'root:flush',
            'root:ack',
            'root:migration:root:error',
        ]);
    });

    it('uses only spawnAgent items for child lineage and ignores activity-only references', () => {
        const value = thread('root', [turn('turn-1', [
            collab('delegate-1', ['root', 'child', 'child']),
            activity('activity-2', 'child'),
            activity('activity-3', 'nested'),
        ])]);

        expect(childThreadReferences(value)).toEqual([
            { childThreadId: 'child', parentTurnId: 'turn-1', delegationItemId: 'delegate-1' },
        ]);
    });
});
