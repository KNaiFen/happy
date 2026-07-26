import type { Model } from './codexAppServerTypes';

export type CodexModelCapability = {
    code: string;
    value: string;
    description?: string | null;
    thinkingLevels: string[];
    defaultThinkingLevel: string;
};

export type CodexAgentCapabilities = {
    codexCliVersion: string;
    detectedAt: number;
    models: CodexModelCapability[];
};

export function normalizeCodexModels(models: Model[]): CodexModelCapability[] {
    return models
        .filter((model) => !model.hidden && model.id.length > 0)
        .map((model) => ({
            code: model.id,
            value: model.displayName || model.model || model.id,
            description: model.description || null,
            thinkingLevels: model.supportedReasoningEfforts
                .map((option) => option.reasoningEffort)
                .filter((effort) => effort.length > 0),
            defaultThinkingLevel: model.defaultReasoningEffort,
        }))
        .filter((model) => (
            model.thinkingLevels.length > 0
            && model.thinkingLevels.includes(model.defaultThinkingLevel)
        ));
}
