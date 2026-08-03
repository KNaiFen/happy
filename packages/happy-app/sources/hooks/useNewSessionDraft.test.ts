import { beforeEach, describe, expect, it, vi } from 'vitest';

type Draft = {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    permissionMode: string | null;
    modelMode: string | null;
    effortLevel: string | null;
    sessionType: 'simple' | 'worktree';
    worktreeKey: string | null;
    updatedAt: number;
};

const mockPersistence = vi.hoisted(() => ({
    draft: null as Draft | null,
    saved: [] as Draft[],
}));

vi.mock('@/sync/persistence', () => ({
    loadNewSessionDraft: () => mockPersistence.draft,
    saveNewSessionDraft: (draft: Draft) => {
        mockPersistence.saved.push(draft);
        mockPersistence.draft = draft;
    },
}));

function persistedDraft(overrides: Partial<Draft> = {}): Draft {
    return {
        input: '',
        selectedMachineId: null,
        selectedPath: null,
        permissionMode: null,
        modelMode: null,
        effortLevel: null,
        sessionType: 'simple',
        worktreeKey: null,
        updatedAt: 1,
        ...overrides,
    };
}

describe('useNewSessionDraft', () => {
    beforeEach(() => {
        vi.resetModules();
        mockPersistence.draft = null;
        mockPersistence.saved = [];
    });

    it('keeps mode defaults unset when there is no persisted draft', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        expect(useNewSessionDraft.getState().permissionMode).toBeNull();
        expect(useNewSessionDraft.getState().modelMode).toBeNull();
        expect(useNewSessionDraft.getState().effortLevel).toBeNull();
    });

    it('loads persisted permission, model, and effort overrides', async () => {
        mockPersistence.draft = persistedDraft({
            permissionMode: 'yolo',
            modelMode: 'opus',
            effortLevel: 'xhigh',
        });

        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        expect(useNewSessionDraft.getState().permissionMode).toBe('yolo');
        expect(useNewSessionDraft.getState().modelMode).toBe('opus');
        expect(useNewSessionDraft.getState().effortLevel).toBe('xhigh');
    });

    it('keeps Codex mode overrides without a provider selector', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        useNewSessionDraft.getState().setPermissionMode('read-only');
        useNewSessionDraft.getState().setModelMode('gpt-5.6-sol');
        useNewSessionDraft.getState().setEffortLevel('max');

        expect(useNewSessionDraft.getState()).toMatchObject({
            permissionMode: 'read-only',
            modelMode: 'gpt-5.6-sol',
            effortLevel: 'max',
        });
    });

    it('prepares a machine environment atomically and clears mode overrides', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');
        useNewSessionDraft.getState().setEffortLevel('high');

        useNewSessionDraft.getState().prepareEnvironment({
            machineId: 'machine-2',
            path: '~/project',
            sessionType: 'worktree',
            worktreeKey: '/worktree',
        });

        expect(useNewSessionDraft.getState()).toMatchObject({
            selectedMachineId: 'machine-2',
            selectedPath: '~/project',
            sessionType: 'worktree',
            worktreeKey: '/worktree',
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
        });
        expect(mockPersistence.saved).toHaveLength(2);
    });

    it('persists effort changes with the rest of the new-session draft', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');

        useNewSessionDraft.getState().setEffortLevel('high');

        expect(useNewSessionDraft.getState().effortLevel).toBe('high');
        expect(mockPersistence.saved.at(-1)).toMatchObject({ effortLevel: 'high' });
    });

    it('keeps temporary image attachments in memory without persisting their file URIs', async () => {
        const { useNewSessionDraft } = await import('./useNewSessionDraft');
        const attachment = {
            id: 'photo-1',
            uri: 'file:///temporary/photo.jpg',
            width: 100,
            height: 100,
            mimeType: 'image/jpeg',
            size: 1024,
            name: 'photo.jpg',
        };

        useNewSessionDraft.getState().setAttachments([attachment]);

        expect(useNewSessionDraft.getState().attachments).toEqual([attachment]);
        expect(mockPersistence.saved).toHaveLength(0);
    });
});
