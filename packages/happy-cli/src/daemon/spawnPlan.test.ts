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

    it('does not pass Codex modes to another retained agent', () => {
        expect(buildDaemonSpawnPlan({
            directory: '/workspace',
            agent: 'gemini',
            permissionMode: 'yolo',
            modelMode: 'gpt-5.6-sol',
            effortLevel: 'max',
        })).toEqual({
            agent: 'gemini',
            args: ['gemini', '--happy-starting-mode', 'remote', '--started-by', 'daemon'],
        });
    });

    it('rejects removed and unknown values instead of falling back', () => {
        expect(() => buildDaemonSpawnPlan({ directory: '/workspace', agent: 'claude' as never }))
            .toThrow('removed agent is no longer supported');
        expect(() => buildDaemonSpawnPlan({
            directory: '/workspace',
            agent: 'unknown' as never,
        })).toThrow("Unsupported agent type: 'unknown'");
    });
});
