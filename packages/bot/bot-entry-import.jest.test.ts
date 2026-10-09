/**
 * Importing a bot entry script (livecheck, target, demo CLI) must be free of side effects: it
 * must not construct a bot host, create state directories, or leave timers running. Each script
 * runs its `main()` only under `if (require.main === module)`. A script that runs on import
 * would start a real host against the developer's `$HOME/.frank-bots` whenever a test imports it.
 */
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'

const hostConstructed = jest.fn()
jest.mock('@frank/bot-framework', () => {
  const actual = jest.requireActual('@frank/bot-framework')
  class SpiedHost extends actual.FrankBotHost {
    constructor(...args: unknown[]) {
      super(...args)
      hostConstructed(...args)
    }
  }
  return { ...actual, FrankBotHost: SpiedHost }
})

function entryScripts(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) entryScripts(path, found)
    else if (
      entry.name.endsWith('.livecheck.ts') ||
      (dir.endsWith('/targets') && entry.name.endsWith('.ts')) ||
      path.endsWith('demo/directory-trust/cli.ts') ||
      entry.name === 'print-curated-defaults.ts'
    )
      found.push(path)
  }
  return found
}

const scripts = entryScripts(__dirname).sort()

describe('bot entry scripts have no import-time side effects', () => {
  it('finds the entry scripts', () => {
    expect(scripts.length).toBeGreaterThan(10)
  })

  it.each(scripts.map(path => [relative(__dirname, path), path]))(
    '%s',
    async (_name, path) => {
      const sandbox = mkdtempSync(join(tmpdir(), 'bot-entry-import-'))
      const saved = { ...process.env }
      process.env.HOME = sandbox
      for (const key of [
        'BOT_STATE_DIR',
        'BLACKJACK_BOT_STATE_DIR',
        'RAFFLE_BOT_STATE_DIR',
        'QWEN_BOT_STATE_DIR',
        'VENDOR_BOT_STATE_DIR',
        'FAUCET_STATE_DIR',
        'FRANK_DEMO_STATE_DIR',
      ])
        process.env[key] = join(sandbox, 'state')
      hostConstructed.mockClear()
      jest.useFakeTimers()
      try {
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require(path)
        })
        // Let any unguarded async main() reach its first await-ed side effect.
        await Promise.resolve()
        await Promise.resolve()
        expect(hostConstructed).not.toHaveBeenCalled()
        expect(readdirSync(sandbox)).toEqual([])
        expect(jest.getTimerCount()).toBe(0)
      } finally {
        jest.useRealTimers()
        process.env = saved
        rmSync(sandbox, { recursive: true, force: true })
      }
    },
  )
})
