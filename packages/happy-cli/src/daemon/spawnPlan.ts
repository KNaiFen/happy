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
    if (agent === 'codex') {
        // Codex is bootstrapped by the headless Gateway manager in daemon/run.
        // Keeping this plan empty makes it impossible to regress to the removed
        // `happy codex --started-by daemon` adapter by accident.
        return { agent, args: [] };
    }
    const args = [
        agent,
        '--happy-starting-mode', 'remote',
        '--started-by', 'daemon',
    ];

    return { agent, args };
}
