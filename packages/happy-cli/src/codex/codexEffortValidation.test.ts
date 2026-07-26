import { describe, expect, it } from 'vitest';
import type { CodexModelCapability } from '@/api/types';
import { resolveCodexEffortForModel } from './codexEffortValidation';

const models: CodexModelCapability[] = [
    {
        code: 'gpt-5.6-sol',
        value: 'GPT-5.6-Sol',
        thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultThinkingLevel: 'low',
        isDefault: true,
    },
    {
        code: 'gpt-5.6-luna',
        value: 'GPT-5.6-Luna',
        thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultThinkingLevel: 'medium',
        isDefault: false,
    },
    {
        code: 'gpt-5.5',
        value: 'GPT-5.5',
        thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultThinkingLevel: 'medium',
        isDefault: false,
    },
];

describe('resolveCodexEffortForModel', () => {
    it('accepts ultra for Sol and for the advertised default model', () => {
        expect(resolveCodexEffortForModel({ effort: 'ultra', model: 'gpt-5.6-sol', models })).toEqual({
            effort: 'ultra',
            accepted: true,
        });
        expect(resolveCodexEffortForModel({ effort: 'ultra', model: undefined, models })).toEqual({
            effort: 'ultra',
            accepted: true,
        });
    });

    it('accepts max but repairs ultra for Luna', () => {
        expect(resolveCodexEffortForModel({ effort: 'max', model: 'gpt-5.6-luna', models }).accepted).toBe(true);
        expect(resolveCodexEffortForModel({ effort: 'ultra', model: 'gpt-5.6-luna', models })).toEqual({
            effort: 'medium',
            accepted: false,
        });
    });

    it('repairs max and ultra for models capped at xhigh', () => {
        expect(resolveCodexEffortForModel({ effort: 'max', model: 'gpt-5.5', models })).toEqual({
            effort: 'medium',
            accepted: false,
        });
        expect(resolveCodexEffortForModel({ effort: 'ultra', model: 'gpt-5.5', models })).toEqual({
            effort: 'medium',
            accepted: false,
        });
    });

    it('uses the compatibility allowlist only when no catalog is available', () => {
        expect(resolveCodexEffortForModel({ effort: 'xhigh', model: 'gpt-any', models: null }).accepted).toBe(true);
        expect(resolveCodexEffortForModel({ effort: 'ultra', model: 'gpt-any', models: null })).toEqual({
            effort: undefined,
            accepted: false,
        });
    });
});
