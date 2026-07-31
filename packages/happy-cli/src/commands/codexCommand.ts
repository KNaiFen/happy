import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { runCodex } from '@/codex/runCodex'
import { extractCodexResumeFlag } from '@/codex/cliArgs'
import { extractNoSandboxFlag } from '@/utils/sandboxFlags'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'
import type { PermissionMode } from '@/api/types'
import type { ReasoningEffort } from '@/codex/protocol'
import { configuration } from '@/configuration'

const CODEX_PERMISSION_MODES = new Set<PermissionMode>(['default', 'read-only', 'safe-yolo', 'yolo'])
const REMOVED_CLAUDE_FLAGS = new Set([
  '--chrome',
  '--no-chrome',
  '--claude-env',
  '--js-runtime',
  '--settings',
])

export type ParsedCodexCommand = {
  showHelp: boolean
  showVersion: boolean
  startedBy: 'daemon' | 'terminal' | undefined
  permissionMode: PermissionMode | undefined
  model: string | undefined
  effort: ReasoningEffort | undefined
  noSandbox: boolean
  resumeThreadId: string | undefined
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} requires a value.`)
  }
  return value
}

export function parseCodexCommandArgs(args: string[]): ParsedCodexCommand {
  let startedBy: 'daemon' | 'terminal' | undefined
  let permissionMode: PermissionMode | undefined
  let model: string | undefined
  let effort: ReasoningEffort | undefined
  let showHelp = false
  let showVersion = false
  const sandboxArgs = extractNoSandboxFlag(args)
  const codexArgs = extractCodexResumeFlag(sandboxArgs.args)

  for (let i = 0; i < codexArgs.args.length; i += 1) {
    const arg = codexArgs.args[i]
    if (arg === '--started-by') {
      const value = requiredValue(codexArgs.args, i, arg)
      if (value !== 'daemon' && value !== 'terminal') {
        throw new Error('--started-by must be daemon or terminal.')
      }
      startedBy = value
      i += 1
    } else if (arg === '--happy-starting-mode') {
      const value = requiredValue(codexArgs.args, i, arg)
      if (value !== 'local' && value !== 'remote') {
        throw new Error('--happy-starting-mode must be local or remote.')
      }
      i += 1
    } else if (arg === '--permission-mode') {
      const value = requiredValue(codexArgs.args, i, arg) as PermissionMode
      if (!CODEX_PERMISSION_MODES.has(value)) {
        throw new Error(`Unsupported Codex permission mode: ${value}`)
      }
      permissionMode = value
      i += 1
    } else if (arg === '--model') {
      model = requiredValue(codexArgs.args, i, arg)
      i += 1
    } else if (arg === '--effort') {
      effort = requiredValue(codexArgs.args, i, arg)
      i += 1
    } else if (arg === '--yolo') {
      permissionMode = 'yolo'
    } else if (arg === '--help' || arg === '-h') {
      showHelp = true
    } else if (arg === '--version' || arg === '-v') {
      showVersion = true
    } else if (REMOVED_CLAUDE_FLAGS.has(arg)) {
      throw new Error(`${arg} was a Claude-only option and is no longer supported.`)
    } else {
      throw new Error(`Unknown Codex option: ${arg}`)
    }
  }

  return {
    showHelp,
    showVersion,
    startedBy,
    permissionMode,
    model,
    effort,
    noSandbox: sandboxArgs.noSandbox,
    resumeThreadId: codexArgs.resumeThreadId ?? undefined,
  }
}

function printCodexHelp(): void {
  console.log(`
happy - Codex remote control

Usage:
  happy [options]         Start Codex
  happy codex [options]   Explicit Codex alias

Options:
  --resume, -r <thread>   Resume a Codex thread
  --model <model>         Select the Codex model
  --effort <level>        Select reasoning effort
  --permission-mode <mode>
                          default, read-only, safe-yolo, or yolo
  --yolo                  Shortcut for --permission-mode yolo
  --no-sandbox            Disable the Happy sandbox
  --help, -h              Show this help
  --version, -v           Show the Happy CLI version
`)
}

export async function handleCodexCommand(args: string[]): Promise<void> {
  const parsed = parseCodexCommandArgs(args)
  if (parsed.showHelp) {
    printCodexHelp()
    return
  }
  if (parsed.showVersion) {
    console.log(`happy version: ${configuration.currentCliVersion}`)
    return
  }

  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()

  await runCodex({
    credentials,
    startedBy: parsed.startedBy,
    noSandbox: parsed.noSandbox,
    resumeThreadId: parsed.resumeThreadId,
    permissionMode: parsed.permissionMode,
    model: parsed.model,
    effort: parsed.effort,
  })
}
