import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    type CodexCommandEntityV4,
    type CodexCommandResultEntityV4,
    type SyncMutationV4,
} from '@slopus/happy-wire';
import { describe, expect, it, vi } from 'vitest';
import type { SyncV4AppliedEntity } from '@/api/syncV4Client';
import type { SyncV4CommandJournalStatus } from '@/api/syncV4Journal';
import {
    CodexV4CommandProcessor,
    type CodexV4CommandReconciliation,
} from './codexV4CommandProcessor';

class FakeStore {
    readonly statuses = new Map<string, SyncV4CommandJournalStatus>();
    readonly commands = new Map<string, CodexCommandEntityV4>();
    readonly transitions: CodexCommandResultEntityV4[] = [];

    getCommandStatus(commandId: string): SyncV4CommandJournalStatus | undefined {
        return this.statuses.get(commandId);
    }

    getPendingCommands(): Array<{ command: CodexCommandEntityV4; status: SyncV4CommandJournalStatus }> {
        const result: Array<{ command: CodexCommandEntityV4; status: SyncV4CommandJournalStatus }> = [];
        for (const [commandId, command] of this.commands) {
            const status = this.statuses.get(commandId);
            if (status === 'received' || status === 'executing' || status === 'resultUnknown') {
                result.push({ command, status });
            }
        }
        return result;
    }

    async publishCommandTransition(
        command: CodexCommandEntityV4,
        result: CodexCommandResultEntityV4,
        status: SyncV4CommandJournalStatus,
    ): Promise<SyncMutationV4> {
        this.commands.set(command.commandId, command);
        this.statuses.set(command.commandId, status);
        this.transitions.push(result);
        return {
            mutationId: `mutation-${this.transitions.length}`,
            producerId: 'producer-1',
            entityId: 'opaque-result',
            entityType: 'codex.commandResult',
            revision: this.transitions.length,
            op: 'upsert',
            ciphertext: 'ciphertext',
        };
    }
}

function command(overrides: Partial<CodexCommandEntityV4> = {}): CodexCommandEntityV4 {
    return {
        schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
        entityType: 'codex.command',
        providerId: 'command-1',
        createdAt: 100,
        updatedAt: 100,
        commandId: 'command-1',
        threadId: 'thread-1',
        expectedTurnId: null,
        command: 'turn.start',
        payload: { text: 'hello' },
        clientUserMessageId: 'command-1',
        replacesCommandId: null,
        ...overrides,
    };
}

function event(entity: CodexCommandEntityV4): SyncV4AppliedEntity {
    return { entity, source: 'change', op: 'upsert', revision: 1, seq: 1 };
}

describe('CodexV4CommandProcessor', () => {
    it('durably transitions a command once and ignores duplicate delivery', async () => {
        const store = new FakeStore();
        const execute = vi.fn(async () => ({ threadId: 'thread-1', turnId: 'turn-1' }));
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile: async () => ({ action: 'pending' }),
            reconcileIntervalMs: 0,
            now: () => 200,
        });

        await processor.handle(event(command()));
        await processor.handle(event(command()));

        expect(execute).toHaveBeenCalledTimes(1);
        expect(store.transitions.map((transition) => transition.status)).toEqual([
            'received',
            'executing',
            'succeeded',
        ]);
        expect(store.transitions.at(-1)).toMatchObject({ threadId: 'thread-1', turnId: 'turn-1' });
        processor.close();
    });

    it('reconciles an unknown turn submission without replaying it first', async () => {
        const store = new FakeStore();
        const unknown = new Error('connection closed');
        unknown.name = 'CodexRpcOutcomeUnknownError';
        const execute = vi.fn(async () => { throw unknown; });
        let reconciliation: CodexV4CommandReconciliation = { action: 'pending' };
        const reconcile = vi.fn(async () => reconciliation);
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile,
            reconcileIntervalMs: 0,
        });

        await processor.handle(event(command()));
        expect(store.statuses.get('command-1')).toBe('resultUnknown');
        expect(execute).toHaveBeenCalledTimes(1);

        reconciliation = { action: 'succeeded', threadId: 'thread-1', turnId: 'turn-from-snapshot' };
        await processor.recoverPending();
        expect(execute).toHaveBeenCalledTimes(1);
        expect(store.transitions.at(-1)).toMatchObject({ status: 'succeeded', turnId: 'turn-from-snapshot' });
        processor.close();
    });

    it('marks an uncertain non-idempotent command notReplayed', async () => {
        const store = new FakeStore();
        const compact = command({ command: 'thread.compact' });
        store.commands.set(compact.commandId, compact);
        store.statuses.set(compact.commandId, 'executing');
        const execute = vi.fn(async () => ({}));
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile: async () => ({ action: 'notReplayed', error: 'Compact outcome cannot be replayed safely' }),
            reconcileIntervalMs: 0,
        });

        await processor.recoverPending();
        expect(execute).not.toHaveBeenCalled();
        expect(store.transitions.at(-1)).toMatchObject({
            status: 'notReplayed',
            error: 'Compact outcome cannot be replayed safely',
        });
        processor.close();
    });

    it('executes a crash-recovered command that was only received', async () => {
        const store = new FakeStore();
        const pending = command();
        store.commands.set(pending.commandId, pending);
        store.statuses.set(pending.commandId, 'received');
        const execute = vi.fn(async () => ({ turnId: 'turn-1' }));
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile: async () => ({ action: 'pending' }),
            reconcileIntervalMs: 0,
        });

        await processor.recoverPending();
        expect(execute).toHaveBeenCalledTimes(1);
        expect(store.statuses.get(pending.commandId)).toBe('succeeded');
        processor.close();
    });

    it('persists inbound commands while paused and executes them only after routing is ready', async () => {
        const store = new FakeStore();
        const execute = vi.fn(async () => ({ threadId: 'thread-1', turnId: 'turn-1' }));
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile: async () => ({ action: 'pending' }),
            reconcileIntervalMs: 0,
            startPaused: true,
        });

        await processor.handle(event(command()));

        expect(execute).not.toHaveBeenCalled();
        expect(store.statuses.get('command-1')).toBe('received');
        expect(store.commands.get('command-1')).toEqual(command());

        await processor.resumeExecution();

        expect(execute).toHaveBeenCalledOnce();
        expect(store.statuses.get('command-1')).toBe('succeeded');
        processor.close();
    });

    it('durably records the execution context before invoking the provider RPC', async () => {
        const store = new FakeStore();
        const pending = command({ payload: { text: 'persist me' } });
        const execute = vi.fn(async () => {
            expect(store.statuses.get(pending.commandId)).toBe('executing');
            expect(store.commands.get(pending.commandId)).toEqual(pending);
            return { threadId: pending.threadId, turnId: 'turn-1' };
        });
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile: async () => ({ action: 'pending' }),
            reconcileIntervalMs: 0,
        });

        await processor.handle(event(pending));
        expect(execute).toHaveBeenCalledTimes(1);
        processor.close();
    });

    it('leaves a received command for the replacement processor when closed mid-transition', async () => {
        const store = new FakeStore();
        let releaseReceived!: () => void;
        let receivedPersisted!: () => void;
        const received = new Promise<void>((resolve) => { receivedPersisted = resolve; });
        const gate = new Promise<void>((resolve) => { releaseReceived = resolve; });
        const publish = store.publishCommandTransition.bind(store);
        store.publishCommandTransition = async (pending, result, status) => {
            const mutation = await publish(pending, result, status);
            if (status === 'received') {
                receivedPersisted();
                await gate;
            }
            return mutation;
        };
        const execute = vi.fn(async () => ({ turnId: 'turn-1' }));
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile: async () => ({ action: 'pending' }),
            reconcileIntervalMs: 0,
        });

        const handling = processor.handle(event(command()));
        await received;
        processor.close();
        releaseReceived();
        await handling;

        expect(execute).not.toHaveBeenCalled();
        expect(store.statuses.get('command-1')).toBe('received');
    });

    it('rejects commands whose provider idempotency key differs from commandId', async () => {
        const store = new FakeStore();
        const execute = vi.fn(async () => ({}));
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile: async () => ({ action: 'pending' }),
            reconcileIntervalMs: 0,
        });

        await processor.handle(event(command({ clientUserMessageId: 'other' })));
        expect(execute).not.toHaveBeenCalled();
        expect(store.transitions).toMatchObject([{ status: 'failed', error: 'clientUserMessageId must equal commandId' }]);
        processor.close();
    });
});
