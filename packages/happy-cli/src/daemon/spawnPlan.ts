import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

export type DaemonSpawnAgent = 'codex' | 'gemini' | 'openclaw' | 'agy';

export type DaemonSpawnPlan = {
    agent: DaemonSpawnAgent;
    args: string[];
};

function resolveDaemonSpawnAgent(agent: SpawnSessionOptions['agent']): DaemonSpawnAgent {
    if (agent === undefined || agent === 'codex') return 'codex';
    if (agent === 'gemini' || agent === 'openclaw' || agent === 'agy') return agent;
    if (agent === 'claude') {
        throw new Error('This removed agent is no longer supported. Choose Codex or another supported agent.');
    }
    throw new Error(`Unsupported agent type: '${String(agent)}'. Please update your CLI to the latest version.`);
}

export function buildDaemonSpawnPlan(options: SpawnSessionOptions): DaemonSpawnPlan {
    const agent = resolveDaemonSpawnAgent(options.agent);
    const args = [
        agent,
        '--happy-starting-mode', 'remote',
        '--started-by', 'daemon',
    ];

    if (agent === 'codex') {
        if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
        if (options.modelMode && options.modelMode !== 'default') args.push('--model', options.modelMode);
        if (options.effortLevel) args.push('--effort', options.effortLevel);
        if (options.resumeCodexThreadId) args.push('--resume', options.resumeCodexThreadId);
    }

    return { agent, args };
}
