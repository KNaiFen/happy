import type {
    CodexCommandEntityV4,
    CodexCommandResultEntityV4,
    CodexRequestEntityV4,
} from '@slopus/happy-wire';
import type { CodexRequestInteraction } from './typesMessage';

export function codexRequestKey(threadId: string, requestId: string): string {
    return JSON.stringify([threadId, requestId]);
}

export function codexRequestResolutionKey(command: CodexCommandEntityV4): string | null {
    if (command.command !== 'request.resolve' || !command.threadId) return null;
    const requestId = jsonObject(command.payload).requestId;
    return typeof requestId === 'string' && requestId.length > 0
        ? codexRequestKey(command.threadId, requestId)
        : null;
}

export function deriveCodexRequestInteraction(options: {
    request: CodexRequestEntityV4;
    commands: readonly CodexCommandEntityV4[];
    commandResults: readonly CodexCommandResultEntityV4[];
}): CodexRequestInteraction {
    const key = codexRequestKey(options.request.threadId, options.request.requestId);
    const command = newestCommand(options.commands.filter((entry) => (
        codexRequestResolutionKey(entry) === key
    )));
    const result = command
        ? newestResult(options.commandResults.filter((entry) => entry.commandId === command.commandId))
        : null;
    const attemptedResponse = command
        ? jsonObject(command.payload).response ?? null
        : null;
    const base = {
        commandId: command?.commandId ?? null,
        response: attemptedResponse,
        error: result?.error ?? null,
    };

    if (options.request.status === 'error') {
        const requestError = jsonObject(options.request.response).error;
        return {
            ...base,
            state: requestError === 'providerResponseOutcomeUnknown'
                ? 'outcomeUnknown'
                : 'unavailable',
            error: typeof requestError === 'string' ? requestError : base.error,
        };
    }
    if (options.request.status !== 'pending') {
        return {
            ...base,
            state: 'settled',
            response: options.request.response ?? attemptedResponse,
            error: null,
        };
    }
    if (!command) return { ...base, state: 'awaitingInput' };
    if (!result || result.status === 'received' || result.status === 'executing') {
        return { ...base, state: 'submitting' };
    }
    if (result.status === 'succeeded') {
        return { ...base, state: 'awaitingConfirmation' };
    }
    if (result.status === 'resultUnknown' || result.status === 'notReplayed') {
        return { ...base, state: 'outcomeUnknown' };
    }
    return { ...base, state: 'retryableError' };
}

function newestCommand(commands: readonly CodexCommandEntityV4[]): CodexCommandEntityV4 | null {
    let newest: CodexCommandEntityV4 | null = null;
    for (const command of commands) {
        if (
            !newest
            || command.createdAt > newest.createdAt
            || (command.createdAt === newest.createdAt && command.commandId > newest.commandId)
            || (
                command.createdAt === newest.createdAt
                && command.commandId === newest.commandId
                && command.providerId > newest.providerId
            )
        ) newest = command;
    }
    return newest;
}

function newestResult(results: readonly CodexCommandResultEntityV4[]): CodexCommandResultEntityV4 | null {
    let newest: CodexCommandResultEntityV4 | null = null;
    for (const result of results) {
        if (
            !newest
            || result.updatedAt > newest.updatedAt
            || (result.updatedAt === newest.updatedAt && result.providerId > newest.providerId)
        ) newest = result;
    }
    return newest;
}

function jsonObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}
