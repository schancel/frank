import { ChildProcess, execFileSync, spawn } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

import { DemoConfig, DemoConfigError, resolveDemoConfig } from './demo-config'
import {
  appCommand,
  DemoAborted,
  DemoHandle,
  printSummary,
  prepareStateDir,
  redact,
  redactLines,
  startDemo,
  walletAddress,
  checkPrerequisites,
} from './demo'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}
async function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}
async function waitFor(fn: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(50)
  }
}

describe('demo lifecycle', () => {
  let dir: string
  let pidFile: string
  let output: string[]
  const print = (l: string) => output.push(l)
  const spawned: ChildProcess[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'demo-life-'))
    pidFile = join(dir, 'relay.pid')
    output = []
  })
  afterEach(() => {
    for (const c of spawned.splice(0)) {
      try {
        if (c.pid) process.kill(-c.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  /** A stand-in cashwebd-exe. `hang`: never serves; `http`: serves 200 on its configured host. */
  function relayStub(kind: 'hang' | 'http' | 'leak' | 'stubborn'): string {
    const path = join(dir, `relay-${kind}.js`)
    writeFileSync(
      path,
      `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
let input = ''
process.stdin.on('data', d => (input += d))
process.stdin.on('end', () => {
  if (${kind === 'leak'}) {
    console.log('rpc=' + process.env.MONAD_TESTNET_HTTP_RPC_URL)
    console.log('token sk-abcdefghijklmnop1234 at https://rpc.example.invalid/v2/CREDPATH?key=abc123')
    process.exit(1)
  }
  if (args[0] === '--check-config') process.exit(0)
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
  fs.writeFileSync(${JSON.stringify(
    pidFile + '.env',
  )}, process.env.MONAD_STAMP_BURN_ADDRESS || 'unset')
  fs.writeFileSync(${JSON.stringify(
    pidFile + '.ws-rpc',
  )}, process.env.MONAD_TESTNET_WS_RPC_URL || 'unset')
  if (${kind === 'stubborn'}) process.on('SIGTERM', () => {})
  if (${kind === 'http'}) {
    const [host, port] = /host = "([^"]+)"/.exec(input)[1].split(':')
    require('http').createServer((q, r) => r.end('[]')).listen(Number(port), host)
  } else {
    setInterval(() => {}, 1000)
  }
})
`,
    )
    chmodSync(path, 0o755)
    return path
  }

  /** A stand-in for the one bot process (`targets/all-bots.ts`): a script the launcher starts in
   * its place. The launcher reads its `[all-bots] ...` lines. */
  function botProcess(body: string): string {
    const script = join(dir, `bots-${Math.random().toString(36).slice(2)}.js`)
    writeFileSync(script, body)
    return script
  }
  const RUNNING = "console.log('[all-bots] running: none'); setInterval(() => {}, 1000)"

  /** A demo configuration with dummy chain settings (the chain is never contacted: balances come
   * from `opts.getBalance`), no identity bots, and a stand-in bot process. */
  async function config(over: Record<string, string> = {}, botScript?: string): Promise<DemoConfig> {
    const wallet = join(dir, 'wallet.json')
    writeFileSync(wallet, JSON.stringify({ address: '0x' + '1a'.repeat(20) }), { mode: 0o600 })
    const c = resolveDemoConfig({
      env: {
        FRANK_DEMO_STATE_DIR: join(dir, 'state'),
        FRANK_DEMO_RELAY_PORT: String(await freePort()),
        MONAD_TESTNET_HTTP_RPC_URL: 'http://127.0.0.1:9',
        E2E_DEMO_MAIN_WALLET_JSON: wallet,
        ...over,
      },
      envFile: {},
      home: dir,
      cwd: dir,
    })
    return {
      ...c,
      bots: [],
      botProcess: { script: botScript ?? botProcess(RUNNING), env: {}, hostStateDir: join(dir, 'state', 'bot-host') },
    }
  }
  const opts = {
    print,
    env: { PATH: process.env.PATH, HOME: dir } as Record<string, string | undefined>,
    pollMs: 50,
    getBalance: async () => 10n ** 21n,
  }

  describe('redact', () => {
    it('scrubs exact secrets, URL paths and queries, key parameters and key-shaped tokens', () => {
      const secret = 'https://rpc.example.invalid/v2/CREDPATH'
      expect(redact(`rpc=${secret}`, [secret])).toBe('rpc=<redacted>')
      expect(redact('GET https://rpc.example.invalid/v2/CREDPATH?x=1 failed', [])).toBe(
        'GET https://rpc.example.invalid/<redacted> failed',
      )
      expect(redact('apikey=abc123&other=1 and key=zzz', [])).toBe(
        'apikey=<redacted>&other=1 and key=zzz',
      )
      expect(redact('bearer sk-abcdefghijklmnop1234 ok', [])).toBe('bearer <redacted> ok')
      expect(redact(`blob ${'A1'.repeat(24)} end`, [])).toBe('blob <redacted> end')
      expect(redact('http://127.0.0.1:8098 is up', [])).toBe('http://127.0.0.1:8098 is up')
    })

    it.each([
      ['https://user:pass@rpc.example.invalid', 'https://<redacted>@rpc.example.invalid'],
      [
        'dial wss://rpc.example.invalid/ws/CREDPATH failed',
        'dial wss://rpc.example.invalid/<redacted> failed',
      ],
      ['wss://user:pw@host:8546', 'wss://<redacted>@host:8546'],
      ['{"apiKey":"abc123","x":1}', '{"apiKey":"<redacted>","x":1}'],
      ['{"api_key": "abc123"}', '{"api_key": "<redacted>"}'],
      ['{"password": "hunter2"}', '{"password": "<redacted>"}'],
      ['ALCHEMY_API_KEY=abc123 next', 'ALCHEMY_API_KEY=<redacted> next'],
      ['MY_SERVICE_TOKEN=xyz', 'MY_SERVICE_TOKEN=<redacted>'],
      ['DB_PASSWORD=p@ss', 'DB_PASSWORD=<redacted>'],
      ['CLIENT_SECRET=s3', 'CLIENT_SECRET=<redacted>'],
      ['Authorization: Bearer abc.def', 'Authorization: Bearer <redacted>'],
      ['Basic dXNlcjpwYXNz', 'Basic <redacted>'],
      ['password: hunter2', 'password: <redacted>'],
      ['api key: abc', 'api key: <redacted>'],
      [
        'abandon ability able about above absent absorb abstract absurd abuse access accident',
        '<redacted>',
      ],
      [
        'phrase: abandon ability able about above absent absorb abstract absurd abuse access accident acid across act action actor actress actual adapt add',
        'phrase: <redacted>',
      ],
    ])('redacts %j', (input, expected) => {
      expect(redact(input, [])).toBe(expected)
    })

    const WORDS =
      'abandon ability able about above absent absorb abstract absurd abuse access accident'
    it.each([
      ['DB_PASSWORD="a b c"', 'a b c'],
      ["API_SECRET='a b c'", 'a b c'],
      ['password: "x y"', 'x y'],
      ["{'apiKey': 'abc123secret'}", 'abc123secret'],
      ['the passphrase is correct horse battery staple', 'correct horse'],
      ['AKIAIOSFODNN7EXAMPLE in the env', 'AKIAIOSFODNN7EXAMPLE'],
      ['Cookie: session=abc123; other=xyz', 'abc123'],
      ['Set-Cookie: sid=sekrit123; Path=/', 'sekrit123'],
      ['fetch rpc.example.invalid/v2/CREDKEY1234567890 failed', 'CREDKEY1234567890'],
      ['fetch rpc.example.invalid/CREDKEY1234567890abcdef failed', 'CREDKEY1234567890abcdef'],
      ['authorization: bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig', 'eyJhbGci'],
      ['sent BEARER eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0', 'eyJzdWI'],
      ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0 raw', 'eyJzdWI'],
      [`wallet seed: ${WORDS}`, 'abandon ability'],
      [`recovery: ${WORDS.split(' ').join(', ')}`, 'abandon, ability'],
      [`${WORDS.split(' ').join('\n')}`, 'abandon\nability'],
      [
        `${WORDS.split(' ')
          .map(w => w[0].toUpperCase() + w.slice(1))
          .join(' ')}`,
        'Abandon Ability',
      ],
      [`oops ${WORDS} ${WORDS}`, 'abandon ability'],
      [`${'0123456789abcdef'.repeat(4)}`, '0123456789abcdef0123456789abcdef'],
      ['x-api-key: hunter22', 'hunter22'],
      ['client_secret=s3cr3tvalue', 's3cr3tvalue'],
      ['PASSWORD=s3cr3t and more', 's3cr3t'],
    ])('a hostile sample cannot leak: %j', (input, secret) => {
      const out = redact(input as string, [])
      expect(out).not.toContain(secret as string)
      expect(out).toContain('<redacted>')
    })

    it('does not redact addresses, hashes, long paths or plain key=value diagnostics', () => {
      for (const keep of [
        `sent to 0x${'ab12'.repeat(10)}`,
        `tx 0x${'cd34'.repeat(16)} confirmed`,
        '    at Object.<anonymous> (/Users/someone/repos/frank/.worktrees/demo-launcher/packages/bot/demo/some-very-long-directory-name/index.ts:120:15)',
        'mode=stub port=8098 retries=3 sort_key=abc monkey=banana keys=2 state=ready',
        'listening on 127.0.0.1:8098, pid=4242',
        'a fairly ordinary sentence of prose that has only eleven regular words here',
      ]) {
        expect(redact(keep, [])).toBe(keep)
      }
    })

    it('redactLines finds a phrase that spans lines', () => {
      const lines = [
        '[start] 1',
        ...WORDS.split(' ').slice(0, 6),
        ...WORDS.split(' ').slice(6),
        '[done] 2',
      ]
      const out = redactLines(lines, [])
      expect(out.join('\n')).not.toContain('abandon')
      expect(out[0]).toBe('[start] 1')
      expect(out[out.length - 1]).toBe('[done] 2')
    })

    it('keeps useful diagnostics', () => {
      for (const keep of [
        'connect ECONNREFUSED 127.0.0.1:8545',
        'Error: listen EADDRINUSE: address already in use 127.0.0.1:8098',
        'relay is up at http://127.0.0.1:8098',
        'the relay exited during startup with code 1',
        'eleven words only here so no phrase at all right now ok',
      ]) {
        expect(redact(keep, [])).toBe(keep)
      }
    })

    it('a startup failure never echoes the RPC URL credential or key-shaped strings', async () => {
      const c = await config({
        MONAD_TESTNET_HTTP_RPC_URL: 'https://rpc.example.invalid/v2/CREDPATH?key=abc123',
        CASHWEBD_BIN: relayStub('leak'),
      })
      expect(c.secrets).toContain('https://rpc.example.invalid/v2/CREDPATH?key=abc123')
      let message = ''
      try {
        await startDemo(c, opts)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toMatch(/the relay exited during startup/)
      expect(message).toContain('<redacted>')
      for (const leaked of ['CREDPATH', 'abc123', 'sk-abcdefghijklmnop1234']) {
        expect(message).not.toContain(leaked)
      }
    })
  })

  describe('readiness timeouts', () => {
    it('a relay that never answers fails with a clear message and leaves no process', async () => {
      const c = await config({ CASHWEBD_BIN: relayStub('hang') })
      await expect(startDemo(c, { ...opts, relayTimeoutS: 1 })).rejects.toThrow(
        /did not answer on .* in time/,
      )
      await waitFor(() => existsSync(pidFile))
      const pid = Number(readFileSync(pidFile, 'utf8'))
      await waitFor(() => !alive(pid), 5000)
      expect(await portFree(c.relayPort)).toBe(true)
    }, 30000)

    it('a bot process that never finishes starting times out and is killed', async () => {
      const c = await config({ CASHWEBD_BIN: relayStub('http') }, botProcess('setInterval(() => {}, 1000)'))
      await expect(startDemo(c, { ...opts, botTimeoutS: 2 })).rejects.toThrow(
        /the bot process did not finish starting in time/,
      )
      await waitFor(() => !alive(Number(readFileSync(pidFile, 'utf8'))), 5000)
    }, 30000)

    it('a bot process that exits during startup is reported as exited, with its output', async () => {
      const c = await config({ CASHWEBD_BIN: relayStub('http') }, botProcess("console.log('boom line'); process.exit(3)"))
      const err: Error = await startDemo(c, opts).then(
        () => new Error('expected failure'),
        e => e,
      )
      expect(err).toBeInstanceOf(DemoConfigError)
      expect(err.message).toMatch(/the bot process exited during startup/)
      expect(err.message).toContain('boom line')
    }, 30000)
  })

  describe('signals and children dying', () => {
    it('a signal during startup stops every child and aborts (SIGHUP, in process)', async () => {
      const c = await config({ CASHWEBD_BIN: relayStub('hang') })
      const started = startDemo(c, { ...opts, relayTimeoutS: 60 })
      const outcome = started.then(
        () => 'started',
        e => e,
      )
      await waitFor(() => existsSync(pidFile))
      const pid = Number(readFileSync(pidFile, 'utf8'))
      process.emit('SIGHUP', 'SIGHUP')
      const err = await outcome
      expect(err).toBeInstanceOf(DemoAborted)
      expect((err as DemoAborted).exitCode).toBe(129)
      await waitFor(() => !alive(pid), 5000)
      expect(await portFree(c.relayPort)).toBe(true)
      expect(existsSync(join(c.stateDir, 'demo.pid'))).toBe(false)
      expect(existsSync(join(c.stateDir, 'demo.lock'))).toBe(false)
    }, 30000)

    it('a signal while bots are still starting also stops everything', async () => {
      const c = await config({ CASHWEBD_BIN: relayStub('http') }, botProcess('setInterval(() => {}, 1000)'))
      const outcome = startDemo(c, { ...opts, botTimeoutS: 60 }).then(
        () => 'started',
        e => e,
      )
      await waitFor(() => output.some(l => l.includes('relay is up')))
      await sleep(300)
      process.emit('SIGHUP', 'SIGHUP')
      expect(await outcome).toBeInstanceOf(DemoAborted)
      await waitFor(() => !alive(Number(readFileSync(pidFile, 'utf8'))), 5000)
    }, 30000)

    async function running(): Promise<{ handle: DemoHandle; c: DemoConfig }> {
      const c = await config({ CASHWEBD_BIN: relayStub('http') })
      return { handle: await startDemo(c, opts), c }
    }

    it('the relay is started with the burn address the bots and the app command use (#364)', async () => {
      const { handle, c } = await running()
      expect(readFileSync(pidFile + '.env', 'utf8')).toBe(c.stampBurnAddress)
      expect(c.stampBurnAddress).toBe('0x000000000000000000000000000000000000dEaD')
      await handle.stop()
      await handle.done
    }, 30000)

    // Supply a real built cashwebd-exe (and a real Monad testnet RPC URL) to exercise the shipped
    // configuration through the production validator and a real start: the relay itself checks
    // the upstream's chain id and genesis block.
    const realRelayTest = process.env.CASHWEBD_BIN && process.env.MONAD_TESTNET_HTTP_RPC_URL ? it : it.skip
    realRelayTest(
      'starts the real relay from the shipped configuration, with the message and directory routes',
      async () => {
        const c = await config({
          CASHWEBD_BIN: process.env.CASHWEBD_BIN!,
          MONAD_TESTNET_HTTP_RPC_URL: process.env.MONAD_TESTNET_HTTP_RPC_URL!,
        })
        const handle = await startDemo(c, { ...opts, relayTimeoutS: 60 })
        try {
          expect((await fetch(`${handle.relayUrl}/metadata/monad?since=0`)).ok).toBe(true)
          const info = (await (await fetch(`${handle.relayUrl}/relay/v1/info`)).json()) as { network: string; endpoint: string }
          expect(info.network).toBe('monad-testnet')
          expect(info.endpoint).toBe(handle.relayUrl)
        } finally {
          await handle.stop()
          await handle.done
        }
      },
      90000,
    )

    it('a custom burn address reaches the relay too', async () => {
      const other = '0x2222222222222222222222222222222222222222'
      const c = await config({ CASHWEBD_BIN: relayStub('http'), MONAD_STAMP_BURN_ADDRESS: other })
      const handle = await startDemo(c, opts)
      expect(readFileSync(pidFile + '.env', 'utf8')).toBe(other)
      await handle.stop()
      await handle.done
    }, 30000)

    it('passes the optional WebSocket RPC only to the relay process', async () => {
      const full = resolveDemoConfig({
        env: { MONAD_TESTNET_HTTP_RPC_URL: 'http://127.0.0.1:9', E2E_DEMO_MAIN_WALLET_JSON: 'w.json', MONAD_TESTNET_WS_RPC_URL: 'wss://rpc.example.invalid/v2/sentinel-key' },
        envFile: {},
        home: dir,
        cwd: dir,
      })
      expect(full.botProcess.env.MONAD_TESTNET_WS_RPC_URL).toBeUndefined()
      const c = await config({ CASHWEBD_BIN: relayStub('http') })
      c.wsRpcUrl = 'wss://rpc.example.invalid/v2/sentinel-key'
      const handle = await startDemo(c, opts)
      expect(readFileSync(pidFile + '.ws-rpc', 'utf8')).toBe(c.wsRpcUrl)
      await handle.stop()
      await handle.done
    }, 30000)

    it('the summary states the app URL and the exact app command with the relay, chain and burn address', async () => {
      const { handle, c } = await running()
      const lines: string[] = []
      printSummary(handle, l => lines.push(l))
      const text = lines.join('\n')
      expect(text).toContain('App URL: http://localhost:8080')
      expect(text).toContain(`QCLI_MONAD_RELAY_BASE_URL=http://127.0.0.1:${c.relayPort}`)
      expect(text).toContain('QCLI_MONAD_RPC_CHAIN=monad-testnet')
      expect(text).not.toContain('QCLI_MONAD_TESTNET_HTTP_RPC_URL')
      expect(text).toContain(`QCLI_MONAD_STAMP_BURN_ADDRESS=${c.stampBurnAddress}`)
      expect(text).toContain(`QCLI_CASHWEB_STAMP_MIN_BURN_VALUE_WEI=${c.minStampWei}`)
      expect(text).toContain('yarn dev:browser')
      expect(text).toContain(`launcher pid ${process.pid}`)
      expect(text).toContain('Chain:   Monad testnet')
      expect(text).toContain(`Funding: ${handle.fundingAddress}`)
      expect(appCommand(c, handle.relayUrl)).toHaveLength(3)
      await handle.stop()
      await handle.done
    }, 30000)

    it('when app is started, the summary reports it running at the app URL', async () => {
      const { handle } = await running()
      const runningHandle: DemoHandle = { ...handle, appStarted: true }
      const lines: string[] = []
      printSummary(runningHandle, l => lines.push(l))
      const text = lines.join('\n')
      expect(text).toContain('App:     Running at http://localhost:8080 (dev server automatically started; browser launched)')
      expect(text).not.toContain('Start the app in another terminal')
      await handle.stop()
      await handle.done
    }, 30000)

    it('after startup, the relay dying stops everything, prints a banner and exits non-zero', async () => {
      const { handle } = await running()
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
      expect(await handle.done).toBe(1)
      expect(handle.unhealthy()).toContain('relay')
      expect(output.join('\n')).toMatch(
        /DEMO UNHEALTHY[\s\S]*relay exited and is NOT restarted; see .*relay\.log/,
      )
      expect(output.join('\n')).toMatch(/the relay is gone/)
    }, 30000)

    it('a non-relay child dying is flagged loudly but the demo keeps running (no restart)', async () => {
      const { handle } = await running()
      const stateFile = join(handle.config.stateDir, 'demo.pid')
      const pids = JSON.parse(readFileSync(stateFile, 'utf8')).children as Array<{
        name: string
        pid: number
      }>
      const worker = pids.find(p => p.name === 'bots')!
      process.kill(worker.pid, 'SIGKILL')
      await waitFor(() => handle.unhealthy().includes('bots'))
      expect(output.join('\n')).toMatch(/bots exited and is NOT restarted; see .*bots\.log/)
      expect(await Promise.race([handle.done, sleep(600).then(() => 'still-running')])).toBe(
        'still-running',
      )
      await handle.stop()
      expect(await handle.done).toBe(0)
      expect(existsSync(stateFile)).toBe(false)
    }, 30000)

    it('stops like a closed terminal when the process that started it (yarn) goes away', async () => {
      const c = await config({ CASHWEBD_BIN: relayStub('http') })
      let parent = 4242
      const handle = await startDemo(c, {
        ...opts,
        watchParent: { pid: 4242, current: () => parent, intervalMs: 50 },
      })
      const relayPid = Number(readFileSync(pidFile, 'utf8'))
      expect(await Promise.race([handle.done, sleep(300).then(() => 'still-running')])).toBe(
        'still-running',
      )
      parent = 1 // reparented to init: the wrapper died
      expect(await handle.done).toBe(0)
      expect(output.join('\n')).toMatch(/is gone: stopping like a closed terminal/)
      await waitFor(() => !alive(relayPid), 5000)
    }, 30000)

    it('stop() is idempotent and a Ctrl-C style signal after startup exits 0', async () => {
      const { handle } = await running()
      process.emit('SIGHUP', 'SIGHUP')
      expect(await handle.done).toBe(0)
      await handle.stop()
      await handle.stop()
    }, 30000)
  })

  describe('one bot process, each bot reported by name', () => {
    it('starts ONE process for all bots; a bot that failed to start is named and not waited for, the others are', async () => {
      const c = await config(
        { CASHWEBD_BIN: relayStub('http') },
        botProcess(
          "console.log('[all-bots] rps registered'); console.error('[all-bots] dice FAILED to start: no dice today'); console.log('[all-bots] running: rps'); setInterval(() => {}, 1000)",
        ),
      )
      // Two real bot profiles (keys made by the launcher's own identity step).
      const full = resolveDemoConfig({
        env: { FRANK_DEMO_STATE_DIR: c.stateDir, MONAD_TESTNET_HTTP_RPC_URL: 'http://127.0.0.1:9', E2E_DEMO_MAIN_WALLET_JSON: c.mainWalletJson },
        envFile: {},
        home: dir,
        cwd: dir,
      })
      const two = { ...c, bots: full.bots.filter(b => b.name === 'rps' || b.name === 'dice') }
      // The relay stand-in lists no profiles, so rps (registered with the host) is never visible
      // on the relay and the start times out waiting for it; dice already failed and is not waited for.
      const err: Error = await startDemo(two, { ...opts, botTimeoutS: 3 }).then(
        () => new Error('expected a timeout'),
        e => e,
      )
      expect(err.message).toMatch(/still waiting for: rps\)/)
      const pids = output.filter(l => l.includes('starting 2 bots in one process'))
      expect(pids).toHaveLength(1)
    }, 30000)

    it('funds are checked per bot account: identity address and stamp account, the faucet\'s stamp account only', async () => {
      const c = await config({ CASHWEBD_BIN: relayStub('http') })
      const { fundingTargets } = await import('./demo')
      expect(fundingTargets('faucet', { faucet: '0xF' }, { faucet: '0xM' })).toEqual([
        { label: 'stamp account', address: '0xM' },
      ])
      expect(fundingTargets('rps', { rps: '0xI' }, { rps: '0xM' }).map(t => t.label)).toEqual([
        'identity address',
        'stamp account',
      ])
      const handle = await startDemo(c, opts)
      expect(handle.botProblems).toEqual([])
      expect(output.join('\n')).toContain('all 0 bots funded and registered')
      await handle.stop()
      await handle.done
    }, 30000)
  })

  describe('the funding wallet is checked before anything is started', () => {
    it('refuses to start, naming the wallet and the shortfall, when it cannot fund the bots', async () => {
      const { fundingNeed, fundingShortfall } = await import('./demo')
      const c = await config()
      const bots = [{ name: 'rps' as const, identityJson: 'x' }, { name: 'faucet' as const, identityJson: 'y' }]
      const balances: Record<string, bigint> = { '0xfund': 2n * 10n ** 17n }
      const params = {
        addresses: { rps: '0xrps', faucet: '0xfaucet' },
        mainAccounts: { rps: '0xrpsmain', faucet: '0xfaucetmain' },
        fundingAddress: '0xfund',
        getBalance: async (a: string) => balances[a] ?? 0n,
      }
      // Three accounts need funding (the faucet's identity address does not). With the host's
      // defaults that is 0.5 MON each: 1.5 MON, and the wallet holds 0.2.
      const short = await fundingShortfall({ ...c, bots }, params)
      expect(short![0]).toMatch(/funding wallet 0xfund holds 0\.2 testnet MON, but 3 bot accounts need funding and the bot host will draw about 1\.5 MON/)
      expect(short!.join('\n')).toContain('Nothing was started and nothing was spent')
      expect(short!.join('\n')).toContain('rps identity address, rps stamp account, faucet stamp account')
      // With the launcher's refill settings: rps's transfer account to 0.6, two stamp accounts 0.5 each.
      const tuned = { ...c, bots, botProcess: { ...c.botProcess, env: { FRANK_BOT_TOP_UP_BELOW_WEI: '300000000000000000', FRANK_BOT_TOP_UP_TO_WEI: '600000000000000000' } } }
      expect((await fundingNeed(tuned, params)).neededWei).toBe(16n * 10n ** 17n)
      // Enough in the wallet, or bots already funded: nothing to report.
      balances['0xfund'] = 15n * 10n ** 17n
      expect(await fundingShortfall({ ...c, bots }, params)).toBeUndefined()
      balances['0xfund'] = 0n
      for (const a of ['0xrps', '0xrpsmain', '0xfaucetmain']) balances[a] = 10n ** 17n
      expect(await fundingShortfall({ ...c, bots }, params)).toBeUndefined()
      // A transfer account between 0.1 and the 0.3 refill mark is refilled by the difference only.
      expect(await fundingNeed(tuned, params)).toEqual({ neededWei: 5n * 10n ** 17n, low: ['rps identity address'] })
    })

    it('a missing wallet file stops the start before the relay is started', async () => {
      const c = await config({ CASHWEBD_BIN: relayStub('http'), E2E_DEMO_MAIN_WALLET_JSON: join(dir, 'missing-wallet.json') })
      const err = await startDemo(c, opts).then(
        () => undefined,
        e => e,
      )
      expect(err).toBeInstanceOf(DemoConfigError)
      expect((err as DemoConfigError).message).toMatch(/E2E_DEMO_MAIN_WALLET_JSON does not exist/)
      expect(existsSync(pidFile)).toBe(false) // the relay was never started
      expect(existsSync(join(c.stateDir, 'demo.lock'))).toBe(false)
    }, 30000)
  })

  describe('the real CLI (separate process)', () => {
    // These tests are about signals while the relay is starting. The separate launcher process
    // reads balances before that, so it is given an endpoint that answers every request with one
    // fixed balance: a stand-in for that single read, nothing more.
    let balanceEndpoint: import('http').Server | undefined
    afterEach(() => balanceEndpoint?.close())
    async function cliEnvFile(): Promise<string> {
      const { createServer: http } = await import('http')
      balanceEndpoint = http((_q, r) => r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x3635c9adc5dea00000' })))
      await new Promise<void>(r => balanceEndpoint!.listen(0, '127.0.0.1', () => r()))
      const wallet = join(dir, 'cli-wallet.json')
      writeFileSync(wallet, JSON.stringify({ address: '0x' + '1a'.repeat(20) }), { mode: 0o600 })
      const envFile = join(dir, 'dummy.env')
      writeFileSync(
        envFile,
        `FRANK_NETWORK_TAG=MONT\nMONAD_TESTNET_HTTP_RPC_URL=http://127.0.0.1:${(balanceEndpoint.address() as { port: number }).port}\nE2E_DEMO_MAIN_WALLET_JSON=${wallet}\n`,
      )
      return envFile
    }
    async function runCli(
      signal: NodeJS.Signals,
      expectedCode: number,
      opts2: { stubborn?: boolean; twice?: boolean } = {},
    ): Promise<void> {
      const relayPort = await freePort()
      const envFile = await cliEnvFile()
      const cli = spawn(
        process.execPath,
        ['--import', 'tsx', join(__dirname, 'demo.ts'), '--no-app'],
        {
          env: {
            PATH: process.env.PATH,
            HOME: dir,
            CASHWEBD_BIN: relayStub(opts2.stubborn ? 'stubborn' : 'hang'),
            FRANK_DEMO_ENV_FILE: envFile,
            FRANK_DEMO_STATE_DIR: join(dir, 'cli-state'),
            FRANK_DEMO_RELAY_PORT: String(relayPort),
          },
          cwd: join(__dirname, '..'),
          stdio: 'ignore',
        },
      )
      const exit = new Promise<number | null>(resolve => cli.on('close', code => resolve(code)))
      await waitFor(() => existsSync(pidFile), 30000) // the relay stub is up: still "starting the relay"
      const relayPid = Number(readFileSync(pidFile, 'utf8'))
      const t0 = Date.now()
      cli.kill(signal)
      if (opts2.twice) {
        await sleep(1500) // the relay ignores SIGTERM: the launcher is now in its grace period
        expect(alive(relayPid)).toBe(true)
        cli.kill(signal)
      }
      expect(await exit).toBe(expectedCode)
      if (opts2.twice) expect(Date.now() - t0).toBeLessThan(7000) // well inside the 8 s grace
      await waitFor(() => !alive(relayPid), 5000)
      expect(await portFree(relayPort)).toBe(true)
    }

    it('kill -INT on the wrapper that started it (yarn exits without forwarding) still stops the stack', async () => {
      const relayPort = await freePort()
      const envFile = await cliEnvFile()
      const cliPidFile = join(dir, 'cli.pid')
      const wrapper = join(dir, 'wrapper.js')
      // Stands in for `yarn`: starts the launcher, dies on SIGINT WITHOUT forwarding it.
      writeFileSync(
        wrapper,
        `const { spawn } = require('child_process')
const child = spawn(process.execPath, ['--import', 'tsx', ${JSON.stringify(
          join(__dirname, 'demo.ts'),
        )}, '--no-app'], { stdio: 'ignore', cwd: ${JSON.stringify(join(__dirname, '..'))} })
require('fs').writeFileSync(${JSON.stringify(cliPidFile)}, String(child.pid))
process.on('SIGINT', () => process.exit(0))
setInterval(() => {}, 1000)
`,
      )
      const w = spawn(process.execPath, [wrapper], {
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          npm_lifecycle_event: 'demo', // set by yarn for every script it runs
          CASHWEBD_BIN: relayStub('hang'),
          FRANK_DEMO_ENV_FILE: envFile,
          FRANK_DEMO_STATE_DIR: join(dir, 'cli-state'),
          FRANK_DEMO_RELAY_PORT: String(relayPort),
        },
        stdio: 'ignore',
      })
      await waitFor(() => existsSync(pidFile) && existsSync(cliPidFile), 30000)
      const relayPid = Number(readFileSync(pidFile, 'utf8'))
      const cliPid = Number(readFileSync(cliPidFile, 'utf8'))
      try {
        const exited = new Promise<void>(r => w.on('close', () => r()))
        w.kill('SIGINT')
        await exited
        expect(alive(cliPid)).toBe(true) // yarn is gone; the launcher was not signalled
        await waitFor(() => !alive(cliPid), 10000) // it notices and stops
        await waitFor(() => !alive(relayPid), 5000)
        expect(await portFree(relayPort)).toBe(true)
      } finally {
        for (const pid of [cliPid, relayPid]) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* gone */
          }
        }
      }
    }, 60000)

    it('Ctrl-C (SIGINT) during "starting the relay" leaves no relay process or port', async () => {
      await runCli('SIGINT', 130)
    }, 60000)
    it('a second Ctrl-C during the grace period kills a child that ignores SIGTERM, at once', async () => {
      await runCli('SIGINT', 130, { stubborn: true, twice: true })
    }, 60000)
    it('SIGTERM during startup leaves nothing behind', async () => {
      await runCli('SIGTERM', 143)
    }, 60000)
    it('SIGHUP (terminal closed) during startup leaves nothing behind', async () => {
      await runCli('SIGHUP', 129)
    }, 60000)
  })

  describe('a leftover run record is never acted on', () => {
    function bystander(name: string, body: string): ChildProcess {
      // Deliberately looks like our own tree: "frank" and "livecheck" in the command line.
      const dirFrank = join(dir, 'repos', 'frank')
      mkdirSync(dirFrank, { recursive: true })
      const script = join(dirFrank, name)
      writeFileSync(script, body)
      const child = spawn('bash', [script], { detached: true, stdio: 'ignore' })
      spawned.push(child)
      return child
    }

    it('never kills an unrelated process whose command line contains "frank" (group leader or not)', async () => {
      const leader = bystander('editor.livecheck.sh', 'sleep 60 & wait')
      await sleep(300)
      const leaderPid = leader.pid as number
      // a non-leader: a member of the leader's group
      const member = Number(
        execFileSync('pgrep', ['-P', String(leaderPid)], { encoding: 'utf8' }).split('\n')[0],
      )
      expect(alive(member)).toBe(true)
      const relayPort = await freePort()
      const busy = createServer()
      await new Promise<void>(r => busy.listen(relayPort, '127.0.0.1', () => r()))
      try {
        const state = join(dir, 'state')
        mkdirSync(state, { recursive: true, mode: 0o700 })
        // a forged / stale record that names both, with plausible-looking details
        writeFileSync(
          join(state, 'demo.pid'),
          JSON.stringify({
            launcher: { pid: 2147483000, startTime: 'x' },
            children: [
              { name: 'relay', pid: leaderPid, pgid: leaderPid, startTime: 'x', argv: ['bash'] },
              { name: 'raffle', pid: member, pgid: leaderPid, startTime: 'x', argv: ['node'] },
            ],
          }),
        )
        const c = await config({
          CASHWEBD_BIN: relayStub('hang'),
          FRANK_DEMO_RELAY_PORT: String(relayPort),
        })
        const err: Error = await startDemo(c, { ...opts, relayTimeoutS: 1 }).then(
          () => new Error('expected failure'),
          e => e,
        )
        expect(err.message).toMatch(/is in use/)
        // advice for the operator, commands to run themselves; nothing was killed
        expect(err.message).toContain(`ps -p ${leaderPid} -o pid,pgid,lstart,command`)
        expect(err.message).toContain(`kill -TERM -- -${leaderPid}`)
        expect(alive(leaderPid)).toBe(true)
        expect(alive(member)).toBe(true)
        expect(existsSync(join(state, 'demo.pid'))).toBe(false) // the stale record was removed
      } finally {
        await new Promise<void>(r => busy.close(() => r()))
      }
    }, 30000)

    it('a planted record naming arbitrary live processes (and garbage) causes no kill and no crash', async () => {
      const victim = bystander('victim.sh', 'sleep 60')
      await sleep(200)
      for (const content of [
        JSON.stringify({ children: [{ name: 'x', pid: victim.pid, pgid: victim.pid }] }),
        JSON.stringify({ children: 'nope' }),
        'garbage',
        JSON.stringify({ children: [{ name: 1, pid: 'a', pgid: {}, argv: 5 }] }),
      ]) {
        const state = join(dir, 'state')
        mkdirSync(state, { recursive: true, mode: 0o700 })
        writeFileSync(join(state, 'demo.pid'), content)
        const c = await config({ CASHWEBD_BIN: relayStub('hang') })
        await expect(startDemo(c, { ...opts, relayTimeoutS: 1 })).rejects.toThrow(/did not answer/)
        expect(alive(victim.pid as number)).toBe(true)
      }
    }, 60000)
  })

  describe('synchronous last-resort kill', () => {
    it('killAllNow kills each child process GROUP (not just the pid), synchronously', async () => {
      const { Supervisor } = await import('./supervisor')
      const sup = new Supervisor({ PATH: process.env.PATH }, () => {})
      const child = sup.start({
        name: 'tree',
        command: 'sh',
        args: ['-c', 'sleep 60 & echo $! && wait'],
        cwd: dir,
        env: {},
        logPath: join(dir, 'tree.log'),
      })
      let grandchild = 0
      for (let i = 0; i < 60 && !grandchild; i++) {
        await sleep(50)
        grandchild = Number(child.tail()[0]) || 0
      }
      expect(alive(grandchild)).toBe(true)
      sup.killAllNow()
      await waitFor(() => !alive(grandchild), 3000)
      await child.exited
    })
  })

  describe('exit guard (pgid reuse)', () => {
    it('never signals the group of a child whose leader has exited (its pgid may belong to someone else now)', async () => {
      const { Supervisor } = await import('./supervisor')
      const sup = new Supervisor({ PATH: process.env.PATH }, () => {})
      // An unrelated process group standing in for "the pgid was reused by somebody else".
      const bystander = spawn('sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' })
      spawned.push(bystander)
      await sleep(100)
      const fake = {
        name: 'gone',
        proc: { pid: bystander.pid },
        argv: [],
        logPath: '',
        tail: () => [],
        exited: Promise.resolve('0'),
        hasExited: () => true,
      }
      ;(sup as unknown as { children: unknown[] }).children.push(fake)
      sup.killAllNow()
      await sup.stopAll(300)
      await sleep(400) // a killed child is only a zombie (still "alive") until node reaps it
      expect(alive(bystander.pid as number)).toBe(true)
    })

    it("flips the exited flag on the leader's exit, not on the later stdio close", async () => {
      const { Supervisor } = await import('./supervisor')
      const sup = new Supervisor({ PATH: process.env.PATH }, () => {})
      // The leader exits at once; a grandchild keeps stdout open, so 'close' comes much later.
      const child = sup.start({
        name: 'leader',
        command: 'sh',
        args: ['-c', 'sleep 3 & exit 0'],
        cwd: dir,
        env: {},
        logPath: join(dir, 'l.log'),
      })
      await waitFor(() => child.hasExited(), 2000)
      let closed = false
      void child.exited.then(() => (closed = true))
      expect(closed).toBe(false)
      await sup.stopAll(200)
    })
  })

  describe('wallet address comparison', () => {
    it('reads only the address, normalised (no 0x, lower-case, exactly 40 hex)', () => {
      const w = join(dir, 'w.json')
      const hex = 'aBcDeF0123456789aBcDeF0123456789aBcDeF01'
      writeFileSync(w, JSON.stringify({ address: `0x${hex}`, privateKey: '0x11' }), { mode: 0o600 })
      expect(walletAddress(w)).toBe(hex.toLowerCase())
      // keystore style: no 0x prefix at all
      writeFileSync(w, JSON.stringify({ address: hex }))
      expect(walletAddress(w)).toBe(hex.toLowerCase())
      for (const bad of ['0xabc', 'zz'.repeat(20), '', 5, null, `0x${hex}00`]) {
        writeFileSync(w, JSON.stringify({ address: bad }))
        expect(walletAddress(w)).toBeUndefined()
      }
      writeFileSync(w, '{"privateKey":"x"}')
      expect(walletAddress(w)).toBeUndefined()
      expect(walletAddress(join(dir, 'missing.json'))).toBeUndefined()
    })

    it('a funding wallet file without a valid address is refused before anything starts', async () => {
      const junk = join(dir, 'junk.json')
      writeFileSync(junk, JSON.stringify({ address: '0x1234' }), { mode: 0o600 })
      const c = await config({ CASHWEBD_BIN: relayStub('hang'), E2E_DEMO_MAIN_WALLET_JSON: junk })
      expect((await checkPrerequisites(c)).join('\n')).toMatch(/valid "address"/)
      expect(await checkPrerequisites(await config({ CASHWEBD_BIN: relayStub('hang') }))).toEqual([])
    })
  })

  describe('prepareStateDir', () => {
    it('tightens a pre-existing directory we own to 0700, and creates new ones 0700', () => {
      const existing = join(dir, 'existing')
      mkdirSync(existing, { mode: 0o755 })
      chmodSync(existing, 0o755)
      prepareStateDir(existing)
      expect(statSync(existing).mode & 0o777).toBe(0o700)
      const fresh = join(dir, 'a', 'b')
      prepareStateDir(fresh)
      expect(statSync(fresh).mode & 0o777).toBe(0o700)
    })

    it('refuses a group/world-writable directory and one owned by another user', () => {
      const open = join(dir, 'open')
      mkdirSync(open)
      chmodSync(open, 0o777)
      expect(() => prepareStateDir(open)).toThrow(/writable by group or others/)
      const mine = join(dir, 'mine')
      mkdirSync(mine, { mode: 0o700 })
      jest.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1)
      try {
        expect(() => prepareStateDir(mine)).toThrow(/owned by another user/)
      } finally {
        jest.restoreAllMocks()
      }
    })
  })
})
