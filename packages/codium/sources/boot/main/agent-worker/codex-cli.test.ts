import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
    buildCodexExecArgs,
    launchCodexTurn,
    resolveCodexExecutable,
    type CodexRuntimeDependencies,
    type CodexTurnObserver,
} from './codex-cli'

function createFakeChild() {
    const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn(() => true)
    return child
}

function createHarness(options: { finalText?: string; pathExists?: boolean } = {}) {
    const child = createFakeChild()
    const removeDirectory = vi.fn(async () => {})
    const readText = vi.fn(async () => options.finalText ?? 'final answer')
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams)
    const observer = {
        onAssistantComplete: vi.fn(),
        onTurnDone: vi.fn(),
        onError: vi.fn(),
    } satisfies CodexTurnObserver
    const dependencies: Partial<CodexRuntimeDependencies> = {
        createTempDirectory: vi.fn(async () => '/tmp/codium-turn'),
        readText,
        removeDirectory,
        pathExists: vi.fn(() => options.pathExists ?? true),
        spawn,
        temporaryRoot: () => '/tmp',
        env: { PATH: '/usr/bin' },
        platform: 'darwin',
        arch: 'arm64',
        resolvePackageJson: (specifier) => `/node_modules/${specifier}`,
    }
    return { child, dependencies, observer, readText, removeDirectory, spawn }
}

describe('buildCodexExecArgs', () => {
    it('keeps prompts behind the option terminator and forwards Codex config', () => {
        expect(buildCodexExecArgs({
            prompt: '--this is prompt text, not an option',
            outputPath: '/tmp/codium-last-message.txt',
            cwd: '/repo/project',
            model: 'gpt-5.6-sol',
            effort: 'max',
        })).toEqual([
            'exec',
            '--json',
            '--color',
            'never',
            '-c',
            'approval_policy="never"',
            '-c',
            'model_reasoning_effort="max"',
            '--sandbox',
            'workspace-write',
            '--output-last-message',
            '/tmp/codium-last-message.txt',
            '--cd',
            '/repo/project',
            '--model',
            'gpt-5.6-sol',
            '--',
            '--this is prompt text, not an option',
        ])
    })
})

describe('resolveCodexExecutable', () => {
    it('resolves both supported macOS package layouts', () => {
        const resolvePackageJson = (specifier: string) => `/packages/${specifier}`
        expect(resolveCodexExecutable({
            platform: 'darwin',
            arch: 'arm64',
            resolvePackageJson,
        }).executable).toBe(
            '/packages/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex',
        )
        expect(resolveCodexExecutable({
            platform: 'darwin',
            arch: 'x64',
            resolvePackageJson,
        }).executable).toBe(
            '/packages/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/codex/codex',
        )
    })

    it('rejects unsupported platforms and architectures', () => {
        expect(() => resolveCodexExecutable({ platform: 'linux', arch: 'x64' })).toThrow('macOS')
        expect(() => resolveCodexExecutable({ platform: 'darwin', arch: 'ia32' })).toThrow('architecture')
    })
})

describe('launchCodexTurn', () => {
    it('drains stdout, reads the final message, and cleans its temporary directory', async () => {
        const harness = createHarness({ finalText: 'completed response' })
        const handle = await launchCodexTurn({
            prompt: 'finish the task',
            cwd: '/repo',
            effort: 'high',
        }, harness.observer, harness.dependencies)

        expect(harness.child.stdout.listenerCount('data')).toBe(1)
        harness.child.stdout.emit('data', Buffer.alloc(128 * 1024))
        harness.child.emit('close', 0, null)
        await handle.completed

        expect(harness.observer.onAssistantComplete).toHaveBeenCalledWith('completed response')
        expect(harness.observer.onTurnDone).toHaveBeenCalledWith({ subtype: 'success' })
        expect(harness.removeDirectory).toHaveBeenCalledWith('/tmp/codium-turn')
        expect(harness.spawn).toHaveBeenCalledWith(
            expect.stringContaining('/codex/codex'),
            expect.arrayContaining(['model_reasoning_effort="high"']),
            expect.objectContaining({
                cwd: '/repo',
                env: expect.objectContaining({ PATH: expect.stringContaining('/vendor/aarch64-apple-darwin/path') }),
            }),
        )
    })

    it('interrupts the child with SIGINT', async () => {
        const harness = createHarness({ pathExists: false })
        const handle = await launchCodexTurn(
            { prompt: 'wait' },
            harness.observer,
            harness.dependencies,
        )

        handle.stop()
        expect(harness.child.kill).toHaveBeenCalledWith('SIGINT')
        harness.child.emit('close', null, 'SIGINT')
        await handle.completed
    })

    it('reports bounded stderr on non-zero exit and still cleans up', async () => {
        const harness = createHarness({ pathExists: false })
        const handle = await launchCodexTurn(
            { prompt: 'fail' },
            harness.observer,
            harness.dependencies,
        )

        harness.child.stderr.emit('data', 'command failed')
        harness.child.emit('close', 2, null)
        await handle.completed

        expect(harness.observer.onTurnDone).toHaveBeenCalledWith({
            subtype: 'error',
            error: 'command failed',
        })
        expect(harness.removeDirectory).toHaveBeenCalledWith('/tmp/codium-turn')
    })

    it('finalizes a process error even when no close event follows', async () => {
        const harness = createHarness({ pathExists: false })
        const handle = await launchCodexTurn(
            { prompt: 'fail after spawn' },
            harness.observer,
            harness.dependencies,
        )

        harness.child.emit('error', new Error('executable unavailable'))
        await handle.completed

        expect(harness.observer.onError).toHaveBeenCalledWith('executable unavailable')
        expect(harness.observer.onTurnDone).toHaveBeenCalledWith({
            subtype: 'error',
            error: 'executable unavailable',
        })
        expect(harness.removeDirectory).toHaveBeenCalledWith('/tmp/codium-turn')
    })

    it('cleans up when process creation fails', async () => {
        const harness = createHarness()
        harness.dependencies.spawn = vi.fn(() => {
            throw new Error('spawn failed')
        })

        await expect(launchCodexTurn(
            { prompt: 'fail before start' },
            harness.observer,
            harness.dependencies,
        )).rejects.toThrow('spawn failed')
        expect(harness.removeDirectory).toHaveBeenCalledWith('/tmp/codium-turn')
    })
})
