import {
  attachCodexGateway,
  delegateToOfficialCodex,
  launchCodexGatewayTui,
  stopCodexGateway,
} from '@/codex/gateway/codexGatewayLauncher'

const OFFICIAL_DELEGATED_SUBCOMMANDS = new Set([
  'exec',
  'review',
  'login',
  'logout',
  'mcp',
  'plugin',
  'mcp-server',
  'app-server',
  'remote-control',
  'app',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'apply',
  'archive',
  'delete',
  'unarchive',
  'cloud',
  'exec-server',
  'features',
  'help',
])

const REMOVED_HAPPY_OPTIONS = new Set([
  '--resume',
  '-r',
  '--effort',
  '--permission-mode',
  '--yolo',
  '--no-sandbox',
  '--started-by',
  '--happy-starting-mode',
  '--chrome',
  '--no-chrome',
  '--claude-env',
  '--js-runtime',
  '--settings',
])

export type CodexCommandPlan =
  | { kind: 'gateway'; args: string[] }
  | { kind: 'attach'; selector?: string }
  | { kind: 'stop'; selector?: string; force: boolean }
  | { kind: 'delegate'; args: string[] }

export function planCodexCommand(args: string[]): CodexCommandPlan {
  for (const arg of args) {
    if (arg === '--remote' || arg.startsWith('--remote=')) {
      throw new Error('--remote is controlled by Happy Gateway and cannot be supplied manually.')
    }
    if (arg === '--remote-auth-token-env' || arg.startsWith('--remote-auth-token-env=')) {
      throw new Error('--remote-auth-token-env is controlled by Happy Gateway and cannot be supplied manually.')
    }
    if (REMOVED_HAPPY_OPTIONS.has(arg)) {
      throw new Error(`${arg} is an obsolete Happy adapter option; use the equivalent official Codex option or subcommand.`)
    }
  }

  const first = args[0]
  if (first === 'attach') {
    if (args.length > 2) throw new Error('Usage: happy codex attach [gateway-or-thread-id]')
    return { kind: 'attach', ...(args[1] ? { selector: args[1] } : {}) }
  }
  if (first === 'stop') {
    let selector: string | undefined
    let force = false
    for (const arg of args.slice(1)) {
      if (arg === '--force') force = true
      else if (!selector) selector = arg
      else throw new Error('Usage: happy codex stop [gateway-or-thread-id] [--force]')
    }
    return { kind: 'stop', ...(selector ? { selector } : {}), force }
  }
  if (first === '--help' || first === '-h' || first === '--version' || first === '-V') {
    return { kind: 'delegate', args }
  }
  if (first && OFFICIAL_DELEGATED_SUBCOMMANDS.has(first)) {
    return { kind: 'delegate', args }
  }
  return { kind: 'gateway', args }
}

export async function handleCodexCommand(args: string[]): Promise<void> {
  const plan = planCodexCommand(args)
  let exitCode = 0
  switch (plan.kind) {
    case 'gateway':
      exitCode = await launchCodexGatewayTui(plan.args)
      break
    case 'attach':
      exitCode = await attachCodexGateway(plan.selector)
      break
    case 'stop':
      await stopCodexGateway(plan)
      break
    case 'delegate':
      exitCode = await delegateToOfficialCodex(plan.args)
      break
  }
  if (exitCode !== 0) process.exitCode = exitCode
}
