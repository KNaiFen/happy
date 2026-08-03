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
    CodexV4CommandCancelledError,
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

    getCommand(commandId: string): CodexCommandEntityV4 | undefined {
        return this.commands.get(commandId);
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

    async publishCommandReplacement(
        previousCommand: CodexCommandEntityV4,
        previousResult: CodexCommandResultEntityV4,
        replacementCommand: CodexCommandEntityV4,
        replacementResult: CodexCommandResultEntityV4,
    ): Promise<[SyncMutationV4, SyncMutationV4]> {
        this.commands.set(previousCommand.commandId, previousCommand);
        this.statuses.set(previousCommand.commandId, 'cancelled');
        this.commands.set(replacementCommand.commandId, replacementCommand);
        this.statuses.set(replacementCommand.commandId, 'received');
        this.transitions.push(previousResult, replacementResult);
        const mutation = (index: number): SyncMutationV4 => ({
            mutationId: `mutation-${index}`,
            producerId: 'producer-1',
            entityId: `opaque-result-${index}`,
            entityType: 'codex.commandResult',
            revision: index,
            op: 'upsert',
            ciphertext: 'ciphertext',
        });
        return [mutation(this.transitions.length - 1), mutation(this.transitions.length)];
    }
}

function command(
    overrides: Partial<CodexCommandEntityV4> & {
        bindingGeneration?: number;
        queueEntryId?: string;
        queuedAt?: number;
    } = {},
): CodexCommandEntityV4 {
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
    } as CodexCommandEntityV4;
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

    it('executes different command ids in strict FIFO order', async () => {
        const store = new FakeStore();
        let releaseFirst!: () => void;
        let firstStarted!: () => void;
        const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const started = new Promise<void>((resolve) => { firstStarted = resolve; });
        const executionOrder: string[] = [];
        const execute = vi.fn(async (pending: CodexCommandEntityV4) => {
            executionOrder.push(`start:${pending.commandId}`);
            if (pending.commandId === 'command-1') {
                firstStarted();
                await gate;
            }
            executionOrder.push(`end:${pending.commandId}`);
            return { threadId: pending.threadId };
        });
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile: async () => ({ action: 'pending' }),
            reconcileIntervalMs: 0,
        });

        const first = processor.handle(event(command()));
        await started;
        const secondCommand = command({
            providerId: 'command-2',
            commandId: 'command-2',
            clientUserMessageId: 'command-2',
        });
        const second = processor.handle(event(secondCommand));
        await Promise.resolve();

        expect(executionOrder).toEqual(['start:command-1']);
        releaseFirst();
        await Promise.all([first, second]);
        expect(executionOrder).toEqual([
            'start:command-1',
            'end:command-1',
            'start:command-2',
            'end:command-2',
        ]);
        processor.close();
    });

    it('persists structured cancellation before any provider retry', async () => {
        const store = new FakeStore();
        const execute = vi.fn(async () => {
            throw new CodexV4CommandCancelledError(
                'bindingSuperseded',
                'The command belongs to an older Gateway binding',
            );
        });
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile: async () => ({ action: 'pending' }),
            reconcileIntervalMs: 0,
        });

        await processor.handle(event(command({ bindingGeneration: 1 })));

        expect(execute).toHaveBeenCalledOnce();
        expect(store.transitions.at(-1)).toMatchObject({
            status: 'cancelled',
            reason: 'bindingSuperseded',
            error: 'The command belongs to an older Gateway binding',
        });
        expect(store.statuses.get('command-1')).toBe('cancelled');
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

    it('keeps follow-ups durable while a turn is active and starts them after provider completion', async () => {
        const store = new FakeStore();
        let turnActive = true;
        const execute = vi.fn(async () => ({ threadId: 'thread-1', turnId: 'turn-queued' }));
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile: async () => ({ action: 'pending' }),
            reconcileIntervalMs: 0,
            isTurnActive: () => turnActive,
        });
        const queued = command({
            command: 'turn.queue',
            queueEntryId: 'queue-1',
            queuedAt: 100,
        });

        await processor.handle(event(queued));
        expect(execute).not.toHaveBeenCalled();
        expect(store.statuses.get(queued.commandId)).toBe('received');

        turnActive = false;
        await processor.providerTurnStateChanged('thread-1');
        expect(execute).toHaveBeenCalledOnce();
        expect(store.statuses.get(queued.commandId)).toBe('succeeded');
        processor.close();
    });

    it('starts queued follow-ups one at a time in FIFO lifecycle order', async () => {
        const store = new FakeStore();
        let turnActive = true;
        const executionOrder: string[] = [];
        const execute = vi.fn(async (pending: CodexCommandEntityV4) => {
            executionOrder.push(pending.commandId);
            turnActive = true;
            return { threadId: 'thread-1', turnId: `turn-${pending.commandId}` };
        });
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile: async () => ({ action: 'pending' }),
            reconcileIntervalMs: 0,
            isTurnActive: () => turnActive,
        });
        const first = command({
            command: 'turn.queue',
            queueEntryId: 'queue-1',
            queuedAt: 100,
        });
        const second = command({
            providerId: 'command-2',
            commandId: 'command-2',
            clientUserMessageId: 'command-2',
            command: 'turn.queue',
            queueEntryId: 'queue-2',
            queuedAt: 200,
            createdAt: 200,
            updatedAt: 200,
        });

        await processor.handle(event(first));
        await processor.handle(event(second));
        turnActive = false;
        await processor.providerTurnStateChanged('thread-1');
        expect(executionOrder).toEqual(['command-1']);
        expect(store.statuses.get(second.commandId)).toBe('received');

        turnActive = false;
        await processor.providerTurnStateChanged('thread-1');
        expect(executionOrder).toEqual(['command-1', 'command-2']);
        processor.close();
    });

    it('atomically replaces a received queue entry without changing its FIFO identity', async () => {
        const store = new FakeStore();
        let turnActive = true;
        const execute = vi.fn(async (pending: CodexCommandEntityV4) => ({
            threadId: pending.threadId,
            turnId: 'turn-replacement',
        }));
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile: async () => ({ action: 'pending' }),
            reconcileIntervalMs: 0,
            isTurnActive: () => turnActive,
        });
        const original = command({
            command: 'turn.queue',
            queueEntryId: 'queue-1',
            queuedAt: 100,
        });
        const replacement = command({
            providerId: 'command-edit',
            commandId: 'command-edit',
            clientUserMessageId: 'command-edit',
            command: 'turn.queue',
            payload: { text: 'edited' },
            replacesCommandId: original.commandId,
            queueEntryId: 'queue-1',
            queuedAt: 100,
            createdAt: 200,
            updatedAt: 200,
        });

        await processor.handle(event(original));
        await processor.handle(event(replacement));
        expect(store.statuses.get(original.commandId)).toBe('cancelled');
        expect(store.statuses.get(replacement.commandId)).toBe('received');
        expect(store.transitions.slice(-2)).toMatchObject([
            { commandId: original.commandId, status: 'cancelled', reason: 'commandReplaced' },
            { commandId: replacement.commandId, status: 'received' },
        ]);

        turnActive = false;
        await processor.providerTurnStateChanged('thread-1');
        expect(execute).toHaveBeenCalledWith(replacement);
        processor.close();
    });

    it('rejects a late replacement without changing the completed queue command', async () => {
        const store = new FakeStore();
        const execute = vi.fn(async () => ({ threadId: 'thread-1', turnId: 'turn-1' }));
        const processor = new CodexV4CommandProcessor({
            store,
            execute,
            reconcile: async () => ({ action: 'pending' }),
            reconcileIntervalMs: 0,
            isTurnActive: () => false,
        });
        const original = command({
            command: 'turn.queue',
            queueEntryId: 'queue-1',
            queuedAt: 100,
        });
        const replacement = command({
            providerId: 'command-late',
            commandId: 'command-late',
            clientUserMessageId: 'command-late',
            command: 'turn.steer',
            expectedTurnId: 'turn-active',
            replacesCommandId: original.commandId,
            queueEntryId: 'queue-1',
            queuedAt: 100,
            createdAt: 200,
            updatedAt: 200,
        });

        await processor.handle(event(original));
        await processor.handle(event(replacement));

        expect(store.statuses.get(original.commandId)).toBe('succeeded');
        expect(store.statuses.get(replacement.commandId)).toBe('failed');
        expect(execute).toHaveBeenCalledTimes(1);
        processor.close();
    });
});
