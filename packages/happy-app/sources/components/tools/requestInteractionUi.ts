import type { CodexRequestInteraction, ToolCall } from '@/sync/typesMessage';
import { AppSyncV4MutationPersistedError } from '@/sync/syncV4Client';

export type RequestResponseLocalFailure = 'retryable' | 'outcomeUnknown';

export function requestInteractionAllowsResponse(
    interaction: CodexRequestInteraction | undefined,
    localSubmissionPending = false,
): boolean {
    return !localSubmissionPending && (interaction === undefined
        || interaction.state === 'awaitingInput'
        || interaction.state === 'retryableError');
}

export function requestResponseLocalFailure(error: unknown): RequestResponseLocalFailure {
    return error instanceof AppSyncV4MutationPersistedError
        ? 'outcomeUnknown'
        : 'retryable';
}

export function shouldShowToolRunningTelemetry(tool: ToolCall): boolean {
    return tool.state === 'running' && tool.requestInteraction === undefined;
}
