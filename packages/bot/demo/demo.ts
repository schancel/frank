/**
 * One-command demo (#312): `yarn demo` from the repo root (or `yarn demo` in packages/bot).
 *
 * Starts, in order: an optional fake chain RPC (`--fake-chain`), the local relay (through the
 * existing `backend/cashweb/run-local-monad.sh`), then the blackjack dealer, raffle, picture shop,
 * Qwen (stub mode unless QWEN_API_KEY is set) and the testnet faucet. Creates any missing bot
 * identity, prints the relay's curated-default config lines, waits until the relay answers and
 * every bot is up (identity bots: their profile is visible on the relay), prints the addresses,
 * and tears everything down on Ctrl-C.
 *
 * Configuration comes ONLY from environment variables and the user's `.env` file (see
 * `demo-config.ts`, the README table). Missing prerequisites print one clear line each, never a
 * stack trace.
 */
import { spawnSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { createServer } from 'net'
import { dirname, join, resolve } from 'path'

import { Wallet } from 'ethers'

import { fetchMonadProfilesSince } from '@frank/wallet/monad-identity'

import { loadOrCreateIdentity } from '../qwen-bot-common'
import { ensurePrivateDir } from '../stamp-pool-seed'
import { collectCuratedEntries, renderCuratedDefaultsToml } from '../print-curated-defaults'
import { BOT_PROFILES } from '../bot-directory'
import { DemoBot, DemoConfig, DemoConfigError, resolveDemoConfig } from './demo-config'
import { EnvFileError, readEnvFile } from './env-file'
import { startFakeRpc, FakeRpc } from './fake-rpc'
import { SupervisedChild, Supervisor } from './supervisor'

const BOT_DIR = resolve(__dirname, '..')
const REPO_ROOT = resolve(BOT_DIR, '..', '..')
const RELAY_SCRIPT = join(REPO_ROOT, 'backend', 'cashweb', 'run-local-monad.sh')

export interface DemoHandle {
  config: DemoConfig
  relayUrl: string
  /** Identity bots' addresses by bot name. */
  addresses: Record<string, string>
  fakeRpc?: FakeRpc
  logDir: string
  /** Stops everything (idempotent, safe at any point). */
  stop(): Promise<void>
  /** Resolves with the process exit code once the demo has stopped, for any reason (Ctrl-C, a
   * signal, the relay dying, an unexpected error). */
  done: Promise<number>
  /** Names of children that exited unexpectedly (they are not restarted). */
  unhealthy(): string[]
}

/** Thrown from startDemo when a stop was requested (a signal) before startup finished. */
export class DemoAborted extends Error {
  constructor(readonly exitCode: number) {
    super('demo startup aborted')
  }
}

export interface StartOptions {
  print?: (line: string) => void
  /** Environment of the launcher process (children get only the named variables). */
  env?: Record<string, string | undefined>
  /** Seconds to wait for the relay (a cold Cargo build can take many minutes). */
  relayTimeoutS?: number
  botTimeoutS?: number
  /** Readiness poll interval override (tests). */
  pollMs?: number
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Scrubs a log line before it is echoed: the exact secrets, then anything that looks like a
 * credential (URL paths and queries, api-key parameters, key-shaped tokens, long opaque strings). */
export function redact(line: string, secrets: string[]): string {
  let out = secrets.reduce((acc, s) => (s ? acc.split(s).join('<redacted>') : acc), line)
  out = out.replace(/(https?:\/\/[^/\s"'?#]+)[/?#][^\s"']*/gi, '$1/<redacted>')
  out = out.replace(/\b((?:api[_-]?)?key|token|secret|password)=[^&\s"']+/gi, '$1=<redacted>')
  out = out.replace(/\b(?:sk|key|tok|pk)[-_][A-Za-z0-9_-]{12,}/g, '<redacted>')
  out = out.replace(/\b[A-Za-z0-9+/_-]{40,}\b/g, '<redacted>')
  return out
}

const STALE_MARKERS = /run-local-monad|livecheck|cashwebd|frank/

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function commandOf(pid: number): string {
  return spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? ''
}

/** The state dir is private to this user: created (or pre-existing) it must be ours and not
 * group/world-writable, and it is tightened to 0700. */
export function prepareStateDir(dir: string): void {
  ensurePrivateDir(dir)
  chmodSync(dir, 0o700)
}

const pidFilePath = (stateDir: string) => join(stateDir, 'demo.pid')

/** A previous launcher that was killed hard (SIGKILL, power loss) cannot clean up. Its pid file
 * names its children: refuse if that launcher is still running, otherwise kill the leftover
 * process groups (only those whose command still looks like ours, since pids get reused). Returns
 * a message per action; throws when another demo is running on this state dir. */
export function cleanupStaleRun(stateDir: string): string[] {
  const path = pidFilePath(stateDir)
  if (!existsSync(path)) return []
  const notes: string[] = []
  try {
    const rec = JSON.parse(readFileSync(path, 'utf8')) as {
      launcher?: number
      children?: Array<{ name: string; pid: number }>
    }
    if (rec.launcher && rec.launcher !== process.pid && isAlive(rec.launcher)) {
      throw new DemoConfigError([
        `another demo is already running on ${stateDir} (launcher pid ${rec.launcher}); stop it first (Ctrl-C)`,
      ])
    }
    for (const c of rec.children ?? []) {
      if (
        Number.isInteger(c.pid) &&
        c.pid > 1 &&
        isAlive(c.pid) &&
        STALE_MARKERS.test(commandOf(c.pid))
      ) {
        try {
          process.kill(-c.pid, 'SIGKILL')
        } catch {
          try {
            process.kill(c.pid, 'SIGKILL')
          } catch {
            /* gone */
          }
        }
        notes.push(
          `stopped a leftover ${c.name} (pid ${c.pid}) from a previous run that was killed`,
        )
      }
    }
  } catch (err) {
    if (err instanceof DemoConfigError) throw err
    /* unreadable pid file: ignore it */
  }
  try {
    unlinkSync(path)
  } catch {
    /* already gone */
  }
  return notes
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolvePort => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)))
  })
}

/** One message per unmet prerequisite; empty when the demo can start. */
export async function checkPrerequisites(config: DemoConfig): Promise<string[]> {
  const problems: string[] = []
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20)
    problems.push(`Node.js 20 or newer is required (this is ${process.versions.node})`)
  if (!existsSync(RELAY_SCRIPT)) {
    problems.push(`relay launcher not found at ${RELAY_SCRIPT} (run from a full checkout)`)
  }
  if (spawnSync('bash', ['--version']).error) problems.push('bash is required to start the relay')
  if (config.cashwebdBin) {
    if (!existsSync(config.cashwebdBin)) {
      problems.push(`CASHWEBD_BIN does not exist: ${config.cashwebdBin}`)
    }
  } else if (
    spawnSync('cargo', ['--version'], { env: { ...process.env, ...config.toolchainEnv } }).error
  ) {
    problems.push(
      'the relay is built with Cargo, but `cargo` was not found: install Rust (rustup.rs) or set CASHWEBD_BIN to a prebuilt cashwebd-exe',
    )
  }
  if (!config.fakeChain) {
    if (!existsSync(config.mainWalletJson)) {
      problems.push(`E2E_DEMO_MAIN_WALLET_JSON does not exist: ${config.mainWalletJson}`)
    } else if ((statSync(config.mainWalletJson).mode & 0o077) !== 0) {
      problems.push(
        `E2E_DEMO_MAIN_WALLET_JSON (${config.mainWalletJson}) is readable by other users; run: chmod 600 ${config.mainWalletJson}`,
      )
    }
  }
  if (!(await portIsFree(config.relayPort))) {
    problems.push(
      `port ${config.relayPort} is in use; is another demo (or relay) running? Set FRANK_DEMO_RELAY_PORT to use another`,
    )
  }
  if (config.fakeChain && !(await portIsFree(config.fakeRpcPort))) {
    problems.push(
      `port ${config.fakeRpcPort} is in use; set FRANK_DEMO_FAKE_RPC_PORT to use another`,
    )
  }
  return problems
}

// `fetch` is global in the Node versions this runs on; the package's older @types/node omits it.
const fetchFn = (
  globalThis as unknown as {
    fetch: (url: string) => Promise<{ ok: boolean }>
  }
).fetch

async function relayIsUp(relayUrl: string): Promise<boolean> {
  try {
    const res = await fetchFn(`${relayUrl}/metadata/monad?since=${Date.now() + 86_400_000}`)
    return res.ok
  } catch {
    return false
  }
}

async function registeredAddresses(relayUrl: string): Promise<Set<string>> {
  const profiles = await fetchMonadProfilesSince({ relayBaseUrl: relayUrl, sinceMs: 0 })
  return new Set(profiles.map(p => p.address.toLowerCase()))
}

function tsxArgs(script: string): string[] {
  return ['--import', 'tsx', script]
}

export async function startDemo(
  config: DemoConfig,
  options: StartOptions = {},
): Promise<DemoHandle> {
  const print = options.print ?? ((line: string) => console.log(line))
  const baseEnv = options.env ?? process.env

  // Everything that can fail or be interrupted from here on goes through one stop(): signal
  // handlers are installed BEFORE the first child is spawned, so an interrupt at any point kills
  // every child process group instead of orphaning them.
  const unhealthy: string[] = []
  let started = false
  let exitCode: number | undefined
  let fakeRpc: FakeRpc | undefined
  let stopped: Promise<void> | undefined
  let resolveDone: (code: number) => void = () => {}
  const done = new Promise<number>(r => (resolveDone = r))

  const supervisor: Supervisor = new Supervisor(baseEnv, print, (child: SupervisedChild) => {
    unhealthy.push(child.name)
    print('')
    print('!!!!!!!! DEMO UNHEALTHY !!!!!!!!')
    print(`!! ${child.name} exited and is NOT restarted; see ${child.logPath}`)
    print('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
    if (child.name === 'relay' && started) {
      print('[demo] the relay is gone, so the demo is unusable: stopping everything')
      requestStop(1)
    }
  })

  const stop = (): Promise<void> =>
    (stopped ??= (async () => {
      removeGuards()
      await supervisor.stopAll()
      await fakeRpc?.close()
      try {
        unlinkSync(pidFilePath(config.stateDir))
      } catch {
        /* never written or already gone */
      }
      resolveDone(exitCode ?? 0)
    })())
  function requestStop(code: number): void {
    if (exitCode === undefined) exitCode = code
    void stop()
  }

  const signalCodes: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
  const onSignal = (signal: NodeJS.Signals) => {
    print(`\n[demo] received ${signal}, stopping ...`)
    requestStop(started ? 0 : signalCodes[signal])
  }
  const onFatal = (err: unknown) => {
    print(`[demo] unexpected error: ${err instanceof Error ? err.message : String(err)}`)
    requestStop(1)
  }
  const onExit = () => supervisor.killAllNow() // last resort, synchronous
  const signals = Object.keys(signalCodes) as NodeJS.Signals[]
  for (const sig of signals) process.on(sig, onSignal)
  process.on('uncaughtException', onFatal)
  process.on('unhandledRejection', onFatal)
  process.on('exit', onExit)
  function removeGuards(): void {
    for (const sig of signals) process.off(sig, onSignal)
    process.off('uncaughtException', onFatal)
    process.off('unhandledRejection', onFatal)
    process.off('exit', onExit)
  }
  const abortIfStopping = () => {
    if (supervisor.isStopping()) throw new DemoAborted(exitCode ?? 1)
  }
  const writePidFile = () =>
    writeFileSync(
      pidFilePath(config.stateDir),
      JSON.stringify({ launcher: process.pid, children: supervisor.listPids() }),
      { mode: 0o600 },
    )

  const logDir = join(config.stateDir, 'logs')
  try {
    prepareStateDir(config.stateDir)
    for (const note of cleanupStaleRun(config.stateDir)) print(`[demo] ${note}`)
    const problems = await checkPrerequisites(config)
    if (problems.length > 0) throw new DemoConfigError(problems)
    prepareStateDir(logDir)

    if (config.fakeChain) {
      const walletPaths = new Set([
        config.mainWalletJson,
        ...config.bots.map(b => b.env.E2E_DEMO_MAIN_WALLET_JSON).filter(Boolean),
      ])
      const funded: string[] = []
      for (const path of walletPaths) {
        if (!existsSync(path)) {
          const wallet = Wallet.createRandom()
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
          writeFileSync(
            path,
            JSON.stringify({ address: wallet.address, privateKey: wallet.privateKey }),
            { mode: 0o600 },
          )
          chmodSync(path, 0o600)
        }
        // Only the address is read, to fund it on the fake chain; the key never leaves the file.
        funded.push((JSON.parse(readFileSync(path, 'utf8')) as { address: string }).address)
      }
      fakeRpc = await startFakeRpc({ port: config.fakeRpcPort, funded })
      print(`[demo] fake chain RPC on ${fakeRpc.url} (no real funds, no keys)`)
    }

    // Identities first: the relay's curated defaults are config, so they must exist before it starts.
    const addresses: Record<string, string> = {}
    const identityEnv: Record<string, string> = {}
    for (const bot of config.bots) {
      if (!bot.identityJson) continue
      mkdirSync(dirname(bot.identityJson), { recursive: true, mode: 0o700 })
      addresses[bot.name] = loadOrCreateIdentity(bot.identityJson, bot.name).displayAddress
      const spec = BOT_PROFILES.find(s => s.key === bot.name)
      if (spec) identityEnv[spec.identityEnv] = bot.identityJson
    }
    const curated = collectCuratedEntries(identityEnv, (path, label) =>
      loadOrCreateIdentity(path, label),
    )
    if (curated.errors.length > 0 && Object.keys(identityEnv).length > 0) {
      throw new DemoConfigError(curated.errors)
    }
    const curatedToml = renderCuratedDefaultsToml(curated.entries)
    const curatedPath = join(config.stateDir, 'relay-curated.toml')
    writeFileSync(curatedPath, curatedToml, { mode: 0o600 })
    print(
      '[demo] curated default contacts for the relay config (already applied to this demo relay):',
    )
    print(curatedToml.trimEnd())
    abortIfStopping()

    const relayDb = join(config.stateDir, 'relay', 'registry.rocksdb')
    mkdirSync(dirname(relayDb), { recursive: true, mode: 0o700 })
    const relay = supervisor.start({
      name: 'relay',
      command: 'bash',
      args: [RELAY_SCRIPT],
      cwd: REPO_ROOT,
      logPath: join(logDir, 'relay.log'),
      env: {
        MONAD_TESTNET_HTTP_RPC_URL: config.rpcUrl,
        FRANK_NETWORK_TAG: config.networkTag,
        CASHWEB_STAMP_MIN_BURN_VALUE_WEI: config.minStampWei,
        FRANK_RELAY_LISTEN: `127.0.0.1:${config.relayPort}`,
        FRANK_RELAY_DB_PATH: relayDb,
        FRANK_RELAY_EXTRA_TOML: curatedPath,
        FRANK_RUN_LOCAL_SKIP_DOTENV: '1',
        ...(config.cashwebdBin ? { CASHWEBD_BIN: config.cashwebdBin } : {}),
        ...config.toolchainEnv,
      },
    })
    writePidFile()
    print(
      config.cashwebdBin
        ? '[demo] starting the relay ...'
        : '[demo] starting the relay (the first run builds it with Cargo and can take several minutes) ...',
    )
    const relayDeadline = Date.now() + (options.relayTimeoutS ?? 1800) * 1000
    while (!(await relayIsUp(config.relayUrl))) {
      abortIfStopping()
      if (relay.hasExited()) {
        throw new DemoConfigError([
          `the relay exited during startup. Last output (${join(logDir, 'relay.log')}):`,
          ...relay
            .tail()
            .slice(-15)
            .map(l => `  ${redact(l, config.secrets)}`),
        ])
      }
      if (Date.now() > relayDeadline) {
        throw new DemoConfigError([
          `the relay did not answer on ${config.relayUrl} in time; see ${join(
            logDir,
            'relay.log',
          )}`,
        ])
      }
      await sleep(options.pollMs ?? 500)
    }
    abortIfStopping()
    print(`[demo] relay is up at ${config.relayUrl}`)

    const readyLines = new Set<string>()
    for (const bot of config.bots) {
      mkdirSync(join(config.stateDir, 'bots', bot.name), { recursive: true, mode: 0o700 })
      supervisor.start({
        name: bot.name,
        command: process.execPath,
        args: tsxArgs(bot.script),
        cwd: BOT_DIR,
        logPath: join(logDir, `${bot.name}.log`),
        env: bot.env,
        onLine: line => {
          if (bot.readyLine.test(line)) readyLines.add(bot.name)
        },
      })
      writePidFile()
    }

    const botDeadline = Date.now() + (options.botTimeoutS ?? 240) * 1000
    const waiting = new Set<DemoBot>(config.bots)
    while (waiting.size > 0) {
      abortIfStopping()
      const registered = await registeredAddresses(config.relayUrl).catch(() => new Set<string>())
      for (const bot of [...waiting]) {
        const address = addresses[bot.name]?.toLowerCase()
        // Started (its loop is running) AND, for identity bots, visible to users on the relay.
        const ready = readyLines.has(bot.name) && (!address || registered.has(address))
        if (ready) {
          waiting.delete(bot)
          print(`[demo] ${bot.name} is ready`)
        }
      }
      if (waiting.size === 0) break
      const dead = [...waiting].find(b => supervisor.get(b.name)?.hasExited())
      if (dead || Date.now() > botDeadline) {
        const name = (dead ?? [...waiting][0]).name
        const child = supervisor.get(name)
        throw new DemoConfigError([
          `${name} did not become ready${dead ? ' (it exited)' : ' in time'}. Last output (${join(
            logDir,
            `${name}.log`,
          )}):`,
          ...(child
            ?.tail()
            .slice(-15)
            .map(l => `  ${redact(l, config.secrets)}`) ?? []),
        ])
      }
      await sleep(options.pollMs ?? 1000)
    }
    abortIfStopping()

    started = true
    return {
      config,
      relayUrl: config.relayUrl,
      addresses,
      fakeRpc,
      logDir,
      stop,
      done,
      unhealthy: () => [...unhealthy],
    }
  } catch (err) {
    requestStop(err instanceof DemoAborted ? err.exitCode : 1)
    await done
    throw err
  }
}

export function printSummary(handle: DemoHandle, print: (line: string) => void): void {
  const { config } = handle
  const rpcForApp = config.fakeChain ? config.rpcUrl : '<your MONAD_TESTNET_HTTP_RPC_URL>'
  print('')
  print('Frank demo is running.')
  print(`  Relay:   ${handle.relayUrl}`)
  print(
    `  Chain:   ${
      config.fakeChain
        ? `FAKE chain at ${config.rpcUrl} (no real funds)`
        : 'Monad testnet (RPC URL hidden)'
    }`,
  )
  print(`  State:   ${config.stateDir}   Logs: ${handle.logDir}`)
  print('  Bots:')
  for (const bot of config.bots) {
    const address = handle.addresses[bot.name]
    print(`    ${bot.name.padEnd(10)} ${address ?? '(no profile; sends transfers only)'}`)
  }
  print(
    config.qwenMode === 'stub'
      ? '  Qwen:    STUB mode (offline canned replies; set QWEN_API_KEY for a real model)'
      : '  Qwen:    live model',
  )
  print('  App (in another terminal):')
  print(
    `    cd app && QCLI_MONAD_TESTNET_HTTP_RPC_URL=${rpcForApp} QCLI_MONAD_RELAY_BASE_URL=${handle.relayUrl} \\`,
  )
  print(
    `      QCLI_MONAD_STAMP_BURN_ADDRESS=0x000000000000000000000000000000000000dEaD QCLI_CASHWEB_STAMP_MIN_BURN_VALUE_WEI=${config.minStampWei} yarn dev:browser`,
  )
  const bad = handle.unhealthy()
  if (bad.length > 0) print(`  UNHEALTHY: ${bad.join(', ')} exited (see the logs above)`)
  print('Press Ctrl-C to stop everything.')
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const print = (line: string) => console.log(line)
  try {
    const envFilePath = env.FRANK_DEMO_ENV_FILE
      ? resolve(env.INIT_CWD ?? process.cwd(), env.FRANK_DEMO_ENV_FILE)
      : join(REPO_ROOT, '.env')
    const config = resolveDemoConfig({
      env,
      envFile: readEnvFile(envFilePath),
      fakeChainFlag: argv.includes('--fake-chain'),
      // `yarn demo` runs inside packages/bot; relative paths mean relative to where the user typed it.
      cwd: env.INIT_CWD ?? process.cwd(),
    })
    const handle = await startDemo(config, { print, env })
    printSummary(handle, print)
    const code = await handle.done
    print('[demo] stopped.')
    return code
  } catch (err) {
    if (err instanceof DemoAborted) return err.exitCode
    if (err instanceof DemoConfigError || err instanceof EnvFileError) {
      console.error('Frank demo cannot start:')
      for (const line of err.message.split('\n')) console.error(`  ${line}`)
      return 1
    }
    throw err
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then(
    code => process.exit(code),
    err => {
      console.error('Frank demo failed unexpectedly:', err instanceof Error ? err.message : err)
      process.exit(1)
    },
  )
}
