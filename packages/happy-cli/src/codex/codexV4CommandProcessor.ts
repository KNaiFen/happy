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

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface CodexV4CommandOutcome {
    threadId?: string | null;
    turnId?: string | null;
    providerRequestId?: string | null;
    result?: unknown;
}

export type CodexV4CommandReconciliation =
    | ({ action: 'succeeded' } & CodexV4CommandOutcome)
    | { action: 'retry' }
    | { action: 'pending' }
    | { action: 'notReplayed'; error: string };

interface CommandStateStore {
    getCommandStatus(commandId: string): SyncV4CommandJournalStatus | undefined;
    getPendingCommands(): Array<{ command: CodexCommandEntityV4; status: SyncV4CommandJournalStatus }>;
    publishCommandTransition(
        command: CodexCommandEntityV4,
        result: CodexCommandResultEntityV4,
        status: SyncV4CommandJournalStatus,
    ): ReturnType<SyncV4Client['publishCommandTransition']>;
}

interface CommandProcessorOptions {
    store: CommandStateStore;
    execute: (command: CodexCommandEntityV4) => Promise<CodexV4CommandOutcome>;
    reconcile: (command: CodexCommandEntityV4) => Promise<CodexV4CommandReconciliation>;
    startPaused?: boolean;
    isOutcomeUnknown?: (error: unknown) => boolean;
    now?: () => number;
    reconcileIntervalMs?: number;
    onError?: (error: unknown) => void;
}

const TERMINAL_STATUSES = new Set<SyncV4CommandJournalStatus>([
    'succeeded',
    'failed',
    'notReplayed',
]);

export class CodexV4CommandProcessor {
    private readonly inFlight = new Map<string, Promise<void>>();
    private readonly reconcileTimer: NodeJS.Timeout | null;
    private executionPaused: boolean;
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
        for (const { command } of this.options.store.getPendingCommands()) {
            await this.process(command);
        }
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

    private async process(command: CodexCommandEntityV4): Promise<void> {
        if (this.closed) return;
        const existing = this.inFlight.get(command.commandId);
        if (existing) return await existing;
        const run = this.processOnce(command).finally(() => {
            if (this.inFlight.get(command.commandId) === run) this.inFlight.delete(command.commandId);
        });
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

        if (!status) {
            await this.transition(command, 'received');
            status = 'received';
        }
        if (this.closed) return;
        if (this.executionPaused) return;

        if (status === 'executing' || status === 'resultUnknown') {
            await this.reconcile(command);
            return;
        }

        await this.execute(command);
    }

    private async execute(command: CodexCommandEntityV4): Promise<void> {
        await this.transition(command, 'executing');
        if (this.closed) return;
        try {
            const outcome = await this.options.execute(command);
            if (this.closed) return;
            await this.transition(command, 'succeeded', outcome);
        } catch (error) {
            if (this.closed) return;
            if (this.isOutcomeUnknown(error)) {
                await this.transition(command, 'resultUnknown', {
                    error: 'Provider RPC outcome is unknown; waiting for authoritative reconciliation',
                });
                return;
            }
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
        outcome: CodexV4CommandOutcome & { error?: string } = {},
    ): Promise<void> {
        const now = Math.max(0, Math.trunc(this.options.now?.() ?? Date.now()));
        const result: CodexCommandResultEntityV4 = {
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
        };
        await this.options.store.publishCommandTransition(command, result, status);
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
