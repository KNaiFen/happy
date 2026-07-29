import { logger } from '@/ui/logger'
import {
  checkIfDaemonRunningAndCleanupStaleState,
  isDaemonRunningForCurrentProfile,
  stopDaemon,
} from './controlClient'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { sanitizeSessionEnvironment } from './sessionEnvironment'
import { configuration } from '@/configuration'

const DAEMON_READY_TIMEOUT_MS = 5000
const DAEMON_READY_POLL_INTERVAL_MS = 100

export async function ensureDaemonRunning(): Promise<void> {
  logger.debug('Ensuring Happy background service is running & matches our version...')

  if (await isDaemonRunningForCurrentProfile()) {
    return
  }

  if (await checkIfDaemonRunningAndCleanupStaleState()) {
    logger.debug('Stopping daemon that belongs to a different CLI or relay profile...')
    await stopDaemon()
  }

  logger.debug('Starting Happy background service...')

  const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
    detached: true,
    stdio: 'ignore',
    env: sanitizeSessionEnvironment(process.env),
  })
  daemonProcess.unref()

  // Wait for the spawned daemon to be fully ready: it must write daemon.state.json,
  // bind its HTTP port, and respond to a health ping. Without this, early callers
  // (e.g. notifyDaemonSessionStarted) race the daemon startup and the webhook is
  // silently lost — which later breaks resume-happy-session.
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isDaemonRunningForCurrentProfile()) {
      logger.debug('Happy background service is ready')
      return
    }
    await new Promise(resolve => setTimeout(resolve, DAEMON_READY_POLL_INTERVAL_MS))
  }

  throw new Error(
    `Happy daemon did not become ready for ${configuration.serverUrl} `
    + `within ${DAEMON_READY_TIMEOUT_MS}ms`,
  )
}
