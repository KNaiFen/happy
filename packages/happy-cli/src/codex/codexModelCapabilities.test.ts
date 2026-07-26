import { describe, expect, it, vi } from 'vitest';
import type { Model } from './codexAppServerTypes';
import {
    loadCodexModelCapabilities,
    mergeCodexAgentCapabilities,
    mergeCodexSessionModels,
    normalizeCodexModels,
} from './codexModelCapabilities';

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

    it('returns no catalog when app-server discovery fails', async () => {
        const client = {
            listModels: vi.fn().mockRejectedValue(new Error('unsupported')),
        };

        await expect(loadCodexModelCapabilities(client)).resolves.toBeNull();
    });

    it('merges machine and session catalogs without clearing existing metadata', () => {
        const models = normalizeCodexModels([model({})]);
        const capabilities = {
            codexCliVersion: 'codex-cli 0.145.0',
            detectedAt: 123,
            models,
        };
        const machineMetadata = {
            host: 'host',
            platform: 'darwin',
            happyCliVersion: '1.0.0',
            homeDir: '/home',
            happyHomeDir: '/home/.happy',
            happyLibDir: '/happy',
            displayName: 'Work Mac',
        };
        const sessionMetadata = {
            path: '/repo',
            host: 'host',
            homeDir: '/home',
            happyHomeDir: '/home/.happy',
            happyLibDir: '/happy',
            happyToolsDir: '/happy/tools',
            summary: { text: 'keep me', updatedAt: 1 },
        };

        expect(mergeCodexAgentCapabilities(machineMetadata, capabilities)).toMatchObject({
            displayName: 'Work Mac',
            agentCapabilities: { codex: capabilities },
        });
        expect(mergeCodexSessionModels(sessionMetadata, models)).toMatchObject({
            summary: sessionMetadata.summary,
            models,
        });
        expect(mergeCodexSessionModels(sessionMetadata, null)).toBe(sessionMetadata);
    });
});
