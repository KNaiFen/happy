/** Durable executor for immutable App-to-CLI Codex Sync v4 commands. */

import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    type CodexCommandEntityV4,
    type CodexCommandResultEntityV4,
} from '@slopus/happy-wire';
import type {
    SyncV4AppliedEntity,
    SyncV4Client,
} from '@/api/syncV4Client';
import type { SyncV4CommandJournalStatus } from '@/api/syncV4Journal';
import type { Thread } from './protocol';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface CodexV4CommandOutcome {
    threadId?: string | null;
    turnId?: string | null;
    providerRequestId?: string | null;
    result?: unknown;
    rollbackSnapshot?: Thread;
}

export type CodexV4CommandReconciliation =
    | ({ action: 'succeeded' } & CodexV4CommandOutcome)
    | { action: 'retry' }
    | { action: 'pending' }
    | { action: 'notReplayed'; error: string }
    | { action: 'cancelled'; reason: CodexV4CommandCancellationReason; error: string };

export type CodexV4CommandCancellationReason =
    | 'bindingSuperseded'
    | 'threadHandoff'
    | 'gatewayStopping'
    | 'commandReplaced'
    | 'queueCancelled';

export class CodexV4CommandCancelledError extends Error {
    constructor(
        readonly reason: CodexV4CommandCancellationReason,
        message: string,
    ) {
        super(message);
        this.name = 'CodexV4CommandCancelledError';
    }
}

interface CommandStateStore {
    getCommandStatus(commandId: string): SyncV4CommandJournalStatus | undefined;
    getCommand(commandId: string): CodexCommandEntityV4 | undefined;
    getPendingCommands(): Array<{ command: CodexCommandEntityV4; status: SyncV4CommandJournalStatus }>;
    publishCommandTransition(
        command: CodexCommandEntityV4,
        result: CodexCommandResultEntityV4,
        status: SyncV4CommandJournalStatus,
    ): ReturnType<SyncV4Client['publishCommandTransition']>;
    publishCommandReplacement(
        previousCommand: CodexCommandEntityV4,
        previousResult: CodexCommandResultEntityV4,
        replacementCommand: CodexCommandEntityV4,
        replacementResult: CodexCommandResultEntityV4,
    ): ReturnType<SyncV4Client['publishCommandReplacement']>;
    publishCommandCancellation(
        queuedCommand: CodexCommandEntityV4,
        queuedResult: CodexCommandResultEntityV4,
        cancellationCommand: CodexCommandEntityV4,
        cancellationResult: CodexCommandResultEntityV4,
    ): ReturnType<SyncV4Client['publishCommandCancellation']>;
}

interface CommandProcessorOptions {
    store: CommandStateStore;
    execute: (command: CodexCommandEntityV4) => Promise<CodexV4CommandOutcome>;
    reconcile: (command: CodexCommandEntityV4) => Promise<CodexV4CommandReconciliation>;
    startPaused?: boolean;
    isOutcomeUnknown?: (error: unknown) => boolean;
    now?: () => number;
    reconcileIntervalMs?: number;
    isTurnActive?: (threadId: string) => boolean;
    onError?: (error: unknown) => void;
}

const TERMINAL_STATUSES = new Set<SyncV4CommandJournalStatus>([
    'succeeded',
    'failed',
    'notReplayed',
    'cancelled',
]);

export class CodexV4CommandProcessor {
    private readonly inFlight = new Map<string, Promise<void>>();
    private pipeline: Promise<void> = Promise.resolve();
    private readonly reconcileTimer: NodeJS.Timeout | null;
    private executionPaused: boolean;
    private readonly queueStartsAwaitingLifecycle = new Set<string>();
    private closed = false;

    constructor(private readonly options: CommandProcessorOptions) {
        this.executionPaused = options.startPaused ?? false;
        const interval = options.reconcileIntervalMs ?? 1_000;
        this.reconcileTimer = interval > 0
            ? setInterval(() => { void this.recoverPending().catch((error) => options.onError?.(error)); }, interval)
            : null;
        this.reconcileTimer?.unref();
    }

    async handle(event: SyncV4AppliedEntity): Promise<void> {
        if (event.op !== 'upsert' || event.entity.entityType !== 'codex.command') return;
        await this.process(event.entity);
    }

    async recoverPending(): Promise<void> {
        if (this.closed) return;
        let queuedCommandVisited = false;
        for (const { command } of this.options.store.getPendingCommands()) {
            if (command.command === 'turn.queue') {
                if (queuedCommandVisited) continue;
            }
            await this.process(command);
            if (
                command.command === 'turn.queue'
                && !TERMINAL_STATUSES.has(
                    this.options.store.getCommandStatus(command.commandId) ?? 'received',
                )
            ) {
                queuedCommandVisited = true;
            }
        }
    }

    async providerTurnStateChanged(threadId: string): Promise<void> {
        if (this.closed) return;
        this.queueStartsAwaitingLifecycle.delete(threadId);
        await this.recoverPending();
    }

    async resumeExecution(): Promise<void> {
        if (this.closed) return;
        this.executionPaused = false;
        await this.recoverPending();
    }

    close(): void {
        this.closed = true;
        if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    }

    async flush(): Promise<void> {
        await this.pipeline;
        await Promise.allSettled(this.inFlight.values());
    }

    hasPendingWork(): boolean {
        if (this.inFlight.size > 0) return true;
        return this.options.store.getPendingCommands().some(({ status }) => !TERMINAL_STATUSES.has(status));
    }

    private async process(command: CodexCommandEntityV4): Promise<void> {
        if (this.closed) return;
        const existing = this.inFlight.get(command.commandId);
        if (existing) return await existing;
        const run = this.pipeline.then(() => this.processOnce(command)).finally(() => {
            if (this.inFlight.get(command.commandId) === run) this.inFlight.delete(command.commandId);
        });
        this.pipeline = run.catch(() => undefined);
        this.inFlight.set(command.commandId, run);
        return await run;
    }

    private async processOnce(command: CodexCommandEntityV4): Promise<void> {
        let status = this.options.store.getCommandStatus(command.commandId);
        if (status && TERMINAL_STATUSES.has(status)) return;

        if (command.clientUserMessageId !== command.commandId) {
            await this.transition(command, 'failed', { error: 'clientUserMessageId must equal commandId' });
            return;
        }

        if (command.command === 'turn.queue.cancel') {
            await this.cancelQueuedCommand(command);
            return;
        }

        if (!status) {
            if (command.replacesCommandId) {
                if (!await this.adoptReplacement(command)) return;
            } else {
                await this.transition(command, 'received');
            }
            status = 'received';
        }
        if (this.closed) return;
        if (this.executionPaused) return;

        if (this.shouldDefer(command)) return;

        if (status === 'executing' || status === 'resultUnknown') {
            await this.reconcile(command);
            return;
        }

        await this.execute(command);
    }

    private async execute(command: CodexCommandEntityV4): Promise<void> {
        await this.transition(command, 'executing');
        if (this.closed) return;
        const queuedThreadId = command.command === 'turn.queue' ? command.threadId : null;
        if (queuedThreadId) this.queueStartsAwaitingLifecycle.add(queuedThreadId);
        try {
            const outcome = await this.options.execute(command);
            if (this.closed) return;
            await this.transition(command, 'succeeded', outcome);
        } catch (error) {
            if (this.closed) return;
            if (error instanceof CodexV4CommandCancelledError) {
                if (queuedThreadId) this.queueStartsAwaitingLifecycle.delete(queuedThreadId);
                await this.transition(command, 'cancelled', {
                    error: error.message,
                    reason: error.reason,
                });
                return;
            }
            if (this.isOutcomeUnknown(error)) {
                await this.transition(command, 'resultUnknown', {
                    error: 'Provider RPC outcome is unknown; waiting for authoritative reconciliation',
                });
                return;
            }
            if (queuedThreadId) this.queueStartsAwaitingLifecycle.delete(queuedThreadId);
            await this.transition(command, 'failed', { error: errorMessage(error) });
        }
    }

    private async reconcile(command: CodexCommandEntityV4): Promise<void> {
        let result: CodexV4CommandReconciliation;
        try {
            result = await this.options.reconcile(command);
        } catch (error) {
            this.options.onError?.(error);
            return;
        }
        if (this.closed) return;

        switch (result.action) {
            case 'succeeded':
                await this.transition(command, 'succeeded', result);
                return;
            case 'retry':
                await this.execute(command);
                return;
            case 'notReplayed':
                await this.transition(command, 'notReplayed', { error: result.error });
                return;
            case 'cancelled':
                await this.transition(command, 'cancelled', {
                    error: result.error,
                    reason: result.reason,
                });
                return;
            case 'pending':
                if (this.options.store.getCommandStatus(command.commandId) !== 'resultUnknown') {
                    await this.transition(command, 'resultUnknown', {
                        error: 'Waiting for authoritative provider state',
                    });
                }
        }
    }

    private async transition(
        command: CodexCommandEntityV4,
        status: SyncV4CommandJournalStatus,
        outcome: CodexV4CommandOutcome & {
            error?: string;
            reason?: CodexV4CommandCancellationReason;
        } = {},
    ): Promise<void> {
        const result = this.resultFor(command, status, outcome);
        await this.options.store.publishCommandTransition(command, result, status);
    }

    private async adoptReplacement(command: CodexCommandEntityV4): Promise<boolean> {
        const previousCommandId = command.replacesCommandId;
        const previous = previousCommandId
            ? this.options.store.getCommand(previousCommandId)
            : undefined;
        const previousStatus = previousCommandId
            ? this.options.store.getCommandStatus(previousCommandId)
            : undefined;
        const replacementQueueEntryId = queueEntryId(command);
        const sameQueueEntry = previous && replacementQueueEntryId
            && replacementQueueEntryId === (queueEntryId(previous) ?? previous.commandId);
        const validReplacement = previous?.command === 'turn.queue'
            && (command.command === 'turn.queue' || command.command === 'turn.steer')
            && previous.threadId === command.threadId
            && sameQueueEntry;
        if (!validReplacement || previousStatus !== 'received') {
            await this.transition(command, 'failed', {
                error: 'The queued message is no longer available for replacement',
            });
            return false;
        }
        await this.options.store.publishCommandReplacement(
            previous,
            this.resultFor(previous, 'cancelled', {
                error: 'Queued message replaced by a newer command',
                reason: 'commandReplaced',
            }),
            command,
            this.resultFor(command, 'received'),
        );
        return true;
    }

    private async cancelQueuedCommand(command: CodexCommandEntityV4): Promise<void> {
        const queuedCommandId = command.replacesCommandId;
        const queued = queuedCommandId
            ? this.options.store.getCommand(queuedCommandId)
            : undefined;
        const queuedStatus = queuedCommandId
            ? this.options.store.getCommandStatus(queuedCommandId)
            : undefined;
        const requestedQueueEntryId = queueEntryId(command);
        const validCancellation = queued?.command === 'turn.queue'
            && (queuedStatus === undefined || queuedStatus === 'received')
            && command.threadId === queued.threadId
            && command.expectedTurnId === queued.expectedTurnId
            && requestedQueueEntryId !== null
            && requestedQueueEntryId === (queueEntryId(queued) ?? queued.commandId)
            && queuedAt(command) === queuedAt(queued)
            && bindingGeneration(command) === bindingGeneration(queued)
            && isEmptyObject(command.payload);
        if (!validCancellation) {
            await this.transition(command, 'failed', {
                error: 'The queued message is no longer available for cancellation',
            });
            return;
        }

        await this.options.store.publishCommandCancellation(
            queued,
            this.resultFor(queued, 'cancelled', {
                error: 'Queued message cancelled',
                reason: 'queueCancelled',
            }),
            command,
            this.resultFor(command, 'succeeded', {
                result: { cancelledCommandId: queued.commandId },
            }),
        );
    }

    private shouldDefer(command: CodexCommandEntityV4): boolean {
        if (command.command !== 'turn.queue' || !command.threadId) return false;
        return this.queueStartsAwaitingLifecycle.has(command.threadId)
            || this.options.isTurnActive?.(command.threadId) === true;
    }

    private resultFor(
        command: CodexCommandEntityV4,
        status: SyncV4CommandJournalStatus,
        outcome: CodexV4CommandOutcome & {
            error?: string;
            reason?: CodexV4CommandCancellationReason;
        } = {},
    ): CodexCommandResultEntityV4 {
        const now = Math.max(0, Math.trunc(this.options.now?.() ?? Date.now()));
        const result = {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.commandResult',
            providerId: `${command.commandId}\0result`,
            createdAt: command.createdAt,
            updatedAt: now,
            commandId: command.commandId,
            threadId: outcome.threadId ?? command.threadId,
            turnId: outcome.turnId ?? null,
            status,
            providerRequestId: outcome.providerRequestId ?? null,
            result: asJsonValue(outcome.result),
            error: outcome.error ?? null,
            reason: outcome.reason ?? null,
        } as unknown as CodexCommandResultEntityV4;
        return result;
    }

    private isOutcomeUnknown(error: unknown): boolean {
        if (this.options.isOutcomeUnknown?.(error)) return true;
        return error instanceof Error && error.name === 'CodexRpcOutcomeUnknownError';
    }
}

function asJsonValue(value: unknown): JsonValue {
    if (value === undefined) return null;
    try {
        const encoded = JSON.stringify(value);
        return encoded === undefined ? null : JSON.parse(encoded) as JsonValue;
    } catch {
        return null;
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message.length > 0 ? error.message : 'Codex command failed';
}

function queueEntryId(command: CodexCommandEntityV4): string | null {
    const value = (command as CodexCommandEntityV4 & {
        queueEntryId?: string | null;
    }).queueEntryId;
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function queuedAt(command: CodexCommandEntityV4): number {
    const value = (command as CodexCommandEntityV4 & { queuedAt?: number }).queuedAt;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : command.createdAt;
}

function bindingGeneration(command: CodexCommandEntityV4): number | undefined {
    const value = (command as CodexCommandEntityV4 & { bindingGeneration?: number }).bindingGeneration;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

function isEmptyObject(value: unknown): boolean {
    return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.keys(value).length === 0,
    );
}
