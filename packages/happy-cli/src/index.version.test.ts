import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import packageJson from '../package.json'

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryHomes: string[] = []

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

describe('standalone version command', () => {
  it.each(['--version', '-v'])(
    'exits before relay-bound credential setup for %s',
    (versionFlag) => {
      const happyHome = mkdtempSync(join(tmpdir(), 'happy-version-'))
      temporaryHomes.push(happyHome)
      writeFileSync(join(happyHome, 'access.key'), JSON.stringify({
        token: 'terminal-token',
        serverOrigin: 'http://relay.example.test:3005',
        secret: Buffer.alloc(32).toString('base64'),
      }))

      const result = spawnSync(
        process.execPath,
        [resolve(cliRoot, 'bin/happy.mjs'), versionFlag],
        {
          cwd: cliRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            HAPPY_HOME_DIR: happyHome,
            HAPPY_SERVER_URL: 'https://api.cluster-fluster.com',
            HAPPY_VARIANT: 'stable',
          },
          timeout: 10_000,
        },
      )

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe(`happy version: ${packageJson.version}`)
      expect(result.stderr).toBe('')
    },
  )
})
