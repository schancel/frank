/**
 * One-command demo (#312): `yarn demo` from the repo root (or `yarn demo` in packages/bot).
 *
 * Runs on Monad testnet, the only mode. Starts, in order: the local relay (through
 * `backend/cashweb/run-local-monad.sh`), then ONE process that runs every bot on one bot host
 * (`targets/all-bots.ts`), so the funding wallet has one user and one source of nonces. Creates
 * any missing bot identity, checks the funding wallet can fund the bots, waits until the relay
 * answers and every bot is registered and funded on chain, prints the addresses, and tears
 * everything down on Ctrl-C. A bot that fails to start or is not funded is reported by name.
 *
 * Configuration comes ONLY from environment variables and the user's `.env` file (see
 * `demo-config.ts`, the README table). Missing prerequisites print one clear line each, never a
 * stack trace.
 */
import { spawnSync } from 'child_process'
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { dirname, join, resolve } from 'path'

import { formatEther } from 'ethers'

import { fetchMonadProfilesSince } from '@frank/wallet/monad-identity'

import { ensurePrivateDir } from '../stamp-pool-seed'
import { renderCuratedDefaultsToml } from '../print-curated-defaults'
import { prepareBotIdentities } from './demo-identities'
import { chainBalanceWei, rpcCall } from './chain-rpc'
import { DEMO_MIN_BOT_BALANCE_WEI, HOST_STAMP_TOP_UP_BELOW_WEI, HOST_STAMP_TOP_UP_TO_WEI, DemoBot, DemoConfig, DemoConfigError, minBlackjackFundsWei, resolveDemoConfig, resolveDirectoryDemoConfig } from './demo-config'
import { EnvFileError, readEnvFile } from './env-file'
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
import { startNgrok } from './ngrok'

const BOT_DIR = resolve(__dirname, '..')
const REPO_ROOT = resolve(BOT_DIR, '..', '..')
const RELAY_SCRIPT = join(REPO_ROOT, 'backend', 'cashweb', 'run-local-monad.sh')

export interface DemoHandle {
  config: DemoConfig
  relayUrl: string
  publicRelayUrl?: string
  publicAppUrl?: string
  /** Bots' identity addresses by bot name. */
  addresses: Record<string, string>
  /** The account each bot pays stamps from, by bot name. */
  mainAccounts: Record<string, string>
  /** Address of the one funding wallet. */
  fundingAddress: string
  /** One line per bot that failed to start or is not funded on chain. Empty when all is well. */
  botProblems: string[]
  logDir: string
  /** Stops everything (idempotent, safe at any point). */
  stop(): Promise<void>
  /** Resolves with the process exit code once the demo has stopped, for any reason (Ctrl-C, a
   * signal, the relay dying, an unexpected error). */
  done: Promise<number>
  /** Names of children that exited unexpectedly (they are not restarted). */
  unhealthy(): string[]
  appStarted?: boolean
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
  /**
   * Whether to launch the Quasar dev server. Default false in startDemo options unless explicitly passed.
   */
  startApp?: boolean
  /** Reads an address's balance from the chain (tests replace it; the default asks the RPC). */
  getBalance?: (address: string) => Promise<bigint>
  /** Reads the chain's gas price in wei (tests replace it; the default asks the RPC). */
  getGasPrice?: () => Promise<bigint>
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
  if (!existsSync(config.mainWalletJson)) {
    problems.push(`E2E_DEMO_MAIN_WALLET_JSON does not exist: ${config.mainWalletJson}`)
  } else if ((statSync(config.mainWalletJson).mode & 0o077) !== 0) {
    problems.push(
      `E2E_DEMO_MAIN_WALLET_JSON (${config.mainWalletJson}) is readable by other users; run: chmod 600 ${config.mainWalletJson}`,
    )
  } else if (!walletAddress(config.mainWalletJson)) {
    problems.push(
      `E2E_DEMO_MAIN_WALLET_JSON (${config.mainWalletJson}) must be JSON with a valid "address" (40 hex characters, with or without 0x)`,
    )
  }
  if (!(await portIsFree(config.relayPort))) {
    problems.push(
      `port ${config.relayPort} is in use; is another demo (or relay) running? Set FRANK_DEMO_RELAY_PORT to use another`,
    )
  }
  if (config.ngrok) {
    if (spawnSync(config.ngrokBin, ['version']).error) {
      problems.push(
        `ngrok was requested (FRANK_DEMO_NGROK=1 or --ngrok), but "${config.ngrokBin}" was not found: install ngrok (https://ngrok.com) or set FRANK_DEMO_NGROK_BIN`,
      )
    }
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

/** The addresses the bot host funds for a bot: its identity address (payouts and transfers; the
 * faucet pays straight from the funding wallet, so not for it) and its stamp account. */
export function fundingTargets(
  bot: string,
  addresses: Record<string, string>,
  mainAccounts: Record<string, string>,
): Array<{ label: string; address: string }> {
  return [
    ...(bot === 'faucet' ? [] : [{ label: 'identity address', address: addresses[bot] }]),
    { label: 'stamp account', address: mainAccounts[bot] },
  ]
}

export interface FundingNeed {
  /** What the bot host will send to bot accounts. */
  transfersWei: bigint
  /** Gas for those transfers, with a margin. */
  gasWei: bigint
  /** transfersWei + gasWei: what this start draws from the funding wallet. */
  drawWei: bigint
  /** The accounts that will be funded, `<bot> <which account>`. */
  low: string[]
}

/** What the bot host will draw from the funding wallet when the bots start, read from the chain
 * and worked out by the host's own rules: a transfer account under its refill mark is brought up
 * to the refill amount, a stamp account under 0.1 MON to 0.5; each is one plain transfer. Reads
 * balances only; nothing is sent. */
export async function fundingNeed(
  config: DemoConfig,
  params: {
    addresses: Record<string, string>
    mainAccounts: Record<string, string>
    getBalance: (address: string) => Promise<bigint>
    gasPriceWei: bigint
  },
): Promise<FundingNeed> {
  let transfersWei = 0n
  const low: string[] = []
  for (const bot of config.bots) {
    for (const target of fundingTargets(bot.name, params.addresses, params.mainAccounts)) {
      const balance = await params.getBalance(target.address)
      const stamp = target.label === 'stamp account'
      const below = stamp ? HOST_STAMP_TOP_UP_BELOW_WEI : config.funding.topUpBelowWei
      const to = stamp ? HOST_STAMP_TOP_UP_TO_WEI : config.funding.topUpToWei
      if (balance >= below) continue
      transfersWei += to - balance
      low.push(`${bot.name} ${target.label}`)
    }
  }
  // A plain transfer costs 21000 x the gas price; twice that, in case the price moves.
  const gasWei = BigInt(low.length) * 21_000n * params.gasPriceWei * 2n
  return { transfersWei, gasWei, drawWei: transfersWei + gasWei, low }
}

/** Lines explaining why this start may not go ahead, or undefined when it may: either the start
 * would draw more than the operator allowed, or the funding wallet cannot cover the draw and the
 * reserve the host keeps in it. Nothing has been started or spent when this speaks. */
export async function fundingRefusal(
  config: DemoConfig,
  need: FundingNeed,
  fundingAddress: string,
  fundingBalanceWei: bigint,
): Promise<string[] | undefined> {
  if (need.low.length === 0) return undefined
  const what = `${need.low.length} bot accounts need funding: starting would draw ${formatEther(need.drawWei)} testnet MON (${formatEther(need.transfersWei)} in transfers, up to ${formatEther(need.gasWei)} gas) from the funding wallet ${fundingAddress}`
  if (config.maxStartDrawWei !== undefined && need.drawWei > config.maxStartDrawWei) {
    return [
      `${what}, more than the ${formatEther(config.maxStartDrawWei)} MON one start may draw.`,
      `  To allow it, run with --allow-draw (or set FRANK_DEMO_MAX_START_DRAW_WEI to at least ${need.drawWei}). Nothing was started and nothing was spent.`,
      `  A state directory whose bots are already funded draws nothing: check that FRANK_DEMO_STATE_DIR (${config.stateDir}) is the one you meant.`,
      `  Unfunded: ${need.low.join(', ')}`,
    ]
  }
  const required = need.drawWei + config.funding.reserveWei
  if (fundingBalanceWei < required) {
    return [
      `${what}, and the host keeps ${formatEther(config.funding.reserveWei)} MON in it as a reserve: it needs ${formatEther(required)} MON and holds ${formatEther(fundingBalanceWei)}.`,
      `  Send testnet MON to ${fundingAddress} (E2E_DEMO_MAIN_WALLET_JSON) and start again. Nothing was started and nothing was spent.`,
      `  Unfunded: ${need.low.join(', ')}`,
    ]
  }
  return undefined
}

const KNOWN_FLAGS = new Set(['--ngrok', '--app', '--no-app', '--allow-draw'])

export async function startDemo(config: DemoConfig, options: StartOptions = {}): Promise<DemoHandle> {
  const print = options.print ?? ((line: string) => console.log(line))
  const baseEnv = options.env ?? process.env

  // Everything that can fail or be interrupted from here on goes through one stop(): signal
  // handlers are installed BEFORE the first child is spawned, so an interrupt at any point kills
  // every child process group instead of orphaning them.
  const unhealthy: string[] = []
  let started = false
  let exitCode: number | undefined
  let stopped: Promise<void> | undefined
  let resolveDone: (code: number) => void = () => {}
  const done = new Promise<number>(r => (resolveDone = r))

  const getBalance = options.getBalance ?? ((address: string) => chainBalanceWei(config.rpcUrl, address))
  const getGasPrice =
    options.getGasPrice ?? (async () => BigInt(await rpcCall<string>(config.rpcUrl, 'eth_gasPrice', [])))

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
    const stale = takeStaleRecord(config.stateDir)
    const staleLines = stale ? staleAdvice(stale) : []
    if (stale) for (const line of staleLines) print(`[demo] ${line}`)
    const problems = await checkPrerequisites(config)
    if (problems.length > 0) {
      throw new DemoConfigError(problems.some(p => p.includes('is in use')) ? [...problems, ...staleLines] : problems)
    }
    prepareStateDir(logDir)

    // Identities first: the relay's curated defaults are config, so they must exist before it starts.
    const { addresses, mainAccounts, curated } = await prepareBotIdentities(config)
    for (const bot of config.bots) {
      print(`[demo] ${bot.name} identity ${addresses[bot.name]}, stamp account ${mainAccounts[bot.name]}`)
    }

    // Before anything is started or spent: can the one funding wallet fund the bots at all?
    const fundingAddress = `0x${walletAddress(config.mainWalletJson) as string}`
    const need = await fundingNeed(config, { addresses, mainAccounts, getBalance, gasPriceWei: await getGasPrice() })
    const refusal = await fundingRefusal(config, need, fundingAddress, await getBalance(fundingAddress))
    if (refusal) throw new DemoConfigError(refusal)
    print(
      need.low.length === 0
        ? '[demo] every bot account is already funded: this start draws nothing from the funding wallet'
        : `[demo] ${need.low.length} bot accounts need funding: this start DRAWS ${formatEther(need.drawWei)} testnet MON from ${fundingAddress} (allowed${config.maxStartDrawWei === undefined ? ' by --allow-draw' : `: the limit is ${formatEther(config.maxStartDrawWei)} MON`})`,
    )
    abortIfStopping()

    let publicRelayUrl = config.publicRelayUrl
    let publicAppUrl = config.publicAppUrl

    if (config.ngrok) {
      print('[demo] starting ngrok tunnels...')
      const ngrokResult = await startNgrok({
        stateDir: config.stateDir,
        logDir,
        relayPort: config.relayPort,
        appPort: config.appPort,
        ngrokBin: config.ngrokBin,
        ngrokConfig: config.ngrokConfig,
        ngrokRelayDomain: config.ngrokRelayDomain,
        ngrokAppDomain: config.ngrokAppDomain,
        ngrokAuthtoken: config.ngrokAuthtoken,
        startApp: options.startApp,
        supervisor,
      })
      writePidFile()
      publicRelayUrl ??= ngrokResult.publicRelayUrl
      publicAppUrl ??= ngrokResult.publicAppUrl
      print(
        `[demo] ngrok tunnels active: app -> ${publicAppUrl ?? `http://localhost:${config.appPort}`}, relay -> ${publicRelayUrl ?? config.relayUrl}`,
      )
    }
    abortIfStopping()

    // The shipped relay config carries the directory section; only the curated defaults are extra.
    //
    // RESERVED USERNAMES GO HERE (PR #1374, not on main when this was written): for each bot call
    // `reservedUsernamesTomlLine([{ username, compressedPubKey }])` from
    // `packages/bot-framework/src/reserved-usernames.ts` with its identity's compressed public key
    // and `getProfile().username ?? id`. The returned line belongs INSIDE `[registry.directory]`,
    // which is in the shipped base config, not in this appended file: pass it to
    // run-local-monad.sh through a new override (as FRANK_RELAY_ID is) rather than appending it.
    const curatedPath = join(config.stateDir, 'relay-curated.toml')
    writeFileSync(curatedPath, renderCuratedDefaultsToml(curated), { mode: 0o600 })
    abortIfStopping()

    const releaseBin = join(REPO_ROOT, 'backend', 'cashweb', 'target', 'release', 'cashwebd-exe')
    const debugBin = join(REPO_ROOT, 'backend', 'cashweb', 'target', 'debug', 'cashwebd-exe')
    const prebuiltBin = existsSync(releaseBin) ? releaseBin : (existsSync(debugBin) ? debugBin : undefined)
    const effectiveCashwebdBin = config.cashwebdBin ?? prebuiltBin

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
        XEC_TESTNET_CHRONIK_URL: config.chronikUrl,
        SOLANA_DEVNET_HTTP_RPC_URL: config.solanaRpcUrl,
        FRANK_RELAY_LISTEN: `127.0.0.1:${config.relayPort}`,
        FRANK_RELAY_DB_PATH: relayDb,
        FRANK_RELAY_EXTRA_TOML: curatedPath,
        ...(publicRelayUrl ? { FRANK_RELAY_PUBLIC_URL: publicRelayUrl.replace(/\/+$/, '') } : {}),
        FRANK_RUN_LOCAL_SKIP_DOTENV: '1',
        ...(effectiveCashwebdBin ? { CASHWEBD_BIN: effectiveCashwebdBin } : {}),
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

    // ONE process runs every bot: one bot host, one funding wallet, one nonce counter.
    const registered = new Set<string>()
    const failed = new Map<string, string>()
    let allStarted = false
    mkdirSync(config.botProcess.hostStateDir, { recursive: true, mode: 0o700 })
    const bots = supervisor.start({
      name: 'bots',
      command: process.execPath,
      args: tsxArgs(config.botProcess.script),
      cwd: BOT_DIR,
      logPath: join(logDir, 'bots.log'),
      env: config.botProcess.env,
      onLine: line => {
        const ok = /\[all-bots\] (\S+) registered/.exec(line)
        if (ok) registered.add(ok[1])
        // The host's line carries the reason; the entry point's line marks the bot as failed.
        const why = /Bot "([^"]+)" could not be started and is left out[^:]*: (.*)$/.exec(line)
        if (why) failed.set(why[1], why[2])
        const bad = /\[all-bots\] (\S+) FAILED to start/.exec(line)
        if (bad && !failed.has(bad[1])) failed.set(bad[1], `see ${join(logDir, 'bots.log')}`)
        if (/\[all-bots\] running: /.test(line)) allStarted = true
      },
    })
    writePidFile()
    print(`[demo] starting ${config.bots.length} bots in one process (each registers and is funded in turn) ...`)

    const botDeadline = Date.now() + (options.botTimeoutS ?? 900) * 1000
    const waiting = new Set<DemoBot>(config.bots)
    const botLog = join(logDir, 'bots.log')
    for (;;) {
      abortIfStopping()
      const visible = await registeredAddresses(config.relayUrl).catch(() => new Set<string>())
      for (const bot of [...waiting]) {
        if (failed.has(bot.name)) {
          waiting.delete(bot)
          continue
        }
        // Registered with the host AND visible to users on the relay.
        if (registered.has(bot.name) && visible.has(addresses[bot.name].toLowerCase())) {
          waiting.delete(bot)
          print(`[demo] ${bot.name} is registered`)
        }
      }
      if (waiting.size === 0 && allStarted) break
      if (bots.hasExited() || Date.now() > botDeadline) {
        throw new DemoConfigError([
          bots.hasExited()
            ? `the bot process exited during startup. Last output (${botLog}):`
            : `the bot process did not finish starting in time (still waiting for: ${
                [...waiting].map(b => b.name).join(', ') || 'its poll loop'
              }). Last output (${botLog}):`,
          ...redactLines(bots.tail().slice(-15), config.secrets).map(l => `  ${l}`),
        ])
      }
      await sleep(options.pollMs ?? 1000)
    }
    abortIfStopping()

    // A bot that did not start, or whose accounts the host could not fund, is an error naming the
    // bot. The others keep running.
    const botProblems = [...failed].map(([name, reason]) => `${name} FAILED to start: ${reason}`)
    for (const bot of config.bots) {
      if (failed.has(bot.name)) continue
      for (const target of fundingTargets(bot.name, addresses, mainAccounts)) {
        const balance = await getBalance(target.address)
        if (balance < DEMO_MIN_BOT_BALANCE_WEI) {
          botProblems.push(
            `${bot.name} is NOT funded: its ${target.label} ${target.address} holds ${formatEther(balance)} MON (needs ${formatEther(DEMO_MIN_BOT_BALANCE_WEI)})`,
          )
        }
      }
    }
    if (botProblems.length > 0) {
      const fundingBalance = await getBalance(fundingAddress).catch(() => undefined)
      print('')
      print('!!!!!!!! DEMO BOT ERRORS !!!!!!!!')
      for (const problem of botProblems) print(`!! ${problem}`)
      print(
        `!! funding wallet ${fundingAddress} holds ${
          fundingBalance === undefined ? 'an unknown amount of' : formatEther(fundingBalance)
        } MON; bot log: ${botLog}`,
      )
      print('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
    } else {
      print(`[demo] all ${config.bots.length} bots funded and registered`)
    }

    let appStarted = false
    if (options.startApp) {
      const effectiveRelayUrl = publicRelayUrl ?? config.relayUrl
      const appEnv: Record<string, string> = {
        QCLI_MONAD_RELAY_BASE_URL: effectiveRelayUrl,
        QCLI_E2E_DEMO_RELAY_URL: effectiveRelayUrl,
        FRANK_DEMO_RELAY_PORT: String(config.relayPort),
        QCLI_MONAD_RPC_CHAIN: 'monad-testnet',
        QCLI_MONAD_STAMP_BURN_ADDRESS: config.stampBurnAddress,
        QCLI_CASHWEB_STAMP_MIN_BURN_VALUE_WEI: config.minStampWei,
      }
      const quasarBin = join(REPO_ROOT, 'node_modules', '@quasar', 'app-vite', 'bin', 'quasar.js')
      const appCommandPath = existsSync(quasarBin) ? process.execPath : 'yarn'
      const appArgs = existsSync(quasarBin) ? [quasarBin, 'dev'] : ['dev:browser']

      supervisor.start({
        name: 'app',
        command: appCommandPath,
        args: appArgs,
        cwd: join(REPO_ROOT, 'app'),
        logPath: join(logDir, 'app.log'),
        env: appEnv,
        onLine: line => {
          if (
            line.includes('App •') ||
            line.includes('Running at') ||
            line.includes('http://localhost:8080')
          ) {
            print(`[demo] ${line.trim()}`)
          }
        },
      })
      writePidFile()
      appStarted = true
      print(`[demo] started app dev server at http://localhost:${config.appPort}`)
    }

    started = true
    return {
      config,
      relayUrl: config.relayUrl,
      publicRelayUrl,
      publicAppUrl,
      addresses,
      mainAccounts,
      fundingAddress,
      botProblems,
      logDir,
      stop,
      done,
      unhealthy: () => [...unhealthy],
      appStarted,
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
  print(`  Relay:   ${handle.relayUrl}${handle.publicRelayUrl ? ` (public: ${handle.publicRelayUrl})` : ''}`)
  print(
    '  Chain:   Monad testnet (RPC URL hidden)',
  )
  print(`  Funding: ${handle.fundingAddress} (the one wallet that funds every bot and the faucet)`)
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
    print(`    ${bot.name.padEnd(10)} ${address}`)
  }
  print(
    config.qwenMode === 'stub'
      ? '  Qwen:    STUB mode, as asked (offline canned replies; unset QWEN_BOT_MODE for the model)'
      : '  Qwen:    live model',
  )
  if (handle.appStarted) {
    print(
      `  App:     Running at ${appUrl}${handle.publicAppUrl ? ` (public: ${handle.publicAppUrl})` : ''} (dev server automatically started; browser launched)`,
    )
  } else {
    print(
      `  App URL: ${appUrl}${handle.publicAppUrl ? ` (public: ${handle.publicAppUrl})` : ''}  (the app dev server's port is fixed in app/quasar.config.js)`,
    )
    print('  Start the app in another terminal, from the repo root, with exactly this:')
    for (const line of appCommand(config, handle.publicRelayUrl ?? handle.relayUrl)) print(`    ${line}`)
  }
  print('  The relay accepts requests from any origin; the app reaches the chain through the relay.')
  const bad = handle.unhealthy()
  if (bad.length > 0) print(`  UNHEALTHY: ${bad.join(', ')} exited (see the logs above)`)
  for (const problem of handle.botProblems) print(`  ERROR: ${problem}`)
  print(
    `Press Ctrl-C to stop everything (or kill -INT ${process.pid}; also stops if the yarn process that started it is killed).`,
  )
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const print = (line: string) => console.log(line)
  try {
    const integration = argv.indexOf('--directory-admission')
    if (integration !== -1) {
      if (argv.length !== 2 || integration !== 0 || !argv[1])
        throw new DemoConfigError([
          'Use --directory-admission /absolute/public-config.json alone',
        ])
      const path = resolve(env.INIT_CWD ?? process.cwd(), argv[1])
      if (!statSync(path).isFile() || statSync(path).size > 1048576)
        throw new DemoConfigError([
          'Bounded public directory configuration file required',
        ])
      const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
      let publicJSON: string
      try {
        if (!fstatSync(fd).isFile()) throw new Error('Regular public configuration required')
        const bytes = Buffer.alloc(1048577)
        let length = 0
        while (length < bytes.length) {
          const count = readSync(fd, bytes, length, bytes.length - length, null)
          if (!count) break
          length += count
        }
        if (length > 1048576) throw new Error('Bounded public directory configuration file required')
        publicJSON = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
      } finally {
        closeSync(fd)
      }
      const config = resolveDirectoryDemoConfig(JSON.parse(publicJSON))
      const { reopenBundle, startFixture } = await import(
        './directory-trust/index'
      )
      const { openDemoNodeAdmission } = await import(
        './directory-trust/admission'
      )
      const { fromHex, toHex } = await import('@frank/codec')
      const bundle = reopenBundle(config.bundle, config.nowNs)
      let fixture: Awaited<ReturnType<typeof startFixture>> | undefined
      let admission:
        | Awaited<ReturnType<typeof openDemoNodeAdmission>>
        | undefined
      let interrupted: number | undefined
      const onInterrupt = () => { interrupted ??= 130 }
      const onTerminate = () => { interrupted ??= 143 }
      const onHangup = () => { interrupted ??= 129 }
      process.once('SIGINT', onInterrupt)
      process.once('SIGTERM', onTerminate)
      process.once('SIGHUP', onHangup)
      const assertRunning = () => { if (interrupted !== undefined) throw new DemoAborted(interrupted) }
      try {
        fixture = await startFixture(config.bundle, config.nowNs)
        assertRunning()
        admission = await openDemoNodeAdmission({
          ...config,
          mode: config.intent,
        })
        assertRunning()
        const current =
          config.intent === 'new'
            ? await admission.enroll(
                [
                  {
                    statement: fromHex(config.statementHex!),
                    attestation: fromHex(bundle.witnessHex!),
                  },
                ],
                config.nowNs,
              )
            : await admission.current(config.nowNs)
        assertRunning()
        print(
          JSON.stringify({
            kind: 'demo-directory-point-in-time',
            head: toHex(current.evidence.hash),
            revision: current.revision.toString(),
            accepted: current.status.accepted,
            runtimeRoutesChanged: false,
            topicWire: 'protobuf',
          }),
        )
        if (config.routeTransport) {
          await admission.close(); admission = undefined
          await fixture.stop(); fixture = undefined
          assertRunning()
          const front = await startDirectoryRouteTransport({ bundle: config.bundle, nowNs: config.nowNs, backendUrl: config.routeTransport.backendUrl })
          try {
            print(JSON.stringify({ kind: 'demo-directory-route-transport', responseAllowanceMs: 70000 }))
            if (interrupted === undefined) await new Promise<void>(resolve => {
              const timer = setInterval(() => { if (interrupted !== undefined) { clearInterval(timer); resolve() } }, 50)
            })
          } finally { await front.stop() }
        }
        return interrupted ?? 0
      } finally {
        try { await admission?.close() } finally {
          try { await fixture?.stop() } finally {
            process.removeListener('SIGINT', onInterrupt)
            process.removeListener('SIGTERM', onTerminate)
            process.removeListener('SIGHUP', onHangup)
          }
        }
      }
    }
    const unknown = argv.filter(arg => !KNOWN_FLAGS.has(arg))
    if (unknown.length > 0) {
      throw new DemoConfigError([
        `unknown argument(s): ${unknown.join(' ')}. The demo runs on Monad testnet; its options are --ngrok, --app, --no-app and --allow-draw.`,
      ])
    }
    const envFilePath = env.FRANK_DEMO_ENV_FILE
      ? resolve(env.INIT_CWD ?? process.cwd(), env.FRANK_DEMO_ENV_FILE)
      : join(REPO_ROOT, '.env')
    const config = resolveDemoConfig({
      env,
      envFile: readEnvFile(envFilePath),
      ngrokFlag: argv.includes('--ngrok'),
      allowDrawFlag: argv.includes('--allow-draw'),
      // `yarn demo` runs inside packages/bot; relative paths mean relative to where the user typed it.
      cwd: env.INIT_CWD ?? process.cwd(),
    })
    const startApp =
      (env.npm_lifecycle_event === 'demo' || argv.includes('--app')) &&
      !argv.includes('--no-app')
    const handle = await startDemo(config, {
      print,
      env,
      startApp,
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

/** Distinct disposable-local directory HTTPS front. The trust probe is stopped before this
 * exclusive listener starts; neither its 3s/5s limits nor installed relay tuple is changed.
 */
export async function startDirectoryRouteTransport(options: {
  bundle: import('./directory-trust/index').BundleRef
  nowNs: bigint
  backendUrl: string
}): Promise<{ stop(): Promise<void>; endpoint: string }> {
  const { listenerMaterial, endpoint } = await import('./directory-trust/provision')
  const { createServer: httpsServer } = await import('node:https')
  const { request: httpRequest } = await import('node:http')
  const target = new URL(options.backendUrl)
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Explicit loopback directory backend required')
  const material = listenerMaterial(options.bundle, options.nowNs)
  endpoint(material.bundle.trustInputs.endpoint)
  const publicPort = Number(material.bundle.trustInputs.endpoint.slice(material.bundle.trustInputs.endpoint.lastIndexOf(':') + 1))
  const sockets = new Set<import('node:stream').Duplex>()
  const upstreams = new Set<import('node:http').ClientRequest>()
  let closing = false
  const server = httpsServer({ key: material.key, cert: material.cert }, (request, response) => {
    const path = request.url ?? ''
    if (closing || !/^\/directory\/v1\/[a-z0-9][a-z0-9._-]{0,63}\/(02|03)[0-9a-f]{64}\/(head|statements\/[0-9a-f]{64})$/.test(path) || !['GET', 'PUT', 'OPTIONS'].includes(request.method ?? '')) { response.writeHead(closing ? 503 : 404, { 'Content-Type': 'text/plain' }); response.end(closing ? 'unavailable/not-started' : 'not-found'); return }
    if (request.method === 'PUT' && request.headers['content-type'] !== 'application/vnd.frank.cbor') { response.writeHead(415); response.end(); return }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: target.port, path, method: request.method, headers: { 'Content-Type': 'application/vnd.frank.cbor', Accept: 'application/vnd.frank.cbor', ...Object.fromEntries(['origin', 'access-control-request-method', 'access-control-request-headers'].flatMap(name => typeof request.headers[name] === 'string' ? [[name, request.headers[name]]] : [])) } }, reply => {
      // Preserve route-local static errors and exact CBOR success; no redirect handling.
      if (reply.statusCode && reply.statusCode >= 300 && reply.statusCode < 400) { reply.destroy(); response.writeHead(503); response.end(); return }
      const headers: Record<string, string> = { 'Cache-Control': 'no-store' }
      for (const name of ['content-type', 'x-frank-directory-evidence', 'x-frank-directory-disposition', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-expose-headers', 'vary']) {
        const value = reply.headers[name]; if (typeof value === 'string') headers[name] = value
      }
      response.writeHead(reply.statusCode ?? 503, headers)
      let count = 0
      reply.on('data', (chunk: Buffer) => { count += chunk.length; if (count > 1048576) { reply.destroy(); response.destroy() } })
      reply.on('error', () => response.destroy())
      reply.pipe(response)
    })
    upstreams.add(upstream)
    upstream.once('close', () => upstreams.delete(upstream))
    upstream.setTimeout(70000, () => upstream.destroy())
    upstream.on('error', () => { if (!response.headersSent) { response.writeHead(503); response.end('unavailable/outcome-unknown') } else response.destroy() })
    const bodyTimer = setTimeout(() => { upstream.destroy(); if (!response.headersSent) { response.writeHead(503); response.end('unavailable/not-started') } }, 5000)
    let length = 0
    request.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 1048576) upstream.destroy() })
    request.once('end', () => clearTimeout(bodyTimer))
    request.once('error', () => { clearTimeout(bodyTimer); upstream.destroy() })
    request.once('aborted', () => { clearTimeout(bodyTimer); upstream.destroy() })
    response.once('close', () => { clearTimeout(bodyTimer); if (!response.writableFinished) upstream.destroy() })
    request.pipe(upstream)
  })
  server.headersTimeout = 5000
  server.requestTimeout = 5000
  server.setTimeout(70000)
  server.on('timeout', socket => socket.destroy())
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(publicPort, '127.0.0.1', resolve) })
  } catch (error) { material.release(); throw error }
  let stopped: Promise<void> | undefined
  return { endpoint: material.bundle.trustInputs.endpoint, stop: () => stopped ??= new Promise<void>(resolve => {
    closing = true
    // Stopping the front disconnects waiters, not the native owner. Its main lifecycle drains.
    for (const upstream of upstreams) upstream.destroy()
    for (const socket of sockets) socket.destroy()
    server.close(() => { material.release(); resolve() })
  }) }
}
