import { describe, expect, it } from 'vitest';
import { buildDaemonSpawnPlan } from './spawnPlan';

describe('buildDaemonSpawnPlan', () => {
    it('turns an omitted agent into an explicit Codex child command', () => {
        expect(buildDaemonSpawnPlan({ directory: '/workspace' })).toEqual({
            agent: 'codex',
            args: ['codex', '--happy-starting-mode', 'remote', '--started-by', 'daemon'],
        });
    });

    it('passes Codex model, effort, permission, and resume exactly once', () => {
        expect(buildDaemonSpawnPlan({
            directory: '/workspace',
            agent: 'codex',
            permissionMode: 'read-only',
            modelMode: 'gpt-5.6-sol',
            effortLevel: 'max',
            resumeCodexThreadId: 'thread-1',
        }).args).toEqual([
            'codex',
            '--happy-starting-mode', 'remote',
            '--started-by', 'daemon',
            '--permission-mode', 'read-only',
            '--model', 'gpt-5.6-sol',
            '--effort', 'max',
            '--resume', 'thread-1',
        ]);
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
