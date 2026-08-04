import type { CodexThreadHistorySummary } from './codexThreadHistory';

export interface CodexThreadOpenDefaults {
    permissionMode?: string;
    modelMode?: string;
    effortLevel?: string;
}

export interface CodexThreadBindingInput {
    sessionId: string;
    dataEncryptionKey?: string;
}

export interface CodexOpenThreadRequest {
    directory: string;
    threadId: string;
    binding?: CodexThreadBindingInput;
    externalDataEncryptionKey?: string;
    defaults?: CodexThreadOpenDefaults;
}

export type CodexOpenThreadResult =
    | {
        type: 'success';
        disposition: 'existing-active' | 'existing-resumed' | 'created';
        sessionId: string;
    }
    | {
        type: 'resumeMaterialRequired';
        sessionId: string;
    }
    | {
        type: 'blocked';
        reason: 'externalThreadActive' | 'legacySession' | 'invalidBinding';
        errorMessage: string;
    }
    | {
        type: 'error';
        errorMessage: string;
    };

export type CodexBoundThreadLaunchDecision =
    | 'existing-active'
    | 'process-transition'
    | 'external-active'
    | 'resume';

export function resolveCodexBoundThreadLaunchDecision(options: {
    providerStatus: CodexThreadHistorySummary['status'];
    gatewayState: 'live' | 'recovering' | 'missing';
}): CodexBoundThreadLaunchDecision {
    if (options.gatewayState === 'live') return 'existing-active';
    if (options.gatewayState === 'recovering') return 'process-transition';
    return options.providerStatus === 'active' ? 'external-active' : 'resume';
}

type OpenDependencies = {
    inspect: (directory: string, threadId: string) => Promise<CodexThreadHistorySummary>;
    openExisting: (
        request: CodexOpenThreadRequest & { binding: CodexThreadBindingInput },
        thread: CodexThreadHistorySummary,
    ) => Promise<CodexOpenThreadResult>;
    createExternal: (
        request: CodexOpenThreadRequest & { externalDataEncryptionKey: string },
        thread: CodexThreadHistorySummary,
    ) => Promise<CodexOpenThreadResult>;
};

export class CodexThreadOpenCoordinator {
    private readonly inFlight = new Map<string, Promise<CodexOpenThreadResult>>();

    constructor(private readonly dependencies: OpenDependencies) {}

    open(request: CodexOpenThreadRequest): Promise<CodexOpenThreadResult> {
        const threadId = request.threadId?.trim();
        if (!threadId) {
            return Promise.resolve({ type: 'error', errorMessage: 'threadId is required' });
        }
        const current = this.inFlight.get(threadId);
        if (current) return current;

        const pending = this.openOnce({ ...request, threadId })
            .catch((error): CodexOpenThreadResult => ({
                type: 'error',
                errorMessage: error instanceof Error ? error.message : 'Failed to open Codex thread',
            }))
            .finally(() => {
                if (this.inFlight.get(threadId) === pending) {
                    this.inFlight.delete(threadId);
                }
            });
        this.inFlight.set(threadId, pending);
        return pending;
    }

    private async openOnce(request: CodexOpenThreadRequest): Promise<CodexOpenThreadResult> {
        const thread = await this.dependencies.inspect(request.directory, request.threadId);
        if (request.binding) {
            return this.dependencies.openExisting(
                { ...request, binding: request.binding },
                thread,
            );
        }
        if (thread.status === 'active') {
            return {
                type: 'blocked',
                reason: 'externalThreadActive',
                errorMessage: 'The selected Codex thread is active outside Happy. Stop it before attaching from the App.',
            };
        }
        if (!request.externalDataEncryptionKey) {
            return {
                type: 'error',
                errorMessage: 'A per-session encryption key is required for an external Codex thread',
            };
        }
        if (
            !request.defaults?.permissionMode?.trim()
            || !request.defaults.modelMode?.trim()
            || !request.defaults.effortLevel?.trim()
        ) {
            return {
                type: 'error',
                errorMessage: 'Codex permission, model, and effort defaults are required for an external thread',
            };
        }
        return this.dependencies.createExternal(
            { ...request, externalDataEncryptionKey: request.externalDataEncryptionKey },
            thread,
        );
    }
}
