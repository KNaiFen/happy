import { describe, expect, it } from 'vitest';

import { getSessionForkSource } from './sessionFork';

describe('getSessionForkSource', () => {
    it('does not expose a fork source for a removed provider session', () => {
        expect(getSessionForkSource({
            id: 'happy-claude',
            metadata: {
                flavor: 'claude',
                machineId: 'machine-1',
                path: '/tmp/project',
            },
        } as any)).toBeNull();
    });

    it('returns a Codex fork source when the session has a Codex thread id', () => {
        expect(getSessionForkSource({
            id: 'happy-codex',
            metadata: {
                flavor: 'codex',
                machineId: 'machine-1',
                path: '/tmp/project',
                codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
                codexSyncVersion: 4,
            },
        } as any)).toEqual({
            kind: 'codex',
            sessionId: 'happy-codex',
            machineId: 'machine-1',
            directory: '/tmp/project',
            codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
        });
    });

    it('returns null when required fork metadata is missing', () => {
        expect(getSessionForkSource({
            id: 'missing',
            metadata: {
                flavor: 'codex',
                machineId: 'machine-1',
                path: '/tmp/project',
                codexSyncVersion: 4,
            },
        } as any)).toBeNull();
    });

    it('does not expose a fork source for a provider-created Codex child', () => {
        expect(getSessionForkSource({
            id: 'happy-child',
            metadata: {
                flavor: 'codex',
                machineId: 'machine-1',
                path: '/tmp/project',
                codexThreadId: 'thread-child',
                codexSyncVersion: 4,
                codexReadOnly: true,
            },
        } as any)).toBeNull();
    });
});
