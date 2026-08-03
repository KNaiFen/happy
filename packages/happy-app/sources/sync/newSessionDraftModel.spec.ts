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
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            sessionType: 'worktree',
            worktreeKey: '/worktree',
            updatedAt: 10,
        });
    });

    it('preserves explicit v2 Codex overrides and drops legacy provider metadata', () => {
        const parsed = parseNewSessionDraft({
            permissionMode: 'read-only',
            modelMode: 'gpt-5.6-sol',
            effortLevel: 'max',
        });

        expect(parsed).toMatchObject({
            permissionMode: 'read-only',
            modelMode: 'gpt-5.6-sol',
            effortLevel: 'max',
        });
        expect(parsed).not.toHaveProperty('agentType');
    });
});
