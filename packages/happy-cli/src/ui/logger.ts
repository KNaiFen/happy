/**
 * Design decisions:
 * - Debug logging is file-only so interactive agent output stays intact.
 * - Use info for logs that are useful to the user - this is our UI
 * - File output location: ~/.handy/logs/<date time in local timezone>.log
 */

import chalk from 'chalk'
import { inspect } from 'node:util'
import { configuration } from '@/configuration'
import { appendFileSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
// Note: readDaemonState is imported lazily inside listDaemonLogFiles() to avoid
// circular dependency: logger.ts ↔ persistence.ts

/**
 * Consistent date/time formatting functions
 */
function createTimestampForFilename(date: Date = new Date()): string {
  return date.toLocaleString('sv-SE', { 
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit', 
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(/[: ]/g, '-').replace(/,/g, '') + '-pid-' + process.pid
}

function createTimestampForLogEntry(date: Date = new Date()): string {
  return date.toLocaleTimeString('en-US', { 
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  })
}

function getSessionLogPath(): string {
  const timestamp = createTimestampForFilename()
  const filename = configuration.isDaemonProcess ? `${timestamp}-daemon.log` : `${timestamp}.log`
  return join(configuration.logsDir, filename)
}

const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024
const LOG_DIRECTORY_TARGET_BYTES = 100 * 1024 * 1024
const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const LOG_CLEANUP_INTERVAL_BYTES = 1024 * 1024
const HAPPY_LOG_FILENAME = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-pid-(\d+)(?:-daemon)?\.log$/

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function pruneLogDirectory(logsDir: string, protectedPath: string): void {
  const cutoff = Date.now() - LOG_RETENTION_MS
  const files = readdirSync(logsDir)
    .flatMap(file => {
      const match = HAPPY_LOG_FILENAME.exec(file)
      if (!match) return []
      const path = join(logsDir, file)
      const stats = statSync(path, { throwIfNoEntry: false })
      return stats ? [{ path, modified: stats.mtimeMs, size: stats.size, pid: Number(match[1]) }] : []
    })
    .sort((left, right) => left.modified - right.modified)

  let totalBytes = files.reduce((total, file) => total + file.size, 0)
  const currentSize = files.find(file => file.path === protectedPath)?.size ?? 0
  const targetBytes = LOG_DIRECTORY_TARGET_BYTES - Math.max(0, MAX_LOG_FILE_BYTES - currentSize)

  for (const file of files) {
    if (file.path === protectedPath || isProcessAlive(file.pid)) continue
    if (file.modified >= cutoff && totalBytes <= targetBytes) break
    rmSync(file.path, { force: true })
    totalBytes -= file.size
  }
}

export class Logger {
  private dangerouslyUnencryptedServerLoggingUrl: string | undefined
  private currentFileBytes: number | undefined
  private bytesSinceCleanup = LOG_CLEANUP_INTERVAL_BYTES

  constructor(
    public readonly logFilePath = getSessionLogPath()
  ) {
    // Remote logging enabled only when explicitly set with server URL
    if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING 
      && process.env.HAPPY_SERVER_URL) {
      this.dangerouslyUnencryptedServerLoggingUrl = process.env.HAPPY_SERVER_URL
      console.log(chalk.yellow('[REMOTE LOGGING] Sending logs to server for AI debugging'))
    }
  }

  // Use local timezone for simplicity of locating the logs,
  // in practice you will not need absolute timestamps
  localTimezoneTimestamp(): string {
    return createTimestampForLogEntry()
  }

  debug(message: string, ...args: unknown[]): void {
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, ...args)

    // NOTE: @kirill does not think its a good ideas,
    // as it can break interactive agent output.
    // Instead simply open the debug file in a new editor window.
    //
    // Also log to console in development mode
    // if (process.env.DEBUG) {
    //   this.logToConsole('debug', '', message, ...args)
    // }
  }

  debugLargeJson(
    message: string,
    object: unknown,
    maxStringLength: number = 100,
    maxArrayLength: number = 10,
  ): void {
    if (!process.env.DEBUG) {
      this.debug(`In production, skipping message inspection`)
    }

    // Some of our messages are huge, but we still want to show them in the logs
    const truncateStrings = (obj: unknown): unknown => {
      if (typeof obj === 'string') {
        return obj.length > maxStringLength 
          ? obj.substring(0, maxStringLength) + '... [truncated for logs]'
          : obj
      }
      
      if (Array.isArray(obj)) {
        const truncatedArray = obj.map(item => truncateStrings(item)).slice(0, maxArrayLength)
        if (obj.length > maxArrayLength) {
          truncatedArray.push(`... [truncated array for logs up to ${maxArrayLength} items]` as unknown)
        }
        return truncatedArray
      }
      
      if (obj && typeof obj === 'object') {
        const result: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === 'usage') {
            // Drop usage, not generally useful for debugging
            continue
          }
          result[key] = truncateStrings(value)
        }
        return result
      }
      
      return obj
    }

    const truncatedObject = truncateStrings(object)
    const json = JSON.stringify(truncatedObject, null, 2)
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, '\n', json)
  }
  
  info(message: string, ...args: unknown[]): void {
    this.logToConsole('info', '', message, ...args)
    this.debug(message, args)
  }
  
  infoDeveloper(message: string, ...args: unknown[]): void {
    // Always write to debug
    this.debug(message, ...args)
    
    // Write to info if DEBUG mode is on
    if (process.env.DEBUG) {
      this.logToConsole('info', '[DEV]', message, ...args)
    }
  }
  
  warn(message: string, ...args: unknown[]): void {
    this.logToConsole('warn', '', message, ...args)
    this.debug(`[WARN] ${message}`, ...args)
  }
  
  getLogPath(): string {
    return this.logFilePath
  }
  
  private logToConsole(level: 'debug' | 'error' | 'info' | 'warn', prefix: string, message: string, ...args: unknown[]): void {
    switch (level) {
      case 'debug': {
        console.log(chalk.gray(prefix), message, ...args)
        break
      }

      case 'error': {
        console.error(chalk.red(prefix), message, ...args)
        break
      }

      case 'info': {
        console.log(chalk.blue(prefix), message, ...args)
        break
      }

      case 'warn': {
        console.log(chalk.yellow(prefix), message, ...args)
        break
      }

      default: {
        this.debug('Unknown log level:', level)
        console.log(chalk.blue(prefix), message, ...args)
        break
      }
    }
  }

  private async sendToRemoteServer(level: string, message: string, ...args: unknown[]): Promise<void> {
    if (!this.dangerouslyUnencryptedServerLoggingUrl) return
    
    try {
      await fetch(this.dangerouslyUnencryptedServerLoggingUrl + '/logs-combined-from-cli-and-mobile-for-simple-ai-debugging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          message: `${message} ${args.map(a => 
            typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
          ).join(' ')}`,
          source: 'cli',
          platform: process.platform
        })
      })
    } catch (error) {
      // Silently fail to avoid disrupting the session
    }
  }

  private logToFile(prefix: string, message: string, ...args: unknown[]): void {
    const logLine = `${prefix} ${message} ${args.map(arg =>
      typeof arg === 'string' ? arg : inspect(arg, { depth: 5, breakLength: 120 })
    ).join(' ')}\n`
    
    // Send to remote server if configured
    if (this.dangerouslyUnencryptedServerLoggingUrl) {
      // Determine log level from prefix
      let level = 'info'
      if (prefix.includes(this.localTimezoneTimestamp())) {
        level = 'debug'
      }
      // Fire and forget, with explicit .catch to prevent unhandled rejection
      this.sendToRemoteServer(level, message, ...args).catch(() => {
        // Silently ignore remote logging errors to prevent loops
      })
    }
    
    try {
      if (this.currentFileBytes === undefined) {
        this.currentFileBytes = existsSync(this.logFilePath) ? statSync(this.logFilePath).size : 0
      }
      if (this.bytesSinceCleanup >= LOG_CLEANUP_INTERVAL_BYTES) {
        pruneLogDirectory(dirname(this.logFilePath), this.logFilePath)
        this.bytesSinceCleanup = 0
      }

      const logLineBytes = Buffer.byteLength(logLine)
      if (this.currentFileBytes + logLineBytes > MAX_LOG_FILE_BYTES) {
        const rolloverNotice = `[${this.localTimezoneTimestamp()}] [LOGGER] Previous entries discarded after reaching the 10 MiB file limit.\n`
        const truncatedNotice = '\n[LOGGER] Entry truncated at the 10 MiB file limit.\n'
        const rolloverBytes = Buffer.byteLength(rolloverNotice)
        const truncatedNoticeBytes = Buffer.byteLength(truncatedNotice)
        const availableEntryBytes = MAX_LOG_FILE_BYTES - rolloverBytes
        const nextContent = logLineBytes <= availableEntryBytes
          ? rolloverNotice + logLine
          : rolloverNotice
            + Buffer.from(logLine).subarray(0, availableEntryBytes - truncatedNoticeBytes - 3).toString('utf8')
            + truncatedNotice
        writeFileSync(this.logFilePath, nextContent)
        this.currentFileBytes = Buffer.byteLength(nextContent)
      } else {
        appendFileSync(this.logFilePath, logLine)
        this.currentFileBytes += logLineBytes
      }
      this.bytesSinceCleanup += logLineBytes
    } catch (appendError) {
      if (process.env.DEBUG) {
        console.error('[DEV MODE ONLY THROWING] Failed to append to log file:', appendError)
        throw appendError
      }
      // In production, fail silently to avoid disturbing an active session.
    }
  }
}

// Will be initialized immideately on startup
export let logger = new Logger()

/**
 * Information about a log file on disk
 */
export type LogFileInfo = {
  file: string;
  path: string;
  modified: Date;
};

/**
 * List daemon log files in descending modification time order.
 * Returns up to `limit` entries; empty array if none.
 */
export async function listDaemonLogFiles(limit: number = 50): Promise<LogFileInfo[]> {
  try {
    const logsDir = configuration.logsDir;
    if (!existsSync(logsDir)) {
      return [];
    }

    const logs = readdirSync(logsDir)
      .filter(file => file.endsWith('-daemon.log'))
      .map(file => {
        const fullPath = join(logsDir, file);
        const stats = statSync(fullPath);
        return { file, path: fullPath, modified: stats.mtime } as LogFileInfo;
      })
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());

    // Prefer the path persisted by the daemon if present (return 0th element if present)
    try {
      // Lazy import to avoid circular dependency: logger.ts ↔ persistence.ts
      const { readDaemonState } = await import('@/persistence');
      const state = await readDaemonState();

      if (!state) {
        return logs;
      }

      if (state.daemonLogPath && existsSync(state.daemonLogPath)) {
        const stats = statSync(state.daemonLogPath);
        const persisted: LogFileInfo = {
          file: basename(state.daemonLogPath),
          path: state.daemonLogPath,
          modified: stats.mtime
        };
        const idx = logs.findIndex(l => l.path === persisted.path);
        if (idx >= 0) {
          const [found] = logs.splice(idx, 1);
          logs.unshift(found);
        } else {
          logs.unshift(persisted);
        }
      }
    } catch {
      // Ignore errors reading daemon state; fall back to directory listing
    }

    return logs.slice(0, Math.max(0, limit));
  } catch {
    return [];
  }
}

/**
 * Get the most recent daemon log file, or null if none exist.
 */
export async function getLatestDaemonLog(): Promise<LogFileInfo | null> {
  const [latest] = await listDaemonLogFiles(1);
  return latest || null;
}
