/** Validates Happy-session thread ownership and records provider command outcomes. */

import type { CodexCommandEntityV4 } from '@slopus/happy-wire';
import type { SyncV4CodexThreadRoute } from '@/api/syncV4Journal';
import type { CodexV4CommandOutcome } from './codexV4CommandProcessor';
import type { CodexV4CommandReconciliation } from './codexV4CommandProcessor';
import type { CodexV4ThreadRouter } from './codexV4ThreadRouter';

interface CodexV4CommandOwnershipOptions {
    readOnly: boolean;
    ownedThreadId?: string;
    routes: ReadonlyMap<string, SyncV4CodexThreadRoute>;
}

const CODEX_V4_READ_ONLY_COMMANDS = new Set([
    'thread.read',
    'skills.list',
    'mcp.status.list',
    'model.list',
]);
const CODEX_V4_THREAD_SCOPED_READ_ONLY_COMMANDS = new Set([
    'thread.read',
    'mcp.status.list',
]);

export function assertCodexV4ReadOnlyCommand(command: CodexCommandEntityV4): void {
    if (!CODEX_V4_READ_ONLY_COMMANDS.has(command.command)) {
        throw new Error('Provider-created Codex child sessions are read-only');
    }
}

export function codexV4CommandTargetThreadId(command: CodexCommandEntityV4): string | null {
    const payloadThreadId = command.payload
        && typeof command.payload === 'object'
        && !Array.isArray(command.payload)
        && typeof (command.payload as Record<string, unknown>).threadId === 'string'
        && (command.payload as Record<string, unknown>).threadId
        ? (command.payload as Record<string, unknown>).threadId as string
        : null;
    if (command.threadId && payloadThreadId && command.threadId !== payloadThreadId) {
        throw new Error('Codex command declares conflicting thread targets');
    }
    return command.threadId ?? payloadThreadId;
}

export function assertCodexV4CommandThreadOwnership(
    command: CodexCommandEntityV4,
    options: CodexV4CommandOwnershipOptions,
): void {
    const targetThreadId = codexV4CommandTargetThreadId(command);
    if (!targetThreadId) {
        if (
            options.readOnly
            && CODEX_V4_THREAD_SCOPED_READ_ONLY_COMMANDS.has(command.command)
        ) {
            throw new Error('Codex child query requires its owned thread target');
        }
        return;
    }

    if (options.readOnly) {
        if (targetThreadId !== options.ownedThreadId) {
            throw new Error('Codex command targets a thread owned by another Happy session');
        }
        return;
    }

    if (targetThreadId === options.ownedThreadId) return;
    const route = options.routes.get(targetThreadId);
    if (route?.kind === 'root' || route?.kind === 'userFork') return;
    if (!route && command.command === 'thread.resume') return;
    throw new Error('Codex command targets a thread owned by another Happy session');
}

export async function registerCodexV4CommandOutcome(
    router: CodexV4ThreadRouter,
    command: CodexCommandEntityV4,
    outcome: CodexV4CommandOutcome,
): Promise<void> {
    if (!outcome.threadId) return;
    switch (command.command) {
        case 'thread.start':
        case 'thread.resume':
        case 'turn.start':
            await router.registerRootThread(outcome.threadId, command.commandId);
            return;
        case 'thread.fork': {
            const parentThreadId = codexV4CommandTargetThreadId(command);
            if (!parentThreadId) throw new Error('Codex user fork has no source thread');
            await router.registerUserFork(outcome.threadId, parentThreadId, command.commandId);
            return;
        }
        case 'review.start': {
            const parentThreadId = codexV4CommandTargetThreadId(command);
            if (!parentThreadId) throw new Error('Codex review has no parent thread');
            await router.registerDetachedReview(
                outcome.threadId,
                parentThreadId,
                command.expectedTurnId,
                command.commandId,
            );
        }
    }
}

export function reconcileCodexV4CoordinatedRoute(
    command: CodexCommandEntityV4,
    routes: ReadonlyMap<string, SyncV4CodexThreadRoute>,
): CodexV4CommandReconciliation | null {
    if (
        command.command !== 'thread.start'
        && command.command !== 'thread.resume'
        && command.command !== 'thread.fork'
        && command.command !== 'review.start'
    ) {
        return null;
    }
    for (const route of routes.values()) {
        if (route.coordinatedCommandId === command.commandId) {
            return { action: 'succeeded', threadId: route.threadId };
        }
    }
    return null;
}
