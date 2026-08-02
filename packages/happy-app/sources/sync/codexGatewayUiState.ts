import type { CodexRuntimeEntityV4 } from '@slopus/happy-wire';
import type { Session } from './storageTypes';
import {
    resolveCodexGatewayBinding,
    type CodexGatewayBinding,
} from './codexV4Capabilities';

export type CodexGatewayRuntimeView = CodexRuntimeEntityV4 & {
    gateway?: {
        gatewayId: string;
        generation: number;
        origin: 'terminal' | 'app';
        role: 'current' | 'draining' | 'inactive' | 'recovering';
        state: 'starting' | 'running' | 'recovering' | 'stopping' | 'stopped';
    };
    terminal?: {
        state: 'attached' | 'pendingDetach' | 'detached' | 'headless';
        detachedAt: number | null;
    };
};

export type CodexGatewayDisplayPhase =
    | 'starting'
    | 'recovering'
    | 'stopping'
    | 'stopped'
    | 'switching'
    | 'syncing'
    | 'attached'
    | 'pendingDetach'
    | 'detached'
    | 'headless';

export interface CodexGatewayUiState {
    canSend: boolean;
    phase: CodexGatewayDisplayPhase | null;
}

export function resolveCodexGatewayUiState(options: {
    session: Pick<Session, 'metadata'>;
    runtime: CodexGatewayRuntimeView | null | undefined;
    syncReady: boolean;
}): CodexGatewayUiState {
    const binding = resolveCodexGatewayBinding(options.session.metadata);
    if (!binding) return { canSend: true, phase: null };

    if (binding.role === 'draining') return { canSend: false, phase: 'switching' };
    if (binding.role === 'inactive') return { canSend: false, phase: 'stopped' };
    if (binding.role === 'recovering') return { canSend: false, phase: 'recovering' };

    const runtime = options.runtime;
    const runtimeGateway = runtime?.gateway;
    if (!runtime || !runtimeGateway || !gatewayMatchesBinding(runtimeGateway, binding)) {
        return { canSend: false, phase: 'syncing' };
    }

    if (runtimeGateway.role === 'draining') return { canSend: false, phase: 'switching' };
    if (runtimeGateway.role === 'inactive') return { canSend: false, phase: 'stopped' };
    if (runtimeGateway.role === 'recovering') return { canSend: false, phase: 'recovering' };

    if (runtimeGateway.state !== 'running') {
        return { canSend: false, phase: runtimeGateway.state };
    }
    if (!options.syncReady || runtime.syncState !== 'ready') {
        return {
            canSend: false,
            phase: runtime.syncState === 'error' ? 'recovering' : 'syncing',
        };
    }

    return {
        canSend: true,
        phase: runtime.terminal?.state ?? null,
    };
}

export function resolveCodexGatewayHandoffTarget(
    source: {
        sessionId: string;
        gatewayId: string;
        generation: number;
        nextSessionId: string;
    },
    sessions: Readonly<Record<string, Session>>,
): string | null {
    const target = sessions[source.nextSessionId];
    const targetBinding = resolveCodexGatewayBinding(target?.metadata);
    if (
        !target
        || !targetBinding
        || targetBinding.gatewayId !== source.gatewayId
        || targetBinding.generation !== source.generation + 1
        || targetBinding.previousSessionId !== source.sessionId
        || targetBinding.role !== 'current'
    ) {
        return null;
    }
    return target.id;
}

function gatewayMatchesBinding(
    gateway: NonNullable<CodexGatewayRuntimeView['gateway']>,
    binding: CodexGatewayBinding,
): boolean {
    return gateway.gatewayId === binding.gatewayId
        && gateway.generation === binding.generation;
}
