import type { CodexRequestInteraction, ToolCall } from '@/sync/typesMessage';
import { describe, expect, it } from 'vitest';
import {
    requestInteractionAllowsResponse,
    shouldShowToolRunningTelemetry,
} from './requestInteractionUi';

function interaction(state: CodexRequestInteraction['state']): CodexRequestInteraction {
    return { state, commandId: null, response: null, error: null };
}

function tool(requestInteraction?: CodexRequestInteraction): ToolCall {
    return {
        name: 'AskUserQuestion',
        state: 'running',
        input: {},
        createdAt: 1,
        startedAt: 1,
        completedAt: null,
        description: null,
        requestInteraction,
    };
}

describe('request interaction UI policy', () => {
    it.each([
        ['awaitingInput', true],
        ['retryableError', true],
        ['submitting', false],
        ['awaitingConfirmation', false],
        ['outcomeUnknown', false],
        ['unavailable', false],
        ['settled', false],
    ] as const)('%s response availability is %s', (state, expected) => {
        expect(requestInteractionAllowsResponse(interaction(state))).toBe(expected);
    });

    it('suppresses spinner and elapsed time only for projected requests', () => {
        expect(shouldShowToolRunningTelemetry(tool())).toBe(true);
        expect(shouldShowToolRunningTelemetry(tool(interaction('awaitingInput')))).toBe(false);
        expect(shouldShowToolRunningTelemetry({
            ...tool(),
            state: 'completed',
        })).toBe(false);
    });
});
