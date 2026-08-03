import { describe, expect, it } from 'vitest';
import { buildDaemonSpawnPlan } from './spawnPlan';

describe('buildDaemonSpawnPlan', () => {
    it('routes an omitted agent to the headless Codex Gateway without legacy argv', () => {
        expect(buildDaemonSpawnPlan({ directory: '/workspace' })).toEqual({
            agent: 'codex',
            args: [],
        });
    });

    it('never encodes Codex settings into the removed daemon child command', () => {
        expect(buildDaemonSpawnPlan({
            directory: '/workspace',
            agent: 'codex',
            permissionMode: 'read-only',
            modelMode: 'gpt-5.6-sol',
            effortLevel: 'max',
            resumeCodexThreadId: 'thread-1',
        }).args).toEqual([]);
    });

    it('rejects every non-Codex value instead of falling back', () => {
        expect(() => buildDaemonSpawnPlan({ directory: '/workspace', agent: 'gemini' as never }))
            .toThrow("Unsupported agent type: 'gemini'");
        expect(() => buildDaemonSpawnPlan({ directory: '/workspace', agent: 'claude' as never }))
            .toThrow("Unsupported agent type: 'claude'");
        expect(() => buildDaemonSpawnPlan({
            directory: '/workspace',
            agent: 'unknown' as never,
        })).toThrow("Unsupported agent type: 'unknown'");
    });
});
