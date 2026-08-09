import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    type CodexCommandEntityV4,
    type CodexCommandResultEntityV4,
    type CodexEntityV4,
} from '../../packages/happy-wire/src';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_CODEX_POST_CLEAR_INPUT } from './codex-responses-fixture';
import { hasSucceededPostClearCommand } from './codex-mobile-field-command-correlation';

const threadId = 'thread-field';

describe('mobile field post-clear command correlation', () => {
    it.each(['turn.start', 'turn.queue', 'turn.steer'] as const)(
        'accepts %s only with its matching succeeded result',
        (commandName) => {
            const command = fieldCommand('command-matching', commandName);
            expect(hasSucceededPostClearCommand([
                command,
                commandResult(command.commandId, 'succeeded'),
            ], threadId)).toBe(true);
        },
    );

    it('rejects unrelated commands and non-success terminal evidence', () => {
        const command = fieldCommand('command-target', 'turn.start');
        const cases: CodexEntityV4[][] = [
            [command, commandResult('command-other', 'succeeded')],
            [command, commandResult(command.commandId, 'executing')],
            [command, { ...commandResult(command.commandId, 'succeeded'), threadId: 'thread-other' }],
            [{ ...command, threadId: 'thread-other' }, commandResult(command.commandId, 'succeeded')],
            [{ ...command, payload: { text: 'different text' } }, commandResult(command.commandId, 'succeeded')],
            [{ ...command, command: 'thread.rollback' }, commandResult(command.commandId, 'succeeded')],
        ];
        for (const entities of cases) {
            expect(hasSucceededPostClearCommand(entities, threadId)).toBe(false);
        }
    });
});

function fieldCommand(
    commandId: string,
    command: 'turn.start' | 'turn.queue' | 'turn.steer',
): CodexCommandEntityV4 {
    return {
        schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
        entityType: 'codex.command',
        providerId: commandId,
        createdAt: 1,
        updatedAt: 1,
        commandId,
        threadId,
        expectedTurnId: command === 'turn.start' ? null : 'turn-active',
        command,
        payload: {
            text: OFFICIAL_CODEX_POST_CLEAR_INPUT,
            displayText: OFFICIAL_CODEX_POST_CLEAR_INPUT,
        },
        clientUserMessageId: commandId,
        replacesCommandId: null,
    };
}

function commandResult(
    commandId: string,
    status: CodexCommandResultEntityV4['status'],
): CodexCommandResultEntityV4 {
    return {
        schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
        entityType: 'codex.commandResult',
        providerId: commandId,
        createdAt: 2,
        updatedAt: 2,
        commandId,
        threadId,
        turnId: null,
        status,
        providerRequestId: null,
        result: null,
        error: null,
    };
}
