import type { CodexRequestInteraction, ToolCall } from '@/sync/typesMessage';

export function requestInteractionAllowsResponse(
    interaction: CodexRequestInteraction | undefined,
): boolean {
    return interaction === undefined
        || interaction.state === 'awaitingInput'
        || interaction.state === 'retryableError';
}

export function shouldShowToolRunningTelemetry(tool: ToolCall): boolean {
    return tool.state === 'running' && tool.requestInteraction === undefined;
}
