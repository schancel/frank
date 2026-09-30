import { ChildProcess, spawn } from 'child_process'
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

import { DemoBot, DemoConfig, DemoConfigError, resolveDemoConfig } from './demo-config'
import {
  cleanupStaleRun,
  DemoAborted,
  DemoHandle,
  prepareStateDir,
  redact,
  startDemo,
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
  function relayStub(kind: 'hang' | 'http' | 'leak'): string {
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
        'apikey=<redacted>&other=1 and key=<redacted>',
      )
      expect(redact('bearer sk-abcdefghijklmnop1234 ok', [])).toBe('bearer <redacted> ok')
      expect(redact(`blob ${'A'.repeat(48)} end`, [])).toBe('blob <redacted> end')
      expect(redact('http://127.0.0.1:8098 is up', [])).toBe('http://127.0.0.1:8098 is up')
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

    it('stop() is idempotent and a Ctrl-C style signal after startup exits 0', async () => {
      const { handle } = await running()
      process.emit('SIGHUP', 'SIGHUP')
      expect(await handle.done).toBe(0)
      await handle.stop()
      await handle.stop()
    }, 30000)
  })

  describe('the real CLI (separate process)', () => {
    async function runCli(signal: NodeJS.Signals, expectedCode: number): Promise<void> {
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
            CASHWEBD_BIN: relayStub('hang'),
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
      cli.kill(signal)
      expect(await exit).toBe(expectedCode)
      await waitFor(() => !alive(relayPid), 5000)
      expect(await portFree(rpcPort)).toBe(true)
      expect(await portFree(relayPort)).toBe(true)
    }

    it('Ctrl-C (SIGINT) during "starting the relay" leaves no relay process or port', async () => {
      await runCli('SIGINT', 130)
    }, 60000)
    it('SIGTERM during startup leaves nothing behind', async () => {
      await runCli('SIGTERM', 143)
    }, 60000)
    it('SIGHUP (terminal closed) during startup leaves nothing behind', async () => {
      await runCli('SIGHUP', 129)
    }, 60000)
  })

  describe('leftovers of a launcher that was killed hard', () => {
    function orphan(name: string, body: string): ChildProcess {
      const script = join(dir, name)
      writeFileSync(script, body)
      const child = spawn('bash', [script], { detached: true, stdio: 'ignore' })
      spawned.push(child)
      return child
    }
    const stateDir = () => {
      const d = join(dir, 'state')
      mkdirSync(d, { recursive: true, mode: 0o700 })
      return d
    }

    it('kills leftover process groups that still look like ours, and removes the pid file', async () => {
      const child = orphan('bot.livecheck.sh', 'sleep 60 & wait')
      await sleep(200)
      const state = stateDir()
      writeFileSync(
        join(state, 'demo.pid'),
        JSON.stringify({ launcher: 2147483000, children: [{ name: 'bot', pid: child.pid }] }),
      )
      const notes = cleanupStaleRun(state)
      expect(notes.join()).toMatch(/stopped a leftover bot/)
      await waitFor(() => !alive(child.pid as number), 5000)
      expect(existsSync(join(state, 'demo.pid'))).toBe(false)
    })

    it('does not kill a reused pid whose command is not ours', async () => {
      const decoy = orphan('sleeper.sh', 'sleep 60')
      await sleep(200)
      const state = stateDir()
      writeFileSync(
        join(state, 'demo.pid'),
        JSON.stringify({ launcher: 2147483000, children: [{ name: 'x', pid: decoy.pid }] }),
      )
      expect(cleanupStaleRun(state)).toEqual([])
      expect(alive(decoy.pid as number)).toBe(true)
    })

    it('refuses while the previous launcher is still running', () => {
      const state = stateDir()
      writeFileSync(
        join(state, 'demo.pid'),
        JSON.stringify({ launcher: process.ppid, children: [] }),
      )
      expect(() => cleanupStaleRun(state)).toThrow(/another demo is already running/)
    })

    it('an unreadable pid file is ignored and removed', () => {
      const state = stateDir()
      writeFileSync(join(state, 'demo.pid'), 'garbage')
      expect(cleanupStaleRun(state)).toEqual([])
      expect(existsSync(join(state, 'demo.pid'))).toBe(false)
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
