import type { CodexCommandResultEntityV4 } from '@slopus/happy-wire';
import type { CodexCommandDraftReceipt } from './persistence';
import {
    hasCodexV4ProviderUserMessage,
    newestCodexV4CommandResult,
    type CodexV4Projection,
} from './codexV4Projection';
import { resolveCodexGatewayBinding } from './codexV4Capabilities';
import { resolveCodexGatewayHandoffTarget } from './codexGatewayUiState';
import type { Session } from './storageTypes';

const RESTORABLE_CANCELLATION_REASONS = new Set(['bindingSuperseded', 'threadHandoff']);

type DraftRecoveryListener = (text: string) => void;

interface CodexCommandDraftRecoveryDependencies {
    loadReceipts: () => CodexCommandDraftReceipt[];
    saveReceipts: (receipts: readonly CodexCommandDraftReceipt[]) => void;
    getSessions: () => Readonly<Record<string, Session>>;
    getProjection: (sessionId: string) => CodexV4Projection | null | undefined;
    updateSessionDraft: (sessionId: string, draft: string) => void;
    now: () => number;
}

export interface CodexCommandDraftReceiptInput {
    commandId: string;
    sourceSessionId: string;
    text: string;
}

type CommandResultWithReason = Omit<CodexCommandResultEntityV4, 'status'> & {
    status: CodexCommandResultEntityV4['status'] | 'cancelled';
    reason?: 'bindingSuperseded' | 'threadHandoff' | 'gatewayStopping' | null;
};

export class CodexCommandDraftRecovery {
    private readonly receipts = new Map<string, CodexCommandDraftReceipt>();
    private readonly listeners = new Map<string, Set<DraftRecoveryListener>>();

    constructor(private readonly dependencies: CodexCommandDraftRecoveryDependencies) {
        for (const receipt of dependencies.loadReceipts()) {
            this.receipts.set(receipt.commandId, receipt);
        }
    }

    record(input: CodexCommandDraftReceiptInput): boolean {
        if (!input.text) return false;
        const source = this.dependencies.getSessions()[input.sourceSessionId];
        const binding = resolveCodexGatewayBinding(source?.metadata);
        if (!source || !binding || binding.role !== 'current') return false;

        const existing = this.receipts.get(input.commandId);
        this.receipts.set(input.commandId, {
            version: 1,
            commandId: input.commandId,
            sourceSessionId: input.sourceSessionId,
            gatewayId: binding.gatewayId,
            bindingGeneration: binding.generation,
            text: input.text,
            createdAt: existing?.createdAt ?? this.dependencies.now(),
        });
        this.persist();
        return true;
    }

    discard(commandId: string): void {
        if (!this.receipts.delete(commandId)) return;
        this.persist();
    }

    reconcileSession(sessionId: string): void {
        for (const receipt of [...this.receipts.values()]) {
            if (receipt.sourceSessionId === sessionId) this.reconcileReceipt(receipt);
        }
    }

    reconcileAll(): void {
        for (const receipt of [...this.receipts.values()]) this.reconcileReceipt(receipt);
    }

    subscribe(sessionId: string, listener: DraftRecoveryListener): () => void {
        let sessionListeners = this.listeners.get(sessionId);
        if (!sessionListeners) {
            sessionListeners = new Set();
            this.listeners.set(sessionId, sessionListeners);
        }
        sessionListeners.add(listener);
        return () => {
            sessionListeners?.delete(listener);
            if (sessionListeners?.size === 0) this.listeners.delete(sessionId);
        };
    }

    private reconcileReceipt(receipt: CodexCommandDraftReceipt): void {
        const projection = this.dependencies.getProjection(receipt.sourceSessionId);
        if (hasCodexV4ProviderUserMessage(projection, receipt.commandId)) {
            this.consume(receipt.commandId);
            return;
        }

        const result = newestCodexV4CommandResult(
            projection,
            receipt.commandId,
        ) as unknown as CommandResultWithReason | null;
        if (!result || result.status === 'received' || result.status === 'executing') return;
        if (
            result.status !== 'cancelled'
            || !result.reason
            || !RESTORABLE_CANCELLATION_REASONS.has(result.reason)
        ) {
            this.consume(receipt.commandId);
            return;
        }

        const targetSessionId = this.resolveTargetSessionId(receipt);
        if (!targetSessionId) return;
        const sessions = this.dependencies.getSessions();
        const currentDraft = sessions[targetSessionId]?.draft ?? '';
        const mergedDraft = mergeRecoveredCodexDraft(currentDraft, receipt.text);

        // Persist the restored draft before consuming the receipt. A crash between
        // these writes safely replays through the idempotent merge on next launch.
        this.dependencies.updateSessionDraft(targetSessionId, mergedDraft);
        this.consume(receipt.commandId);
        for (const listener of this.listeners.get(targetSessionId) ?? []) {
            try {
                listener(receipt.text);
            } catch {
                console.error('Failed to notify the active Codex draft composer');
            }
        }
    }

    private resolveTargetSessionId(receipt: CodexCommandDraftReceipt): string | null {
        const sessions = this.dependencies.getSessions();
        const source = sessions[receipt.sourceSessionId];
        const sourceBinding = resolveCodexGatewayBinding(source?.metadata);
        const hintedTargetId = sourceBinding
            && sourceBinding.gatewayId === receipt.gatewayId
            && sourceBinding.generation === receipt.bindingGeneration
            && (sourceBinding.role === 'draining' || sourceBinding.role === 'inactive')
            ? sourceBinding.nextSessionId
            : undefined;
        if (hintedTargetId) {
            return resolveCodexGatewayHandoffTarget({
                sessionId: receipt.sourceSessionId,
                gatewayId: receipt.gatewayId,
                generation: receipt.bindingGeneration,
                nextSessionId: hintedTargetId,
            }, sessions);
        }

        const matchingTargets = Object.values(sessions).filter((candidate) => {
            const binding = resolveCodexGatewayBinding(candidate.metadata);
            return binding?.gatewayId === receipt.gatewayId
                && binding.generation === receipt.bindingGeneration + 1
                && binding.previousSessionId === receipt.sourceSessionId
                && binding.role === 'current';
        });
        if (matchingTargets.length !== 1) return null;
        return resolveCodexGatewayHandoffTarget({
            sessionId: receipt.sourceSessionId,
            gatewayId: receipt.gatewayId,
            generation: receipt.bindingGeneration,
            nextSessionId: matchingTargets[0].id,
        }, sessions);
    }

    private consume(commandId: string): void {
        if (!this.receipts.delete(commandId)) return;
        this.persist();
    }

    private persist(): void {
        this.dependencies.saveReceipts([...this.receipts.values()].sort(compareReceipts));
    }
}

export function mergeRecoveredCodexDraft(current: string, recovered: string): string {
    if (!current) return recovered;
    if (!recovered || current === recovered || current.endsWith(`\n\n${recovered}`)) return current;
    return `${current}\n\n${recovered}`;
}

function compareReceipts(a: CodexCommandDraftReceipt, b: CodexCommandDraftReceipt): number {
    return a.createdAt - b.createdAt || a.commandId.localeCompare(b.commandId);
}
