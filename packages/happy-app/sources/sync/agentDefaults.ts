import * as z from 'zod';

export const agentKeys = ['codex'] as const;
export type AgentKey = typeof agentKeys[number];

export const AgentDefaultOverrideSchema = z.object({
    permissionMode: z.string().optional(),
    modelMode: z.string().optional(),
    effortLevel: z.string().optional(),
}).passthrough();

export const AgentDefaultOverridesSchema = z.object({
    codex: AgentDefaultOverrideSchema.optional(),
}).default({});

export type AgentDefaultOverride = z.infer<typeof AgentDefaultOverrideSchema>;
export type AgentDefaultOverrides = z.infer<typeof AgentDefaultOverridesSchema>;
export type AgentDefaultField = keyof Pick<AgentDefaultOverride, 'permissionMode' | 'modelMode' | 'effortLevel'>;

export type AgentDefaultConfig = {
    permissionMode: string;
    modelMode: string;
    effortLevel: string | null;
};

const codeAgentDefaults: Record<AgentKey, AgentDefaultConfig> = {
    codex: { permissionMode: 'yolo', modelMode: 'gpt-5.5', effortLevel: 'medium' },
};

const unknownAgentDefaults: AgentDefaultConfig = {
    permissionMode: 'default',
    modelMode: 'default',
    effortLevel: null,
};

function parseAgentKey(flavor: string | null | undefined): AgentKey | null {
    return flavor === 'codex' ? 'codex' : null;
}

export function resolveNewSessionAgent(flavor: string | null | undefined): AgentKey {
    return parseAgentKey(flavor) ?? 'codex';
}

export function sanitizeAgentDefaultOverrides(
    overrides: AgentDefaultOverrides | null | undefined,
): AgentDefaultOverrides {
    const source = overrides ?? {};
    const value = source.codex;
    return value && typeof value === 'object' ? { codex: { ...value } } : {};
}

export function getCodeAgentDefaults(flavor: string | null | undefined): AgentDefaultConfig {
    const key = parseAgentKey(flavor);
    return key ? codeAgentDefaults[key] : unknownAgentDefaults;
}

export function getAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
): AgentDefaultOverride {
    const key = parseAgentKey(flavor);
    return key ? overrides?.[key] ?? {} : {};
}

export function resolveAgentDefaultConfig(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
): AgentDefaultConfig {
    const codeDefaults = getCodeAgentDefaults(flavor);
    const userOverride = getAgentDefaultOverride(overrides, flavor);
    return {
        permissionMode: userOverride.permissionMode ?? codeDefaults.permissionMode,
        modelMode: userOverride.modelMode ?? codeDefaults.modelMode,
        effortLevel: userOverride.effortLevel ?? codeDefaults.effortLevel,
    };
}

export function hasAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
): boolean {
    return getAgentDefaultOverride(overrides, flavor)[field] !== undefined;
}

export function getAgentDefaultOverrideValue(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
): string | undefined {
    return getAgentDefaultOverride(overrides, flavor)[field];
}

export function setAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
    value: string | null | undefined,
): AgentDefaultOverrides {
    const key = parseAgentKey(flavor);
    const next = sanitizeAgentDefaultOverrides(overrides);
    if (!key) return next;
    const current: AgentDefaultOverride = { ...(next[key] ?? {}) };

    if (value === null || value === undefined) {
        delete current[field];
    } else {
        current[field] = value;
    }

    if (current.permissionMode === undefined && current.modelMode === undefined && current.effortLevel === undefined) {
        delete next[key];
    } else {
        next[key] = current;
    }

    return next;
}
