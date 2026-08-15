import type { MachineMetadata, Metadata } from '@/sync/storageTypes';
import { hackModes } from '@/sync/modeHacks';
import { getCodeAgentDefaults } from '@/sync/agentDefaults';

export type ModeOption = {
    key: string;
    name: string;
    description?: string | null;
    semanticKind?: string | null;
    disabled?: boolean;
};

export type PermissionMode = ModeOption;
export type ModelMode = ModeOption & {
    modelId?: string;
    providerId?: string;
    providerName?: string;
    providerKind?: string;
    contextWindow?: number;
    serviceTiers?: string[];
    thinkingLevels?: string[];
    defaultThinkingLevel?: string | null;
    isDefault?: boolean;
    unavailable?: boolean;
};

export type EffortLevel = ModeOption;
export type PermissionModeKey = string;
export type ModelModeKey = string;

export type AgentFlavor = 'codex' | string | null | undefined;

type Translate = (key: any) => string;

type MetadataOption = {
    code: string;
    value: string;
    description?: string | null;
};

type MetadataModelOption = MetadataOption & {
    thinkingLevels?: string[];
    defaultThinkingLevel?: string | null;
    isDefault?: boolean;
};

export function mapMetadataOptions(options?: MetadataOption[] | null): ModeOption[] {
    if (!options || options.length === 0) {
        return [];
    }

    return options.map((option) => ({
        key: option.code,
        name: option.value,
        description: option.description ?? null,
    }));
}

export function mapMetadataModels(options?: MetadataModelOption[] | null): ModelMode[] {
    if (!options || options.length === 0) {
        return [];
    }

    return options.map((option) => ({
        key: option.code,
        name: option.value,
        description: option.description ?? null,
        ...(option.thinkingLevels ? { thinkingLevels: option.thinkingLevels } : {}),
        ...(option.defaultThinkingLevel != null
            ? { defaultThinkingLevel: option.defaultThinkingLevel }
            : {}),
        ...(option.isDefault !== undefined ? { isDefault: option.isDefault } : {}),
    }));
}

function findCodexModel(models: ModelMode[], modelKey: string): ModelMode | undefined {
    const resolvedKey = modelKey === 'default'
        ? getCodeAgentDefaults('codex').modelMode
        : modelKey;
    return models.find((model) => model.key === resolvedKey);
}

function createCodexDefaultModelOption(models: ModelMode[]): ModelMode {
    const launchDefault = findCodexModel(models, 'default');
    return {
        key: 'default',
        name: 'default model',
        description: null,
        ...(launchDefault?.thinkingLevels
            ? { thinkingLevels: launchDefault.thinkingLevels }
            : {}),
        ...(launchDefault?.defaultThinkingLevel
            ? { defaultThinkingLevel: launchDefault.defaultThinkingLevel }
            : {}),
    };
}

export function getCodexPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.codexPermissionMode.default'), description: translate('agentInput.codexPermissionMode.defaultDescription') },
        { key: 'read-only', name: translate('agentInput.codexPermissionMode.readOnly'), description: translate('agentInput.codexPermissionMode.readOnlyDescription') },
        { key: 'safe-yolo', name: translate('agentInput.codexPermissionMode.safeYolo'), description: translate('agentInput.codexPermissionMode.safeYoloDescription') },
        { key: 'yolo', name: translate('agentInput.codexPermissionMode.yolo'), description: translate('agentInput.codexPermissionMode.yoloDescription') },
    ];
}

export function getCodexModelModes(): ModelMode[] {
    return [
        { key: 'default', name: 'default model', description: null },
        { key: 'gpt-5.6-sol', name: 'gpt-5.6 sol', description: null },
        { key: 'gpt-5.6-terra', name: 'gpt-5.6 terra', description: null },
        { key: 'gpt-5.6-luna', name: 'gpt-5.6 luna', description: null },
        { key: 'gpt-5.5', name: 'gpt-5.5', description: null },
        { key: 'gpt-5.4', name: 'gpt-5.4', description: null },
        { key: 'gpt-5.3-codex', name: 'gpt-5.3-codex', description: null },
        { key: 'gpt-5.2-codex', name: 'gpt-5.2-codex', description: null },
        { key: 'gpt-5.1-codex-max', name: 'gpt-5.1-codex-max', description: null },
        { key: 'gpt-5.2', name: 'gpt-5.2', description: null },
        { key: 'gpt-5.1-codex-mini', name: 'gpt-5.1-codex-mini', description: null },
    ];
}

export function getHardcodedPermissionModes(flavor: AgentFlavor, translate: Translate): PermissionMode[] {
    return flavor === 'codex' ? getCodexPermissionModes(translate) : [];
}

export function getHardcodedModelModes(flavor: AgentFlavor, _translate: Translate): ModelMode[] {
    return flavor === 'codex' ? getCodexModelModes() : [];
}

export function getAvailableModels(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
    selectedKey?: string | null,
): ModelMode[] {
    if (flavor !== 'codex') return [];
    const metadataModels = mapMetadataModels(metadata?.models);
    if (metadataModels.length > 0) {
        if (flavor === 'codex' && !metadataModels.some((model) => model.key === 'default')) {
            return [createCodexDefaultModelOption(metadataModels), ...metadataModels];
        }
        return metadataModels;
    }
    return getHardcodedModelModes(flavor, translate);
}

export function getAvailableModelsForMachine(
    flavor: AgentFlavor,
    metadata: MachineMetadata | null | undefined,
    translate: Translate,
    selectedKey?: string | null,
): ModelMode[] {
    const codexModels = flavor === 'codex'
        ? metadata?.agentCapabilities?.codex?.models
        : undefined;
    const models = mapMetadataModels(codexModels);
    if (models.length > 0) {
        return [createCodexDefaultModelOption(models), ...models];
    }
    const fallbacks = getHardcodedModelModes(flavor, translate);
    if (
        flavor === 'codex'
        && selectedKey
        && !fallbacks.some((model) => model.key === selectedKey)
    ) {
        return [{ key: selectedKey, name: selectedKey, description: null }, ...fallbacks];
    }
    return fallbacks;
}

export function getAvailablePermissionModes(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
    selectedKey?: string | null,
): PermissionMode[] {
    if (flavor !== 'codex') return [];
    return hackModes(getHardcodedPermissionModes(flavor, translate));
}

export function findOptionByKey<T extends ModeOption>(options: T[], key: string | null | undefined): T | null {
    if (!key) {
        return null;
    }
    return options.find((option) => option.key === key) ?? null;
}

export function resolveCurrentOption<T extends ModeOption>(
    options: T[],
    preferredKeys: Array<string | null | undefined>,
): T | null {
    for (const key of preferredKeys) {
        const option = findOptionByKey(options, key);
        if (option) {
            return option;
        }
    }
    return null;
}

export function getDefaultModelKey(flavor: AgentFlavor): string {
    return getCodeAgentDefaults(flavor).modelMode;
}

export function getDefaultPermissionModeKey(flavor: AgentFlavor): string {
    return getCodeAgentDefaults(flavor).permissionMode;
}

// Effort levels per agent type

export function getCodexEffortLevels(): EffortLevel[] {
    return [
        { key: 'low', name: 'low' },
        { key: 'medium', name: 'medium' },
        { key: 'high', name: 'high' },
        { key: 'xhigh', name: 'xhigh' },
        { key: 'max', name: 'max' },
    ];
}

export function getHardcodedEffortLevels(flavor: AgentFlavor): EffortLevel[] {
    if (flavor === 'codex') return getCodexEffortLevels();
    return [];
}

export function getDefaultEffortKey(flavor: AgentFlavor): string | null {
    return getCodeAgentDefaults(flavor).effortLevel;
}

// Per-model effort: returns effort levels for a specific model, or empty if the model has no effort
export function getEffortLevelsForModel(
    flavor: AgentFlavor,
    modelKey: string,
    metadata?: Metadata | null,
): EffortLevel[] {
    if (flavor === 'codex') {
        const advertisedModel = findCodexModel(mapMetadataModels(metadata?.models), modelKey);
        if (advertisedModel?.thinkingLevels) {
            return advertisedModel.thinkingLevels.map((level) => ({ key: level, name: level }));
        }
        return getCodexEffortLevels();
    }
    return [];
}

export function getEffortLevelsForModelOnMachine(
    flavor: AgentFlavor,
    modelKey: string,
    metadata: MachineMetadata | null | undefined,
    selectedKey?: string | null,
): EffortLevel[] {
    if (flavor === 'codex') {
        const advertisedModel = findCodexModel(
            mapMetadataModels(metadata?.agentCapabilities?.codex?.models),
            modelKey,
        );
        if (advertisedModel?.thinkingLevels) {
            return advertisedModel.thinkingLevels.map((level) => ({ key: level, name: level }));
        }
    }
    const fallbacks = getEffortLevelsForModel(flavor, modelKey);
    if (
        flavor === 'codex'
        && !metadata?.agentCapabilities?.codex
        && selectedKey
        && !fallbacks.some((level) => level.key === selectedKey)
    ) {
        return [{ key: selectedKey, name: selectedKey }, ...fallbacks];
    }
    return fallbacks;
}

// Prefer the advertised model default, then fall back to Happy's code default.
export function getDefaultEffortKeyForModel(
    flavor: AgentFlavor,
    modelKey: string,
    metadata?: Metadata | null,
): string | null {
    const levels = getEffortLevelsForModel(flavor, modelKey, metadata);
    if (levels.length === 0) return null;
    const advertisedDefault = flavor === 'codex'
        ? findCodexModel(mapMetadataModels(metadata?.models), modelKey)?.defaultThinkingLevel
        : null;
    if (advertisedDefault && levels.some((level) => level.key === advertisedDefault)) {
        return advertisedDefault;
    }
    const codeDefault = getCodeAgentDefaults(flavor).effortLevel;
    if (codeDefault && levels.some((level) => level.key === codeDefault)) {
        return codeDefault;
    }
    return levels[levels.length - 1].key;
}

export function getSupportsWorktree(flavor: AgentFlavor): boolean {
    return flavor === 'codex';
}
