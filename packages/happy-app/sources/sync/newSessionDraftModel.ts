import type { PermissionModeKey } from '@/components/PermissionModeSelector';

export const newSessionAgentTypes = ['codex', 'gemini', 'openclaw', 'agy'] as const;
export type NewSessionAgentType = typeof newSessionAgentTypes[number];
export type NewSessionSessionType = 'simple' | 'worktree';

export interface NewSessionDraft {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    agentType: NewSessionAgentType;
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

function parseAgent(value: unknown): NewSessionAgentType {
    return typeof value === 'string' && (newSessionAgentTypes as readonly string[]).includes(value)
        ? value as NewSessionAgentType
        : 'codex';
}

export function parseNewSessionDraft(value: unknown, legacyV1 = false): NewSessionDraft | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    return {
        input: typeof raw.input === 'string' ? raw.input : '',
        selectedMachineId: nullableString(raw.selectedMachineId),
        selectedPath: nullableString(raw.selectedPath),
        agentType: parseAgent(raw.agentType),
        permissionMode: legacyV1 ? null : nullableString(raw.permissionMode),
        modelMode: legacyV1 ? null : nullableString(raw.modelMode),
        effortLevel: legacyV1 ? null : nullableString(raw.effortLevel),
        sessionType: raw.sessionType === 'worktree' ? 'worktree' : 'simple',
        worktreeKey: nullableString(raw.worktreeKey),
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    };
}
