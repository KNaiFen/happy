import { describe, expect, it } from 'vitest';
import type { Session } from './storageTypes';
import {
    selectVisibleSideChats,
    shouldArchiveSideChatOnClose,
} from './sideChatSessions';

function sideChat(overrides: {
    id: string;
    createdAt: number;
    active: boolean;
    archivedAt?: number | null;
    parentSessionId?: string;
    codexReadOnly?: boolean;
}): Session {
    return {
        id: overrides.id,
        createdAt: overrides.createdAt,
        active: overrides.active,
        archivedAt: overrides.archivedAt ?? null,
        metadata: {
            isSideChat: true,
            parentSessionId: overrides.parentSessionId ?? 'parent',
            codexReadOnly: overrides.codexReadOnly ?? false,
        },
    } as Session;
}

describe('selectVisibleSideChats', () => {
    it('keeps active side chats and inactive provider children in sidebar history', () => {
        const active = sideChat({ id: 'active', createdAt: 20, active: true });
        const history = sideChat({ id: 'history', createdAt: 10, active: false, codexReadOnly: true });

        expect(selectVisibleSideChats([history, active], 'parent').map((session) => session.id))
            .toEqual(['active', 'history']);
    });

    it('does not expose archived, writable inactive, or unrelated side chats', () => {
        const archivedProvider = sideChat({
            id: 'archived-provider',
            createdAt: 10,
            active: false,
            archivedAt: 100,
            codexReadOnly: true,
        });
        const inactiveWritable = sideChat({ id: 'inactive-writable', createdAt: 20, active: false });
        const unrelated = sideChat({
            id: 'unrelated',
            createdAt: 30,
            active: false,
            codexReadOnly: true,
            parentSessionId: 'other-parent',
        });

        expect(selectVisibleSideChats([archivedProvider, inactiveWritable, unrelated], 'parent')).toEqual([]);
    });
});

describe('shouldArchiveSideChatOnClose', () => {
    it('keeps provider-created read-only children local when their panel is closed', () => {
        expect(shouldArchiveSideChatOnClose(sideChat({
            id: 'provider-child',
            createdAt: 1,
            active: true,
            codexReadOnly: true,
        }))).toBe(false);
    });

    it('archives user-created writable side chats', () => {
        expect(shouldArchiveSideChatOnClose(sideChat({
            id: 'writable-child',
            createdAt: 1,
            active: true,
        }))).toBe(true);
    });
});
