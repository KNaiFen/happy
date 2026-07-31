export type AgentEngine = 'codex'

export interface AgentModel {
    id: string
    engine: AgentEngine
    label: string
    group: string
    model?: string
    description?: string
}

export const AGENT_MODELS: AgentModel[] = [
    {
        id: 'codex-default',
        engine: 'codex',
        label: 'Codex',
        group: 'OpenAI',
        description: 'Bundled Codex CLI default model.',
    },
]

export function agentModelById(id: string): AgentModel {
    return AGENT_MODELS.find((model) => model.id === id) ?? AGENT_MODELS[0]
}
