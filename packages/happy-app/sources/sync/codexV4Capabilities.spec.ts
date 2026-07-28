import type {
    CodexCommandEntityV4,
    CodexThreadEntityV4,
    CodexTurnEntityV4,
} from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';
import type { Metadata } from './storageTypes';
import { createCodexV4Projection } from './codexV4Projection';
import {
    assertCodexV4CommandPublishAllowed,
    codexV4CommandTargetThreadId,
    isCodexSessionReadOnly,
    resolveCodexV4SessionCapabilities,
} from './codexV4Capabilities';

function metadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/workspace',
        host: 'host',
        flavor: 'codex',
        codexSyncVersion: 4,
        codexThreadId: 'thread-owned',
        ...overrides,
    };
}

function projection() {
    const result = createCodexV4Projection();
    result.thread = { threadId: 'thread-owned' } as CodexThreadEntityV4;
    result.entities['codex.turn']['turn-owned'] = {
        entityType: 'codex.turn',
        providerId: 'turn-owned',
        threadId: 'thread-owned',
        turnId: 'turn-owned',
    } as CodexTurnEntityV4;
    result.entities['codex.turn']['turn-other'] = {
        entityType: 'codex.turn',
        providerId: 'turn-other',
        threadId: 'thread-other',
        turnId: 'turn-other',
    } as CodexTurnEntityV4;
    return result;
}

function command(overrides: Partial<CodexCommandEntityV4> = {}): CodexCommandEntityV4 {
    return {
        schemaVersion: 1,
        entityType: 'codex.command',
        providerId: 'command-1',
        createdAt: 1,
        updatedAt: 1,
        commandId: 'command-1',
        threadId: 'thread-owned',
        expectedTurnId: null,
        command: 'turn.start',
        payload: { text: 'hello' },
        clientUserMessageId: 'command-1',
        replacesCommandId: null,
        ...overrides,
    };
}

describe('Codex v4 App capabilities', () => {
    it('uses the encrypted session marker and metadata-selected owned thread', () => {
        expect(isCodexSessionReadOnly(metadata({ codexReadOnly: true }))).toBe(true);
        expect(resolveCodexV4SessionCapabilities(
            metadata({ codexThreadId: 'thread-metadata' }),
            Object.assign(projection(), {
                thread: { threadId: 'thread-projection' } as CodexThreadEntityV4,
            }),
        )).toEqual({
            readOnly: false,
            ownedThreadId: 'thread-metadata',
        });
    });

    it('rejects every App command from a provider-created child session', () => {
        expect(() => assertCodexV4CommandPublishAllowed({
            command: command({ command: 'thread.read' }),
            metadata: metadata({ codexReadOnly: true }),
            projection: projection(),
        })).toThrow('read-only');
    });

    it('rejects conflicting, missing, and cross-session thread targets', () => {
        expect(() => codexV4CommandTargetThreadId(command({
            threadId: 'thread-owned',
            payload: { threadId: 'thread-other' },
        }))).toThrow('conflicting thread targets');
        expect(() => assertCodexV4CommandPublishAllowed({
            command: command({ threadId: null }),
            metadata: metadata(),
            projection: projection(),
        })).toThrow('requires the owned thread target');
        expect(() => assertCodexV4CommandPublishAllowed({
            command: command({ threadId: 'thread-other' }),
            metadata: metadata(),
            projection: projection(),
        })).toThrow('another Happy session');
    });

    it('allows only explicit global reads and initial thread creation without an owner', () => {
        expect(() => assertCodexV4CommandPublishAllowed({
            command: command({ command: 'model.list', threadId: null }),
            metadata: metadata({ codexThreadId: undefined }),
            projection: null,
        })).not.toThrow();
        expect(() => assertCodexV4CommandPublishAllowed({
            command: command({ command: 'turn.start', threadId: null }),
            metadata: metadata({ codexThreadId: undefined }),
            projection: null,
        })).not.toThrow();
        expect(() => assertCodexV4CommandPublishAllowed({
            command: command({ command: 'thread.compact', threadId: null }),
            metadata: metadata({ codexThreadId: undefined }),
            projection: null,
        })).toThrow('before thread ownership');
    });

    it('requires expected turns to belong to the selected session thread', () => {
        expect(() => assertCodexV4CommandPublishAllowed({
            command: command({
                command: 'turn.interrupt',
                expectedTurnId: 'turn-owned',
                payload: { expectedTurnId: 'turn-owned' },
            }),
            metadata: metadata(),
            projection: projection(),
        })).not.toThrow();
        expect(() => assertCodexV4CommandPublishAllowed({
            command: command({
                command: 'turn.interrupt',
                expectedTurnId: 'turn-other',
                payload: { expectedTurnId: 'turn-other' },
            }),
            metadata: metadata(),
            projection: projection(),
        })).toThrow('expected turn');
        expect(() => assertCodexV4CommandPublishAllowed({
            command: command({
                command: 'turn.interrupt',
                expectedTurnId: 'turn-unknown',
                payload: { expectedTurnId: 'turn-unknown' },
            }),
            metadata: metadata(),
            projection: projection(),
        })).toThrow('expected turn');
    });
});
