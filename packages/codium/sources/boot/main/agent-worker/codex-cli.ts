import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, type PathLike } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const nodeRequire = createRequire(import.meta.url)
const STDERR_LIMIT_BYTES = 64 * 1024

export interface CodexExecArgsInput {
    prompt: string
    outputPath: string
    cwd?: string
    model?: string
    effort?: 'low' | 'medium' | 'high' | 'max'
}

export function buildCodexExecArgs(input: CodexExecArgsInput): string[] {
    return [
        'exec',
        '--json',
        '--color',
        'never',
        '-c',
        'approval_policy="never"',
        ...(input.effort ? ['-c', `model_reasoning_effort="${input.effort}"`] : []),
        '--sandbox',
        'workspace-write',
        '--output-last-message',
        input.outputPath,
        ...(input.cwd ? ['--cd', input.cwd] : []),
        ...(input.model ? ['--model', input.model] : []),
        '--',
        input.prompt,
    ]
}

export interface CodexExecutable {
    executable: string
    extraPathDirs: string[]
}

export interface CodexExecutableOptions {
    platform?: NodeJS.Platform
    arch?: string
    resolvePackageJson?: (specifier: string) => string
}

export function resolveCodexExecutable(options: CodexExecutableOptions = {}): CodexExecutable {
    const platform = options.platform ?? process.platform
    const arch = options.arch ?? process.arch
    if (platform !== 'darwin') {
        throw new Error('Bundled Codex binary is currently configured for macOS only.')
    }
    if (arch !== 'arm64' && arch !== 'x64') {
        throw new Error(`Bundled Codex binary does not support architecture ${arch}.`)
    }

    const targetTriple = arch === 'arm64'
        ? 'aarch64-apple-darwin'
        : 'x86_64-apple-darwin'
    const pkg = arch === 'arm64'
        ? '@openai/codex-darwin-arm64'
        : '@openai/codex-darwin-x64'
    const resolvePackageJson = options.resolvePackageJson
        ?? ((specifier: string) => nodeRequire.resolve(specifier))
    const vendorRoot = join(dirname(resolvePackageJson(`${pkg}/package.json`)), 'vendor', targetTriple)
    return {
        executable: join(vendorRoot, 'codex', 'codex'),
        extraPathDirs: [join(vendorRoot, 'path')],
    }
}

export interface CodexTurnObserver {
    onAssistantComplete(text: string): void
    onTurnDone(result: { subtype: 'success' | 'error'; error?: string }): void
    onError(message: string): void
}

export interface CodexTurnHandle {
    stop(): void
    completed: Promise<void>
    executable: string
    args: string[]
    outputPath: string
}

type SpawnCodex = (
    executable: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams

export interface CodexRuntimeDependencies {
    createTempDirectory(prefix: string): Promise<string>
    readText(path: PathLike): Promise<string>
    removeDirectory(path: PathLike): Promise<void>
    pathExists(path: PathLike): boolean
    spawn: SpawnCodex
    temporaryRoot(): string
    env: NodeJS.ProcessEnv
    platform: NodeJS.Platform
    arch: string
    resolvePackageJson(specifier: string): string
}

const defaultDependencies: CodexRuntimeDependencies = {
    createTempDirectory: mkdtemp,
    readText: (path) => readFile(path, 'utf8'),
    removeDirectory: (path) => rm(path, { recursive: true, force: true }),
    pathExists: existsSync,
    spawn: nodeSpawn,
    temporaryRoot: tmpdir,
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    resolvePackageJson: (specifier) => nodeRequire.resolve(specifier),
}

export async function launchCodexTurn(
    input: Omit<CodexExecArgsInput, 'outputPath'>,
    observer: CodexTurnObserver,
    dependencyOverrides: Partial<CodexRuntimeDependencies> = {},
): Promise<CodexTurnHandle> {
    const dependencies = { ...defaultDependencies, ...dependencyOverrides }
    const tempDirectory = await dependencies.createTempDirectory(
        join(dependencies.temporaryRoot(), 'codium-codex-'),
    )
    const outputPath = join(tempDirectory, 'last-message.txt')

    try {
        const { executable, extraPathDirs } = resolveCodexExecutable({
            platform: dependencies.platform,
            arch: dependencies.arch,
            resolvePackageJson: dependencies.resolvePackageJson,
        })
        const args = buildCodexExecArgs({ ...input, outputPath })
        const child = dependencies.spawn(executable, args, {
            ...(input.cwd ? { cwd: input.cwd } : {}),
            env: {
                ...dependencies.env,
                PATH: prependExistingPath(
                    extraPathDirs,
                    dependencies.env.PATH,
                    dependencies.platform,
                    dependencies.pathExists,
                ),
            },
        })

        let stderr = ''
        let spawnError: string | null = null
        child.stdout.on('data', () => {
            // Always drain JSON output so the child cannot block on a full pipe.
        })
        child.stderr.on('data', (chunk) => {
            stderr = appendBounded(stderr, String(chunk), STDERR_LIMIT_BYTES)
        })

        const completed = new Promise<void>((resolve) => {
            let finalized = false
            const complete = (code: number | null, signal: NodeJS.Signals | null): void => {
                if (finalized) return
                finalized = true
                void finalizeCodexTurn({
                    code,
                    signal,
                    stderr,
                    spawnError,
                    outputPath,
                    tempDirectory,
                    observer,
                    dependencies,
                }).finally(resolve)
            }
            child.once('error', (error) => {
                spawnError = errorMessage(error)
                observer.onError(spawnError)
                complete(null, null)
            })
            child.once('close', (code, signal) => {
                complete(code, signal)
            })
        })

        return {
            executable,
            args,
            outputPath,
            completed,
            stop() {
                try {
                    child.kill('SIGINT')
                } catch {
                    // Process may already have closed.
                }
            },
        }
    } catch (error) {
        await dependencies.removeDirectory(tempDirectory).catch(() => {})
        throw error
    }
}

async function finalizeCodexTurn(options: {
    code: number | null
    signal: NodeJS.Signals | null
    stderr: string
    spawnError: string | null
    outputPath: string
    tempDirectory: string
    observer: CodexTurnObserver
    dependencies: CodexRuntimeDependencies
}): Promise<void> {
    let finalizationError: string | null = null
    try {
        if (options.dependencies.pathExists(options.outputPath)) {
            const text = await options.dependencies.readText(options.outputPath)
            if (text.trim().length > 0) {
                options.observer.onAssistantComplete(text)
            }
        }
    } catch (error) {
        finalizationError = errorMessage(error)
        options.observer.onError(finalizationError)
    }

    const succeeded = options.code === 0 && !options.spawnError && !finalizationError
    if (succeeded) {
        options.observer.onTurnDone({ subtype: 'success' })
    } else {
        options.observer.onTurnDone({
            subtype: 'error',
            error: options.stderr.trim()
                || options.spawnError
                || finalizationError
                || (options.signal
                    ? `Codex exited via ${options.signal}`
                    : `Codex exited with code ${options.code}`),
        })
    }

    await options.dependencies.removeDirectory(options.tempDirectory).catch(() => {})
}

function prependExistingPath(
    dirs: string[],
    currentPath: string | undefined,
    platform: NodeJS.Platform,
    pathExists: (path: PathLike) => boolean,
): string {
    const separator = platform === 'win32' ? ';' : ':'
    return [
        ...dirs.filter((dir) => pathExists(dir)),
        ...(currentPath ?? '').split(separator).filter(Boolean),
    ].join(separator)
}

function appendBounded(current: string, next: string, limit: number): string {
    const combined = current + next
    return combined.length <= limit ? combined : combined.slice(-limit)
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
