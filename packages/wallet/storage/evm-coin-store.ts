/**
 * The wallet's durable list of received coins on one EVM chain, and the one-time payments it has
 * prepared for contacts.
 *
 * A coin is money that arrived at a one-time account this wallet can spend from but cannot find
 * again from its seed alone: the account's key is derived from a message (a stealth payment's
 * ephemeral key, a stamp's shared point). The coin is therefore recorded WITH its private key, in
 * this one store, when the message is read, and it stays here whatever happens to the message:
 * deleting a message never touches its coins.
 *
 * So that the account's other devices, and a wallet restored from the seed, find the coin without
 * the message, the wallet writes what the key is derived from in a note to itself, once per coin
 * (`receivedCoinNoteOf`, `notedAtMs`). The note holds no key.
 *
 * `amountWei` is what the chain last reported at the address, never what a sender wrote. A coin is
 * `pending` until the chain shows the transfer its message named included successfully, `unspent`
 * while the account then holds money, `spent` once it is empty again, and `failed` when the chain
 * shows that transfer can never land (it reverted, or its nonce went to another transaction).
 *
 * One wallet is bound to one chain, so a coin carries no chain field.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'
import { computeAddress, getAddress, Interface, Transaction } from 'ethers'
import { PROTOCOL_CHAINS } from '../chain/chains-registry'
import { runNativeTransactionExclusive } from '../chain/chain-wallet'
import type { ReceivedCoinItem } from '@frank/cashweb/types/messages'
import { durableDelete, durablePut, openDurableLevel } from './level-durability'

export type EvmCoinOrigin = 'stealth' | 'stamp'
export type EvmCoinState = 'pending' | 'unspent' | 'spent' | 'failed'

export interface EvmCoin {
  /** Where the money is: the one-time account's address, lower case. The record's key. */
  readonly address: string
  readonly privateKey: string
  readonly origin: EvmCoinOrigin
  readonly state: EvmCoinState
  /** The balance the chain last reported at `address` (decimal wei). "0" until it was read. */
  readonly amountWei: string
  /** What the chain showed the first time it showed any money here (decimal wei): the amount that
   * arrived, which later spending does not change. Absent until then. For a registered native
   * set this is the current canonical verified member sum, which can fall after a reorg. */
  readonly receivedAmountWei?: string
  /** When the chain was last read for this coin. Absent: never read. */
  readonly checkedAtMs?: number
  /** A pending coin only: whether the node knew the transfer that funds it at the last read. */
  readonly transferSeen?: boolean
  /** What the sender's message said the amount was (decimal wei). Display only. */
  readonly claimedAmountWei: string
  /** The transfers the message carried for this coin: a signed raw transaction or a hash, hex. */
  readonly transactions: readonly string[]
  /** Member transaction hashes confirmed included with positive value on-chain for a multi-tx set. */
  readonly settledTransactions?: readonly string[]
  /** Member transaction hashes confirmed failed/reverted on-chain for a multi-tx set. */
  readonly failedTransactions?: readonly string[]
  /** The message the coin came from (its payload digest, bare lower-case hex), when known. */
  readonly payloadDigest?: string
  /** A stealth coin: the sender's ephemeral public key, bare lower-case hex. */
  readonly ephemeralPubKey?: string
  /** A stamp coin: which of the message's payments this is. */
  readonly childIndex?: number
  /** A stamp coin: the public shared point of its message, bare lower-case hex. With
   * `childIndex` it is what the account's key is derived from. Absent on a coin found through
   * the legacy JSON mailbox, whose key is derived another way. */
  readonly stampSharedPoint?: string
  /** When the account's own mailbox was known to hold the note that says how this coin's key is
   * derived: this wallet sent it, or read it. Absent: not written yet. */
  readonly notedAtMs?: number
  readonly discoveredAtMs: number
  /** Distinct ERC20 facts at this same owned account. Native fields above remain native-only.
   * Absence means no discovered ERC20 positions; zero native balance never deletes these. */
  readonly erc20Positions?: readonly EvmErc20Position[]
}

export interface EvmErc20Claim {
  readonly txHash: string
  readonly rawTransaction: string
  readonly amountBaseUnits: string
  readonly payloadDigests: readonly string[]
  readonly discoveredAtMs: number
  readonly execution?: 'succeeded' | 'reverted'
}
export interface EvmErc20Receipt {
  readonly txHash: string
  readonly logIndex: number
  readonly from: string
  readonly amountBaseUnits: string
  readonly blockHash: string
  readonly blockNumber: number
}
export interface EvmErc20Position {
  readonly contractAddress: string
  /** Latest successful balanceOf read. Never a sum of receipts or claimed amounts. */
  readonly balanceBaseUnits: string
  readonly checkedAtMs?: number
  readonly observedBlockHash?: string
  readonly observedBlockNumber?: number
  readonly claims: readonly EvmErc20Claim[]
  /** Identity within this position: [txHash, logIndex]. The position owns token identity. */
  readonly receipts: readonly EvmErc20Receipt[]
}

const erc20 = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
const transferTopic = erc20.getEvent('Transfer')!.topicHash
const uint256 = (value: bigint): bigint => {
  if (value < 0n || value >= 1n << 256n)
    throw new RangeError('Invalid ERC20 quantity')
  return value
}

function configuredErc20(chainIdentifier: string, contractAddress: string) {
  const chain = Object.prototype.hasOwnProperty.call(
    PROTOCOL_CHAINS,
    chainIdentifier,
  )
    ? PROTOCOL_CHAINS[chainIdentifier]
    : undefined
  const contract = getAddress(contractAddress).toLowerCase()
  if (!chain || chain.family !== 'evm')
    throw new Error('Unsupported canonical EVM chain')
  const supported = (chain.dex ?? []).some(
    venue =>
      venue.adapter === 'uniswap-v4' &&
      venue.enabled &&
      venue.tokens.some(token => token.address?.toLowerCase() === contract),
  )
  if (!supported) throw new Error('Unsupported configured ERC20 contract')
  return { contract, nativeChainId: BigInt(chain.nativeChainId!) }
}

function paymentTransaction(
  coin: EvmCoin,
  chainIdentifier: string,
  contractAddress: string,
  rawTransaction: string,
  amountBaseUnits: bigint,
) {
  const { contract, nativeChainId } = configuredErc20(
    chainIdentifier,
    contractAddress,
  )
  const transaction = Transaction.from(rawTransaction)
  uint256(amountBaseUnits)
  if (
    amountBaseUnits === 0n ||
    !transaction.isSigned() ||
    transaction.chainId !== nativeChainId ||
    transaction.value !== 0n ||
    transaction.to?.toLowerCase() !== contract ||
    transaction.data.toLowerCase() !==
      erc20
        .encodeFunctionData('transfer', [
          getAddress(coin.address),
          amountBaseUnits,
        ])
        .toLowerCase()
  )
    throw new Error('ERC20 transaction does not match the claimed payment')
  return transaction
}

/** Register exact signed evidence, not value. Repeated messages add membership without another
 * payment; a later token or transaction at a known account adds a distinct claim. */
export function registerEvmErc20Payment(
  coin: EvmCoin,
  payment: {
    chainIdentifier: string
    contractAddress: string
    rawTransaction: string
    amountBaseUnits: bigint
    payloadDigest?: string
    discoveredAtMs: number
  },
): EvmCoin {
  const tx = paymentTransaction(
    coin,
    payment.chainIdentifier,
    payment.contractAddress,
    payment.rawTransaction,
    payment.amountBaseUnits,
  )
  const contract = tx.to!.toLowerCase()
  const digest = payment.payloadDigest?.replace(/^0x/, '').toLowerCase()
  if (digest !== undefined && !/^[0-9a-f]{64}$/.test(digest))
    throw new Error('Invalid payment membership')
  const positions = [...(coin.erc20Positions ?? [])]
  const index = positions.findIndex(
    position => position.contractAddress === contract,
  )
  const position: EvmErc20Position =
    index < 0
      ? {
          contractAddress: contract,
          balanceBaseUnits: '0',
          claims: [],
          receipts: [],
        }
      : positions[index]!
  const claims = [...position.claims]
  const previous = claims.findIndex(claim => claim.txHash === tx.hash)
  const known = previous < 0 ? undefined : claims[previous]
  const claim: EvmErc20Claim = {
    ...known,
    txHash: tx.hash!,
    rawTransaction: tx.serialized,
    amountBaseUnits: payment.amountBaseUnits.toString(),
    payloadDigests: [
      ...new Set([
        ...(known?.payloadDigests ?? []),
        ...(digest === undefined ? [] : [digest]),
      ]),
    ].sort(),
    discoveredAtMs: Math.min(
      known?.discoveredAtMs ?? payment.discoveredAtMs,
      payment.discoveredAtMs,
    ),
  }
  if (previous < 0) claims.push(claim)
  else claims[previous] = claim
  const next = { ...position, claims }
  if (index < 0) positions.push(next)
  else positions[index] = next
  return { ...coin, erc20Positions: positions }
}

export interface EvmErc20Reader {
  call(tx: { to: string; data: string; blockTag?: number }): Promise<string>
  getBlock(
    tag: 'latest' | number,
  ): Promise<{ hash: string | null; number: number } | null>
  getTransactionReceipt(hash: string): Promise<{
    hash: string
    from: string
    to: string | null
    status: number | null
    blockHash: string
    blockNumber: number
    logs: readonly {
      address: string
      topics: readonly string[]
      data: string
      index: number
    }[]
  } | null>
}

/** Read-only RPC evidence. No rebroadcast, signing, native funding or persistence side effects;
 * the existing owner must durably save the returned account before acknowledging receive. */
export async function refreshEvmErc20Position(
  coin: EvmCoin,
  options: {
    chainIdentifier: string
    contractAddress: string
    reader: EvmErc20Reader
    atMs: number
  },
): Promise<EvmCoin> {
  options = { ...options }
  const { contract } = configuredErc20(
    options.chainIdentifier,
    options.contractAddress,
  )
  const position = coin.erc20Positions?.find(
    item => item.contractAddress === contract,
  )
  if (!position) throw new Error('ERC20 position has not been discovered')
  const block = await options.reader.getBlock('latest')
  if (
    !block?.hash ||
    !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
    !Number.isSafeInteger(block.number) ||
    block.number < 0
  )
    throw new Error('ERC20 observation block unavailable')
  const encodedBalance = await options.reader.call({
    to: contract,
    data: erc20.encodeFunctionData('balanceOf', [getAddress(coin.address)]),
    blockTag: block.number,
  })
  if (!/^0x[0-9a-fA-F]{64}$/.test(encodedBalance))
    throw new Error('Invalid ERC20 balance response')
  const balance = uint256(BigInt(encodedBalance))
  const claims: EvmErc20Claim[] = []
  let receipts = [...position.receipts]
  for (const claim of position.claims) {
    const tx = paymentTransaction(
      coin,
      options.chainIdentifier,
      contract,
      claim.rawTransaction,
      BigInt(claim.amountBaseUnits),
    )
    if (tx.hash !== claim.txHash)
      throw new Error('ERC20 claim transaction hash mismatch')
    const receipt = await options.reader.getTransactionReceipt(claim.txHash)
    if (receipt === null) {
      // A formerly included transaction may have been removed by a reorganization.
      // Absence is pending evidence, never proof of failure or retained receipt value.
      receipts = receipts.filter(item => item.txHash !== claim.txHash)
      const { execution: _execution, ...pending } = claim
      claims.push(pending)
      continue
    }
    const included = await options.reader.getBlock(receipt.blockNumber)
    if (
      receipt.hash.toLowerCase() !== tx.hash ||
      receipt.from.toLowerCase() !== tx.from!.toLowerCase() ||
      receipt.to?.toLowerCase() !== contract ||
      !included?.hash ||
      included.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      included.number !== receipt.blockNumber ||
      receipt.blockNumber > block.number ||
      (receipt.status !== 0 && receipt.status !== 1)
    )
      throw new Error('Invalid ERC20 inclusion evidence')
    const effects: EvmErc20Receipt[] = []
    const indexes = new Set<number>()
    if (receipt.status === 1)
      for (const log of receipt.logs) {
        if (
          log.address.toLowerCase() !== contract ||
          log.topics[0]?.toLowerCase() !== transferTopic.toLowerCase()
        )
          continue
        if (
          !Number.isSafeInteger(log.index) ||
          log.index < 0 ||
          indexes.has(log.index)
        )
          throw new Error('Invalid ERC20 receipt log index')
        indexes.add(log.index)
        if (log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data))
          throw new Error('Invalid ERC20 Transfer log')
        const event = erc20.decodeEventLog('Transfer', log.data, [
          ...log.topics,
        ])
        if (
          getAddress(event.from).toLowerCase() !== tx.from!.toLowerCase() ||
          getAddress(event.to).toLowerCase() !== coin.address.toLowerCase()
        )
          continue
        effects.push({
          txHash: claim.txHash,
          logIndex: log.index,
          from: tx.from!.toLowerCase(),
          amountBaseUnits: uint256(event.value).toString(),
          blockHash: receipt.blockHash.toLowerCase(),
          blockNumber: receipt.blockNumber,
        })
      }
    // Re-observing this transaction replaces its evidence; it never adds value twice.
    receipts = [
      ...receipts.filter(item => item.txHash !== claim.txHash),
      ...effects,
    ]
    claims.push({
      ...claim,
      execution: receipt.status === 1 ? 'succeeded' : 'reverted',
    })
  }
  // Recheck the snapshot after RPC awaits. An inconsistent/reorganized block commits nothing.
  const current = await options.reader.getBlock(block.number)
  if (current?.hash?.toLowerCase() !== block.hash.toLowerCase())
    throw new Error('ERC20 observation block changed')
  const next = {
    ...position,
    balanceBaseUnits: balance.toString(),
    checkedAtMs: options.atMs,
    observedBlockHash: block.hash.toLowerCase(),
    observedBlockNumber: block.number,
    claims,
    receipts,
  }
  return {
    ...coin,
    erc20Positions: coin.erc20Positions!.map(item =>
      item.contractAddress === contract ? next : item,
    ),
  }
}

/** Receipt amount and current position are separate quantities. Native fees are supplied by
 * the bound owner from its current read/quote, never taken from the token or a message stamp. */
export function receivedErc20Payments(
  coin: EvmCoin,
  options: {
    nativeBalanceWei: bigint
    requiredNativeFeeWei: bigint
    reserved?: boolean
  },
) {
  uint256(options.nativeBalanceWei)
  uint256(options.requiredNativeFeeWei)
  return (coin.erc20Positions ?? []).flatMap(position =>
    position.claims.map(claim => {
      const received = position.receipts
        .filter(receipt => receipt.txHash === claim.txHash)
        .reduce((sum, receipt) => sum + BigInt(receipt.amountBaseUnits), 0n)
      const status: 'pending' | 'received' | 'partial' | 'failed' =
        claim.execution === 'reverted'
          ? 'failed'
          : claim.execution !== 'succeeded'
          ? 'pending'
          : received === BigInt(claim.amountBaseUnits)
          ? 'received'
          : 'partial'
      const spendability:
        | 'empty'
        | 'unverified'
        | 'reserved'
        | 'needs-native-gas'
        | 'spendable' =
        BigInt(position.balanceBaseUnits) === 0n
          ? 'empty'
          : !position.receipts.some(
              receipt => BigInt(receipt.amountBaseUnits) > 0n,
            )
          ? 'unverified'
          : options.reserved
          ? 'reserved'
          : options.nativeBalanceWei < options.requiredNativeFeeWei ||
            options.nativeBalanceWei === 0n
          ? 'needs-native-gas'
          : 'spendable'
      return {
        address: coin.address,
        contractAddress: position.contractAddress,
        txHash: claim.txHash,
        payloadDigests: claim.payloadDigests,
        claimedAmountBaseUnits: BigInt(claim.amountBaseUnits),
        receivedAmountBaseUnits: received,
        balanceBaseUnits: BigInt(position.balanceBaseUnits),
        status,
        spendability,
      }
    }),
  )
}

/** Account discovery for token preparation, independent of native gas availability. Selection
 * still checks the chosen source's nonce claim and native fee cap before signing anything. */
export function fundedErc20Coins(
  coins: readonly EvmCoin[],
  contractAddress: string,
): EvmCoin[] {
  const contract = getAddress(contractAddress).toLowerCase()
  return coins.filter(coin =>
    coin.erc20Positions?.some(
      position =>
        position.contractAddress === contract &&
        BigInt(position.balanceBaseUnits) > 0n &&
        position.receipts.some(receipt => BigInt(receipt.amountBaseUnits) > 0n),
    ),
  )
}

/** The note to self for a coin: the chain, the account, and what its key is derived from. No key
 * and nothing else of the message. Undefined for a coin that holds no derivation data (one found
 * through the legacy JSON mailbox): such a coin is found again only from its message. */
export function receivedCoinNoteOf(
  coin: EvmCoin,
  chainIdentifier: string,
): ReceivedCoinItem | undefined {
  const derivation =
    coin.origin === 'stealth'
      ? coin.ephemeralPubKey === undefined
        ? undefined
        : { ephemeralPubKey: coin.ephemeralPubKey }
      : coin.stampSharedPoint === undefined || coin.childIndex === undefined
      ? undefined
      : {
          stampSharedPoint: coin.stampSharedPoint,
          childIndex: coin.childIndex,
        }
  if (derivation === undefined) return undefined
  return {
    type: 'received-coin',
    chainIdentifier,
    address: coin.address,
    origin: coin.origin,
    ...derivation,
    claimedAmountWei: coin.claimedAmountWei,
    ...(coin.transactions.length > 0
      ? { transactions: [...coin.transactions] }
      : {}),
    ...(coin.payloadDigest === undefined
      ? {}
      : { payloadDigest: coin.payloadDigest }),
    timestamp: coin.discoveredAtMs,
  }
}

/** A one-time payment to a contact this wallet has made: the signed transfer and what the message
 * item needs so the contact can find it. Written before the transfer is signed and kept, so a
 * restart finishes the same payment (the same transfer, the same message) and never makes
 * another. */
export interface ContactPayment {
  /** The one-time address the transfer pays, lower case. The record's key. */
  readonly stealthAddress: string
  /** The message that carries the item: 16 bytes as 8-4-4-4-12 hex. */
  readonly messageId: string
  readonly ephemeralPubKey: string
  readonly recipientAddress: string
  readonly valueWei: string
  readonly memo?: string
  readonly conversationId?: string
  readonly stampValueWei?: string
  /** `planned`: nothing is signed yet. `prepared`: the transfer is signed and journalled and NOT
   * broadcast; its source account is held; the message is being delivered from this record.
   * `delivered`: the relay has the message; this wallet broadcasts the transfer (the contact's
   * does too). `paid`: the chain showed the transfer included. `failed`: the relay ended the
   * message for good; nothing was broadcast by this wallet, the source stays held, and the item
   * is kept to be sent again in a new message. */
  /** `released`: no byte of it ever left the device, and its signed transfer was cancelled in
   * the journal; the record stays so a message carrying its item is refused. */
  readonly state:
    | 'planned'
    | 'prepared'
    | 'delivered'
    | 'paid'
    | 'failed'
    | 'released'
  /** Who sends the message that carries the item: the wallet itself, or the host through its
   * own send path (a chat). Either way the transfer is broadcast only once the relay has it. */
  readonly deliveredBy?: 'wallet' | 'host'
  /** From `prepared` on: the native operation that holds the signed transfer. */
  readonly operationId?: string
  /** Shared construction identity; the journal operationId remains its durable native row. */
  readonly transactionSetOperationId?: string
  readonly rawTransaction?: string
  readonly txHash?: string
  readonly payloadDigest?: string
  readonly failure?: string
  readonly createdAtMs: number
}

/** String-keyed JSON rows, all held in memory and written through before a `put` resolves. */
export interface RecordStore<T> {
  get(key: string): T | undefined
  all(): T[]
  /** Refresh this wrapper's read cache from its one durable owner; no default writes. */
  refresh(): Promise<void>
  put(key: string, row: T): Promise<void>
  /** Compare against durable state, not this wrapper's cache. A miss refreshes its cache. */
  compareAndPut(key: string, expected: T | undefined, row: T): Promise<boolean>
  delete(key: string): Promise<void>
  close(): Promise<void>
}

export class MemoryRecordStore<T> implements RecordStore<T> {
  private readonly rows = new Map<string, T>()
  get(key: string): T | undefined {
    return this.rows.get(key)
  }
  all(): T[] {
    return [...this.rows.values()]
  }
  async refresh(): Promise<void> {
    // This store has one in-memory authority shared by its readers.
  }
  async put(key: string, row: T): Promise<void> {
    this.rows.set(key, { ...row })
  }
  async compareAndPut(
    key: string,
    expected: T | undefined,
    row: T,
  ): Promise<boolean> {
    if (JSON.stringify(this.rows.get(key)) !== JSON.stringify(expected))
      return false
    this.rows.set(key, { ...row })
    return true
  }
  async compareAndDelete(key: string, expected: T): Promise<boolean> {
    if (JSON.stringify(this.rows.get(key)) !== JSON.stringify(expected)) return false
    this.rows.delete(key)
    return true
  }
  async delete(key: string): Promise<void> {
    this.rows.delete(key)
  }
  async close(): Promise<void> {
    return undefined
  }
}

export class LevelRecordStore<T> implements RecordStore<T> {
  private readonly rows = new Map<string, T>()
  private constructor(
    private readonly db: LevelDB,
    private readonly coordinationKey: string,
  ) {}
  static async open<T>(
    location: string,
    namespace: string,
  ): Promise<LevelRecordStore<T>> {
    const database = level(join(location, namespace))
    try {
      await openDurableLevel(database, location, namespace)
      const store = new LevelRecordStore<T>(
        database,
        `received-record-store:${join(location, namespace)}`,
      )
      for await (const [key, value] of (database as any).iterator({}))
        store.rows.set(String(key), JSON.parse(String(value)) as T)
      return store
    } catch (error) {
      await (database as any).close()
      throw error
    }
  }
  get(key: string): T | undefined {
    return this.rows.get(key)
  }
  all(): T[] {
    return [...this.rows.values()]
  }
  /** Reload durable rows before a cross-context admission decision. */
  async refresh(): Promise<void> {
    await runNativeTransactionExclusive(
      this.coordinationKey,
      'single-realm',
      async () => {
        const rows = new Map<string, T>()
        for await (const [key, value] of (this.db as any).iterator({}))
          rows.set(String(key), JSON.parse(String(value)) as T)
        this.rows.clear()
        for (const [key, row] of rows) this.rows.set(key, row)
      },
    )
  }
  async put(key: string, row: T): Promise<void> {
    const bytes = JSON.stringify(row)
    await runNativeTransactionExclusive(
      this.coordinationKey,
      'single-realm',
      async () => {
        await durablePut(this.db, key, bytes)
        this.rows.set(key, JSON.parse(bytes) as T)
      },
    )
  }
  async compareAndPut(
    key: string,
    expected: T | undefined,
    row: T,
  ): Promise<boolean> {
    const expectedBytes = JSON.stringify(expected)
    const bytes = JSON.stringify(row)
    return runNativeTransactionExclusive(
      this.coordinationKey,
      'single-realm',
      async () => {
        let current: T | undefined
        try {
          current = JSON.parse(String(await this.db.get(key))) as T
        } catch (error) {
          if (
            !(
              error &&
              typeof error === 'object' &&
              'notFound' in error &&
              error.notFound === true
            )
          )
            throw error
        }
        if (current === undefined) this.rows.delete(key)
        else this.rows.set(key, current)
        if (JSON.stringify(current) !== expectedBytes) return false
        await durablePut(this.db, key, bytes)
        this.rows.set(key, JSON.parse(bytes) as T)
        return true
      },
    )
  }
  async compareAndDelete(key: string, expected: T): Promise<boolean> {
    const expectedBytes = JSON.stringify(expected)
    return runNativeTransactionExclusive(
      this.coordinationKey,
      'single-realm',
      async () => {
        let current: T | undefined
        try {
          current = JSON.parse(String(await this.db.get(key))) as T
        } catch (error) {
          if (!(error && typeof error === 'object' && 'notFound' in error && error.notFound === true))
            throw error
        }
        if (current === undefined) this.rows.delete(key)
        else this.rows.set(key, current)
        if (JSON.stringify(current) !== expectedBytes) return false
        await durableDelete(this.db, key)
        this.rows.delete(key)
        return true
      },
    )
  }
  async delete(key: string): Promise<void> {
    await runNativeTransactionExclusive(
      this.coordinationKey,
      'single-realm',
      async () => {
        await durableDelete(this.db, key)
        this.rows.delete(key)
      },
    )
  }
  async close(): Promise<void> {
    await (this.db as any).close()
  }
}

export const EVM_COIN_NAMESPACE = 'received-coins'
export const CONTACT_PAYMENT_NAMESPACE = 'contact-payments'

/** First discovery keeps derivation ownership; repeated discovery cannot replace another key
 * or discard positions. Later asset/payment facts enter through their own typed operations. */
export async function recordStoredEvmCoin(
  store: RecordStore<EvmCoin>,
  coin: EvmCoin,
): Promise<EvmCoin> {
  coin = copyCoin(coin)
  const key = getAddress(coin.address).toLowerCase()
  if (key !== coin.address)
    throw new Error('Received account address must be normalized')
  if (computeAddress(coin.privateKey).toLowerCase() !== key)
    throw new Error('Received account key does not open its address')
  for (let attempt = 0; attempt < 8; attempt++) {
    const known = store.get(key)
    if (
      known &&
      (known.privateKey !== coin.privateKey ||
        known.origin !== coin.origin ||
        known.ephemeralPubKey !== coin.ephemeralPubKey ||
        known.stampSharedPoint !== coin.stampSharedPoint ||
        known.childIndex !== coin.childIndex)
    )
      throw new Error('Received account derivation conflicts with its owner')
    const next = known ?? coin
    if (await store.compareAndPut(key, known, next)) return next
  }
  throw new Error('Received account changed during discovery; retry required')
}

type Erc20PaymentInput = Parameters<typeof registerEvmErc20Payment>[1]
type Erc20RefreshOptions = Parameters<typeof refreshEvmErc20Position>[1]
const copyCoin = (coin: EvmCoin): EvmCoin =>
  JSON.parse(JSON.stringify(coin)) as EvmCoin

async function changeStoredCoin(
  store: RecordStore<EvmCoin>,
  address: string,
  change: (coin: EvmCoin) => EvmCoin,
): Promise<EvmCoin> {
  const key = getAddress(address).toLowerCase()
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = store.get(key)
    if (!current) throw new Error('Received account has not been discovered')
    const captured = copyCoin(current)
    const next = change(captured)
    if (await store.compareAndPut(key, captured, next)) return next
  }
  throw new Error('Received account changed during update; retry required')
}

/** Registers the first exact native payment after an account-only recovery note. This changes
 * claim evidence only, never observed native balances or ERC20 positions. The store is already
 * bound to the wallet/chain by composition; caller derivation must match its immutable account. */
export async function registerStoredEvmNativePayment(
  store: RecordStore<EvmCoin>,
  address: string,
  payment: {
    chainIdentifier: string
    ephemeralPubKey: string
    rawTransaction: string
    amountWei: bigint
    payloadDigest: string
  },
): Promise<EvmCoin> {
  return registerStoredEvmNativePaymentSet(store, address, {
    ...payment,
    rawTransactions: [payment.rawTransaction],
  })
}

export interface EvmNativePaymentSet {
  readonly chainIdentifier: string
  readonly ephemeralPubKey: string
  readonly rawTransactions: readonly string[]
  readonly amountWei: bigint
  readonly payloadDigest: string
}
function validateNativePaymentSet(
  address: string,
  payment: EvmNativePaymentSet,
  options?: { allowClaimedMismatch?: boolean },
) {
  const chain = Object.prototype.hasOwnProperty.call(
    PROTOCOL_CHAINS,
    payment.chainIdentifier,
  )
    ? PROTOCOL_CHAINS[payment.chainIdentifier]
    : undefined
  if (!chain || chain.family !== 'evm')
    throw new Error('Unsupported canonical EVM chain')
  if (
    !payment.rawTransactions.length ||
    payment.rawTransactions.length > 16 ||
    payment.amountWei <= 0n ||
    payment.amountWei >= 1n << 256n
  )
    throw new Error('Invalid native payment set')
  const key = getAddress(address).toLowerCase()
  const hashes = new Set<string>(),
    sources = new Set<string>()
  let value = 0n
  const raws = payment.rawTransactions.map(raw => {
    const tx = Transaction.from(raw)
    if (
      !tx.isSigned() ||
      tx.chainId !== BigInt(chain.nativeChainId!) ||
      tx.to?.toLowerCase() !== key ||
      tx.data !== '0x' ||
      tx.value <= 0n
    )
      throw new Error('Native transaction does not match the claimed payment')
    const source = `${tx.from!.toLowerCase()}:${tx.nonce}`
    if (hashes.has(tx.hash!) || sources.has(source))
      throw new Error('Duplicate native payment transaction or source nonce')
    hashes.add(tx.hash!)
    sources.add(source)
    value += tx.value
    return tx.serialized.slice(2).toLowerCase()
  })
  if (!options?.allowClaimedMismatch && value !== payment.amountWei)
    throw new Error('Native transaction set does not match the claimed amount')
  if (!/^[0-9a-fA-F]{64}$/.test(payment.payloadDigest))
    throw new Error('Invalid native payment digest')
  const digest = payment.payloadDigest.toLowerCase()
  return { key, raws, digest }
}
function nativePaymentDerivation(
  coin: EvmCoin,
  payment: EvmNativePaymentSet,
  key: string,
): void {
  if (
    coin.origin !== 'stealth' ||
    coin.ephemeralPubKey !== payment.ephemeralPubKey ||
    computeAddress(coin.privateKey).toLowerCase() !== key
  )
    throw new Error('Native payment derivation conflicts with its owner')
}
function nativePaymentRegistered(
  coin: EvmCoin,
  payment: EvmNativePaymentSet,
  raws: readonly string[],
  digest: string,
): boolean {
  return (
    JSON.stringify(coin.transactions) === JSON.stringify(raws) &&
    coin.claimedAmountWei === payment.amountWei.toString() &&
    coin.payloadDigest === digest
  )
}
/** One complete immutable claim, registered atomically; values are claim evidence, never funds. */
export async function registerStoredEvmNativePaymentSet(
  store: RecordStore<EvmCoin>,
  address: string,
  input: EvmNativePaymentSet,
): Promise<EvmCoin> {
  const payment = { ...input, rawTransactions: [...input.rawTransactions] }
  const { key, raws, digest } = validateNativePaymentSet(address, payment)
  return changeStoredCoin(store, key, coin => {
    nativePaymentDerivation(coin, payment, key)
    if (nativePaymentRegistered(coin, payment, raws, digest)) return coin
    if (coin.transactions.length !== 0 || coin.claimedAmountWei !== '0')
      throw new Error('Conflicting native receipt account claim')
    return {
      ...coin,
      transactions: raws,
      claimedAmountWei: payment.amountWei.toString(),
      payloadDigest: digest,
    }
  })
}

/** Canonical observation for a registered independent native set. RPC does not hold a write lock.
 * Unknown members contribute no verified value; this lower bound never proves nonexecution. */
export async function refreshStoredEvmNativePaymentSet(
  store: RecordStore<EvmCoin>,
  address: string,
  input: EvmNativePaymentSet,
  read: (
    address: string,
    rawTransactions: readonly string[],
  ) => Promise<{
    balanceWei: bigint
    receivedAmountsWei: readonly (bigint | undefined)[]
  }>,
  atMs: number,
): Promise<{
  applied: boolean
  coin: EvmCoin
  verifiedReceivedAmountWei: bigint
  complete: boolean
  allFailed: boolean
}> {
  const payment = { ...input, rawTransactions: [...input.rawTransactions] }
  const { key, raws, digest } = validateNativePaymentSet(address, payment, {
    allowClaimedMismatch: true,
  })
  if (raws.length < 2 || !Number.isFinite(atMs) || atMs < 0)
    throw new Error('Invalid native payment set observation')
  const captured = store.get(key)
  if (!captured) throw new Error('Received account has not been discovered')
  nativePaymentDerivation(captured, payment, key)
  if (!nativePaymentRegistered(captured, payment, raws, digest))
    throw new Error('Native payment set must be registered before observation')
  const nativeBasis = (coin: EvmCoin) =>
    JSON.stringify([
      coin.state,
      coin.amountWei,
      coin.receivedAmountWei,
      coin.checkedAtMs,
      coin.transferSeen,
      coin.settledTransactions,
      coin.failedTransactions,
    ])
  const basis = nativeBasis(captured)
  const observation = await read(
    key,
    raws.map(raw => '0x' + raw),
  )
  const balanceWei = observation.balanceWei
  if (
    observation.balanceWei < 0n ||
    observation.balanceWei >= 1n << 256n ||
    observation.receivedAmountsWei.length !== raws.length
  )
    throw new Error('Invalid native payment set evidence')
  let received = 0n,
    known = 0,
    failures = 0
  const settledTransactions: string[] = []
  const failedTransactions: string[] = []
  for (let i = 0; i < raws.length; i++) {
    const value = observation.receivedAmountsWei[i]
    if (value === undefined) continue
    const tx = Transaction.from('0x' + raws[i]!)
    if (value !== 0n && value !== tx.value)
      throw new Error(
        'Native payment member evidence differs from signed value',
      )
    known++
    const txHash = tx.hash!.replace(/^0x/, '').toLowerCase()
    if (value === 0n) {
      failures++
      failedTransactions.push(txHash)
    } else {
      settledTransactions.push(txHash)
    }
    received += value
  }
  const complete = known === raws.length,
    allFailed = failures === raws.length
  let applied = false
  const coin = await changeStoredCoin(store, key, current => {
    applied = false
    nativePaymentDerivation(current, payment, key)
    if (!nativePaymentRegistered(current, payment, raws, digest))
      throw new Error('Native payment set changed during observation')
    if (
      nativeBasis(current) !== basis ||
      (current.checkedAtMs !== undefined && current.checkedAtMs > atMs)
    )
      return current
    applied = true
    return {
      ...observeEvmCoin(current, {
        balanceWei,
        transfer: received > 0n ? 'included' : allFailed ? 'failed' : 'unseen',
        transferValueWei: received,
        atMs,
      }),
      receivedAmountWei: received.toString(),
      settledTransactions,
      failedTransactions,
    }
  })
  return {
    applied,
    coin,
    verifiedReceivedAmountWei: received,
    complete,
    allFailed,
  }
}

/** Native observations merge against current durable state and preserve every token position.
 * All observations at this owner boundary must use CAS, not put an earlier full-row snapshot. */
export function applyStoredNativeCoinObservation(
  store: RecordStore<EvmCoin>,
  address: string,
  observation: EvmCoinObservation,
): Promise<EvmCoin> {
  observation = { ...observation }
  return changeStoredCoin(store, address, current =>
    current.checkedAtMs !== undefined && current.checkedAtMs > observation.atMs
      ? current
      : observeEvmCoin(current, observation),
  )
}

export function markStoredEvmCoinNoted(
  store: RecordStore<EvmCoin>,
  address: string,
  notedAtMs: number,
): Promise<EvmCoin> {
  if (!Number.isFinite(notedAtMs))
    throw new Error('Invalid received account note time')
  return changeStoredCoin(store, address, current =>
    current.notedAtMs === undefined ? { ...current, notedAtMs } : current,
  )
}

export function registerStoredEvmErc20Payment(
  store: RecordStore<EvmCoin>,
  address: string,
  payment: Erc20PaymentInput,
): Promise<EvmCoin> {
  payment = { ...payment }
  return changeStoredCoin(store, address, current =>
    registerEvmErc20Payment(current, payment),
  )
}

/** RPC never holds the write lock. A changed target position is observable, and must be retried
 * from its current claims; the stale result cannot erase new discovery or newer chain evidence.
 * Updates to native facts or another token are merged from current durable state. */
export async function refreshStoredEvmErc20Position(
  store: RecordStore<EvmCoin>,
  address: string,
  options: Erc20RefreshOptions,
): Promise<{ applied: boolean; coin: EvmCoin }> {
  options = { ...options }
  const key = getAddress(address).toLowerCase()
  const known = store.get(key)
  if (!known) throw new Error('Received account has not been discovered')
  const captured = copyCoin(known)
  const { contract } = configuredErc20(
    options.chainIdentifier,
    options.contractAddress,
  )
  const before = JSON.stringify(
    captured.erc20Positions?.find(
      position => position.contractAddress === contract,
    ),
  )
  const observed = await refreshEvmErc20Position(captured, options)
  const refreshed = observed.erc20Positions!.find(
    position => position.contractAddress === contract,
  )!
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = store.get(key)
    if (!current) throw new Error('Received account disappeared during refresh')
    const snapshot = copyCoin(current)
    if (
      JSON.stringify(
        snapshot.erc20Positions?.find(
          position => position.contractAddress === contract,
        ),
      ) !== before
    )
      return { applied: false, coin: snapshot }
    const next = {
      ...snapshot,
      erc20Positions: snapshot.erc20Positions!.map(position =>
        position.contractAddress === contract ? refreshed : position,
      ),
    }
    if (await store.compareAndPut(key, snapshot, next))
      return { applied: true, coin: next }
  }
  throw new Error('Received account changed during refresh; retry required')
}

/** What the chain says about the transfer a coin's message named.
 * - `none`: the message named no transfer; only the balance can speak.
 * - `included`: that exact transaction is in a block and succeeded.
 * - `seen`: the node knows it (or just accepted it) and it is not in a block yet.
 * - `unseen`: the node does not know it and it could not be handed to the node this time.
 * - `failed`: it can never land: it reverted, or its sender's nonce was used by another
 *   transaction. */
export type EvmCoinTransfer = 'none' | 'included' | 'seen' | 'unseen' | 'failed'

/** What one chain read says about a coin. */
export interface EvmCoinObservation {
  readonly balanceWei: bigint
  /** Asked only while the coin is not yet known to be funded. */
  readonly transfer?: EvmCoinTransfer
  /** With `included`: what that transaction pays this account, read from the transaction. */
  readonly transferValueWei?: bigint
  readonly atMs: number
}

/** The coin after a chain read.
 *
 * A coin is counted only when the chain shows BOTH the named transfer included successfully and
 * money at the address (a message that named no transfer has only the balance to go by). Once
 * counted, the amount follows the chain's balance, and an empty account was spent. A transfer
 * that can never land marks the coin failed: it stays recorded and is never counted.
 *
 * Nothing is ever "received" without an amount the chain showed arriving. A named transfer that
 * is included but found with an empty account (spent from another device) is taken as received
 * only at the value that transaction itself paid this account; an included transaction that paid
 * it nothing proves nothing, and the coin stays pending. */
export function observeEvmCoin(
  coin: EvmCoin,
  observation: EvmCoinObservation,
): EvmCoin {
  const funded = observation.balanceWei > 0n
  let state: EvmCoinState
  if (coin.state === 'unspent' || coin.state === 'spent')
    state = funded ? 'unspent' : 'spent'
  else {
    const transfer = observation.transfer ?? 'none'
    const paid = observation.transferValueWei ?? 0n
    if (transfer === 'failed') state = 'failed'
    else if (transfer === 'included' && funded) state = 'unspent'
    else if (transfer === 'included' && paid > 0n) state = 'spent'
    else if (transfer === 'none' && funded) state = 'unspent'
    else state = coin.state === 'failed' ? 'failed' : 'pending'
  }
  const { transferSeen: _dropped, ...rest } = coin
  return {
    ...rest,
    state,
    amountWei: observation.balanceWei.toString(),
    ...(coin.receivedAmountWei === undefined &&
    (state === 'unspent' || state === 'spent')
      ? {
          // What arrived: the verified transfer's own value when known, else what the chain
          // first showed at the account.
          receivedAmountWei: (observation.transferValueWei !== undefined &&
          observation.transferValueWei > 0n
            ? observation.transferValueWei
            : observation.balanceWei
          ).toString(),
        }
      : {}),
    checkedAtMs: observation.atMs,
    ...(state === 'pending'
      ? { transferSeen: observation.transfer === 'seen' }
      : {}),
  }
}

/** How long after its message a payment the node still does not know is called not received.
 * The coin stays pending in the store and keeps being re-checked (and its carried transaction
 * re-broadcast), so a late arrival still becomes received. */
export const PAYMENT_NOT_RECEIVED_AFTER_MS = 10 * 60_000

/** The longest a not-received coin waits between two looks at the chain. */
export const PENDING_COIN_MAX_BACKOFF_MS = 6 * 60 * 60_000

/** Whether a background read should ask the chain about a pending coin now. A coin still within
 * `PAYMENT_NOT_RECEIVED_AFTER_MS` of its message, or whose transfer the node knows, is always due.
 * One the node still does not know after that is asked about less and less often: the wait since
 * its last look grows with its age (an eighth of it, at most `PENDING_COIN_MAX_BACKOFF_MS`), so
 * any number of claims that never arrive cannot keep the wallet asking at a steady rate. A late
 * arrival is still found; a read that names the coin always asks. */
export function pendingCoinDue(coin: EvmCoin, nowMs: number): boolean {
  if (coin.checkedAtMs === undefined || coin.transferSeen === true) return true
  const age = nowMs - coin.discoveredAtMs
  if (age < PAYMENT_NOT_RECEIVED_AFTER_MS) return true
  return (
    nowMs - coin.checkedAtMs >= Math.min(age / 8, PENDING_COIN_MAX_BACKOFF_MS)
  )
}

/** What a host shows for a received payment.
 * - `pending`: not on the chain yet, and either the node knows the transfer or it is early.
 * - `received`: the chain showed the transfer included and the money at the account.
 * - `not-received`: the sender's message claimed it, the node does not know the transfer, and
 *   `PAYMENT_NOT_RECEIVED_AFTER_MS` has passed since the message. Still re-checked.
 * - `failed`: the transfer can never land (reverted, or its nonce went to another transaction). */
export type ReceivedPaymentStatus =
  | 'pending'
  | 'received'
  | 'not-received'
  | 'failed'

/** What a host may say about a received payment. `spendable` only while the chain shows funds. */
export interface ReceivedPayment {
  readonly address: string
  readonly origin: EvmCoinOrigin
  readonly status: ReceivedPaymentStatus
  /** What the chain holds at the address now. */
  readonly amountWei: bigint
  /** What the chain showed when the money arrived. Absent while nothing has been seen. */
  readonly receivedAmountWei?: bigint
  /** What the sender's message said. Never a balance. */
  readonly claimedAmountWei: bigint
  /** True when some verified value arrived on-chain, but less than the intended claimed amount or with remaining unsettled member transactions. */
  readonly partial?: boolean
  /** Recorded transaction membership (signed raw transactions or hashes, bare lower-case hex). */
  readonly transactions?: readonly string[]
  /** Member transaction hashes confirmed included with positive value on-chain. */
  readonly settledTransactions?: readonly string[]
  /** Member transaction hashes confirmed failed/reverted on-chain. */
  readonly failedTransactions?: readonly string[]
  readonly spendable: boolean
  readonly payloadDigest?: string
  /** A stealth payment: the ephemeral key of the item it came from, bare lower-case hex. */
  readonly ephemeralPubKey?: string
  readonly childIndex?: number
}

export function receivedPaymentOf(
  coin: EvmCoin,
  nowMs: number = Date.now(),
): ReceivedPayment {
  const receivedVal =
    coin.receivedAmountWei !== undefined ? BigInt(coin.receivedAmountWei) : 0n
  const claimedVal = BigInt(coin.claimedAmountWei)
  const hasMemberTracking =
    coin.transactions.length > 1 &&
    (coin.settledTransactions !== undefined ||
      coin.failedTransactions !== undefined)
  const settledCount = coin.settledTransactions?.length ?? 0
  const failedCount = coin.failedTransactions?.length ?? 0

  let status: ReceivedPaymentStatus
  if (hasMemberTracking) {
    if (settledCount === coin.transactions.length && receivedVal > 0n) {
      status = 'received'
    } else if (failedCount > 0) {
      status = 'failed'
    } else if (
      coin.checkedAtMs === undefined ||
      coin.transferSeen === true ||
      nowMs - coin.discoveredAtMs < PAYMENT_NOT_RECEIVED_AFTER_MS
    ) {
      status = 'pending'
    } else {
      status = 'not-received'
    }
  } else {
    status =
      coin.state === 'failed'
        ? 'failed'
        : // Received means an amount the chain showed arriving, and nothing less.
        coin.state !== 'pending' &&
          coin.receivedAmountWei !== undefined &&
          receivedVal > 0n
        ? 'received'
        : coin.checkedAtMs === undefined ||
          coin.transferSeen === true ||
          nowMs - coin.discoveredAtMs < PAYMENT_NOT_RECEIVED_AFTER_MS
        ? 'pending'
        : 'not-received'
  }

  const isPartial =
    receivedVal > 0n && (status !== 'received' || receivedVal < claimedVal)

  return {
    address: coin.address,
    origin: coin.origin,
    status,
    amountWei: BigInt(coin.amountWei),
    ...(coin.receivedAmountWei === undefined
      ? {}
      : { receivedAmountWei: receivedVal }),
    claimedAmountWei: claimedVal,
    ...(isPartial ? { partial: true } : {}),
    ...(coin.transactions.length > 0
      ? { transactions: coin.transactions }
      : {}),
    ...(coin.settledTransactions !== undefined
      ? { settledTransactions: coin.settledTransactions }
      : {}),
    ...(coin.failedTransactions !== undefined
      ? { failedTransactions: coin.failedTransactions }
      : {}),
    spendable: coin.state === 'unspent',
    ...(coin.payloadDigest === undefined
      ? {}
      : { payloadDigest: coin.payloadDigest }),
    ...(coin.ephemeralPubKey === undefined
      ? {}
      : { ephemeralPubKey: coin.ephemeralPubKey }),
    ...(coin.childIndex === undefined ? {} : { childIndex: coin.childIndex }),
  }
}

/** THE selection rule: the coins a wallet may spend from, count, or move. Only a coin the chain
 * has verified (its transfer included, money at its account) is ever one of them. A pending, failed
 * or spent coin is never returned, so a sender's claim can never become an input of a transaction
 * this wallet builds: not a native send, not a stamp's funding, not a sweep. */
export function spendableCoins(coins: readonly EvmCoin[]): EvmCoin[] {
  return coins.filter(
    coin => coin.state === 'unspent' && BigInt(coin.amountWei) > 0n,
  )
}

/** Everything the chain shows in coins right now. A pending coin is never counted. */
export function spendableCoinTotal(coins: readonly EvmCoin[]): bigint {
  return spendableCoins(coins).reduce(
    (sum, coin) => sum + BigInt(coin.amountWei),
    0n,
  )
}

function summarizePaymentSubset(subset: readonly ReceivedPayment[]): {
  status: 'none' | 'pending' | 'received' | 'not-received' | 'failed'
  receivedWei: bigint
  statedWei: bigint
  partial: boolean
} {
  const status =
    subset.length === 0
      ? 'none'
      : subset.some(p => p.status === 'failed')
      ? 'failed'
      : subset.some(p => p.status === 'not-received')
      ? 'not-received'
      : subset.some(p => p.status !== 'received')
      ? 'pending'
      : 'received'
  const receivedWei = subset.reduce(
    (sum, p) =>
      p.status === 'received' || p.partial === true
        ? sum + (p.receivedAmountWei ?? 0n)
        : sum,
    0n,
  )
  const statedWei = subset.reduce((sum, p) => sum + p.claimedAmountWei, 0n)
  const partial =
    (receivedWei > 0n && (status !== 'received' || receivedWei < statedWei)) ||
    subset.some(p => p.partial === true)
  return { status, receivedWei, statedWei, partial }
}

/** Whether the payments a message carried have landed, from the wallet's coins for it.
 * - `none`: the wallet holds no coin for the message (it carried no payment to this wallet).
 * - `pending`: at least one payment is not on the chain yet, and none has failed or is overdue.
 * - `not-received`: at least one payment the message claimed is still unknown to the node long
 *   after the message (`PAYMENT_NOT_RECEIVED_AFTER_MS`). It is still re-checked.
 * - `failed`: at least one payment can never land.
 * - `received`: the chain shows every payment included, with its money at its account.
 * `receivedWei` is what the chain showed arriving, across the received ones; `statedWei` is what
 * the message said, and is never a balance. */
export interface MessagePayment {
  readonly status: 'none' | 'pending' | 'received' | 'not-received' | 'failed'
  readonly receivedWei: bigint
  readonly statedWei: bigint
  readonly partial: boolean
  readonly stampStatus:
    | 'none'
    | 'pending'
    | 'received'
    | 'not-received'
    | 'failed'
  readonly stampReceivedWei: bigint
  readonly stampStatedWei: bigint
  readonly contentStatus:
    | 'none'
    | 'pending'
    | 'received'
    | 'not-received'
    | 'failed'
  readonly contentReceivedWei: bigint
  readonly contentStatedWei: bigint
  readonly payments: readonly ReceivedPayment[]
}

export function messagePaymentOf(
  coins: readonly EvmCoin[],
  payloadDigest: string,
  nowMs: number = Date.now(),
): MessagePayment {
  const digest = payloadDigest.replace(/^0x/, '').toLowerCase()
  const payments = coins
    .filter(coin => coin.payloadDigest === digest)
    .map(coin => receivedPaymentOf(coin, nowMs))
  const overall = summarizePaymentSubset(payments)
  const stamps = summarizePaymentSubset(
    payments.filter(p => p.origin === 'stamp'),
  )
  const content = summarizePaymentSubset(
    payments.filter(p => p.origin === 'stealth'),
  )
  return {
    status: overall.status,
    receivedWei: overall.receivedWei,
    statedWei: overall.statedWei,
    partial: overall.partial,
    stampStatus: stamps.status,
    stampReceivedWei: stamps.receivedWei,
    stampStatedWei: stamps.statedWei,
    contentStatus: content.status,
    contentReceivedWei: content.receivedWei,
    contentStatedWei: content.statedWei,
    payments,
  }
}
