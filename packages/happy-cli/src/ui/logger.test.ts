import { mkdtempSync, readdirSync, readFileSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Logger } from './logger'

const roots: string[] = []

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happy-logger-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Logger disk bounds', () => {
  it('restarts a log file when it reaches 10 MiB', () => {
    const root = createRoot()
    const path = join(root, '2026-09-13-10-00-00-pid-1.log')
    writeFileSync(path, '')
    truncateSync(path, 10 * 1024 * 1024)

    new Logger(path).debug('newest entry')

    const content = readFileSync(path, 'utf8')
    expect(content).toContain('Previous entries discarded after reaching the 10 MiB file limit.')
    expect(content).toContain('newest entry')
    expect(statSync(path).size).toBeLessThan(1024)
  })

  it('removes expired and excess Happy logs before writing', () => {
    const root = createRoot()
    const oldPath = join(root, '2026-08-01-10-00-00-pid-999999999.log')
    writeFileSync(oldPath, 'old')
    utimesSync(oldPath, new Date(0), new Date(0))
    const activePath = join(root, `2026-08-01-10-00-01-pid-${process.pid}.log`)
    writeFileSync(activePath, 'active')
    utimesSync(activePath, new Date(0), new Date(0))

    for (let index = 0; index < 11; index += 1) {
      const path = join(root, `2026-09-13-10-00-${String(index).padStart(2, '0')}-pid-${999999900 + index}.log`)
      writeFileSync(path, '')
      truncateSync(path, 10 * 1024 * 1024)
      const modified = new Date(Date.now() - (11 - index) * 1000)
      utimesSync(path, modified, modified)
    }
    writeFileSync(join(root, 'unmanaged.log'), 'keep')

    const currentPath = join(root, '2026-09-13-11-00-00-pid-99.log')
    new Logger(currentPath).debug('current')

    const files = readdirSync(root)
    const totalBytes = files
      .filter(file => /^\d{4}-.+-pid-\d+(?:-daemon)?\.log$/.test(file))
      .reduce((total, file) => total + statSync(join(root, file)).size, 0)
    expect(files).not.toContain('2026-08-01-10-00-00-pid-999999999.log')
    expect(files).toContain(`2026-08-01-10-00-01-pid-${process.pid}.log`)
    expect(files).toContain('unmanaged.log')
    expect(totalBytes).toBeLessThanOrEqual(100 * 1024 * 1024 + Buffer.byteLength('active'))
  })

  it('retains a bounded prefix of an oversized entry', () => {
    const root = createRoot()
    const path = join(root, '2026-09-13-12-00-00-pid-1.log')

    new Logger(path).debug(`oversized ${'x'.repeat(10 * 1024 * 1024)}`)

    const content = readFileSync(path, 'utf8')
    expect(content).toContain('oversized')
    expect(content).toContain('Entry truncated at the 10 MiB file limit.')
    expect(statSync(path).size).toBeLessThanOrEqual(10 * 1024 * 1024)
  })
})
