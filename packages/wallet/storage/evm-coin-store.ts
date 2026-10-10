/**
 * The wallet's durable list of received coins on one EVM chain, and the one-time payments it has
 * prepared for contacts.
 *
 * A coin is money that arrived at a one-time account this wallet can spend from but cannot find
 * again from its seed alone: the account's key is derived from a message (a stealth payment's
 * ephemeral key, a stamp's shared point). The coin is therefore recorded WITH its private key, in
 * this one store, when the message is read, and it stays here whatever happens to the message.
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
   * arrived, which later spending does not change. Absent until then. */
  readonly receivedAmountWei?: string
  /** When the chain was last read for this coin. Absent: never read. */
  readonly checkedAtMs?: number
  /** A pending coin only: whether the node knew the transfer that funds it at the last read. */
  readonly transferSeen?: boolean
  /** What the sender's message said the amount was (decimal wei). Display only. */
  readonly claimedAmountWei: string
  /** The transfers the message carried for this coin: a signed raw transaction or a hash, hex. */
  readonly transactions: readonly string[]
  /** The message the coin came from (its payload digest, bare lower-case hex), when known. */
  readonly payloadDigest?: string
  /** A stealth coin: the sender's ephemeral public key, bare lower-case hex. */
  readonly ephemeralPubKey?: string
  /** A stamp coin: which of the message's payments this is. */
  readonly childIndex?: number
  readonly discoveredAtMs: number
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
  readonly state: 'planned' | 'prepared' | 'delivered' | 'paid' | 'failed'
  /** Who sends the message that carries the item: the wallet itself, or the host through its
   * own send path (a chat). Either way the transfer is broadcast only once the relay has it. */
  readonly deliveredBy?: 'wallet' | 'host'
  /** From `prepared` on: the native operation that holds the signed transfer. */
  readonly operationId?: string
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
  put(key: string, row: T): Promise<void>
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
  async put(key: string, row: T): Promise<void> {
    this.rows.set(key, { ...row })
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
  private constructor(private readonly db: LevelDB) {}
  static async open<T>(
    location: string,
    namespace: string,
  ): Promise<LevelRecordStore<T>> {
    const database = level(join(location, namespace))
    try {
      await openDurableLevel(database, location, namespace)
      const store = new LevelRecordStore<T>(database)
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
  async put(key: string, row: T): Promise<void> {
    await durablePut(this.db, key, JSON.stringify(row))
    this.rows.set(key, { ...row })
  }
  async delete(key: string): Promise<void> {
    await durableDelete(this.db, key)
    this.rows.delete(key)
  }
  async close(): Promise<void> {
    await (this.db as any).close()
  }
}

export const EVM_COIN_NAMESPACE = 'received-coins'
export const CONTACT_PAYMENT_NAMESPACE = 'contact-payments'

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
  const status: ReceivedPaymentStatus =
    coin.state === 'failed'
      ? 'failed'
      : // Received means an amount the chain showed arriving, and nothing less.
      coin.state !== 'pending' &&
        coin.receivedAmountWei !== undefined &&
        BigInt(coin.receivedAmountWei) > 0n
      ? 'received'
      : coin.checkedAtMs === undefined ||
        coin.transferSeen === true ||
        nowMs - coin.discoveredAtMs < PAYMENT_NOT_RECEIVED_AFTER_MS
      ? 'pending'
      : 'not-received'
  return {
    address: coin.address,
    origin: coin.origin,
    status,
    amountWei: BigInt(coin.amountWei),
    ...(coin.receivedAmountWei === undefined
      ? {}
      : { receivedAmountWei: BigInt(coin.receivedAmountWei) }),
    claimedAmountWei: BigInt(coin.claimedAmountWei),
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
  const status =
    payments.length === 0
      ? 'none'
      : payments.some(p => p.status === 'failed')
      ? 'failed'
      : payments.some(p => p.status === 'not-received')
      ? 'not-received'
      : payments.some(p => p.status !== 'received')
      ? 'pending'
      : 'received'
  return {
    status,
    receivedWei: payments.reduce(
      (sum, p) =>
        p.status === 'received' ? sum + (p.receivedAmountWei ?? 0n) : sum,
      0n,
    ),
    statedWei: payments.reduce((sum, p) => sum + p.claimedAmountWei, 0n),
    payments,
  }
}
