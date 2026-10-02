import { ChildProcess, execFileSync, spawn } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

import { DemoBot, DemoConfig, DemoConfigError, resolveDemoConfig } from './demo-config'
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

  function fakeBot(name: string, body: string): DemoBot {
    const script = join(dir, `${name}.js`)
    writeFileSync(script, body)
    return { name: name as never, script, env: {}, readyLine: /READY/ }
  }

  async function config(
    over: Record<string, string> = {},
    bots: DemoBot[] = [],
    fake = true,
  ): Promise<DemoConfig> {
    const c = resolveDemoConfig({
      env: {
        FRANK_DEMO_STATE_DIR: join(dir, 'state'),
        FRANK_DEMO_RELAY_PORT: String(await freePort()),
        FRANK_DEMO_FAKE_RPC_PORT: String(await freePort()),
        ...over,
      },
      envFile: {},
      fakeChainFlag: fake,
      home: dir,
      cwd: dir,
    })
    return { ...c, bots }
  }
  const opts = {
    print,
    env: { PATH: process.env.PATH, HOME: dir } as Record<string, string | undefined>,
    pollMs: 50,
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
      const wallet = join(dir, 'wallet.json')
      writeFileSync(wallet, '{}', { mode: 0o600 })
      const c = await config(
        {
          MONAD_TESTNET_HTTP_RPC_URL: 'https://rpc.example.invalid/v2/CREDPATH?key=abc123',
          E2E_DEMO_MAIN_WALLET_JSON: wallet,
          FRANK_DEMO_NO_FAUCET: '1',
          CASHWEBD_BIN: relayStub('leak'),
        },
        [],
        false,
      )
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
      expect(await portFree(c.fakeRpcPort)).toBe(true)
    }, 30000)

    it('a bot that never becomes ready times out and is killed', async () => {
      const bot = fakeBot('silent', 'setInterval(() => {}, 1000)')
      const c = await config({ CASHWEBD_BIN: relayStub('http') }, [bot])
      await expect(startDemo(c, { ...opts, botTimeoutS: 2 })).rejects.toThrow(
        /silent did not become ready in time/,
      )
      await waitFor(() => !alive(Number(readFileSync(pidFile, 'utf8'))), 5000)
    }, 30000)

    it('a bot that exits during startup is reported as exited, with its output', async () => {
      const bot = fakeBot('crasher', "console.log('boom line'); process.exit(3)")
      const c = await config({ CASHWEBD_BIN: relayStub('http') }, [bot])
      const err: Error = await startDemo(c, opts).then(
        () => new Error('expected failure'),
        e => e,
      )
      expect(err).toBeInstanceOf(DemoConfigError)
      expect(err.message).toMatch(/crasher did not become ready \(it exited\)/)
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
      expect(await portFree(c.fakeRpcPort)).toBe(true)
      expect(existsSync(join(c.stateDir, 'demo.pid'))).toBe(false)
      expect(existsSync(join(c.stateDir, 'demo.lock'))).toBe(false)
    }, 30000)

    it('a signal while bots are still starting also stops everything', async () => {
      const bot = fakeBot('slow', 'setInterval(() => {}, 1000)')
      const c = await config({ CASHWEBD_BIN: relayStub('http') }, [bot])
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
      const bot = fakeBot('worker', "console.log('READY'); setInterval(() => {}, 1000)")
      const c = await config({ CASHWEBD_BIN: relayStub('http') }, [bot])
      return { handle: await startDemo(c, opts), c }
    }

    it('the relay is started with the burn address the bots and the app command use (#364)', async () => {
      const { handle, c } = await running()
      expect(readFileSync(pidFile + '.env', 'utf8')).toBe(c.stampBurnAddress)
      expect(c.stampBurnAddress).toBe('0x000000000000000000000000000000000000dEaD')
      await handle.stop()
      await handle.done
    }, 30000)

    it('a custom burn address reaches the relay too', async () => {
      const other = '0x2222222222222222222222222222222222222222'
      const bot = fakeBot('worker', "console.log('READY'); setInterval(() => {}, 1000)")
      const c = await config({ CASHWEBD_BIN: relayStub('http'), MONAD_STAMP_BURN_ADDRESS: other }, [
        bot,
      ])
      const handle = await startDemo(c, opts)
      expect(readFileSync(pidFile + '.env', 'utf8')).toBe(other)
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
      expect(appCommand(c, handle.relayUrl)).toHaveLength(3)
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
      const worker = pids.find(p => p.name === 'worker')!
      process.kill(worker.pid, 'SIGKILL')
      await waitFor(() => handle.unhealthy().includes('worker'))
      expect(output.join('\n')).toMatch(/worker exited and is NOT restarted; see .*worker\.log/)
      expect(await Promise.race([handle.done, sleep(600).then(() => 'still-running')])).toBe(
        'still-running',
      )
      await handle.stop()
      expect(await handle.done).toBe(0)
      expect(existsSync(stateFile)).toBe(false)
    }, 30000)

    it('stops like a closed terminal when the process that started it (yarn) goes away', async () => {
      const bot = fakeBot('worker', "console.log('READY'); setInterval(() => {}, 1000)")
      const c = await config({ CASHWEBD_BIN: relayStub('http') }, [bot])
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

  describe('state dir mode marker', () => {
    it('refuses to start on a state dir made for the other mode, before starting anything', async () => {
      const c = await config({ CASHWEBD_BIN: relayStub('http') })
      mkdirSync(c.stateDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(c.stateDir, 'demo-mode.json'), '{"mode":"real","chainId":10143}')
      const err = await startDemo(c, opts).then(
        () => undefined,
        e => e,
      )
      expect(err).toBeInstanceOf(DemoConfigError)
      expect((err as DemoConfigError).message).toMatch(/created for a real network/)
      expect(existsSync(pidFile)).toBe(false) // the relay was never started
      expect(existsSync(join(c.stateDir, 'demo.lock'))).toBe(false)
    }, 30000)
  })

  describe('a failed start does not claim the state dir (first-run trap)', () => {
    it('a real-network start that fails its prerequisites leaves no marker, so --fake-chain still works', async () => {
      const real = await config(
        {
          MONAD_TESTNET_HTTP_RPC_URL: 'http://127.0.0.1:9',
          E2E_DEMO_MAIN_WALLET_JSON: join(dir, 'missing-wallet.json'),
          FRANK_DEMO_NO_FAUCET: '1',
          CASHWEBD_BIN: relayStub('http'),
        },
        [],
        false,
      )
      const err = await startDemo(real, opts).then(
        () => undefined,
        e => e,
      )
      expect(err).toBeInstanceOf(DemoConfigError)
      expect((err as DemoConfigError).message).toMatch(/E2E_DEMO_MAIN_WALLET_JSON does not exist/)
      expect(existsSync(join(real.stateDir, 'demo-mode.json'))).toBe(false)

      const fake = await config({ CASHWEBD_BIN: relayStub('http') }, [])
      const handle = await startDemo(fake, opts)
      expect(JSON.parse(readFileSync(join(fake.stateDir, 'demo-mode.json'), 'utf8')).mode).toBe(
        'fake-chain',
      )
      await handle.stop()
      await handle.done
    }, 30000)
  })

  describe('the real CLI (separate process)', () => {
    async function runCli(
      signal: NodeJS.Signals,
      expectedCode: number,
      opts2: { stubborn?: boolean; twice?: boolean } = {},
    ): Promise<void> {
      const relayPort = await freePort()
      const rpcPort = await freePort()
      const envFile = join(dir, 'dummy.env')
      writeFileSync(envFile, 'FRANK_NETWORK_TAG=MONT\n')
      const cli = spawn(
        process.execPath,
        ['--import', 'tsx', join(__dirname, 'demo.ts'), '--fake-chain'],
        {
          env: {
            PATH: process.env.PATH,
            HOME: dir,
            CASHWEBD_BIN: relayStub(opts2.stubborn ? 'stubborn' : 'hang'),
            FRANK_DEMO_ENV_FILE: envFile,
            FRANK_DEMO_STATE_DIR: join(dir, 'cli-state'),
            FRANK_DEMO_RELAY_PORT: String(relayPort),
            FRANK_DEMO_FAKE_RPC_PORT: String(rpcPort),
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
      expect(await portFree(rpcPort)).toBe(true)
      expect(await portFree(relayPort)).toBe(true)
    }

    it('kill -INT on the wrapper that started it (yarn exits without forwarding) still stops the stack', async () => {
      const relayPort = await freePort()
      const rpcPort = await freePort()
      const envFile = join(dir, 'dummy.env')
      writeFileSync(envFile, 'FRANK_NETWORK_TAG=MONT\n')
      const cliPidFile = join(dir, 'cli.pid')
      const wrapper = join(dir, 'wrapper.js')
      // Stands in for `yarn`: starts the launcher, dies on SIGINT WITHOUT forwarding it.
      writeFileSync(
        wrapper,
        `const { spawn } = require('child_process')
const child = spawn(process.execPath, ['--import', 'tsx', ${JSON.stringify(
          join(__dirname, 'demo.ts'),
        )}, '--fake-chain'], { stdio: 'ignore', cwd: ${JSON.stringify(join(__dirname, '..'))} })
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
          FRANK_DEMO_FAKE_RPC_PORT: String(rpcPort),
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
        expect(await portFree(rpcPort)).toBe(true)
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

    it('refuses a copy or a symlink of the same wallet as the faucet wallet, allows a different one', async () => {
      const main = join(dir, 'main.json')
      writeFileSync(main, JSON.stringify({ address: `0x${'ab'.repeat(20)}`, privateKey: '0x1' }), {
        mode: 0o600,
      })
      const copy = join(dir, 'copy.json')
      writeFileSync(copy, readFileSync(main), { mode: 0o600 })
      const link = join(dir, 'link.json')
      symlinkSync(main, link)
      const other = join(dir, 'other.json')
      writeFileSync(other, JSON.stringify({ address: `0x${'cd'.repeat(20)}`, privateKey: '0x2' }), {
        mode: 0o600,
      })

      const withBots = async (faucet: string) => {
        const c = resolveDemoConfig({
          env: {
            FRANK_DEMO_STATE_DIR: join(dir, 'state'),
            FRANK_DEMO_RELAY_PORT: String(await freePort()),
            MONAD_TESTNET_HTTP_RPC_URL: 'http://127.0.0.1:1',
            E2E_DEMO_MAIN_WALLET_JSON: main,
            FRANK_DEMO_FAUCET_WALLET_JSON: faucet,
            CASHWEBD_BIN: relayStub('hang'),
          },
          envFile: {},
          fakeChainFlag: false,
          home: dir,
          cwd: dir,
        })
        return c
      }
      for (const same of [copy, link]) {
        const problems = await checkPrerequisites(await withBots(same))
        expect(problems.join('\n')).toMatch(/is the same wallet as the stamp wallet/)
      }
      // the same wallet written keystore-style (no 0x, different case) is still the same wallet
      const keystore = join(dir, 'keystore.json')
      writeFileSync(keystore, JSON.stringify({ address: 'AB'.repeat(20) }), { mode: 0o600 })
      expect((await checkPrerequisites(await withBots(keystore))).join('\n')).toMatch(
        /is the same wallet/,
      )
      // an address that is not 40 hex fails closed
      const junk = join(dir, 'junk.json')
      writeFileSync(junk, JSON.stringify({ address: '0x1234' }), { mode: 0o600 })
      expect((await checkPrerequisites(await withBots(junk))).join('\n')).toMatch(/valid "address"/)
      expect(await checkPrerequisites(await withBots(other))).toEqual([])
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
