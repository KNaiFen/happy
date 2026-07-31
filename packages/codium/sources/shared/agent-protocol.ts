/* Wire protocol between renderer, main process, and the Codex worker. */

export type AgentEffort = 'low' | 'medium' | 'high' | 'max'
export type AgentEngine = 'codex'

export interface AgentStartOptions {
    /** Built-in runtime. The only supported runtime is bundled Codex CLI. */
    engine?: AgentEngine
    /** Optional runtime model id or alias. */
    model?: string
    /** Optional reasoning effort. */
    effort?: AgentEffort
    /** Optional working directory for the Codex process. */
    cwd?: string
}

/* ─────────── Renderer → worker (via main) ─────────── */

export type ToWorker =
    /** Begin a one-shot Codex turn. */
    | {
        kind: 'start'
        sessionId: string
        prompt: string
        options: AgentStartOptions
      }
    /** Rejected while a one-shot turn is active; retained for clear IPC errors. */
    | { kind: 'send'; sessionId: string; text: string }
    /** Interrupt the current Codex process. */
    | { kind: 'interrupt'; sessionId: string }
    /** Stop the current Codex process. */
    | { kind: 'stop'; sessionId: string }

/* ─────────── Worker → renderer (via main) ─────────── */

/** Normalized event contract kept independent from the Codex process format. */
export type AgentEvent =
    | { type: 'session_init'; sessionId: string; model?: string }
    /** A new assistant message is about to start. Lets the renderer split
     *  multi-step turns (text → tool → text) into discrete chat rows. */
    | { type: 'assistant_turn_started' }
    /** Token-level deltas during streaming. */
    | { type: 'text_delta'; index: number; delta: string }
    | { type: 'thinking_delta'; index: number; delta: string }
    /** Tool-use block start — id/name known, input still streaming. */
    | { type: 'tool_use_start'; id: string; name: string }
    /** Tool-use input arguments arriving as JSON deltas. */
    | { type: 'tool_use_input_delta'; toolId: string; delta: string }
    /** Authoritative snapshot of a completed assistant message. */
    | {
        type: 'assistant_complete'
        text: string
        thinking?: string
        toolUses: { id: string; name: string; input: Record<string, unknown> }[]
      }
    | { type: 'tool_result'; toolUseId: string; output: string; isError?: boolean }
    | {
        type: 'turn_done'
        subtype: 'success' | 'error'
        result?: string
        costUsd?: number
        error?: string
      }
    | { type: 'error'; message: string }

export type FromWorker =
    | { kind: 'event'; sessionId: string; event: AgentEvent }
    /** The one-shot Codex process and its temporary state have been cleaned up. */
    | { kind: 'closed'; sessionId: string }
    /** Worker-level fatal (e.g. uncaught exception). Not session-scoped. */
    | { kind: 'fatal'; error: string }
