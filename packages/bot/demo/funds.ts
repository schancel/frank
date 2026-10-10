/**
 * Where the testnet MON of test and demo runs is, and how to get it back.
 *
 *   yarn --cwd packages/bot funds:report [dir ...]          what every wallet found there holds on chain
 *   yarn --cwd packages/bot funds:sweep  <dir ...>          dry run: what a sweep would move
 *   yarn --cwd packages/bot funds:sweep  <dir ...> --send   moves it to the funding wallet
 *   yarn demo:sweep <demo state dir> [--send]               the same for a demo's bots (from the repo root)
 *
 * A demo start, a harness run and every livecheck put testnet MON into accounts whose keys live
 * in a state directory. This finds those keys by the file names the code writes
 * (`account-root.hex`, `roots.json`, `identity.json`, `stamp-pool-seed.json`, a `{address,
 * privateKey}` wallet file), derives each wallet's accounts the way the wallet does (main account,
 * identity, single-use sender accounts, change accounts), reads their balances from the chain and
 * can send what is worth moving back to the funding wallet (`E2E_DEMO_MAIN_WALLET_JSON`; only its
 * address is read). With no directory, `funds:report` looks in the known places under the home
 * and temp directories.
 *
 * A state directory is never written to: a wallet's pool records are read from a temporary copy.
 * Keys are used to sign and are never printed. One transfer per account, one at a time, each
 * waited for: on Monad a second transfer from a small account within a few blocks reverts. An
 * account holding less than twice the transfer fee is left alone (dust). A sweep refuses a
 * directory a running process has open (checked again just before sending; when `lsof` cannot
 * answer the directory counts as in use), and a demo state directory unless `--demo` is given
 * (the bots are meant to stay funded between runs).
 *
 * A state that will be used again stays usable: by default a sweep takes the main and identity
 * accounts, change accounts and the sender accounts the wallet's records call spent or retired
 * (or do not name), and LEAVES sender accounts the records call funded for a coming message,
 * because emptying those would leave records that say they hold money. `--abandoned` takes
 * everything, for a state that will never be opened again (`yarn demo:sweep` passes it).
 */
import { execFileSync } from 'child_process'
import { appendFileSync, cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'

import { JsonRpcProvider, Wallet, formatEther, getAddress } from 'ethers'
import level from 'level'

import { deriveDomainRoot } from '@frank/domain-roots'
import { MonadChangeKeyring } from '@frank/wallet/monad-change-keyring'
import { MonadHdKeyring } from '@frank/wallet/monad-hd-keyring'
import { createMonadWalletMaterial, type MonadRootBundle } from '@frank/wallet/monad-wallet-material'

import { rpcUrlList } from './chain-rpc'
import { realStackEnv } from './real-stack'
import { isAlive, lockPath } from './run-lock'

const MONAD_TESTNET_CHAIN_ID = 10143n
export const TRANSFER_GAS = 21_000n
/** Sender and change indexes read past the highest one a wallet's records name. */
const INDEX_MARGIN = 3
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export interface FoundAccount {
  /** What the account is in its wallet: main, identity, sender 3 (spent), change 0, wallet file. */
  role: string
  address: string
  /** Absent when only the address is known (records without their key file). */
  privateKey?: string
  /** A sender account the wallet's records hold ready for a coming message: emptying it would
   * leave those records wrong, so only a sweep of an abandoned state takes it. */
  heldByRecords?: boolean
}

export interface FoundWallet {
  /** The directory (or file) holding the key. */
  path: string
  kind: 'account root' | 'roots.json' | 'identity file' | 'pool seed' | 'wallet file' | 'records without a key'
  accounts: FoundAccount[]
  /** Why nothing could be derived, when that is the case. Never quotes the file. */
  problem?: string
  /** Something the reader must know about how complete this is. */
  note?: string
}

// ---------------------------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------------------------

export interface Holding {
  wallet: string
  role: string
  address: string
  balanceWei: bigint
  hasKey: boolean
  heldByRecords?: boolean
}

export interface Move extends Holding {
  /** What arrives: the balance less one transfer fee. */
  valueWei: bigint
}

export interface Skip extends Holding {
  reason: string
}

export interface SweepPlan {
  transferCostWei: bigint
  moves: Move[]
  skipped: Skip[]
  /** Sum of what the moves deliver. */
  recoverableWei: bigint
  feesWei: bigint
  /** Held by accounts too small to move. */
  dustWei: bigint
  /** Held by accounts whose key was not found. */
  noKeyWei: bigint
}

/** Decides, for balances already read, what a sweep moves. One transfer per address; an address
 * that appears in several wallets (a bot's exported identity file) is counted once; `never`
 * (the destination and the wallets that fund tests) is not a source. */
export function planSweep(
  holdings: Holding[],
  gasPriceWei: bigint,
  never: string[] = [],
  options: { abandoned?: boolean } = {},
): SweepPlan {
  const transferCostWei = gasPriceWei * TRANSFER_GAS
  const excluded = new Set(never.filter(Boolean).map(a => a.toLowerCase()))
  const seen = new Map<string, Holding>()
  for (const holding of holdings) {
    const key = holding.address.toLowerCase()
    const prior = seen.get(key)
    // A copy with the key wins over a copy that only names the address.
    if (!prior || (!prior.hasKey && holding.hasKey)) seen.set(key, holding)
  }
  const plan: SweepPlan = { transferCostWei, moves: [], skipped: [], recoverableWei: 0n, feesWei: 0n, dustWei: 0n, noKeyWei: 0n }
  for (const holding of seen.values()) {
    if (holding.balanceWei === 0n) continue
    if (excluded.has(holding.address.toLowerCase())) {
      plan.skipped.push({ ...holding, reason: 'a funding or test wallet, never a source' })
    } else if (!holding.hasKey) {
      plan.noKeyWei += holding.balanceWei
      plan.skipped.push({ ...holding, reason: 'its key was not found' })
    } else if (holding.heldByRecords && !options.abandoned) {
      plan.skipped.push({ ...holding, reason: "kept: the wallet's records hold it ready for a coming message (--abandoned takes it, for a state that will not be used again)" })
    } else if (holding.balanceWei < transferCostWei * 2n) {
      plan.dustWei += holding.balanceWei
      plan.skipped.push({ ...holding, reason: `dust: under twice the transfer fee of ${formatEther(transferCostWei)} MON` })
    } else {
      plan.moves.push({ ...holding, valueWei: holding.balanceWei - transferCostWei })
      plan.recoverableWei += holding.balanceWei - transferCostWei
      plan.feesWei += transferCostWei
    }
  }
  plan.moves.sort((a, b) => (a.valueWei < b.valueWei ? 1 : a.valueWei > b.valueWei ? -1 : 0))
  return plan
}

// ---------------------------------------------------------------------------------------------
// Finding wallets
// ---------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'logs', 'relay', 'relay-db', 'fake-chain', 'directory'])
const STORAGE_DIR = /-evm-(0x[0-9a-f]{40})$/

interface PoolRecords {
  /** One past the highest index the records name. */
  nextIndex: number
  status: Map<number, string>
  addresses: Map<number, string>
}

/** Reads a wallet's `level` records from a temporary copy, so the state directory is untouched. */
async function readLevelCopy(dbDir: string): Promise<PoolRecords | 'unreadable' | undefined> {
  if (!existsSync(dbDir)) return undefined
  const copy = mkdtempSync(join(tmpdir(), 'frank-funds-read-'))
  const records: PoolRecords = { nextIndex: 0, status: new Map(), addresses: new Map() }
  try {
    cpSync(dbDir, join(copy, 'db'), { recursive: true })
    rmSync(join(copy, 'db', 'LOCK'), { force: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = level(join(copy, 'db')) as any
    try {
      for await (const [key, value] of db.iterator({})) {
        let parsed: unknown
        try {
          parsed = JSON.parse(value)
        } catch {
          continue
        }
        if (key === '__next_index__' && typeof parsed === 'number') {
          records.nextIndex = Math.max(records.nextIndex, parsed)
          continue
        }
        const row = parsed as { index?: unknown; address?: unknown; status?: unknown }
        if (typeof row?.index !== 'number' || typeof row.address !== 'string') continue
        records.nextIndex = Math.max(records.nextIndex, row.index + 1)
        records.addresses.set(row.index, row.address)
        if (typeof row.status === 'string') records.status.set(row.index, row.status)
      }
    } finally {
      await db.close()
    }
    return records
  } catch {
    return 'unreadable'
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
}

function walk(root: string, visit: (dir: string, names: string[]) => void, depth = 0): void {
  if (depth > 8) return
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  visit(root, names)
  for (const name of names) {
    if (SKIP_DIRS.has(name) || STORAGE_DIR.test(name)) continue
    const path = join(root, name)
    try {
      // A symbolic link is never followed: it could lead out of the state directory.
      if (lstatSync(path).isDirectory()) walk(path, visit, depth + 1)
    } catch {
      /* gone meanwhile */
    }
  }
}

const hexBytes = (text: string) => Uint8Array.from(Buffer.from(text.trim(), 'hex'))

const READY = new Set(['available', 'in-use', 'funding', 'unfunded'])

async function poolAccounts(
  keyring: { deriveSubAccount(index: number): { address: string; privateKey: string } },
  changeKeyring: { deriveSubAccount(index: number): { address: string; privateKey: string } },
  storageDirs: string[],
): Promise<{ accounts: FoundAccount[]; note?: string }> {
  const accounts: FoundAccount[] = []
  const empty = (): PoolRecords => ({ nextIndex: 0, status: new Map(), addresses: new Map() })
  let senders = empty()
  let change = empty()
  const notes: string[] = []
  if (storageDirs.length === 0) notes.push('no wallet records were found beside the key')
  for (const dir of storageDirs) {
    const s = await readLevelCopy(join(dir, 'sub-account-pool'))
    if (s === 'unreadable') notes.push(`the sender-account records in ${dir} could not be read`)
    else if (s && s.nextIndex >= senders.nextIndex) senders = s
    const c = await readLevelCopy(join(dir, 'change-pool'))
    if (c === 'unreadable') notes.push(`the change-account records in ${dir} could not be read`)
    else if (c && c.nextIndex >= change.nextIndex) change = c
  }
  for (let i = 0; i < senders.nextIndex + INDEX_MARGIN; i += 1) {
    const { address, privateKey } = keyring.deriveSubAccount(i)
    const status = senders.status.get(i)
    accounts.push({
      role: `sender ${i}${status ? ` (${status})` : ''}`,
      address,
      privateKey,
      ...(status && READY.has(status) ? { heldByRecords: true } : {}),
    })
  }
  for (let i = 0; i < change.nextIndex + INDEX_MARGIN; i += 1) {
    const { address, privateKey } = changeKeyring.deriveSubAccount(i)
    accounts.push({ role: `change ${i}`, address, privateKey })
  }
  return {
    accounts,
    // Said, not hidden: without records only the first few indexes are looked at.
    note: notes.length
      ? `${notes.join('; ')}: only sender and change accounts 0-${INDEX_MARGIN - 1} were looked at, so money on a later one would be missed`
      : undefined,
  }
}

/** Every wallet whose key file is under `root` (or `root` itself, when it is a wallet file). */
export async function findWallets(root: string): Promise<FoundWallet[]> {
  const found: FoundWallet[] = []
  const walletFile = (path: string) => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { address?: unknown; privateKey?: unknown }
      if (typeof parsed.privateKey !== 'string' || typeof parsed.address !== 'string') return
      const signer = new Wallet(parsed.privateKey)
      found.push({ path, kind: 'wallet file', accounts: [{ role: 'wallet file', address: signer.address, privateKey: signer.privateKey }] })
    } catch {
      /* not a wallet file */
    }
  }
  if (!existsSync(root)) return found
  if (statSync(root).isFile()) {
    walletFile(root)
    return found
  }
  // Wallet storage is a sibling named after the wallet's main account; index those first.
  const storage = new Map<string, string[]>()
  const keyDirs: { dir: string; names: string[] }[] = []
  walk(root, (dir, names) => {
    for (const name of names) {
      const match = STORAGE_DIR.exec(name)
      if (match) storage.set(match[1], [...(storage.get(match[1]) ?? []), join(dir, name)])
    }
    keyDirs.push({ dir, names })
  })
  const claimed = new Set<string>()
  const UNREADABLE = 'its key file is malformed or in a format the current code cannot open; skipped'

  const typed = async (path: string, kind: FoundWallet['kind'], roots: () => MonadRootBundle) => {
    try {
      const material = createMonadWalletMaterial(roots())
      try {
        const main = material.mainAccount.address
        const dirs = storage.get(main.toLowerCase()) ?? []
        claimed.add(main.toLowerCase())
        const pool = await poolAccounts(material.keyring, material.changeKeyring, dirs)
        found.push({
          path,
          kind,
          accounts: [
            { role: 'main', address: main, privateKey: material.mainAccount.privateKey },
            { role: 'identity', address: material.identity.address.raw, privateKey: `0x${material.identity.toPrivateKeyHex().replace(/^0x/, '')}` },
            ...pool.accounts,
          ],
          note: pool.note,
        })
      } finally {
        material.dispose()
      }
    } catch {
      // The reason is not repeated: a parser's message can quote the file, which holds a key.
      found.push({ path, kind, accounts: [], problem: UNREADABLE })
    }
  }
  for (const { dir, names } of keyDirs) {
    if (names.includes('account-root.hex')) {
      await typed(dir, 'account root', () => {
        const accountRoot = hexBytes(readFileSync(join(dir, 'account-root.hex'), 'utf8'))
        try {
          return {
            evm: deriveDomainRoot(accountRoot, 'evm-wallet'),
            authentication: deriveDomainRoot(accountRoot, 'identity-authentication'),
            messaging: deriveDomainRoot(accountRoot, 'messaging-encryption'),
          }
        } finally {
          accountRoot.fill(0)
        }
      })
    }
    if (names.includes('roots.json')) {
      let stored: Record<string, string> = {}
      try {
        stored = JSON.parse(readFileSync(join(dir, 'roots.json'), 'utf8')) as Record<string, string>
        if (stored === null || typeof stored !== 'object') throw new Error('not an object')
      } catch {
        stored = {}
        found.push({ path: join(dir, 'roots.json'), kind: 'roots.json', accounts: [], problem: UNREADABLE })
      }
      // The Solana swap livecheck keeps a `roots.json` too; only one with an EVM root is ours.
      if (typeof stored['evm-wallet'] === 'string') {
        await typed(dir, 'roots.json', () => {
          const root = (purpose: string) => ({ registry: 'frank-domain-roots-v1', purpose, bytes: hexBytes(stored[purpose]) })
          return {
            evm: root('evm-wallet'),
            authentication: root('identity-authentication'),
            messaging: root('messaging-encryption'),
          } as unknown as MonadRootBundle
        })
      }
    }
    if (names.includes('stamp-pool-seed.json')) {
      try {
        const { mnemonic } = JSON.parse(readFileSync(join(dir, 'stamp-pool-seed.json'), 'utf8')) as { mnemonic: string }
        const pool = await poolAccounts(MonadHdKeyring.fromMnemonic(mnemonic), MonadChangeKeyring.fromMnemonic(mnemonic), [dir])
        found.push({ path: dir, kind: 'pool seed', accounts: pool.accounts, note: pool.note })
      } catch {
        found.push({ path: join(dir, 'stamp-pool-seed.json'), kind: 'pool seed', accounts: [], problem: UNREADABLE })
      }
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      if (name === 'identity.json') {
        try {
          const { privateKeyHex } = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { privateKeyHex?: string }
          if (typeof privateKeyHex !== 'string') continue
          const signer = new Wallet(`0x${privateKeyHex.replace(/^0x/, '')}`)
          found.push({ path: join(dir, name), kind: 'identity file', accounts: [{ role: 'identity', address: signer.address, privateKey: signer.privateKey }] })
        } catch {
          /* not an identity file */
        }
      } else if (name.includes('wallet')) {
        walletFile(join(dir, name))
      }
    }
  }
  // Wallet records whose key file is gone: the addresses are in the records, the money is lost.
  for (const [main, dirs] of storage) {
    if (claimed.has(main)) continue
    const accounts: FoundAccount[] = [{ role: 'main', address: getAddress(main) }]
    for (const dir of dirs) {
      const senders = await readLevelCopy(join(dir, 'sub-account-pool'))
      if (senders && senders !== 'unreadable') {
        for (const [index, address] of senders.addresses) {
          accounts.push({ role: `sender ${index}${senders.status.get(index) ? ` (${senders.status.get(index)})` : ''}`, address })
        }
      }
      const change = await readLevelCopy(join(dir, 'change-pool'))
      if (change && change !== 'unreadable') for (const [index, address] of change.addresses) accounts.push({ role: `change ${index}`, address })
    }
    found.push({ path: dirs[0], kind: 'records without a key', accounts })
  }
  return found
}

/** The places test and demo state is known to be kept on this machine. */
export function knownLocations(env: Record<string, string | undefined> = process.env): string[] {
  const home = homedir()
  const listed = (dir: string, match: (name: string) => boolean) => {
    try {
      return readdirSync(dir).filter(match).map(name => join(dir, name))
    } catch {
      return []
    }
  }
  const all = [
    ...listed(home, name => name.startsWith('.frank-')),
    ...listed(tmpdir(), name => /^(frank-|chain-blackjack-|sub-account-pool-|change-pool-)/.test(name)),
    ...listed('/private/tmp', name => name.startsWith('frank-')),
    ...[env.FRANK_DEMO_STATE_DIR, env.FRANK_REAL_STACK_DIR].flatMap(dir => (dir ? [resolve(dir)] : [])),
  ]
  return [...new Set(all)]
}

/** Who has `dir` in use: a live demo launcher's lock on it, or a process with a file under it
 * open. When that cannot be established (`lsof` is missing or fails) the answer says so, and
 * the directory counts as in use: money is never moved out from under a run on a guess. */
export function usersOf(
  dir: string,
  listOpenFiles: () => string = () =>
    execFileSync('lsof', ['-Fpn'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }),
): string[] {
  const users = new Set<string>()
  try {
    const lock = JSON.parse(readFileSync(lockPath(dir), 'utf8')) as { pid?: number }
    if (typeof lock.pid === 'number' && isAlive(lock.pid)) users.add(`demo launcher ${lock.pid}`)
  } catch {
    /* no lock */
  }
  let out: string
  try {
    out = listOpenFiles()
  } catch (err) {
    // lsof exits non-zero when it could not read some process, but still lists the others.
    const partial = (err as { stdout?: unknown }).stdout
    if (typeof partial !== 'string' || partial.length === 0) {
      users.add('unknown (lsof could not be run, so whether a process has it open is not known)')
      return [...users]
    }
    out = partial
  }
  let real = dir
  try {
    real = realpathSync(dir)
  } catch {
    /* compared as given */
  }
  let pid = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1)
    else if (line.startsWith('n') && (line.slice(1) === real || line.slice(1).startsWith(`${real}/`))) users.add(`pid ${pid}`)
  }
  return [...users]
}

/** A directory the demo launcher runs bots from. */
export const isDemoState = (dir: string) => existsSync(join(dir, 'bot-host', 'bots'))

// ---------------------------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------------------------

/** Balances of `addresses`, twenty per request, a few requests a second. */
export async function readBalances(rpcUrl: string, addresses: string[]): Promise<Map<string, bigint>> {
  const url = rpcUrlList(rpcUrl)[0]
  const balances = new Map<string, bigint>()
  const unique = [...new Set(addresses.map(a => a.toLowerCase()))]
  for (let at = 0; at < unique.length; at += 20) {
    const batch = unique.slice(at, at + 20)
    let answered: { id: number; result?: string }[] | undefined
    for (let attempt = 0; attempt < 4 && !answered; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(batch.map((address, id) => ({ jsonrpc: '2.0', id, method: 'eth_getBalance', params: [address, 'latest'] }))),
        })
        const body = (await response.json()) as { id: number; result?: string }[]
        if (response.ok && Array.isArray(body) && body.every(row => typeof row.result === 'string')) answered = body
      } catch {
        /* retried below */
      }
      if (!answered) await sleep(1500 * (attempt + 1))
    }
    if (!answered) throw new Error('the chain RPC did not answer a balance request')
    for (const row of answered) balances.set(batch[row.id], BigInt(row.result as string))
    await sleep(350)
  }
  return balances
}

export interface SweepResult {
  address: string
  role: string
  wallet: string
  valueWei: bigint
  txHash?: string
  /** mined, reverted, or why it was not sent. */
  status: string
}

/** Sends each planned move, one at a time, and waits for it. Appends one JSON line per transfer
 * to `logPath` as it goes, so an interrupted sweep leaves a record of what was sent. */
export async function sendSweep(params: {
  rpcUrl: string
  destination: string
  moves: Move[]
  keys: Map<string, string>
  logPath: string
  print?: (line: string) => void
}): Promise<SweepResult[]> {
  const provider = new JsonRpcProvider(rpcUrlList(params.rpcUrl)[0], MONAD_TESTNET_CHAIN_ID, { staticNetwork: true })
  const results: SweepResult[] = []
  try {
    for (const move of params.moves) {
      const result: SweepResult = { address: move.address, role: move.role, wallet: move.wallet, valueWei: 0n, status: 'not sent' }
      try {
        const signer = new Wallet(params.keys.get(move.address.toLowerCase()) as string, provider)
        // Read again at the moment of sending: the plan may be minutes old.
        const gasPrice = BigInt(await provider.send('eth_gasPrice', []))
        const cost = gasPrice * TRANSFER_GAS
        const balance = await provider.getBalance(signer.address)
        if (balance < cost * 2n) {
          result.status = `not sent: it now holds ${formatEther(balance)} MON, under twice the fee`
        } else {
          result.valueWei = balance - cost
          const tx = await signer.sendTransaction({ type: 0, to: params.destination, value: balance - cost, gasLimit: TRANSFER_GAS, gasPrice })
          result.txHash = tx.hash
          result.status = 'sent, not seen mined'
          const receipt = await tx.wait(1, 120_000)
          result.status = receipt?.status === 1 ? 'mined' : 'reverted'
        }
      } catch (err) {
        const message = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'error'
        // Without a hash the request may still have reached the node: a second run reads the
        // balance again, so it can never send the same money twice.
        result.status = result.txHash ? `sent, not seen mined: ${message}` : `no transfer confirmed: ${message}`
      }
      if (result.status !== 'mined') result.valueWei = result.txHash ? result.valueWei : 0n
      results.push(result)
      appendFileSync(
        params.logPath,
        `${JSON.stringify({ at: new Date().toISOString(), source: result.address, role: result.role, wallet: result.wallet, to: params.destination, amountMon: formatEther(result.valueWei), txHash: result.txHash ?? null, status: result.status })}\n`,
      )
      params.print?.(`  ${result.status.padEnd(8)} ${formatEther(result.valueWei).padStart(22)} MON  ${result.address}  ${result.txHash ?? ''}`)
      await sleep(400)
    }
  } finally {
    provider.destroy()
  }
  return results
}

// ---------------------------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------------------------

const mon = (wei: bigint) => formatEther(wei)
const short = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path)

function addressOf(path: string | undefined): string | undefined {
  if (!path) return undefined
  try {
    const { address } = JSON.parse(readFileSync(path, 'utf8')) as { address?: string }
    return address ? getAddress(address.startsWith('0x') ? address : `0x${address}`) : undefined
  } catch {
    return undefined
  }
}

export interface FundsRun {
  mode: 'report' | 'sweep'
  dirs: string[]
  send: boolean
  demo: boolean
  /** Take everything, including sender accounts the records hold ready: the state is finished with. */
  abandoned: boolean
  help: boolean
  logPath?: string
}

export const USAGE = [
  'funds:report [dir ...]                   what every wallet found there holds on chain (read-only; no dir: the known places)',
  'funds:sweep <dir ...>                    dry run: what a sweep would send to the funding wallet',
  'funds:sweep <dir ...> --send             sends it, one transfer per account, and logs every transfer',
  '  --abandoned    also take sender accounts the wallet records hold ready for a coming message:',
  '                 only for a state that will never be opened again',
  '  --demo         allow a demo state directory (yarn demo:sweep passes --demo --abandoned)',
  '  --log <file>   where --send appends one JSON line per transfer (default: a file in the temp directory)',
  '  --help         this text',
  'A directory a process has open is never swept. Keys are never printed. Testnet MON only.',
].join('\n')

export function parseArgs(argv: string[]): FundsRun {
  const [mode, ...rest] = argv
  if (argv.includes('--help') || argv.includes('-h')) return { mode: 'report', dirs: [], send: false, demo: false, abandoned: false, help: true }
  if (mode !== 'report' && mode !== 'sweep') throw new Error(`Usage:\n${USAGE}`)
  const run: FundsRun = { mode, dirs: [], send: false, demo: false, abandoned: false, help: false }
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--send') run.send = true
    else if (rest[i] === '--demo') run.demo = true
    else if (rest[i] === '--abandoned') run.abandoned = true
    else if (rest[i] === '--log') run.logPath = resolve(rest[(i += 1)] ?? '')
    else if (rest[i].startsWith('--')) throw new Error(`unknown option ${rest[i]}`)
    else run.dirs.push(resolve(rest[i]))
  }
  if (mode === 'sweep' && run.dirs.length === 0) {
    throw new Error('funds:sweep needs the state directories to empty: it never guesses which ones are abandoned (funds:report lists them)')
  }
  if (mode === 'report' && run.send) throw new Error('--send belongs to funds:sweep')
  return run
}

export async function main(argv: string[], print: (line: string) => void = console.log): Promise<number> {
  const run = parseArgs(argv)
  if (run.help) {
    print(USAGE)
    return 0
  }
  const env = realStackEnv()
  const rpcUrl = env.MONAD_TESTNET_HTTP_RPC_URL
  if (!rpcUrl) throw new Error('MONAD_TESTNET_HTTP_RPC_URL is required (environment or .env)')
  const provider = new JsonRpcProvider(rpcUrlList(rpcUrl)[0], undefined, { staticNetwork: true })
  let gasPrice: bigint
  try {
    const id = BigInt(await provider.send('eth_chainId', []))
    if (id !== MONAD_TESTNET_CHAIN_ID) throw new Error(`MONAD_TESTNET_HTTP_RPC_URL answers chain id ${id}, not Monad testnet: this tool moves testnet MON only`)
    gasPrice = BigInt(await provider.send('eth_gasPrice', []))
  } finally {
    provider.destroy()
  }
  const destination = addressOf(env.E2E_DEMO_MAIN_WALLET_JSON)
  const never = [destination, addressOf(env.FRANK_TEST_WALLET_JSON), addressOf(env.FRANK_DEMO_FAUCET_WALLET_JSON)].filter((a): a is string => !!a)
  if (run.mode === 'sweep' && !destination) {
    throw new Error('E2E_DEMO_MAIN_WALLET_JSON is required (environment or .env): its address is where a sweep sends')
  }
  const dirs = run.dirs.length > 0 ? run.dirs : knownLocations(env)
  print(`transfer fee ${mon(gasPrice * TRANSFER_GAS)} MON (21000 gas at ${gasPrice} wei); an account under twice that is dust`)
  if (destination) print(`funding wallet ${destination}`)

  const keys = new Map<string, string>()
  const toSend: { dir: string; moves: Move[] }[] = []
  const total = { held: 0n, recoverable: 0n, dust: 0n, noKey: 0n, moves: 0 }
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      print(`\n${short(dir)}: does not exist`)
      continue
    }
    const wallets = await findWallets(dir)
    if (wallets.length === 0) {
      if (run.dirs.length > 0) print(`\n${short(dir)}: no key files found`)
      continue
    }
    const holdings: Holding[] = []
    const balances = await readBalances(rpcUrl, wallets.flatMap(w => w.accounts.map(a => a.address)))
    for (const wallet of wallets) {
      for (const account of wallet.accounts) {
        if (account.privateKey) keys.set(account.address.toLowerCase(), account.privateKey)
        holdings.push({
          wallet: wallet.path,
          role: account.role,
          address: account.address,
          balanceWei: balances.get(account.address.toLowerCase()) ?? 0n,
          hasKey: account.privateKey !== undefined,
          heldByRecords: account.heldByRecords,
        })
      }
    }
    const plan = planSweep(holdings, gasPrice, never, { abandoned: run.abandoned })
    const held = plan.recoverableWei + plan.feesWei + plan.dustWei + plan.noKeyWei
    const users = usersOf(dir)
    const demo = isDemoState(dir)
    const at = statSync(dir).mtime
    const two = (n: number) => String(n).padStart(2, '0')
    const modified = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`
    print(
      `\n${short(dir)}  (${demo ? 'demo state' : 'test state'}, modified ${modified}${users.length ? `, IN USE by ${users.slice(0, 3).join(', ')}` : ''})`,
    )
    print(
      `  ${wallets.length} wallets, ${new Set(holdings.map(h => h.address.toLowerCase())).size} accounts; holds ${mon(held)} MON: ${mon(plan.recoverableWei)} recoverable in ${plan.moves.length} transfers, ${mon(plan.dustWei)} dust, ${mon(plan.noKeyWei)} without a key`,
    )
    for (const wallet of wallets) {
      if (wallet.problem) print(`  SKIPPED ${short(wallet.path)}: ${wallet.problem}`)
      if (wallet.note) print(`  NOTE ${short(wallet.path)}: ${wallet.note}`)
    }
    const kept = plan.skipped.filter(s => s.reason.startsWith('kept'))
    if (kept.length > 0) {
      print(`  ${mon(kept.reduce((sum, s) => sum + s.balanceWei, 0n))} MON in ${kept.length} sender accounts stays: the wallet's records hold them ready for coming messages (--abandoned takes them)`)
    }
    for (const move of plan.moves) {
      print(`  ${mon(move.balanceWei).padStart(22)} MON  ${move.address}  ${move.role.padEnd(22)} ${short(move.wallet).slice(short(dir).length) || basename(dirname(move.wallet))}`)
    }
    for (const skip of plan.skipped.filter(s => !s.reason.startsWith('dust') && !s.reason.startsWith('kept'))) {
      print(`  ${mon(skip.balanceWei).padStart(22)} MON  ${skip.address}  ${skip.role}: NOT MOVED, ${skip.reason}`)
    }
    total.held += held
    total.dust += plan.dustWei
    total.noKey += plan.noKeyWei
    if (run.mode === 'sweep') {
      if (users.length > 0) {
        print('  NOT SWEPT: a running process has this directory open')
        continue
      }
      if (demo && !run.demo) {
        print('  NOT SWEPT: this is a demo state directory, whose bots stay funded between runs. To empty it: yarn demo:sweep <dir> --send')
        continue
      }
      toSend.push({ dir, moves: plan.moves })
    }
    total.recoverable += plan.recoverableWei
    total.moves += plan.moves.length
  }
  print(
    `\nTOTAL held ${mon(total.held)} MON: ${mon(total.recoverable)} recoverable in ${total.moves} transfers, ${mon(total.dust)} dust not worth moving, ${mon(total.noKey)} without a key`,
  )
  if (run.mode === 'report') return 0

  const allMoves = toSend.flatMap(group => group.moves)
  const sendWei = allMoves.reduce((sum, move) => sum + move.valueWei, 0n)
  if (!run.send) {
    print(`DRY RUN: --send would move ${mon(sendWei)} MON in ${allMoves.length} transfers to ${destination}. Nothing was sent.`)
    return 0
  }
  const logPath = run.logPath ?? join(tmpdir(), `frank-funds-sweep-${Date.now()}.jsonl`)
  print(`sending ${mon(sendWei)} MON in ${allMoves.length} transfers to ${destination}; log ${logPath}`)
  const results: SweepResult[] = []
  let refused = 0
  for (const group of toSend) {
    if (group.moves.length === 0) continue
    // Asked again at the moment of sending: reading the balances above took a while.
    const users = usersOf(group.dir)
    if (users.length > 0) {
      refused += 1
      print(`  NOT SWEPT ${short(group.dir)}: in use since the check above (${users.slice(0, 3).join(', ')})`)
      continue
    }
    results.push(...(await sendSweep({ rpcUrl, destination: destination as string, moves: group.moves, keys, logPath, print })))
  }
  const mined = results.filter(r => r.status === 'mined')
  const failed = results.filter(r => r.status !== 'mined')
  print(`\nRETURNED ${mon(mined.reduce((sum, r) => sum + r.valueWei, 0n))} MON in ${mined.length} transfers to ${destination}; log ${logPath}`)
  for (const result of failed) print(`  NOT RETURNED from ${result.address} (${result.role}): ${result.status}`)
  return failed.length === 0 && refused === 0 ? 0 : 1
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    err => {
      console.error(err instanceof Error ? err.message : 'funds: failed')
      process.exit(1)
    },
  )
}
