import { describe, expect, it } from 'vitest';
import {
    resolveCodexGatewayHandoffTarget,
    resolveCodexGatewayUiState,
    shouldShowCodexGatewayLifecycle,
    type CodexGatewayRuntimeView,
} from './codexGatewayUiState';

function session(options: {
    id?: string;
    generation?: number;
    role?: 'current' | 'draining' | 'inactive' | 'recovering';
    previousSessionId?: string;
    nextSessionId?: string;
    active?: boolean;
    archivedAt?: number | null;
} = {}): any {
    return {
        id: options.id ?? 'source',
        active: options.active ?? true,
        archivedAt: options.archivedAt ?? null,
        metadata: {
            flavor: 'codex',
            codexSyncVersion: 4,
            machineId: 'machine-1',
            codexGatewayBinding: {
                gatewayId: 'gateway-1',
                generation: options.generation ?? 3,
                origin: 'terminal',
                role: options.role ?? 'current',
                terminal: 'attached',
                changedAt: 10,
                ...(options.previousSessionId ? { previousSessionId: options.previousSessionId } : {}),
                ...(options.nextSessionId ? { nextSessionId: options.nextSessionId } : {}),
            },
        },
    };
}

function runtime(overrides: Partial<CodexGatewayRuntimeView> = {}): CodexGatewayRuntimeView {
    return {
        schemaVersion: 1,
        providerId: 'runtime:thread-1',
        entityType: 'codex.runtime',
        createdAt: 1,
        updatedAt: 10,
        threadId: 'thread-1',
        connection: 'connected',
        execution: { type: 'idle' },
        statusUnknown: false,
        protocolVersion: 'stable-v2',
        codexCliVersion: '0.145.0',
        syncState: 'ready',
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        activeSubagentCount: 0,
        gateway: {
            gatewayId: 'gateway-1',
            generation: 3,
            origin: 'terminal',
            role: 'current',
            state: 'running',
        },
        terminal: { state: 'attached', detachedAt: null },
        lastError: null,
        lastKnownAt: 10,
        ...overrides,
    };
}

describe('Codex Gateway App state', () => {
    it('only presents transient Gateway lifecycle for active, unarchived sessions', () => {
        expect(shouldShowCodexGatewayLifecycle(session())).toBe(true);
        expect(shouldShowCodexGatewayLifecycle(session({ active: false }))).toBe(false);
        expect(shouldShowCodexGatewayLifecycle(session({ archivedAt: 10 }))).toBe(false);
    });

    it('allows input only after the matching current generation is ready', () => {
        expect(resolveCodexGatewayUiState({
            session: session(),
            runtime: runtime(),
            syncReady: true,
        })).toEqual({ canSend: true, phase: 'attached' });

        expect(resolveCodexGatewayUiState({
            session: session(),
            runtime: runtime({ syncState: 'importing' }),
            syncReady: true,
        })).toEqual({ canSend: false, phase: 'syncing' });

        expect(resolveCodexGatewayUiState({
            session: session(),
            runtime: runtime({
                gateway: {
                    gatewayId: 'gateway-1',
                    generation: 2,
                    origin: 'terminal',
                    role: 'current',
                    state: 'running',
                },
            }),
            syncReady: true,
        })).toEqual({ canSend: false, phase: 'syncing' });
    });

    it('keeps terminal lifecycle separate from provider execution', () => {
        const active = runtime({
            execution: { type: 'active', activeFlags: [] },
            terminal: { state: 'detached', detachedAt: 20 },
        });
        expect(resolveCodexGatewayUiState({
            session: session(),
            runtime: active,
            syncReady: true,
        })).toEqual({ canSend: true, phase: 'detached' });
        expect(active.execution).toEqual({ type: 'active', activeFlags: [] });
    });

    it('requires an exact same-gateway next-generation handoff before navigation', () => {
        const source = session({ role: 'draining', nextSessionId: 'target' });
        const target = session({
            id: 'target',
            generation: 4,
            role: 'current',
            previousSessionId: 'source',
        });
        const intent = {
            sessionId: source.id,
            gatewayId: 'gateway-1',
            generation: 3,
            nextSessionId: 'target',
        };
        expect(resolveCodexGatewayHandoffTarget(intent, { source, target })).toBe('target');

        const staleTarget = session({
            id: 'target',
            generation: 3,
            role: 'current',
            previousSessionId: 'source',
        });
        expect(resolveCodexGatewayHandoffTarget(intent, { source, target: staleTarget })).toBeNull();

        target.metadata.codexGatewayBinding.gatewayId = 'gateway-other';
        expect(resolveCodexGatewayHandoffTarget(intent, { source, target })).toBeNull();
    });
});
