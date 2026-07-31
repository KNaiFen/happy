import { describe, expect, it } from 'vitest';
import { resolveNewSessionAgentConfig } from './newSessionConfig';

const base = {
    defaults: { permissionMode: 'yolo', modelMode: 'gpt-5.6-sol', effortLevel: 'max' },
    overrides: {},
    permissionOptions: [{ key: 'default' }, { key: 'yolo' }],
    modelOptions: [{ key: 'default' }, { key: 'gpt-5.6-sol' }],
    effortOptionsForModel: () => [{ key: 'low' }, { key: 'medium' }, { key: 'max' }],
} as const;

describe('resolveNewSessionAgentConfig', () => {
    it('keeps the configured max effort while capabilities are unknown', () => {
        expect(resolveNewSessionAgentConfig({ ...base, capabilityState: 'unknown' })).toEqual({
            permissionMode: 'yolo',
            modelMode: 'gpt-5.6-sol',
            effortLevel: 'max',
        });
    });

    it('keeps an unknown configured key until authoritative capability arrives', () => {
        expect(resolveNewSessionAgentConfig({
            ...base,
            defaults: { ...base.defaults, effortLevel: 'ultra' },
            capabilityState: 'unknown',
        }).effortLevel).toBe('ultra');
    });

    it('uses model default then Agent default when authoritative values are unsupported', () => {
        expect(resolveNewSessionAgentConfig({
            ...base,
            overrides: { modelMode: 'removed-model', effortLevel: 'ultra' },
            modelOptions: [
                { key: 'gpt-5.6-sol', isDefault: true, defaultThinkingLevel: 'medium' },
            ],
            capabilityState: 'authoritative',
        })).toEqual({
            permissionMode: 'yolo',
            modelMode: 'gpt-5.6-sol',
            effortLevel: 'medium',
        });
    });

    it('applies explicit per-session overrides without changing defaults', () => {
        expect(resolveNewSessionAgentConfig({
            ...base,
            overrides: { permissionMode: 'default', effortLevel: 'low' },
            capabilityState: 'authoritative',
        })).toMatchObject({ permissionMode: 'default', effortLevel: 'low' });
    });
});
