import { describe, expect, it } from 'vitest';
import type { Model } from './codexAppServerTypes';
import { normalizeCodexModels } from './codexModelCapabilities';

function model(overrides: Partial<Model>): Model {
    return {
        id: 'gpt-test',
        model: 'gpt-test',
        displayName: 'GPT Test',
        description: 'Test model',
        hidden: false,
        supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Low' },
            { reasoningEffort: 'ultra', description: 'Ultra' },
        ],
        defaultReasoningEffort: 'low',
        isDefault: false,
        ...overrides,
    };
}

describe('normalizeCodexModels', () => {
    it('keeps picker fields and the advertised effort order', () => {
        expect(normalizeCodexModels([model({})])).toEqual([{
            code: 'gpt-test',
            value: 'GPT Test',
            description: 'Test model',
            thinkingLevels: ['low', 'ultra'],
            defaultThinkingLevel: 'low',
        }]);
    });

    it('drops hidden models and malformed effort defaults', () => {
        expect(normalizeCodexModels([
            model({ id: 'hidden', hidden: true }),
            model({ id: 'invalid', defaultReasoningEffort: 'medium' }),
        ])).toEqual([]);
    });
});
