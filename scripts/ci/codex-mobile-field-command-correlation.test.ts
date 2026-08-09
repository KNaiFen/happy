import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    type CodexCommandEntityV4,
    type CodexCommandResultEntityV4,
    type CodexEntityV4,
} from '../../packages/happy-wire/src';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_CODEX_POST_CLEAR_INPUT } from './codex-responses-fixture';
import {
    hasSucceededPostClearCommand,
    inspectRollbackCommand,
} from './codex-mobile-field-command-correlation';

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

    it.each([
        ['succeeded', 'none'],
        ['failed', 'failed'],
        ['resultUnknown', 'resultUnknown'],
        ['notReplayed', 'notReplayed'],
        ['cancelled', 'cancelled'],
    ] as const)('reports rollback terminal status %s without payload data', (status, errorKind) => {
        const command = rollbackCommand('rollback-terminal');
        const inspection = inspectRollbackCommand([
            command,
            commandResult(command.commandId, status),
        ], threadId);

        expect(inspection).toEqual({
            commandId: command.commandId,
            terminalStatus: status,
            updatedAt: 2,
            errorKind,
        });
        expect(Object.keys(inspection).sort()).toEqual([
            'commandId',
            'errorKind',
            'terminalStatus',
            'updatedAt',
        ]);
    });

    it('distinguishes missing, mismatched, and non-terminal rollback evidence', () => {
        const command = rollbackCommand('rollback-target');

        expect(inspectRollbackCommand([], threadId)).toMatchObject({
            commandId: null,
            errorKind: 'commandMissing',
        });
        expect(inspectRollbackCommand([command], threadId)).toMatchObject({
            commandId: command.commandId,
            errorKind: 'resultMissing',
        });
        expect(inspectRollbackCommand([
            command,
            { ...commandResult(command.commandId, 'succeeded'), threadId: 'thread-other' },
        ], threadId)).toMatchObject({
            commandId: command.commandId,
            errorKind: 'resultThreadMismatch',
        });
        for (const status of ['received', 'executing'] as const) {
            expect(inspectRollbackCommand([
                command,
                commandResult(command.commandId, status),
            ], threadId)).toEqual({
                commandId: command.commandId,
                terminalStatus: null,
                updatedAt: null,
                errorKind: 'resultNonTerminal',
            });
        }
    });

    it('selects the newest rollback command with a stable command-id tie break', () => {
        const older = rollbackCommand('rollback-a', 3);
        const newer = rollbackCommand('rollback-b', 4);
        const tied = rollbackCommand('rollback-c', 4);

        expect(inspectRollbackCommand([
            older,
            commandResult(older.commandId, 'succeeded'),
            newer,
            commandResult(newer.commandId, 'succeeded'),
            tied,
            { ...commandResult(tied.commandId, 'failed'), updatedAt: 5 },
        ], threadId)).toEqual({
            commandId: tied.commandId,
            terminalStatus: 'failed',
            updatedAt: 5,
            errorKind: 'failed',
        });
    });
});

function rollbackCommand(commandId: string, updatedAt = 1): CodexCommandEntityV4 {
    return {
        ...fieldCommand(commandId, 'turn.start'),
        updatedAt,
        command: 'thread.rollback',
        payload: { allTurns: true },
    };
}

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
