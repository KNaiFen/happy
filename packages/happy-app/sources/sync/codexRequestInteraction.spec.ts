import type {
    CodexCommandEntityV4,
    CodexCommandResultEntityV4,
    CodexRequestEntityV4,
} from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';
import {
    codexRequestResolutionKey,
    deriveCodexRequestInteraction,
} from './codexRequestInteraction';

function request(overrides: Partial<CodexRequestEntityV4> = {}): CodexRequestEntityV4 {
    return {
        schemaVersion: 1,
        entityType: 'codex.request',
        providerId: 'request-provider-1',
        createdAt: 10,
        updatedAt: 10,
        requestId: 'request-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: null,
        requestType: 'toolUserInput',
        status: 'pending',
        title: null,
        prompt: 'Choose',
        options: {},
        response: null,
        resolvedAt: null,
        ...overrides,
    };
}

function command(
    commandId: string = 'command-1',
    overrides: Partial<CodexCommandEntityV4> = {},
): CodexCommandEntityV4 {
    return {
        schemaVersion: 1,
        entityType: 'codex.command',
        providerId: `${commandId}-provider`,
        createdAt: 20,
        updatedAt: 20,
        commandId,
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        command: 'request.resolve',
        payload: {
            requestId: 'request-1',
            response: { answers: { choice: { answers: ['Resume'] } } },
        },
        clientUserMessageId: commandId,
        replacesCommandId: null,
        ...overrides,
    };
}

function result(
    status: CodexCommandResultEntityV4['status'],
    overrides: Partial<CodexCommandResultEntityV4> = {},
): CodexCommandResultEntityV4 {
    return {
        schemaVersion: 1,
        entityType: 'codex.commandResult',
        providerId: `result-${status}`,
        createdAt: 21,
        updatedAt: 21,
        commandId: 'command-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status,
        providerRequestId: null,
        result: null,
        error: null,
        reason: null,
        ...overrides,
    };
}

describe('Codex request interaction state', () => {
    it.each([
        { commandResults: [] as CodexCommandResultEntityV4[], state: 'submitting' },
        { commandResults: [result('received')], state: 'submitting' },
        { commandResults: [result('executing')], state: 'submitting' },
        { commandResults: [result('succeeded')], state: 'awaitingConfirmation' },
        { commandResults: [result('failed')], state: 'retryableError' },
        { commandResults: [result('cancelled')], state: 'retryableError' },
        { commandResults: [result('resultUnknown')], state: 'outcomeUnknown' },
        { commandResults: [result('notReplayed')], state: 'outcomeUnknown' },
    ] as const)('maps the latest command result to $state', ({ commandResults, state }) => {
        expect(deriveCodexRequestInteraction({
            request: request(),
            commands: [command()],
            commandResults,
        })).toMatchObject({ state, commandId: 'command-1' });
    });

    it('keeps request lifecycle authoritative over command state', () => {
        expect(deriveCodexRequestInteraction({
            request: request(),
            commands: [],
            commandResults: [],
        }).state).toBe('awaitingInput');
        expect(deriveCodexRequestInteraction({
            request: request({ status: 'accepted', response: { decision: 'accept' } }),
            commands: [command()],
            commandResults: [result('failed')],
        })).toMatchObject({ state: 'settled', error: null });
        expect(deriveCodexRequestInteraction({
            request: request({
                status: 'error',
                response: { error: 'providerResponseOutcomeUnknown' },
            }),
            commands: [command()],
            commandResults: [result('failed')],
        }).state).toBe('outcomeUnknown');
        expect(deriveCodexRequestInteraction({
            request: request({ status: 'error', response: { error: 'providerProcessRestarted' } }),
            commands: [command()],
            commandResults: [result('succeeded')],
        }).state).toBe('unavailable');
    });

    it('selects the latest same-thread attempt and ignores a reused request id elsewhere', () => {
        const oldAttempt = command('command-old', { createdAt: 20, updatedAt: 20 });
        const latestAttempt = command('command-latest', {
            createdAt: 30,
            updatedAt: 30,
            payload: { requestId: 'request-1', response: { decision: 'accept' } },
        });
        const otherThread = command('command-other-thread', {
            createdAt: 40,
            updatedAt: 40,
            threadId: 'thread-2',
        });

        expect(codexRequestResolutionKey(otherThread)).toBe(JSON.stringify(['thread-2', 'request-1']));
        expect(deriveCodexRequestInteraction({
            request: request(),
            commands: [oldAttempt, otherThread, latestAttempt],
            commandResults: [
                result('failed', { commandId: 'command-old', updatedAt: 25 }),
                result('executing', { commandId: 'command-latest', updatedAt: 31 }),
            ],
        })).toEqual({
            state: 'submitting',
            commandId: 'command-latest',
            response: { decision: 'accept' },
            error: null,
        });
    });
});
