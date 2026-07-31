import { parentPort } from 'node:worker_threads'
import type { AgentEvent, AgentStartOptions, FromWorker, ToWorker } from '../../../shared/agent-protocol'
import { launchCodexTurn, type CodexTurnHandle } from './codex-cli'

if (!parentPort) {
    throw new Error('agent worker must be started via worker_threads')
}

const port = parentPort
const sessions = new Map<string, CodexTurnHandle>()
const send = (message: FromWorker) => port.postMessage(message)

port.on('message', (message: ToWorker) => {
    Promise.resolve(handle(message)).catch((error) => {
        send({ kind: 'fatal', error: errorMessage(error) })
    })
})

async function handle(message: ToWorker): Promise<void> {
    if (message.kind === 'start') {
        await startTurn(message.sessionId, message.prompt, message.options)
        return
    }

    const session = sessions.get(message.sessionId)
    if (!session) {
        if (message.kind === 'send') {
            emit(message.sessionId, {
                type: 'error',
                message: 'send: turn is not active. Start a new Codex turn.',
            })
        }
        return
    }

    if (message.kind === 'send') {
        emit(message.sessionId, {
            type: 'error',
            message: 'Codex CLI turns are one-shot. Start a new turn after the current process closes.',
        })
        return
    }
    session.stop()
}

async function startTurn(
    sessionId: string,
    prompt: string,
    options: AgentStartOptions,
): Promise<void> {
    if (sessions.has(sessionId)) {
        emit(sessionId, {
            type: 'error',
            message: 'start: turn is already active. Interrupt or stop it first.',
        })
        return
    }
    if ((options as { engine?: unknown }).engine !== undefined && options.engine !== 'codex') {
        emit(sessionId, { type: 'error', message: 'Unsupported agent engine.' })
        send({ kind: 'closed', sessionId })
        return
    }

    emit(sessionId, { type: 'assistant_turn_started' })
    try {
        const handle = await launchCodexTurn({
            prompt,
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.effort ? { effort: options.effort } : {}),
        }, {
            onAssistantComplete(text) {
                emit(sessionId, { type: 'assistant_complete', text, toolUses: [] })
            },
            onTurnDone(result) {
                emit(sessionId, { type: 'turn_done', ...result })
            },
            onError(message) {
                emit(sessionId, { type: 'error', message })
            },
        })
        sessions.set(sessionId, handle)
        void handle.completed.finally(() => {
            if (sessions.get(sessionId) === handle) {
                sessions.delete(sessionId)
            }
            send({ kind: 'closed', sessionId })
        })
    } catch (error) {
        emit(sessionId, { type: 'error', message: errorMessage(error) })
        send({ kind: 'closed', sessionId })
    }
}

function emit(sessionId: string, event: AgentEvent): void {
    send({ kind: 'event', sessionId, event })
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

process.on('uncaughtException', (error) => {
    send({ kind: 'fatal', error: errorMessage(error) })
})
