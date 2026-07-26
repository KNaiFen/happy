import type { CodexModelCapability } from '@/api/types';
import type { ReasoningEffort } from './codexAppServerTypes';

const COMPATIBILITY_EFFORTS = new Set<ReasoningEffort>([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
]);

export type CodexEffortResolution = {
    effort: ReasoningEffort | undefined;
    accepted: boolean;
};

export function resolveCodexEffortForModel(opts: {
    effort: ReasoningEffort | undefined;
    model: string | undefined;
    models: CodexModelCapability[] | null;
}): CodexEffortResolution {
    if (!opts.effort) {
        return { effort: undefined, accepted: true };
    }

    if (!opts.models) {
        return COMPATIBILITY_EFFORTS.has(opts.effort)
            ? { effort: opts.effort, accepted: true }
            : { effort: undefined, accepted: false };
    }

    const model = opts.models.find((candidate) => (
        candidate.code === opts.model || (!opts.model && candidate.isDefault)
    ));
    if (!model) {
        return { effort: undefined, accepted: false };
    }
    if (model.thinkingLevels.includes(opts.effort)) {
        return { effort: opts.effort, accepted: true };
    }

    const fallback = model.thinkingLevels.includes(model.defaultThinkingLevel)
        ? model.defaultThinkingLevel
        : undefined;
    return { effort: fallback, accepted: false };
}
