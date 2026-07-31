export type NewSessionConfigOption = {
    key: string;
    isDefault?: boolean;
    defaultThinkingLevel?: string | null;
};

export type NewSessionAgentConfig = {
    permissionMode: string;
    modelMode: string;
    effortLevel: string | null;
};

function hasKey(options: readonly NewSessionConfigOption[], key: string | null | undefined): key is string {
    return Boolean(key && options.some((option) => option.key === key));
}

export function resolveNewSessionAgentConfig(input: {
    defaults: NewSessionAgentConfig;
    overrides: Partial<NewSessionAgentConfig>;
    permissionOptions: readonly NewSessionConfigOption[];
    modelOptions: readonly NewSessionConfigOption[];
    effortOptionsForModel: (modelKey: string) => readonly NewSessionConfigOption[];
    capabilityState: 'unknown' | 'authoritative';
}): NewSessionAgentConfig {
    const requestedPermission = input.overrides.permissionMode ?? input.defaults.permissionMode;
    const permissionMode = hasKey(input.permissionOptions, requestedPermission)
        ? requestedPermission
        : (hasKey(input.permissionOptions, input.defaults.permissionMode)
            ? input.defaults.permissionMode
            : input.permissionOptions[0]?.key);
    if (!permissionMode) throw new Error('No supported permission mode is available');

    const requestedModel = input.overrides.modelMode ?? input.defaults.modelMode;
    let modelMode: string;
    if (input.capabilityState === 'unknown') {
        modelMode = requestedModel || input.modelOptions[0]?.key;
    } else if (hasKey(input.modelOptions, requestedModel)) {
        modelMode = requestedModel;
    } else {
        modelMode = input.modelOptions.find((option) => option.isDefault)?.key
            ?? (hasKey(input.modelOptions, input.defaults.modelMode) ? input.defaults.modelMode : undefined)
            ?? input.modelOptions[0]?.key;
    }
    if (!modelMode) throw new Error('No supported model is available');

    const effortOptions = input.effortOptionsForModel(modelMode);
    if (effortOptions.length === 0) {
        return { permissionMode, modelMode, effortLevel: null };
    }
    const requestedEffort = input.overrides.effortLevel ?? input.defaults.effortLevel;
    if (input.capabilityState === 'unknown') {
        return {
            permissionMode,
            modelMode,
            effortLevel: requestedEffort ?? effortOptions[0].key,
        };
    }
    const modelDefaultEffort = input.modelOptions.find((option) => option.key === modelMode)
        ?.defaultThinkingLevel;
    const effortLevel = hasKey(effortOptions, requestedEffort)
        ? requestedEffort
        : (hasKey(effortOptions, modelDefaultEffort)
            ? modelDefaultEffort
            : (hasKey(effortOptions, input.defaults.effortLevel)
                ? input.defaults.effortLevel
                : effortOptions[0].key));
    return { permissionMode, modelMode, effortLevel };
}
