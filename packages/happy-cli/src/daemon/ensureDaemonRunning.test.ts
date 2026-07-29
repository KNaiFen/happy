import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_SCOPED_ENV_KEYS } from './sessionEnvironment'

const mocks = vi.hoisted(() => ({
  mockLoggerDebug: vi.fn(),
  mockIsDaemonRunningForCurrentProfile: vi.fn(),
  mockCheckIfDaemonRunningAndCleanupStaleState: vi.fn(),
  mockStopDaemon: vi.fn(),
  mockSpawnHappyCLI: vi.fn(),
}))

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}))

vi.mock('./controlClient', () => ({
  isDaemonRunningForCurrentProfile: mocks.mockIsDaemonRunningForCurrentProfile,
  checkIfDaemonRunningAndCleanupStaleState: mocks.mockCheckIfDaemonRunningAndCleanupStaleState,
  stopDaemon: mocks.mockStopDaemon,
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: mocks.mockSpawnHappyCLI,
}))

import { ensureDaemonRunning } from './ensureDaemonRunning'

describe('ensureDaemonRunning', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockCheckIfDaemonRunningAndCleanupStaleState.mockResolvedValue(false)
    mocks.mockStopDaemon.mockResolvedValue(undefined)
    mocks.mockSpawnHappyCLI.mockReturnValue({
      unref: vi.fn(),
    })
  })

  it('returns without spawning when the daemon is already running', async () => {
    mocks.mockIsDaemonRunningForCurrentProfile.mockResolvedValue(true)

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
    expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).not.toHaveBeenCalled()
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith(
      'Ensuring Happy background service is running & matches our version...',
    )
  })

  it('starts the daemon and waits for readiness when the installed version is not running', async () => {
    const mockUnref = vi.fn()
    mocks.mockIsDaemonRunningForCurrentProfile
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    mocks.mockSpawnHappyCLI.mockReturnValue({
      unref: mockUnref,
    })

    for (const key of SESSION_SCOPED_ENV_KEYS) {
      vi.stubEnv(key, `stale-${key}`)
    }
    vi.stubEnv('HAPPY_SAFE_ENV', 'kept')

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHappyCLI).toHaveBeenCalledWith(['daemon', 'start-sync'], expect.objectContaining({
      detached: true,
      stdio: 'ignore',
      env: expect.objectContaining({ HAPPY_SAFE_ENV: 'kept' }),
    }))
    const spawnedEnv = mocks.mockSpawnHappyCLI.mock.calls[0][1].env
    for (const key of SESSION_SCOPED_ENV_KEYS) {
      expect(spawnedEnv).not.toHaveProperty(key)
    }
    expect(mockUnref).toHaveBeenCalled()
    expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).toHaveBeenCalledOnce()
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith('Starting Happy background service...')
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith('Happy background service is ready')
  })

  it('stops a healthy daemon from another relay profile before spawning', async () => {
    mocks.mockIsDaemonRunningForCurrentProfile
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    mocks.mockCheckIfDaemonRunningAndCleanupStaleState.mockResolvedValueOnce(true)

    await ensureDaemonRunning()

    expect(mocks.mockStopDaemon).toHaveBeenCalledOnce()
    expect(mocks.mockSpawnHappyCLI).toHaveBeenCalledOnce()
  })
})
