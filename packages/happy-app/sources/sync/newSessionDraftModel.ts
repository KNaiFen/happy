import type { PermissionModeKey } from '@/components/PermissionModeSelector';

export type NewSessionSessionType = 'simple' | 'worktree';

export interface NewSessionDraft {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    permissionMode: PermissionModeKey | null;
    modelMode: string | null;
    effortLevel: string | null;
    sessionType: NewSessionSessionType;
    worktreeKey: string | null;
    updatedAt: number;
}

function nullableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

export function parseNewSessionDraft(value: unknown, legacyV1 = false): NewSessionDraft | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    return {
        input: typeof raw.input === 'string' ? raw.input : '',
        selectedMachineId: nullableString(raw.selectedMachineId),
        selectedPath: nullableString(raw.selectedPath),
        permissionMode: legacyV1 ? null : nullableString(raw.permissionMode),
        modelMode: legacyV1 ? null : nullableString(raw.modelMode),
        effortLevel: legacyV1 ? null : nullableString(raw.effortLevel),
        sessionType: raw.sessionType === 'worktree' ? 'worktree' : 'simple',
        worktreeKey: nullableString(raw.worktreeKey),
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    };
}
