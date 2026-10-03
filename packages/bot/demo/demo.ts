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
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { dirname, join, resolve } from 'path'

import { formatEther, Wallet } from 'ethers'

import { fetchMonadProfilesSince } from '@frank/wallet/monad-identity'

import { loadOrCreateIdentity } from '../qwen-bot-common'
import { ensurePrivateDir } from '../stamp-pool-seed'
import { collectCuratedEntries, renderCuratedDefaultsToml } from '../print-curated-defaults'
import { BOT_PROFILES } from '../bot-directory'
import { DemoBot, DemoConfig, DemoConfigError, minBlackjackFundsWei, resolveDemoConfig } from './demo-config'
import { checkDemoMode, writeDemoMode } from './demo-mode'
import { EnvFileError, readEnvFile } from './env-file'
import { startFakeRpc, FakeRpc } from './fake-rpc'
import {
  acquireLock,
  HeldLock,
  LockError,
  removeRunRecord,
  staleAdvice,
  takeStaleRecord,
  writeRunRecord,
} from './run-lock'
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
  /** Called instead of `process.exit` on a second signal during shutdown (tests). */
  forceExit?: (code: number) => void
  /**
   * Stop the stack when this launcher's parent process goes away. Set when a package-manager
   * wrapper (`yarn demo`) started it: `kill -INT <yarn pid>` kills yarn without forwarding the
   * signal, which would leave the stack running with no terminal to stop it. It is the same as a
   * SIGHUP (terminal closed). Nothing is killed because of it beyond this launcher's own children.
   */
  watchParent?: { pid: number; current?: () => number; intervalMs?: number }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Scrubs a log line before it is echoed: the exact secrets, then anything that looks like a
 * credential (URL paths and queries, api-key parameters, key-shaped tokens, long opaque strings). */
export function redact(text: string, secrets: string[]): string {
  let out = secrets.reduce((acc, s) => (s ? acc.split(s).join('<redacted>') : acc), text)
  // Credentials embedded in a URL (any scheme), then URL paths and queries (http/https/ws/wss).
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@"']+@/gi, '$1<redacted>@')
  out = out.replace(/\b((?:https?|wss?):\/\/[^/\s"'?#]+)[/?#][^\s"']*/gi, '$1/<redacted>')
  // Scheme-less provider URLs: host.tld/v2/KEY or host.tld/<long token>
  out = out.replace(/\b((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?)\/v\d+\/[^\s"']+/gi, '$1/<redacted>')
  out = out.replace(/\b((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?)\/[A-Za-z0-9_-]{16,}[^\s"']*/gi, '$1/<redacted>')
  // Cookies
  out = out.replace(/\b((?:set-)?cookie)\s*:[^\r\n]*/gi, '$1: <redacted>')
  // Authorization schemes, however short the token (a JWT after `bearer ` is one run of these)
  out = out.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>')
  // "the passphrase is ...": redact the rest of the line
  out = out.replace(
    /\b(passphrase|password|passwd|secret|token|mnemonic|seed phrase|recovery phrase)\s+(?:is|was)\s+[^\r\n]*/gi,
    '$1 is <redacted>',
  )
  // Credential-named keys (JSON, single-quoted JSON, env assignments, `password: x y`), with a
  // double-quoted, single-quoted or bare value. Plain `key=value` diagnostics are left alone.
  const NAMED =
    '(?:(?:[a-z0-9]+[_.-])*(?:api|access|secret|private|client|auth)[_. -]?(?:key|token|secret)|token|secret|password|passwd|passphrase|pwd|credentials?)'
  const ENV_SUFFIX = '[A-Za-z0-9_.-]*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE)'
  const assignment = new RegExp(
    `(["']?)\\b(${NAMED}|${ENV_SUFFIX})\\1(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&"'}\\]]+)`,
    'gi',
  )
  out = out.replace(assignment, (m, q: string, name: string, sep: string, value: string) => {
    if (
      /^[a-z0-9_.-]*_(?:key|token|secret|password|passwd|passphrase)$/i.test(name) &&
      !/^[a-z0-9_.-]*[A-Z]/.test(name) &&
      !new RegExp(`^${NAMED}$`, 'i').test(name)
    ) {
      return m // a lower-case snake_case name ending in _key (sort_key=...) is not env-style
    }
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : ''
    return `${q}${name}${q}${sep}${quote}<redacted>${quote}`
  })
  // A query parameter named key
  out = out.replace(/([?&])key=[^&\s"']+/gi, '$1key=<redacted>')
  // AWS access key ids, JWTs, key-shaped tokens
  out = out.replace(/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/g, '<redacted>')
  out = out.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g, '<redacted>')
  out = out.replace(/\b(?:sk|key|tok|pk)[-_][A-Za-z0-9_-]{12,}/g, '<redacted>')
  // Long opaque tokens (base64/hex, e.g. a bare private key), but never 0x-prefixed hex (addresses
  // and hashes) and never a plain long path or word: it must mix letters and digits.
  out = out.replace(/(?<![\w/.])[A-Za-z0-9+_-]{40,}(?![\w/])/g, tok =>
    /^0x[0-9a-f]+$/i.test(tok) || !/[0-9]/.test(tok) || !/[A-Za-z]/.test(tok) ? tok : '<redacted>',
  )
  // A recovery phrase: a run of 12 or more words (3-8 letters, any case) separated by spaces,
  // commas or newlines, whatever precedes it.
  out = out.replace(/(?<![A-Za-z<])(?:[A-Za-z]{3,8}[ \t,\r\n]+){11,}[A-Za-z]{3,8}(?![A-Za-z>])/g, '<redacted>')
  return out
}

/** Redacts a block of log lines as one text (a phrase can span lines), keeping the line split. */
export function redactLines(lines: string[], secrets: string[]): string[] {
  return redact(lines.join('\n'), secrets).split('\n')
}

/** The state dir is private to this user: created (or pre-existing) it must be ours and not
 * group/world-writable, and it is tightened to 0700. */
export function prepareStateDir(dir: string): void {
  ensurePrivateDir(dir)
  chmodSync(dir, 0o700)
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolvePort => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)))
  })
}

/** The `address` field of a wallet JSON file, normalised (no 0x, lower-case, exactly 40 hex), or
 * undefined if it is missing or not an address. Never touches the key. */
export function walletAddress(path: string): string | undefined {
  try {
    const address = (JSON.parse(readFileSync(path, 'utf8')) as { address?: unknown }).address
    if (typeof address !== 'string') return undefined
    const hex = address.trim().replace(/^0x/i, '').toLowerCase()
    return /^[0-9a-f]{40}$/.test(hex) ? hex : undefined
  } catch {
    return undefined
  }
}

/** One message per unmet prerequisite; empty when the demo can start. */
export async function checkPrerequisites(config: DemoConfig): Promise<string[]> {
  const problems: string[] = []
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) problems.push(`Node.js 20 or newer is required (this is ${process.versions.node})`)
  if (!existsSync(RELAY_SCRIPT)) {
    problems.push(`relay launcher not found at ${RELAY_SCRIPT} (run from a full checkout)`)
  }
  if (spawnSync('bash', ['--version']).error) problems.push('bash is required to start the relay')
  if (config.cashwebdBin) {
    if (!existsSync(config.cashwebdBin)) {
      problems.push(`CASHWEBD_BIN does not exist: ${config.cashwebdBin}`)
    }
  } else if (
    spawnSync('cargo', ['--version'], {
      env: { ...process.env, ...config.toolchainEnv },
    }).error
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
  if (!config.fakeChain) {
    const faucet = config.bots.find(b => b.name === 'faucet')
    const faucetPath = faucet?.env.E2E_DEMO_MAIN_WALLET_JSON
    if (faucetPath && existsSync(config.mainWalletJson) && existsSync(faucetPath)) {
      // Paths can differ (a copy, a symlink) while the wallet is the same: compare ADDRESSES.
      const main = walletAddress(config.mainWalletJson)
      const other = walletAddress(faucetPath)
      if (!main || !other) {
        problems.push(
          'the stamp wallet and the faucet wallet files must each be JSON with a valid "address" (40 hex characters, with or without 0x)',
        )
      } else if (main === other) {
        problems.push(
          `the faucet wallet (${faucetPath}) is the same wallet as the stamp wallet (${config.mainWalletJson}); the faucet needs its own funded testnet wallet`,
        )
      }
    }
  }
  if (!(await portIsFree(config.relayPort))) {
    problems.push(
      `port ${config.relayPort} is in use; is another demo (or relay) running? Set FRANK_DEMO_RELAY_PORT to use another`,
    )
  }
  if (config.fakeChain && !(await portIsFree(config.fakeRpcPort))) {
    problems.push(`port ${config.fakeRpcPort} is in use; set FRANK_DEMO_FAKE_RPC_PORT to use another`)
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
  const profiles = await fetchMonadProfilesSince({
    relayBaseUrl: relayUrl,
    sinceMs: 0,
  })
  return new Set(profiles.map(p => p.address.toLowerCase()))
}

function tsxArgs(script: string): string[] {
  return ['--import', 'tsx', script]
}

export async function startDemo(config: DemoConfig, options: StartOptions = {}): Promise<DemoHandle> {
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

  let shuttingDown = false
  let lock: HeldLock | undefined
  const stop = (): Promise<void> =>
    (stopped ??= (async () => {
      shuttingDown = true
      // Guards stay installed until everything is dead, so a second signal during the grace
      // period is handled (see onSignal) instead of falling to the default action.
      await supervisor.stopAll()
      await fakeRpc?.close()
      if (lock) removeRunRecord(config.stateDir)
      lock?.release()
      removeGuards()
      resolveDone(exitCode ?? 0)
    })())
  function requestStop(code: number): void {
    if (exitCode === undefined) exitCode = code
    void stop()
  }

  const signalCodes: Record<string, number> = {
    SIGINT: 130,
    SIGTERM: 143,
    SIGHUP: 129,
  }
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      // Second signal while stopping: no more grace. Kill the process groups THIS launcher
      // spawned (held in memory, never read from a file), release the lock and leave now.
      print(`\n[demo] received ${signal} again: killing all children now`)
      supervisor.killAllNow()
      lock?.release()
      removeRunRecord(config.stateDir)
      ;(options.forceExit ?? ((code: number) => process.exit(code)))(exitCode ?? signalCodes[signal])
      return
    }
    print(`\n[demo] received ${signal}, stopping ...`)
    requestStop(started ? 0 : signalCodes[signal])
  }
  const onFatal = (err: unknown) => {
    print(`[demo] unexpected error: ${err instanceof Error ? err.message : String(err)}`)
    requestStop(1)
  }
  const onExit = () => {
    supervisor.killAllNow() // last resort, synchronous
    lock?.release()
  }
  const signals = Object.keys(signalCodes) as NodeJS.Signals[]
  let parentTimer: NodeJS.Timeout | undefined
  const watch = options.watchParent
  if (watch) {
    const currentParent = watch.current ?? (() => process.ppid)
    parentTimer = setInterval(() => {
      if (currentParent() === watch.pid) return
      clearInterval(parentTimer)
      print(
        `\n[demo] the process that started this launcher (pid ${watch.pid}, e.g. yarn) is gone: stopping like a closed terminal`,
      )
      onSignal('SIGHUP')
    }, watch.intervalMs ?? 1000)
    parentTimer.unref()
  }
  for (const sig of signals) process.on(sig, onSignal)
  process.on('uncaughtException', onFatal)
  process.on('unhandledRejection', onFatal)
  process.on('exit', onExit)
  function removeGuards(): void {
    if (parentTimer) clearInterval(parentTimer)
    for (const sig of signals) process.off(sig, onSignal)
    process.off('uncaughtException', onFatal)
    process.off('unhandledRejection', onFatal)
    process.off('exit', onExit)
  }
  const abortIfStopping = () => {
    if (supervisor.isStopping()) throw new DemoAborted(exitCode ?? 1)
  }
  const writePidFile = () => writeRunRecord(config.stateDir, supervisor.listPids())

  const logDir = join(config.stateDir, 'logs')
  try {
    prepareStateDir(config.stateDir)
    // One launcher per state dir. A leftover run record is NEVER acted on (no process is killed
    // from a file): it is only reported, with commands for the operator to inspect it.
    try {
      lock = acquireLock(config.stateDir)
    } catch (err) {
      if (err instanceof LockError) throw new DemoConfigError([err.message])
      throw err
    }
    const modeProblem = checkDemoMode(config.stateDir, config.fakeChain ? 'fake-chain' : 'real')
    if (modeProblem) throw new DemoConfigError([modeProblem])
    const stale = takeStaleRecord(config.stateDir)
    const staleLines = stale ? staleAdvice(stale) : []
    if (stale) for (const line of staleLines) print(`[demo] ${line}`)
    const problems = await checkPrerequisites(config)
    if (problems.length > 0) {
      throw new DemoConfigError(problems.some(p => p.includes('is in use')) ? [...problems, ...staleLines] : problems)
    }
    // Only now is the run real enough to claim the directory for this mode.
    writeDemoMode(config.stateDir, config.fakeChain ? 'fake-chain' : 'real')
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
            JSON.stringify({
              address: wallet.address,
              privateKey: wallet.privateKey,
            }),
            { mode: 0o600 },
          )
          chmodSync(path, 0o600)
        }
        // Only the address is read, to fund it on the fake chain; the key never leaves the file.
        funded.push((JSON.parse(readFileSync(path, 'utf8')) as { address: string }).address)
      }
      fakeRpc = await startFakeRpc({
        port: config.fakeRpcPort,
        funded,
        stateFile: config.fakeChainLedger,
      })
      print(`[demo] fake chain RPC on ${fakeRpc.url} (no real funds, no keys)`)
      print(
        fakeRpc.restoredTransactions > 0
          ? `[demo] fake chain restored from ${config.fakeChainLedger} (${
              fakeRpc.restoredTransactions
            } transactions): balances and the faucet's records survive restarts; delete ${dirname(
              config.fakeChainLedger as string,
            )} to start a fresh chain`
          : `[demo] fake chain starts empty; it is saved to ${config.fakeChainLedger} and reloaded on the next start`,
      )
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
    const curated = collectCuratedEntries(identityEnv, (path, label) => loadOrCreateIdentity(path, label))
    if (curated.errors.length > 0 && Object.keys(identityEnv).length > 0) {
      throw new DemoConfigError(curated.errors)
    }
    const curatedToml = renderCuratedDefaultsToml(curated.entries)
    const curatedPath = join(config.stateDir, 'relay-curated.toml')
    writeFileSync(curatedPath, curatedToml, { mode: 0o600 })
    print('[demo] curated default contacts for the relay config (already applied to this demo relay):')
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
        ...(config.wsRpcUrl ? { MONAD_TESTNET_WS_RPC_URL: config.wsRpcUrl } : {}),
        FRANK_NETWORK_TAG: config.networkTag,
        CASHWEB_STAMP_MIN_BURN_VALUE_WEI: config.minStampWei,
        // The relay's topic routes (forum posts and votes) answer HTTP 500 without it (#364).
        MONAD_STAMP_BURN_ADDRESS: config.stampBurnAddress,
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
          ...redactLines(relay.tail().slice(-15), config.secrets).map(l => `  ${l}`),
        ])
      }
      if (Date.now() > relayDeadline) {
        throw new DemoConfigError([
          `the relay did not answer on ${config.relayUrl} in time; see ${join(logDir, 'relay.log')}`,
        ])
      }
      await sleep(options.pollMs ?? 500)
    }
    abortIfStopping()
    print(`[demo] relay is up at ${config.relayUrl}`)

    const readyLines = new Set<string>()
    for (const bot of config.bots) {
      mkdirSync(join(config.stateDir, 'bots', bot.name), {
        recursive: true,
        mode: 0o700,
      })
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
          ...redactLines(child?.tail().slice(-15) ?? [], config.secrets).map(l => `  ${l}`),
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

/** The exact shell command that starts the app so its browser can reach this stack. */
export function appCommand(config: DemoConfig, relayUrl: string): string[] {
  return [
    `cd app && QCLI_MONAD_RELAY_BASE_URL=${relayUrl} QCLI_MONAD_RPC_CHAIN=monad-testnet \\`,
    `  QCLI_MONAD_STAMP_BURN_ADDRESS=${config.stampBurnAddress} QCLI_CASHWEB_STAMP_MIN_BURN_VALUE_WEI=${config.minStampWei} \\`,
    '  yarn dev:browser',
  ]
}

export function printSummary(handle: DemoHandle, print: (line: string) => void): void {
  const { config } = handle
  const appUrl = `http://localhost:${config.appPort}`
  print('')
  print(`Frank demo is running (launcher pid ${process.pid}).`)
  print(`  Relay:   ${handle.relayUrl}`)
  print(
    `  Chain:   ${
      config.fakeChain
        ? `FAKE chain at ${config.rpcUrl} (no real funds; saved in ${config.fakeChainLedger}, so balances survive a restart)`
        : 'Monad testnet (RPC URL hidden)'
    }`,
  )
  print(`  Burn:    ${config.stampBurnAddress} (relay, bots and the app command below all use it)`)
  if (config.faucetAmountWei) {
    const needed = minBlackjackFundsWei()
    print(
      `  Faucet:  ${formatEther(config.faucetAmountWei)} MON per new profile` +
        (BigInt(config.faucetAmountWei) < needed
          ? `  WARNING: less than the ${formatEther(
              needed,
            )} MON one minimum-bet blackjack hand needs; raise FAUCET_AMOUNT_WEI (max 1 MON)`
          : ''),
    )
  }
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
  print(`  App URL: ${appUrl}  (the app dev server's port is fixed in app/quasar.config.js)`)
  print('  Start the app in another terminal, from the repo root, with exactly this:')
  for (const line of appCommand(config, handle.relayUrl)) print(`    ${line}`)
  print(
    config.fakeChain
      ? '  The fake chain and the relay accept requests from any origin, so the browser reaches them directly.'
      : '  The relay accepts requests from any origin; your RPC provider must allow the app origin.',
  )
  const bad = handle.unhealthy()
  if (bad.length > 0) print(`  UNHEALTHY: ${bad.join(', ')} exited (see the logs above)`)
  print(
    `Press Ctrl-C to stop everything (or kill -INT ${process.pid}; also stops if the yarn process that started it is killed).`,
  )
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
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
    const handle = await startDemo(config, {
      print,
      env,
      // Started by `yarn demo`: stop the stack if yarn is killed without forwarding the signal.
      watchParent: env.npm_lifecycle_event ? { pid: process.ppid } : undefined,
    })
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
