import { describe, expect, it } from 'vitest';
import {
    localSettingsParse,
    migrateAgentDefaultOverridesToLocal,
} from './localSettings';

describe('local agent default persistence', () => {
    it('imports existing synced defaults once', () => {
        const local = localSettingsParse({});
        const migrated = migrateAgentDefaultOverridesToLocal(local, {
            codex: { modelMode: 'gpt-5.6-sol', effortLevel: 'max' },
        });

        expect(migrated.agentDefaultOverrides).toEqual({
            codex: { modelMode: 'gpt-5.6-sol', effortLevel: 'max' },
        });
        expect(migrated.agentDefaultOverridesMigrated).toBe(true);
    });

    it('does not restore stale synced defaults after the local selection is cleared', () => {
        const local = localSettingsParse({
            agentDefaultOverrides: {},
            agentDefaultOverridesMigrated: true,
        });
        const migrated = migrateAgentDefaultOverridesToLocal(local, {
            codex: { effortLevel: 'xhigh' },
        });

        expect(migrated).toBe(local);
        expect(migrated.agentDefaultOverrides).toEqual({});
    });

    it('parses persisted local defaults after a cold app start', () => {
        const parsed = localSettingsParse({
            agentDefaultOverrides: {
                codex: { effortLevel: 'ultra' },
            },
            agentDefaultOverridesMigrated: true,
        });

        expect(parsed.agentDefaultOverrides.codex?.effortLevel).toBe('ultra');
    });
});
