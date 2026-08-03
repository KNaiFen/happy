import { describe, expect, it } from 'vitest';
import {
    getAvailableModels,
    getAvailableModelsForMachine,
    getAvailablePermissionModes,
    getCodexEffortLevels,
    getDefaultEffortKeyForModel,
    getDefaultModelKey,
    getEffortLevelsForModel,
    getSupportsWorktree,
    resolveCurrentOption,
} from './modelModeOptions';
import type { MachineMetadata, Metadata } from '@/sync/storageTypes';

const translate = (key: string) => key;

describe('Codex model and mode options', () => {
    it('returns no options for unsupported providers', () => {
        expect(getAvailableModels('gemini', null, translate)).toEqual([]);
        expect(getAvailablePermissionModes('openclaw', null, translate)).toEqual([]);
        expect(getEffortLevelsForModel('agy', 'default')).toEqual([]);
    });

    it('uses only Codex defaults', () => {
        expect(getDefaultModelKey('codex')).toBe('gpt-5.5');
        expect(getCodexEffortLevels().map((level) => level.key)).toEqual([
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
        ]);
        expect(getSupportsWorktree('codex')).toBe(true);
        expect(getSupportsWorktree('gemini')).toBe(false);
    });

    it('prefers the Codex model catalog advertised by the session', () => {
        const metadata = {
            models: [{
                code: 'gpt-test',
                value: 'GPT Test',
                description: 'Advertised by Codex',
                thinkingLevels: ['low', 'high'],
                defaultThinkingLevel: 'high',
            }],
        } as Metadata;

        const models = getAvailableModels('codex', metadata, translate);
        expect(models.map((model) => model.key)).toEqual(['default', 'gpt-test']);
        expect(getEffortLevelsForModel('codex', 'gpt-test', metadata).map((level) => level.key)).toEqual([
            'low',
            'high',
        ]);
        expect(getDefaultEffortKeyForModel('codex', 'gpt-test', metadata)).toBe('high');
    });

    it('uses the machine Codex catalog and retains a selected fallback model', () => {
        const advertised = {
            host: 'host',
            platform: 'darwin',
            happyCliVersion: '1.0.0',
            happyHomeDir: '/tmp/happy',
            homeDir: '/tmp',
            agentCapabilities: {
                codex: {
                    codexCliVersion: '0.145.0',
                    detectedAt: 1,
                    models: [{ code: 'gpt-machine', value: 'GPT Machine' }],
                },
            },
        } as MachineMetadata;
        expect(getAvailableModelsForMachine('codex', advertised, translate).map((model) => model.key)).toEqual([
            'default',
            'gpt-machine',
        ]);

        const fallback = getAvailableModelsForMachine('codex', null, translate, 'gpt-custom');
        expect(fallback[0]?.key).toBe('gpt-custom');
    });

    it('resolves the first available preferred option', () => {
        expect(resolveCurrentOption([
            { key: 'first', name: 'First' },
            { key: 'second', name: 'Second' },
        ], ['missing', 'second', 'first'])?.key).toBe('second');
    });
});
