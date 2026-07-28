import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    type CodexCommandEntityV4,
} from '@slopus/happy-wire';
import { describe, expect, it, vi } from 'vitest';
import type { SyncV4CodexThreadRoute } from '@/api/syncV4Journal';
import type { CodexV4ThreadRouter } from './codexV4ThreadRouter';
import {
    assertCodexV4ReadOnlyCommand,
    assertCodexV4CommandThreadOwnership,
    codexV4CommandTargetThreadId,
    reconcileCodexV4CoordinatedRoute,
    registerCodexV4CommandOutcome,
} from './codexV4CommandRouting';

function command(overrides: Partial<CodexCommandEntityV4> = {}): CodexCommandEntityV4 {
    return {
        schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
        entityType: 'codex.command',
        providerId: 'command-1',
        createdAt: 1,
        updatedAt: 1,
        commandId: 'command-1',
        threadId: 'thread-root',
        expectedTurnId: null,
        command: 'turn.start',
        payload: { text: 'hello' },
        clientUserMessageId: 'command-1',
        replacesCommandId: null,
        ...overrides,
    };
}

function route(
    threadId: string,
    kind: SyncV4CodexThreadRoute['kind'],
): SyncV4CodexThreadRoute {
    return {
        threadId,
        kind,
        parentThreadId: kind === 'root' ? null : 'thread-root',
        parentTurnId: null,
        delegationItemId: null,
        depth: kind === 'root' || kind === 'userFork' ? 0 : 1,
    };
}

function router() {
    return {
        registerRootThread: vi.fn(async () => {}),
        registerUserFork: vi.fn(async () => {}),
        registerDetachedReview: vi.fn(async () => {}),
    } as unknown as CodexV4ThreadRouter;
}

describe('Codex v4 command routing', () => {
    it('uses the payload thread only when the canonical target is absent', () => {
        expect(codexV4CommandTargetThreadId(command({
            threadId: null,
            payload: { threadId: 'thread-payload' },
        }))).toBe('thread-payload');
        expect(codexV4CommandTargetThreadId(command({
            threadId: 'thread-canonical',
            payload: { threadId: 'thread-canonical' },
        }))).toBe('thread-canonical');
    });

    it('rejects conflicting canonical and payload thread targets', () => {
        expect(() => codexV4CommandTargetThreadId(command({
            threadId: 'thread-canonical',
            payload: { threadId: 'thread-payload' },
        }))).toThrow('conflicting thread targets');
        expect(() => assertCodexV4CommandThreadOwnership(
            command({
                threadId: 'thread-root',
                payload: { threadId: 'thread-child' },
            }),
            {
                readOnly: false,
                ownedThreadId: 'thread-root',
                routes: new Map([['thread-root', route('thread-root', 'root')]]),
            },
        )).toThrow('conflicting thread targets');
    });

    it('allows root and user-fork routes but rejects provider children', () => {
        const routes = new Map([
            ['thread-root', route('thread-root', 'root')],
            ['thread-fork', route('thread-fork', 'userFork')],
            ['thread-child', route('thread-child', 'providerChild')],
        ]);
        expect(() => assertCodexV4CommandThreadOwnership(
            command({ threadId: 'thread-fork' }),
            { readOnly: false, ownedThreadId: 'thread-root', routes },
        )).not.toThrow();
        expect(() => assertCodexV4CommandThreadOwnership(
            command({ command: 'thread.resume', threadId: 'thread-child' }),
            { readOnly: false, ownedThreadId: 'thread-root', routes },
        )).toThrow('another Happy session');
    });

    it('allows an explicit resume to claim an unknown thread but no other cross-thread command', () => {
        const routes = new Map<string, SyncV4CodexThreadRoute>();
        expect(() => assertCodexV4CommandThreadOwnership(
            command({ command: 'thread.resume', threadId: 'thread-new' }),
            { readOnly: false, routes },
        )).not.toThrow();
        expect(() => assertCodexV4CommandThreadOwnership(
            command({ command: 'turn.start', threadId: 'thread-new' }),
            { readOnly: false, routes },
        )).toThrow('another Happy session');
    });

    it('keeps a read-only binding scoped to its exact child thread', () => {
        const routes = new Map<string, SyncV4CodexThreadRoute>();
        expect(() => assertCodexV4CommandThreadOwnership(
            command({ command: 'thread.read', threadId: 'thread-child' }),
            { readOnly: true, ownedThreadId: 'thread-child', routes },
        )).not.toThrow();
        expect(() => assertCodexV4CommandThreadOwnership(
            command({ command: 'request.resolve', threadId: null, payload: { threadId: 'thread-root' } }),
            { readOnly: true, ownedThreadId: 'thread-child', routes },
        )).toThrow('another Happy session');
    });

    it('does not let child thread queries fall back to the globally selected thread', () => {
        const routes = new Map<string, SyncV4CodexThreadRoute>();
        expect(() => assertCodexV4CommandThreadOwnership(
            command({ command: 'mcp.status.list', threadId: null }),
            { readOnly: true, ownedThreadId: 'thread-child', routes },
        )).toThrow('requires its owned thread target');
        expect(() => assertCodexV4CommandThreadOwnership(
            command({ command: 'skills.list', threadId: null }),
            { readOnly: true, ownedThreadId: 'thread-child', routes },
        )).not.toThrow();
        expect(() => assertCodexV4CommandThreadOwnership(
            command({ command: 'model.list', threadId: null }),
            { readOnly: true, ownedThreadId: 'thread-child', routes },
        )).not.toThrow();
    });

    it('allows only side-effect-free commands in a read-only child binding', () => {
        expect(() => assertCodexV4ReadOnlyCommand(command({
            command: 'thread.read',
            threadId: 'thread-child',
        }))).not.toThrow();
        expect(() => assertCodexV4ReadOnlyCommand(command({
            command: 'request.resolve',
            threadId: 'thread-child',
        }))).toThrow('read-only');
    });

    it('registers new turns, user forks, and detached reviews with explicit lineage', async () => {
        const target = router();
        await registerCodexV4CommandOutcome(
            target,
            command({ threadId: null }),
            { threadId: 'thread-started', turnId: 'turn-started' },
        );
        await registerCodexV4CommandOutcome(
            target,
            command({ command: 'thread.fork', threadId: 'thread-root' }),
            { threadId: 'thread-fork' },
        );
        await registerCodexV4CommandOutcome(
            target,
            command({
                command: 'review.start',
                threadId: 'thread-root',
                expectedTurnId: 'turn-parent',
            }),
            { threadId: 'thread-review', turnId: 'turn-review' },
        );

        expect(target.registerRootThread).toHaveBeenCalledWith('thread-started', 'command-1');
        expect(target.registerUserFork).toHaveBeenCalledWith(
            'thread-fork',
            'thread-root',
            'command-1',
        );
        expect(target.registerDetachedReview).toHaveBeenCalledWith(
            'thread-review',
            'thread-root',
            'turn-parent',
            'command-1',
        );
    });

    it('reconciles only non-idempotent commands whose route receipt is durable', () => {
        const routes = new Map<string, SyncV4CodexThreadRoute>([
            ['thread-fork', {
                ...route('thread-fork', 'userFork'),
                coordinatedCommandId: 'command-1',
            }],
        ]);

        expect(reconcileCodexV4CoordinatedRoute(
            command({ command: 'thread.fork' }),
            routes,
        )).toEqual({
            action: 'succeeded',
            threadId: 'thread-fork',
        });
        expect(reconcileCodexV4CoordinatedRoute(
            command({ command: 'thread.fork', commandId: 'command-other' }),
            routes,
        )).toBeNull();
        expect(reconcileCodexV4CoordinatedRoute(
            command({ command: 'turn.start' }),
            routes,
        )).toBeNull();
    });
});
