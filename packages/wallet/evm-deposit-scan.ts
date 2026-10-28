/**
 * Deposits from outside Frank to the wallet's own addresses on one EVM chain, found by reading
 * the chain's own JSON-RPC node: History's record of money that arrived with no Frank message
 * (a faucet, an exchange withdrawal, a plain transfer from another wallet).
 *
 * The node is the index. For each watched address the scanner keeps a cursor: a block and what
 * the address held at it (native balance, nonce, and the balance of every supported ERC20).
 * When what the address holds at the head differs from the cursor, the first block where it
 * changed is found by bisection over historical state reads (`eth_getBalance`,
 * `eth_getTransactionCount` and `balanceOf` at a block number), and only that block is read:
 *
 * - native: when the balance rose, or changed while the nonce did not (so the address did not
 *   send it), the block's transaction hashes (`eth_getBlockByNumber` without transactions, the
 *   read the relay's RPC proxy serves; it refuses full-transaction blocks), then each
 *   transaction (`eth_getTransactionByHash`), and the receipt of each one sent to the address;
 * - ERC20: when a token's balance changed, `eth_getLogs` for `Transfer(_, address, _)` of that
 *   token in that one block (the proxy accepts at most a few blocks per log query).
 *
 * The cursor then moves to that block and the next change is looked for, up to
 * `MAX_CHANGES_PER_REFRESH` per refresh; the rest is found by the next one. A block is read
 * once: deposits are written before the cursor passes their block, and a deposit's key is a
 * fact of the chain (`depositId`), so a repeated read writes the same rows.
 *
 * Where reading starts for an address the scanner has not seen (`firstCursor`): at the head when
 * the address holds nothing and never sent anything; otherwise at the later of
 * `head - FIRST_SCAN_WINDOW_BLOCKS` and the oldest block whose state the node still serves
 * (a Monad node keeps hours of it, not the chain's whole history). Deposits before that block
 * are not listed; the cursor records the height (`scannedFrom`).
 *
 * What is not found:
 * - native value moved by a contract (an internal transfer): it is in no transaction's `to`,
 *   and trace APIs are not used;
 * - a native deposit in the same block as a send from the same address whose net change is a
 *   fall in balance;
 * - changes in blocks whose state the node no longer serves when the scanner reaches them
 *   (the wallet was not opened for longer than the node keeps state), and native deposits in a
 *   block of more than `MAX_BLOCK_TRANSACTION_READS` transactions: the cursor records the
 *   blocks passed over (`unreadable`) and moves on.
 *
 * This is a derived view of the chain, rebuilt by deleting the namespace: it holds no key, never
 * signs, and is not where the balance or the coin list come from (they read the chain
 * themselves). Every device of the account reads the same chain and computes the same rows.
 */
import { getAddress, Interface, zeroPadValue } from 'ethers'
import type { RecordStore } from './storage/evm-coin-store'
import { isRateLimited } from './evm-rpc-read-budget'
import { MAX_NATIVE_BLOCK_TRANSACTION_READS, readCanonicalNativeTransfers } from './evm-native-receipt'

export const EVM_EXTERNAL_DEPOSITS_NAMESPACE = 'evm-external-deposits'

/** How far back a first scan of an address may start, in blocks. */
export const FIRST_SCAN_WINDOW_BLOCKS = 1_000_000
/** The most state changes one refresh follows per address. */
export const MAX_CHANGES_PER_REFRESH = 16
/** The most transactions read from one block to find the ones sent to the address. */
export const MAX_BLOCK_TRANSACTION_READS = MAX_NATIVE_BLOCK_TRANSACTION_READS
const erc20 = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
const TRANSFER_TOPIC = erc20.getEvent('Transfer')!.topicHash

/** A supported ERC20 of the chain. */
export interface EvmDepositToken {
  /** Lower-case 0x contract address. */
  readonly contract: string
  readonly symbol: string
  readonly decimals: number
}

export type EvmDepositAsset =
  | { readonly kind: 'native' }
  | {
      readonly kind: 'erc20'
      readonly contract: string
      readonly symbol: string
      readonly decimals: number
    }

/** One deposit the chain shows: value sent to a watched address by someone outside the wallet. */
export interface EvmExternalDeposit {
  /** `depositId`: the transaction hash, and the log index for a token transfer. */
  readonly id: string
  readonly chainIdentifier: string
  /** Lower-case 0x transaction hash. */
  readonly txHash: string
  /** A token transfer's log index; absent for native value. */
  readonly logIndex?: number
  /** Lower-case 0x watched address it arrived at. */
  readonly to: string
  /** Lower-case 0x sender. */
  readonly from: string
  readonly asset: EvmDepositAsset
  /** Base units (wei for native), decimal string. */
  readonly amount: string
  readonly blockNumber: number
  /** Lower-case 0x block hash. */
  readonly blockHash: string
  /** The block's time, epoch ms. */
  readonly blockTimeMs: number
}

/** What an address held at one block. */
interface AddressState {
  readonly balanceWei: string
  readonly nonce: number
  /** Token contract -> balance in base units; only tokens that answered. */
  readonly tokens: Readonly<Record<string, string>>
}

interface Cursor extends AddressState {
  readonly address: string
  readonly block: number
  /** The block the scan of this address started at: nothing earlier is listed. */
  readonly scannedFrom: number
  /** Blocks passed over: the node no longer served their state, or a block held more
   * transactions than `MAX_BLOCK_TRANSACTION_READS`. [from, to], inclusive. */
  readonly unreadable?: readonly (readonly [number, number])[]
}

type Row =
  | ({ readonly kind: 'cursor' } & Cursor)
  | ({ readonly kind: 'deposit' } & EvmExternalDeposit)

export interface EvmDepositRpc {
  send(method: string, params: unknown[]): Promise<unknown>
}

/** The key of a deposit, the same on every device: a fact of the chain, never a random value. */
export function depositId(txHash: string, logIndex?: number): string {
  const hash = txHash.toLowerCase()
  return logIndex === undefined ? `${hash}:native` : `${hash}:log:${logIndex}`
}

/** The node no longer has (or never had) the state of that block. */
export class HistoricalStateUnavailable extends Error {
  constructor(readonly block: number, cause: unknown) {
    super(`The node does not serve the state of block ${block}`, { cause })
  }
}

function messageOf(error: unknown, depth = 0): string {
  if (depth > 4 || typeof error !== 'object' || error === null)
    return typeof error === 'string' ? error : ''
  const value = error as {
    message?: unknown
    shortMessage?: unknown
    error?: unknown
    info?: unknown
  }
  return [
    typeof value.message === 'string' ? value.message : '',
    typeof value.shortMessage === 'string' ? value.shortMessage : '',
    messageOf(value.error, depth + 1),
    messageOf(value.info, depth + 1),
  ].join(' ')
}

/** Whether a node's answer says it does not serve state at that height (pruned history). Any
 * other failure (a timeout, a rate limit) is not evidence of that. */
export function isHistoricalStateUnavailable(error: unknown): boolean {
  if (isRateLimited(error)) return false
  // Monad: "Block requested not found. Request might be querying historical state that is not
  // available"; geth: "missing trie node", "header not found"; anvil with pruned history:
  // "BlockOutOfRangeError". The scanner never asks for a block above the head it read.
  return /historical state|block requested not found|header not found|missing trie node|state (is )?not available|pruned|BlockOutOfRange/i.test(
    messageOf(error),
  )
}

const hex = (value: number): string => `0x${value.toString(16)}`
const lower = (address: string): string => getAddress(address).toLowerCase()

function sameState(a: AddressState, b: AddressState): boolean {
  if (a.balanceWei !== b.balanceWei || a.nonce !== b.nonce) return false
  const keys = new Set([...Object.keys(a.tokens), ...Object.keys(b.tokens)])
  for (const key of keys) if ((a.tokens[key] ?? '0') !== (b.tokens[key] ?? '0')) return false
  return true
}

function holdsNothing(state: AddressState): boolean {
  return (
    state.balanceWei === '0' &&
    state.nonce === 0 &&
    Object.values(state.tokens).every(value => value === '0')
  )
}

export interface EvmDepositScannerOptions {
  readonly chainIdentifier: string
  readonly rpc: EvmDepositRpc
  readonly store: RecordStore<Row>
  /** The addresses whose deposits are listed: the wallet's receive and identity accounts and its
   * dApp personas. Read at each refresh. */
  readonly watched: () => readonly string[]
  /** The chain's supported ERC20s. */
  readonly tokens: readonly EvmDepositToken[]
  /** Whether an address is one of the wallet's own accounts: a transfer from one is the wallet
   * moving its own money, never a deposit. */
  readonly isOwnAccount: (address: string) => boolean
  /** Transactions the wallet already knows as Frank payments (received coins' transfers): never
   * listed again as deposits. Lower-case 0x hashes. */
  readonly knownTransactions?: () => ReadonlySet<string>
  /** Explicit canonical scan boundary. Financial consumers must provide their configured
   * spend-rule head; the history default reads the proposed RPC head and is not payment authority. */
  readonly maximumBlock?: () => Promise<number>
  readonly firstScanWindowBlocks?: number
}

export class EvmDepositScanner {
  private refreshing: Promise<void> | undefined
  constructor(private readonly options: EvmDepositScannerOptions) {}

  /** Every deposit found so far, newest first. Read only. */
  deposits(): EvmExternalDeposit[] {
    return this.options.store
      .all()
      .flatMap(row => {
        if (row.kind !== 'deposit') return []
        const { kind: _kind, ...deposit } = row
        return deposit.chainIdentifier === this.options.chainIdentifier ? [deposit] : []
      })
      .sort((a, b) => b.blockNumber - a.blockNumber || a.id.localeCompare(b.id))
  }

  /** The scan state of one address: the block it reached, where it started and any gaps. */
  cursorOf(address: string):
    | { block: number; scannedFrom: number; unreadable: readonly (readonly [number, number])[] }
    | undefined {
    const row = this.options.store.get(`cursor:${lower(address)}`)
    if (row?.kind !== 'cursor') return undefined
    return { block: row.block, scannedFrom: row.scannedFrom, unreadable: row.unreadable ?? [] }
  }

  /** Reads the chain up to its head for every watched address. One refresh at a time: a call
   * while one runs waits for it. Rejects when the node cannot be read; what was found before the
   * failure is kept. */
  refresh(): Promise<void> {
    this.refreshing ??= this.run().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async run(): Promise<void> {
    const head = this.options.maximumBlock
      ? await this.options.maximumBlock()
      : Number(BigInt((await this.options.rpc.send('eth_blockNumber', [])) as string))
    if (!Number.isSafeInteger(head) || head < 0) throw new Error('Invalid deposit scan maximum block')
    const addresses = [...new Set(this.options.watched().map(lower))]
    const failures: unknown[] = []
    for (const address of addresses) {
      try {
        await this.scanAddress(address, head)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw failures[0]
  }

  private async readState(address: string, block: number): Promise<AddressState> {
    const tag = hex(block)
    try {
      const [balance, nonce, ...tokens] = await Promise.all([
        this.options.rpc.send('eth_getBalance', [address, tag]),
        this.options.rpc.send('eth_getTransactionCount', [address, tag]),
        ...this.options.tokens.map(token =>
          this.options.rpc.send('eth_call', [
            {
              to: token.contract,
              data: erc20.encodeFunctionData('balanceOf', [address]),
            },
            tag,
          ]),
        ),
      ])
      const tokenBalances: Record<string, string> = {}
      this.options.tokens.forEach((token, index) => {
        const raw = tokens[index] as string
        tokenBalances[token.contract] =
          raw === '0x' ? '0' : BigInt(raw).toString()
      })
      return {
        balanceWei: BigInt(balance as string).toString(),
        nonce: Number(BigInt(nonce as string)),
        tokens: tokenBalances,
      }
    } catch (error) {
      if (isHistoricalStateUnavailable(error)) throw new HistoricalStateUnavailable(block, error)
      throw error
    }
  }

  /** The oldest block in [from, to] whose state the node serves; `to` is known to be served. */
  private async oldestReadable(address: string, from: number, to: number): Promise<number> {
    let lo = from
    let hi = to
    // Served blocks are the most recent ones: [oldest, head]. Find the first served one.
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      try {
        await this.options.rpc.send('eth_getBalance', [address, hex(mid)])
        hi = mid
      } catch (error) {
        if (!isHistoricalStateUnavailable(error)) throw error
        lo = mid + 1
      }
    }
    return lo
  }

  private async firstCursor(address: string, head: number, now: AddressState): Promise<Cursor> {
    if (holdsNothing(now))
      return { address, block: head, scannedFrom: head, ...now }
    let start = Math.max(0, head - (this.options.firstScanWindowBlocks ?? FIRST_SCAN_WINDOW_BLOCKS))
    let state: AddressState
    try {
      state = await this.readState(address, start)
    } catch (error) {
      if (!(error instanceof HistoricalStateUnavailable)) throw error
      start = await this.oldestReadable(address, start, head)
      state = await this.readState(address, start)
    }
    return { address, block: start, scannedFrom: start, ...state }
  }

  private async scanAddress(address: string, head: number): Promise<void> {
    const key = `cursor:${address}`
    const now = await this.readState(address, head)
    const stored = this.options.store.get(key)
    let cursor: Cursor
    if (stored?.kind === 'cursor') {
      const { kind: _kind, ...rest } = stored
      cursor = rest
    } else {
      cursor = await this.firstCursor(address, head, now)
      await this.options.store.put(key, { kind: 'cursor', ...cursor })
    }
    if (cursor.block >= head) return
    for (let step = 0; step < MAX_CHANGES_PER_REFRESH; step++) {
      if (sameState(cursor, now)) {
        cursor = { ...cursor, block: head }
        await this.options.store.put(key, { kind: 'cursor', ...cursor })
        return
      }
      let change: { block: number; state: AddressState }
      try {
        change = await this.firstChange(address, cursor, head, now)
      } catch (error) {
        if (!(error instanceof HistoricalStateUnavailable)) throw error
        // The node no longer serves some of the blocks after the cursor: start again from the
        // oldest it serves, and record the blocks passed over.
        const oldest = await this.oldestReadable(address, cursor.block + 1, head)
        const state = await this.readState(address, oldest)
        cursor = {
          ...cursor,
          ...state,
          block: oldest,
          unreadable: [...(cursor.unreadable ?? []), [cursor.block + 1, oldest]],
        }
        await this.options.store.put(key, { kind: 'cursor', ...cursor })
        continue
      }
      const read = await this.depositsIn(address, change.block, cursor, change.state, head)
      for (const deposit of read.deposits)
        await this.options.store.put(`deposit:${deposit.id}`, { kind: 'deposit', ...deposit })
      cursor = {
        ...cursor,
        ...change.state,
        block: change.block,
        ...(read.unread
          ? { unreadable: [...(cursor.unreadable ?? []), [change.block, change.block] as const] }
          : {}),
      }
      await this.options.store.put(key, { kind: 'cursor', ...cursor })
    }
  }

  /** The first block after the cursor at which the address holds something else. The state at
   * the head (`now`) is known to differ from the cursor's. */
  private async firstChange(
    address: string,
    cursor: Cursor,
    head: number,
    now: AddressState,
  ): Promise<{ block: number; state: AddressState }> {
    let lo = cursor.block
    let hi = head
    let hiState = now
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      const state = await this.readState(address, mid)
      if (sameState(state, cursor)) lo = mid
      else {
        hi = mid
        hiState = state
      }
    }
    return { block: hi, state: hiState }
  }

  private async depositsIn(
    address: string,
    blockNumber: number,
    before: AddressState,
    after: AddressState,
    maximumBlock: number,
  ): Promise<{ deposits: EvmExternalDeposit[]; unread: boolean }> {
    const block = (await this.options.rpc.send('eth_getBlockByNumber', [
      hex(blockNumber),
      false,
    ])) as { hash: string; timestamp: string; transactions: string[] } | null
    if (!block) throw new Error(`The node did not return block ${blockNumber}`)
    const blockHash = block.hash.toLowerCase()
    const blockTimeMs = Number(BigInt(block.timestamp)) * 1000
    const known = this.options.knownTransactions?.() ?? new Set<string>()
    const found: EvmExternalDeposit[] = []
    const common = {
      chainIdentifier: this.options.chainIdentifier,
      to: address,
      blockNumber,
      blockHash,
      blockTimeMs,
    }

    const before_ = BigInt(before.balanceWei)
    const after_ = BigInt(after.balanceWei)
    const nativeArrived = after_ > before_ || (after_ !== before_ && after.nonce === before.nonce)
    // A block with more transactions than one read may cover is passed over, and recorded so.
    const unread = nativeArrived && block.transactions.length > MAX_BLOCK_TRANSACTION_READS
    if (nativeArrived && !unread) {
      const transfers = await readCanonicalNativeTransfers({
        rpc: this.options.rpc,
        chainIdentifier: this.options.chainIdentifier,
        address,
        blockNumber,
        maximumBlock,
      })
      // This earlier block read also supplies the token-history projection below.
      if (transfers.some(transfer => transfer.blockHash !== blockHash))
        throw new Error('Deposit block changed during native evidence read')
      for (const transfer of transfers) {
        if (
          this.options.isOwnAccount(transfer.from) ||
          known.has(transfer.txHash)
        )
          continue
        found.push({
          ...transfer,
          id: depositId(transfer.txHash),
          asset: { kind: 'native' },
        })
      }
    }

    for (const token of this.options.tokens) {
      if ((before.tokens[token.contract] ?? '0') === (after.tokens[token.contract] ?? '0')) continue
      const logs = (await this.options.rpc.send('eth_getLogs', [
        {
          fromBlock: hex(blockNumber),
          toBlock: hex(blockNumber),
          address: token.contract,
          topics: [TRANSFER_TOPIC, null, zeroPadValue(address, 32)],
        },
      ])) as {
        transactionHash: string
        logIndex: string
        topics: string[]
        data: string
        blockHash: string
        removed?: boolean
      }[]
      for (const log of logs) {
        if (log.removed || log.blockHash.toLowerCase() !== blockHash) continue
        const from = getAddress(`0x${log.topics[1]!.slice(26)}`).toLowerCase()
        const amount = BigInt(log.data)
        if (
          amount === 0n ||
          this.options.isOwnAccount(from) ||
          known.has(log.transactionHash.toLowerCase())
        )
          continue
        const logIndex = Number(BigInt(log.logIndex))
        found.push({
          ...common,
          id: depositId(log.transactionHash, logIndex),
          txHash: log.transactionHash.toLowerCase(),
          logIndex,
          from,
          asset: {
            kind: 'erc20',
            contract: token.contract,
            symbol: token.symbol,
            decimals: token.decimals,
          },
          amount: amount.toString(),
        })
      }
    }
    return { deposits: found, unread }
  }
}

export type EvmDepositRow = Row
