/** Transactional import of an official Codex thread tree into Sync v4. */

import type { CodexRuntimeEntityV4 } from '@slopus/happy-wire';
import type { Thread } from './protocol';
import type { ThreadGoal } from './protocol';

export interface CodexV4MigrationSink {
    prepareMigration(threadId: string): Promise<void>;
    importThread(thread: Thread): void;
    importGoal(threadId: string, goal: ThreadGoal | null): void;
    setSyncState(syncState: CodexRuntimeEntityV4['syncState']): Promise<void>;
    flush(): Promise<void>;
    flushOutboundOnce(): Promise<void>;
}

export interface CodexV4ChildThreadRoute {
    thread: Thread;
    parentThreadId: string;
    parentTurnId: string | null;
    delegationItemId: string | null;
    depth: number;
}

interface MigrationOptions {
    rootSink: CodexV4MigrationSink;
    readThread: (threadId: string) => Promise<Thread>;
    readGoal?: (threadId: string) => Promise<ThreadGoal | null>;
    resolveChildSink: (route: CodexV4ChildThreadRoute) => Promise<CodexV4MigrationSink>;
}

interface PendingThread {
    thread: Thread;
    sink: CodexV4MigrationSink;
    depth: number;
}

interface ChildReference {
    childThreadId: string;
    parentTurnId: string;
    delegationItemId: string;
}

export class CodexV4Migrator {
    private readonly preparedThreads = new Map<string, CodexV4MigrationSink>();
    private readonly sinks = new Set<CodexV4MigrationSink>();

    constructor(private readonly options: MigrationOptions) {}

    async prepareRoot(threadId: string): Promise<void> {
        await this.prepareThread(threadId, this.options.rootSink);
    }

    async migrate(rootThread: Thread): Promise<void> {
        if (!this.preparedThreads.has(rootThread.id)) {
            await this.prepareRoot(rootThread.id);
        }

        const pending: PendingThread[] = [{ thread: rootThread, sink: this.options.rootSink, depth: 0 }];
        const seen = new Set<string>();
        try {
            while (pending.length > 0) {
                const current = pending.shift()!;
                if (seen.has(current.thread.id)) continue;
                seen.add(current.thread.id);

                current.sink.importThread(current.thread);
                current.sink.importGoal(
                    current.thread.id,
                    this.options.readGoal ? await this.options.readGoal(current.thread.id) : null,
                );
                await current.sink.flush();
                await current.sink.flushOutboundOnce();

                for (const child of childThreadReferences(current.thread)) {
                    if (seen.has(child.childThreadId)) continue;
                    const childThread = await this.options.readThread(child.childThreadId);
                    const childSink = await this.options.resolveChildSink({
                        thread: childThread,
                        parentThreadId: current.thread.id,
                        parentTurnId: child.parentTurnId,
                        delegationItemId: child.delegationItemId,
                        depth: current.depth + 1,
                    });
                    await this.prepareThread(childThread.id, childSink);
                    pending.push({ thread: childThread, sink: childSink, depth: current.depth + 1 });
                }
            }

            for (const sink of this.sinks) {
                await sink.flush();
                await sink.flushOutboundOnce();
            }
            const activationOrder = [
                ...[...this.sinks].filter((sink) => sink !== this.options.rootSink),
                this.options.rootSink,
            ];
            for (const sink of activationOrder) {
                await sink.setSyncState('ready');
                await sink.flush();
                await sink.flushOutboundOnce();
            }
        } catch (error) {
            await Promise.allSettled([...this.sinks].map(async (sink) => {
                await sink.setSyncState('error');
                await sink.flush();
                await sink.flushOutboundOnce();
            }));
            throw error;
        }
    }

    private async prepareThread(threadId: string, sink: CodexV4MigrationSink): Promise<void> {
        const existing = this.preparedThreads.get(threadId);
        if (existing) {
            if (existing !== sink) throw new Error('Codex thread was routed to multiple Sync v4 sessions');
            return;
        }
        this.preparedThreads.set(threadId, sink);
        this.sinks.add(sink);

        await sink.prepareMigration(threadId);
        await sink.flush();
        await sink.flushOutboundOnce();
        await sink.setSyncState('importing');
        await sink.flush();
        await sink.flushOutboundOnce();
    }
}

export function childThreadReferences(thread: Thread): ChildReference[] {
    const references = new Map<string, ChildReference>();
    for (const turn of thread.turns) {
        for (const item of turn.items) {
            if (item.type === 'collabAgentToolCall') {
                for (const childThreadId of item.receiverThreadIds) {
                    if (!childThreadId || childThreadId === thread.id || references.has(childThreadId)) continue;
                    references.set(childThreadId, {
                        childThreadId,
                        parentTurnId: turn.id,
                        delegationItemId: item.id,
                    });
                }
            } else if (item.type === 'subAgentActivity') {
                const childThreadId = item.agentThreadId;
                if (!childThreadId || childThreadId === thread.id || references.has(childThreadId)) continue;
                references.set(childThreadId, {
                    childThreadId,
                    parentTurnId: turn.id,
                    delegationItemId: item.id,
                });
            }
        }
    }
    return [...references.values()];
}
