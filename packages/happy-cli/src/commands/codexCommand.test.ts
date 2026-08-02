import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(async () => 0),
  attach: vi.fn(async () => 0),
  stop: vi.fn(async () => undefined),
  delegate: vi.fn(async () => 0),
}))

vi.mock('@/codex/gateway/codexGatewayLauncher', () => ({
  launchCodexGatewayTui: mocks.launch,
  attachCodexGateway: mocks.attach,
  stopCodexGateway: mocks.stop,
  delegateToOfficialCodex: mocks.delegate,
}))

import { handleCodexCommand, planCodexCommand } from './codexCommand'

describe('Codex command routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
  })

  it('passes a prompt and native TUI flags through the Gateway unchanged', async () => {
    const args = ['--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="max"', 'hello']
    expect(planCodexCommand(args)).toEqual({ kind: 'gateway', args })

    await handleCodexCommand(args)

    expect(mocks.launch).toHaveBeenCalledWith(args)
  })

  it.each(['resume', 'fork'])(
    'runs the official %s selector through a new Gateway',
    async (subcommand) => {
      const args = [subcommand, '--all']
      await handleCodexCommand(args)
      expect(mocks.launch).toHaveBeenCalledWith(args)
      expect(mocks.delegate).not.toHaveBeenCalled()
    },
  )

  it.each(['exec', 'review', 'login', 'mcp', 'completion', 'doctor', 'app-server'])(
    'delegates non-interactive or administrative %s directly to official Codex',
    async (subcommand) => {
      const args = [subcommand, '--help']
      await handleCodexCommand(args)
      expect(mocks.delegate).toHaveBeenCalledWith(args)
      expect(mocks.launch).not.toHaveBeenCalled()
    },
  )

  it('delegates official help and version without creating a Gateway', async () => {
    await handleCodexCommand(['--help'])
    await handleCodexCommand(['--version'])
    expect(mocks.delegate).toHaveBeenNthCalledWith(1, ['--help'])
    expect(mocks.delegate).toHaveBeenNthCalledWith(2, ['--version'])
  })

  it('routes attach and stop to Happy Gateway control', async () => {
    await handleCodexCommand(['attach', 'thread-a'])
    await handleCodexCommand(['stop', 'gateway-a', '--force'])
    expect(mocks.attach).toHaveBeenCalledWith('thread-a')
    expect(mocks.stop).toHaveBeenCalledWith({
      kind: 'stop',
      selector: 'gateway-a',
      force: true,
    })
  })

  it.each([
    ['--remote', 'ws://attacker.invalid'],
    ['--remote=ws://attacker.invalid'],
    ['--remote-auth-token-env', 'TOKEN'],
  ])('rejects a user-controlled remote transport before launching: %j', async (...args) => {
    await expect(handleCodexCommand(args)).rejects.toThrow('controlled by Happy Gateway')
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.delegate).not.toHaveBeenCalled()
  })

  it.each(['--resume', '-r', '--effort', '--permission-mode', '--yolo', '--no-sandbox']) (
    'rejects obsolete adapter option %s', async (flag) => {
      await expect(handleCodexCommand([flag])).rejects.toThrow('obsolete Happy adapter option')
      expect(mocks.launch).not.toHaveBeenCalled()
    },
  )

  it('propagates the official TUI exit code without exiting inside the handler', async () => {
    mocks.launch.mockResolvedValueOnce(7)
    await handleCodexCommand([])
    expect(process.exitCode).toBe(7)
  })
})
