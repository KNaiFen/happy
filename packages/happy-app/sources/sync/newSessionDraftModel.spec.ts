import { describe, expect, it } from 'vitest';
import { parseNewSessionDraft } from './newSessionDraftModel';

describe('parseNewSessionDraft', () => {
    it('migrates v1 environment state while clearing ambiguous modes', () => {
        expect(parseNewSessionDraft({
            input: 'hello',
            selectedMachineId: 'machine-1',
            selectedPath: '~/project',
            agentType: 'claude',
            permissionMode: 'bypassPermissions',
            modelMode: 'opus',
            effortLevel: 'medium',
            sessionType: 'worktree',
            worktreeKey: '/worktree',
            updatedAt: 10,
        }, true)).toEqual({
            input: 'hello',
            selectedMachineId: 'machine-1',
            selectedPath: '~/project',
            agentType: 'codex',
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            sessionType: 'worktree',
            worktreeKey: '/worktree',
            updatedAt: 10,
        });
    });

    it('preserves explicit v2 overrides for retained agents', () => {
        expect(parseNewSessionDraft({
            agentType: 'codex',
            permissionMode: 'read-only',
            modelMode: 'gpt-5.6-sol',
            effortLevel: 'max',
        })).toMatchObject({
            agentType: 'codex',
            permissionMode: 'read-only',
            modelMode: 'gpt-5.6-sol',
            effortLevel: 'max',
        });
    });
});
