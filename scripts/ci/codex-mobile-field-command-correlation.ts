import type {
    CodexCommandEntityV4,
    CodexCommandResultEntityV4,
    CodexEntityV4,
} from '../../packages/happy-wire/src';
import { OFFICIAL_CODEX_POST_CLEAR_INPUT } from './codex-responses-fixture';

const postClearCommands = new Set<CodexCommandEntityV4['command']>([
    'turn.start',
    'turn.queue',
    'turn.steer',
]);

export type RollbackCommandTerminalStatus = Extract<
    CodexCommandResultEntityV4['status'],
    'succeeded' | 'failed' | 'resultUnknown' | 'notReplayed' | 'cancelled'
>;

export type RollbackCommandErrorKind =
    | 'none'
    | 'commandMissing'
    | 'resultMissing'
    | 'resultThreadMismatch'
    | 'resultNonTerminal'
    | 'failed'
    | 'resultUnknown'
    | 'notReplayed'
    | 'cancelled';

export interface RollbackCommandInspection {
    commandId: string | null;
    terminalStatus: RollbackCommandTerminalStatus | null;
    updatedAt: number | null;
    errorKind: RollbackCommandErrorKind;
}

const rollbackTerminalStatuses = new Set<RollbackCommandTerminalStatus>([
    'succeeded',
    'failed',
    'resultUnknown',
    'notReplayed',
    'cancelled',
]);

export function inspectRollbackCommand(
    entities: readonly CodexEntityV4[],
    threadId: string,
): RollbackCommandInspection {
    const commands = entities
        .filter((entity): entity is CodexCommandEntityV4 => (
            entity.entityType === 'codex.command'
            && entity.threadId === threadId
            && entity.command === 'thread.rollback'
        ))
        .sort((left, right) => (
            left.updatedAt - right.updatedAt
            || left.commandId.localeCompare(right.commandId)
        ));
    const command = commands.at(-1);
    if (!command) {
        return {
            commandId: null,
            terminalStatus: null,
            updatedAt: null,
            errorKind: 'commandMissing',
        };
    }

    const sameCommandResults = entities.filter((entity): entity is CodexCommandResultEntityV4 => (
        entity.entityType === 'codex.commandResult'
        && entity.commandId === command.commandId
    ));
    const matchingResults = sameCommandResults
        .filter((result) => result.threadId === threadId)
        .sort(compareEntity);
    const result = matchingResults.at(-1);
    if (!result) {
        return {
            commandId: command.commandId,
            terminalStatus: null,
            updatedAt: null,
            errorKind: sameCommandResults.length > 0
                ? 'resultThreadMismatch'
                : 'resultMissing',
        };
    }
    if (!rollbackTerminalStatuses.has(result.status as RollbackCommandTerminalStatus)) {
        return {
            commandId: command.commandId,
            terminalStatus: null,
            updatedAt: null,
            errorKind: 'resultNonTerminal',
        };
    }
    const terminalStatus = result.status as RollbackCommandTerminalStatus;
    return {
        commandId: command.commandId,
        terminalStatus,
        updatedAt: result.updatedAt,
        errorKind: terminalStatus === 'succeeded' ? 'none' : terminalStatus,
    };
}

export function hasSucceededPostClearCommand(
    entities: readonly CodexEntityV4[],
    threadId: string,
): boolean {
    const postClearCommandIds = new Set(entities
        .filter((entity): entity is CodexCommandEntityV4 => (
            entity.entityType === 'codex.command'
            && entity.threadId === threadId
            && postClearCommands.has(entity.command)
            && commandText(entity.payload) === OFFICIAL_CODEX_POST_CLEAR_INPUT
        ))
        .map((command) => command.commandId));
    return entities.some((entity): entity is CodexCommandResultEntityV4 => (
        entity.entityType === 'codex.commandResult'
        && entity.threadId === threadId
        && postClearCommandIds.has(entity.commandId)
        && entity.status === 'succeeded'
    ));
}

function commandText(payload: CodexCommandEntityV4['payload']): string | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const text = (payload as Record<string, unknown>).text;
    return typeof text === 'string' ? text : null;
}

function compareEntity(
    left: Pick<CodexEntityV4, 'updatedAt' | 'providerId'>,
    right: Pick<CodexEntityV4, 'updatedAt' | 'providerId'>,
): number {
    return left.updatedAt - right.updatedAt
        || left.providerId.localeCompare(right.providerId);
}
