/**
 * Keys a solonet check generates and funds outside a stack's wallets, kept where a crash cannot
 * lose them (the TypeScript side of backend/labs/solonet_payer.rs, same rules):
 *
 *   const keys = SolonetKeyRun.open('group-writes')   // a run directory of its own, locked
 *   await sweepLeftoverKeyRuns(rpcUrl)                  // earlier runs that never swept
 *   keys.save(wallet.privateKey)                        // BEFORE anything funds it
 *   ...
 *   await keys.sweep(rpcUrl)                            // exact; a file goes once its sweep landed
 *   keys.close()
 *
 * The root is `FRANK_SOLONET_KEY_DIR`, default `~/.frank-regtest/solonet-keys` (absolute only).
 * Each run writes into `run-<time>-<random>/` under it, one `0x<address>.key` file per key
 * (mode 0600, flushed to disk, then renamed into place), and holds `.lock` there for its
 * lifetime by touching it every few seconds. `sweepLeftoverKeyRuns` takes over only directories
 * whose lock is stale (untouched for a minute), and takes each by renaming it first, so two runs
 * never share keys and two starters never sweep the same directory. `startMonadRegtest` runs it
 * once per process, so every solonet check sweeps leftovers before it funds anything.
 *
 * A key's file is removed only once it holds no more than a transfer's fee: its sweep landed, or
 * it held nothing after sending. A key that holds nothing and never sent anything (its funding
 * never arrived) keeps its file for an hour, since Monad can take a payment it refused much
 * later (docs/protocol/chains/monad-reserve-balance.md). A file that is not a readable key is
 * named and left in place.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from 'fs'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'

import { formatEther, JsonRpcProvider, Wallet } from 'ethers'

import { findWallets } from '../funds'
import { MONAD_REGTEST_CHAIN_ID, sweepToFaucet } from './monad-regtest'

const LOCK_STALE_MS = 60_000
const LOCK_HEARTBEAT_MS = 5_000
const UNUSED_EMPTY_KEY_KEPT_MS = 3_600_000
const TRANSFER_GAS = 21_000n

/** Where every run directory goes. */
export function solonetKeyRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.FRANK_SOLONET_KEY_DIR?.trim() || join(homedir(), '.frank-regtest', 'solonet-keys')
  if (!isAbsolute(root)) throw new Error(`FRANK_SOLONET_KEY_DIR must be an absolute path, not ${root}`)
  return root
}

/** Write `contents` to `path` durably: a fresh file beside it, flushed, renamed, directory flushed. */
export function writeDurably(path: string, contents: string): void {
  const dir = join(path, '..')
  const partial = join(dir, `.${path.split('/').pop()}.${Math.random().toString(16).slice(2, 10)}.partial`)
  const fd = openSync(partial, 'wx', 0o600)
  try {
    writeSync(fd, contents)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(partial, path)
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/** What happened to one key in a sweep. */
export type KeyOutcome = 'swept' | 'empty' | 'unfunded' | 'holds-funds'

export interface SweepReport {
  returnedWei: bigint
  /** Addresses that still hold more than a transfer's fee. */
  unswept: string[]
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function waitBlocks(provider: JsonRpcProvider, count: number): Promise<void> {
  const target = (await provider.getBlockNumber()) + count
  while ((await provider.getBlockNumber()) < target) await sleep(300)
}

/**
 * Send what each key holds back to the faucet, exactly (`sweepToFaucet`: fee cap base + tip +
 * margin, and it holds back exactly that). First lets every account settle: its own pending
 * transactions land, then six blocks (Monad reverts a below-reserve transfer within three blocks
 * of the sender's last transaction). A sweep that did not empty the account is tried again a few
 * blocks later, three rounds in all.
 */
export async function sweepKeysExactly(
  rpcUrl: string,
  privateKeys: string[],
): Promise<{ report: SweepReport; outcomes: Map<string, KeyOutcome> }> {
  const outcomes = new Map<string, KeyOutcome>()
  const report: SweepReport = { returnedWei: 0n, unswept: [] }
  const keys = [...new Set(privateKeys)]
  if (keys.length === 0) return { report, outcomes }
  const provider = new JsonRpcProvider(rpcUrl, MONAD_REGTEST_CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 })
  provider.pollingInterval = 250
  try {
    for (const key of keys) {
      const address = new Wallet(key).address
      for (const deadline = Date.now() + 120_000; Date.now() < deadline; ) {
        const [pending, latest] = await Promise.all([
          provider.getTransactionCount(address, 'pending'),
          provider.getTransactionCount(address, 'latest'),
        ])
        if (pending === latest) break
        await sleep(500)
      }
    }
    await waitBlocks(provider, 6)
    let left = keys
    for (let round = 0; round < 3 && left.length > 0; round++) {
      const fee = TRANSFER_GAS * BigInt(await provider.send('eth_gasPrice', []))
      const again: string[] = []
      for (const key of left) {
        const address = new Wallet(key).address
        const before = await provider.getBalance(address, 'latest')
        if (before <= fee) {
          const sent = await provider.getTransactionCount(address, 'latest')
          outcomes.set(key, sent === 0 ? 'unfunded' : 'empty')
          continue
        }
        await sweepToFaucet(key, rpcUrl).catch(error =>
          console.warn(`[solonet] sweep of ${address}: ${error instanceof Error ? error.message : String(error)}`),
        )
        const after = await provider.getBalance(address, 'latest')
        if (after <= fee) {
          outcomes.set(key, 'swept')
          report.returnedWei += before - after
        } else {
          again.push(key)
        }
      }
      left = again
      if (left.length > 0) await waitBlocks(provider, 4)
    }
    for (const key of left) {
      outcomes.set(key, 'holds-funds')
      report.unswept.push(new Wallet(key).address)
    }
    return { report, outcomes }
  } finally {
    provider.destroy()
  }
}

/** The keys saved in run directory `dir`, by file; unreadable files are named and left. */
function savedKeys(dir: string): { file: string; key: string }[] {
  const saved: { file: string; key: string }[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch (error) {
    console.warn(`[solonet] cannot read ${dir}: ${(error as Error).message}; left in place`)
    return saved
  }
  for (const name of names) {
    if (!name.endsWith('.key')) continue
    const file = join(dir, name)
    try {
      const text = readFileSync(file, 'utf8').trim()
      const key = text.startsWith('0x') ? text : `0x${text}`
      new Wallet(key)
      saved.push({ file, key })
    } catch (error) {
      console.warn(`[solonet] ${file} is not a readable private key (${(error as Error).message}); skipped and left in place`)
    }
  }
  return saved
}

/** Sweep every key saved in `dir`, and remove each file whose key is done. */
async function sweepKeyFiles(dir: string, rpcUrl: string): Promise<SweepReport> {
  const saved = savedKeys(dir)
  const { report, outcomes } = await sweepKeysExactly(
    rpcUrl,
    saved.map(entry => entry.key),
  )
  for (const { file, key } of saved) {
    const outcome = outcomes.get(key)
    const old = Date.now() - statSync(file).mtimeMs > UNUSED_EMPTY_KEY_KEPT_MS
    if (outcome === 'swept' || outcome === 'empty' || (outcome === 'unfunded' && old)) rmSync(file, { force: true })
  }
  return report
}

/** Remove run directory `dir` when nothing but its lock and unfinished non-key saves is left. */
function removeIfDone(dir: string): boolean {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return true
  }
  if (names.every(name => name === '.lock' || (name.endsWith('.partial') && !name.includes('.key.')))) {
    rmSync(dir, { recursive: true, force: true })
    return true
  }
  return false
}

function lockAgeMs(dir: string): number {
  for (const path of [join(dir, '.lock'), dir]) {
    try {
      return Date.now() - statSync(path).mtimeMs
    } catch {
      /* next */
    }
  }
  return Infinity
}

/**
 * Take over the stale run directory `stale`, so no other starter sweeps it too: its lock is
 * touched (fresh, so a starter that lists it now leaves it), then the directory is renamed, which
 * only one starter can do. The taker keeps the lock fresh for the rest of its life; a directory
 * it leaves keys in goes stale again when it ends. Undefined when another starter took it first.
 */
function take(stale: string): string | undefined {
  const lock = join(stale, '.lock')
  const taken = `${stale.replace(/-taken-[0-9a-f]{8}$/, '')}-taken-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`
  try {
    const now = new Date()
    utimesSync(lock, now, now)
  } catch {
    try {
      writeDurably(lock, String(process.pid))
    } catch {
      return undefined
    }
  }
  try {
    renameSync(stale, taken)
  } catch {
    return undefined
  }
  const takenLock = join(taken, '.lock')
  setInterval(() => {
    try {
      const now = new Date()
      utimesSync(takenLock, now, now)
    } catch {
      /* removed once swept */
    }
  }, LOCK_HEARTBEAT_MS).unref()
  return taken
}

/**
 * Sweep the keys of every earlier run whose lock is stale (it was killed, or its sweep did not
 * land), and remove the run directories left with nothing to keep. A live run is left alone.
 */
export async function sweepLeftoverKeyRuns(rpcUrl: string, own?: SolonetKeyRun): Promise<SweepReport> {
  const total: SweepReport = { returnedWei: 0n, unswept: [] }
  const root = solonetKeyRoot()
  let runs: string[] = []
  try {
    runs = readdirSync(root).filter(name => name.startsWith('run-'))
  } catch {
    return total
  }
  for (const name of runs) {
    const stale = join(root, name)
    if (stale === own?.dir) continue
    if (lockAgeMs(stale) <= LOCK_STALE_MS) {
      console.log(`[solonet] ${stale} belongs to a run that is still alive; left to a later run`)
      continue
    }
    const dir = take(stale)
    if (!dir) continue
    const keys = savedKeys(dir)
    if (keys.length > 0) {
      console.log(`[solonet] ${keys.length} keys of an earlier run left in ${dir}; sweeping them first`)
      const report = await sweepKeyFiles(dir, rpcUrl)
      total.returnedWei += report.returnedWei
      total.unswept.push(...report.unswept)
      console.log(`[solonet] returned ${formatEther(report.returnedWei)} MON from ${dir}`)
    }
    removeIfDone(dir)
  }
  return total
}

/** The keys one run funds, in a locked run directory of its own (see the file comment). */
export class SolonetKeyRun {
  private constructor(
    readonly dir: string,
    private readonly heartbeat: NodeJS.Timeout,
  ) {}

  static open(label: string): SolonetKeyRun {
    const root = solonetKeyRoot()
    const dir = join(root, `run-${Math.floor(Date.now() / 1000)}-${label}-${Math.random().toString(16).slice(2, 10)}`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const lock = join(dir, '.lock')
    writeDurably(lock, String(process.pid))
    const heartbeat = setInterval(() => {
      try {
        const now = new Date()
        utimesSync(lock, now, now)
      } catch {
        /* the next beat tries again */
      }
    }, LOCK_HEARTBEAT_MS)
    heartbeat.unref()
    return new SolonetKeyRun(dir, heartbeat)
  }

  /** Save `privateKey` durably; call before anything funds it. */
  save(privateKey: string): void {
    writeDurably(join(this.dir, `${new Wallet(privateKey).address.toLowerCase()}.key`), privateKey)
  }

  /** Sweep every key of this run back to the faucet, removing each file once it is done. */
  sweep(rpcUrl: string): Promise<SweepReport> {
    return sweepKeyFiles(this.dir, rpcUrl)
  }

  /** Stop holding the lock; remove the directory if no key is left in it, else say where. */
  close(): void {
    clearInterval(this.heartbeat)
    if (!removeIfDone(this.dir))
      console.warn(`[solonet] keys not yet done (funds left, or a funding that may still land) stay in ${this.dir}; a later run's leftover sweep returns them`)
  }
}

/**
 * Sweep every account whose key `findWallets` finds under `dir` (a stack state directory that
 * was kept because funds may remain) back to the faucet, exactly. The directory itself stays.
 *
 *   yarn --cwd packages/bot regtest:monad-sweep-state <dir>
 */
export async function sweepStateDir(rpcUrl: string, dir: string): Promise<SweepReport> {
  const keys = (await findWallets(dir))
    .flatMap(wallet => wallet.accounts)
    .flatMap(account => (account.privateKey ? [account.privateKey] : []))
  const { report } = await sweepKeysExactly(rpcUrl, keys)
  return report
}

if (require.main === module) {
  const [command, dir] = process.argv.slice(2)
  const rpcUrl = process.env.FRANK_SOLONET_RPC_URL ?? 'http://127.0.0.1:48080'
  if (command !== 'sweep-state' || !dir) {
    console.error('usage: solonet-keys.ts sweep-state <stack state directory>')
    process.exit(2)
  }
  sweepStateDir(rpcUrl, dir).then(
    report => {
      console.log(
        `returned ${formatEther(report.returnedWei)} MON to the faucet${
          report.unswept.length ? `; still holding funds: ${report.unswept.join(', ')}` : '; every found account is empty'
        }`,
      )
      process.exit(report.unswept.length ? 1 : 0)
    },
    error => {
      console.error(error)
      process.exit(1)
    },
  )
}
