import { createServer } from 'net'

import { resolveDemoConfig } from './demo-config'
import { checkPrerequisites, main } from './demo'

describe('demo launcher', () => {
  let errors: string[]
  beforeEach(() => {
    errors = []
    jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '))
    })
    jest.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  it('prints one clear line per missing setting and exits 1, with no stack trace', async () => {
    const code = await main([], { FRANK_DEMO_ENV_FILE: '/nonexistent/dummy.env', PATH: process.env.PATH })
    expect(code).toBe(1)
    const out = errors.join('\n')
    expect(out).toContain('Frank demo cannot start:')
    expect(out).toMatch(/MONAD_TESTNET_HTTP_RPC_URL is required/)
    expect(out).toMatch(/E2E_DEMO_MAIN_WALLET_JSON is required/)
    expect(out).not.toMatch(/\n\s+at /)
  })

  it('a bad env file is reported by line number without echoing its content', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const dir = mkdtempSync(join(tmpdir(), 'demo-env-'))
    try {
      writeFileSync(join(dir, 'dummy.env'), 'FRANK_NETWORK_TAG=MONT\nthis line has sekret-token-9 in it\n')
      const code = await main([], { FRANK_DEMO_ENV_FILE: join(dir, 'dummy.env') })
      expect(code).toBe(1)
      expect(errors.join('\n')).toContain('line 2 is not KEY=value')
      expect(errors.join('\n')).not.toContain('sekret-token-9')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a busy port and a missing prebuilt relay, each on its own line', async () => {
    const server = createServer()
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const busy = (server.address() as { port: number }).port
    try {
      const config = resolveDemoConfig({
        env: { FRANK_DEMO_RELAY_PORT: String(busy), CASHWEBD_BIN: '/nonexistent/cashwebd-exe' },
        envFile: {},
        fakeChainFlag: true,
        home: '/home/dummy',
        cwd: '/work',
      })
      const problems = await checkPrerequisites(config)
      expect(problems.some(p => p.startsWith('CASHWEBD_BIN does not exist'))).toBe(true)
      expect(problems.some(p => p.includes(`port ${busy} is in use`))).toBe(true)
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  it('without CASHWEBD_BIN it says how to get a relay when cargo is missing', async () => {
    const config = resolveDemoConfig({
      env: {},
      envFile: {},
      fakeChainFlag: true,
      home: '/home/dummy',
      cwd: '/work',
    })
    const savedPath = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      const problems = await checkPrerequisites(config)
      expect(problems.some(p => p.includes('`cargo` was not found') && p.includes('CASHWEBD_BIN'))).toBe(true)
    } finally {
      process.env.PATH = savedPath
    }
  })
})
