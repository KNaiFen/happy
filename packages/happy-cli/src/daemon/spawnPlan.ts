import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

export type DaemonSpawnAgent = 'codex';

export type DaemonSpawnPlan = {
    agent: DaemonSpawnAgent;
    args: string[];
};

function resolveDaemonSpawnAgent(agent: SpawnSessionOptions['agent']): DaemonSpawnAgent {
    if (agent === undefined || agent === 'codex') return 'codex';
    throw new Error(`Unsupported agent type: '${String(agent)}'. Happy only supports Codex Sync V4.`);
}

export function buildDaemonSpawnPlan(options: SpawnSessionOptions): DaemonSpawnPlan {
    const agent = resolveDaemonSpawnAgent(options.agent);
    // Codex is bootstrapped by the headless Gateway manager in daemon/run.
    return { agent, args: [] };
}
