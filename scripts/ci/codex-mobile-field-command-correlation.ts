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
