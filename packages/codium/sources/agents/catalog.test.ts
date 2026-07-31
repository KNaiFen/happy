import { describe, expect, it } from 'vitest'
import { AGENT_MODELS, agentModelById } from './catalog'

describe('Codium agent catalog', () => {
    it('exposes Codex as the only bundled runtime and safe fallback', () => {
        expect(AGENT_MODELS).toHaveLength(1)
        expect(AGENT_MODELS[0]).toMatchObject({
            id: 'codex-default',
            engine: 'codex',
        })
        expect(agentModelById('removed-provider-model')).toBe(AGENT_MODELS[0])
    })
})
