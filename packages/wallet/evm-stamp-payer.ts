/**
 * Pays the stamp of one message from the wallet's coin list (`EvmCoinList`): its funded
 * sub-accounts, its main and identity accounts, and the coins it received.
 *
 * The shape is the old Stamp wallet's: filter what is unspent, select, and mark the chosen coins
 * in the same synchronous step, so a second payment being built at the same moment cannot see
 * them; then sign with the key the coin carries. No request is made to choose: what each coin
 * holds and its nonce are in the list, kept there off the send path (`EvmCoinListSync`, and
 * settlement below). Only when the list does not cover a payment are the accounts that need it
 * read again, once.
 *
 * A taken coin leaves its holder in exactly two ways:
 * - nothing signed ever left the wallet (`release`, `releasePayment` of an unsigned coin): it is
 *   free again at once;
 * - the chain shows what happened to its transaction (`recordSpent`, `recordFailed`): never a
 *   timeout, a relay answer or a restart.
 *
 * While the coin list and the pool's own claims both exist (other spenders of these accounts
 * still take the pool's claims), a coin taken here also takes the pool's claim on its account,
 * so those spenders keep seeing it as taken.
 */
import { getAddress, Transaction, type Provider } from 'ethers'
import { selectStampAccounts } from './evm-stamp-account-selection'
import { EVM_FAILURE_CONFIRMATIONS } from './chain/evm-settlement'
import {
  InsufficientStampFundsError,
  type EvmSubAccountPool as MonadSubAccountPool,
} from './evm-account-pool'
import { MonadAccountTxSigner, type MonadTxSubmitter } from './evm-account-tx'
import {
  ChainUnreachableError,
  ChainWaitCancelledError,
  EvmBlockWatcher,
} from './evm-block-watcher'
import {
  EvmCoinListError,
  type EvmCoinList,
  type EvmCoinListOrigin,
  type EvmListCoin,
} from './evm-coin-list'
import type { EvmCoinListSync } from './evm-coin-list-sync'

export { ChainUnreachableError, ChainWaitCancelledError }

export { InsufficientStampFundsError }

/** Where a paying coin comes from: a funded sub-account of the pool, the wallet's main account,
 * its identity account, or a received coin. A caller may filter by it. */
export type StampCoinSource = 'pool' | 'main' | 'identity' | 'coin'

export function stampSourceOf(origin: EvmCoinListOrigin): StampCoinSource {
  switch (origin) {
    case 'deterministic':
      return 'pool'
    case 'root':
      return 'main'
    case 'identity':
      return 'identity'
    default:
      return 'coin'
  }
}

/** One signed payment of a stamp: the account it spends and the exact bytes. */
export interface StampPayment {
  readonly source: StampCoinSource
  /** The pool index, for a `pool` coin. */
  readonly index?: number
  readonly address: string
  readonly rawTx: string
}

export interface StampFee {
  /** What the chain charges per gas right now (`eth_gasPrice`: base fee plus tip). */
  readonly chargedPerGas: bigint
  readonly maxFeePerGas?: bigint
  readonly maxPriorityFeePerGas?: bigint
  readonly gasPrice?: bigint
}

/** What the chain says about one signed payment. */
export type StampPaymentObservation =
  /** In a block. A reverted transaction consumed its nonce all the same. */
  | {
      readonly state: 'included'
      readonly reverted: boolean
      readonly block?: number
    }
  /** The account's nonce was consumed by a different transaction: this one can never land. */
  | { readonly state: 'replaced' }
  /** Not settled: in the mempool, included but awaiting failure depth, or unknown to the node. */
  | {
      readonly state: 'pending'
      readonly where?: 'mempool' | 'included' | 'unknown-to-node'
    }

/** One coin claimed for a payment: the account, the nonce it is at, and what it pays. */
export interface ClaimedStampCoin {
  readonly source: StampCoinSource
  readonly index?: number
  readonly address: string
  readonly nonce: number
  readonly paymentValueWei: bigint
}

/** The coins one message's stamp is paid from, claimed and not yet signed for. */
export interface StampClaim {
  readonly holder: string
  readonly accounts: readonly ClaimedStampCoin[]
  readonly fee: StampFee
}

/** Read-only snapshot. An available quote is not a reservation; sending rechecks everything. */
export type StampAffordabilityQuote = {
  readonly stampValueWei: bigint
  /** Capacity after per-account maximum fees, across the largest supported spending route.
   * Fragment size rules can still make a particular amount unavailable. */
  readonly capacityWei: bigint
} & (
  | { readonly status: 'available'; readonly maximumFeeWei: bigint }
  | { readonly status: 'insufficient' }
)

const STAMP_GAS_LIMIT = 21_000n
const FEE_TTL_MS = 6_000
/** How many times a payment that only accounts waiting to be read again could cover reads
 * them, one look of the chain apart, before it is refused as not covered. */
const MAX_UNREAD_LOOKS = 30
/** At most this many coins pay one stamp. */
const MAX_PARTS = 64
/**
 * Resolves once `address` has sent no transaction in the last `blocks` blocks (or stays at or
 * above `options.reserveBalanceWei`) AND has none the node still holds unmined, so a value
 * transfer signed now is not one the chain's spacing rule reverts (Monad's reserve balance: see
 * `EvmChainConfig.spendSpacingBlocks`). A transaction in the mempool counts: it will be mined
 * inside the window (a funding transfer whose receipt wait ran out, a transfer some other code
 * signed with the same key), and signing behind it would also stack a nonce. The caller holds
 * the account's claim, so nothing of this wallet signs from it meanwhile, and reads the nonce
 * AFTER this returns. Three reads a look, a look every 400 ms; rejects, having signed nothing,
 * when the chain cannot be read for 20 s. `blocks` 0 or absent: no wait and no request.
 */
export async function waitForSpendSpacing(
  provider: Provider,
  address: string,
  blocks: number | undefined,
  options?: {
    reserveBalanceWei?: bigint
    spendValueWei?: bigint
  },
): Promise<void> {
  if (!blocks || blocks <= 0) return
  let failingSince: number | undefined
  for (;;) {
    try {
      const head = await provider.getBlockNumber()
      const [now, before, pending] = await Promise.all([
        provider
          .getTransactionCount(address, head)
          .catch(() => provider.getTransactionCount(address, 'latest')),
        head < blocks
          ? Promise.resolve(undefined)
          : provider
              .getTransactionCount(address, head - blocks)
              .catch(() => undefined),
        provider.getTransactionCount(address, 'pending'),
      ])
      if (pending <= now) {
        if (before === undefined || now === before) return
        if (
          options?.reserveBalanceWei !== undefined &&
          typeof provider.getBalance === 'function'
        ) {
          const balance = await provider.getBalance(address)
          const spend = options.spendValueWei ?? 0n
          if (balance >= spend && balance - spend >= options.reserveBalanceWei)
            return
        }
      }
      failingSince = undefined
    } catch (error) {
      failingSince ??= Date.now()
      if (Date.now() - failingSince > 20_000) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}


export interface EvmStampPayerConfig {
  pool: MonadSubAccountPool
  /** The wallet's coins. Every payment is selected from here. */
  coins: EvmCoinList
  /** What keeps `coins` in step with the chain. */
  sync: EvmCoinListSync
  provider: Provider
  httpClient: MonadTxSubmitter
  /** See `EvmChainConfig.spendSpacingBlocks`. */
  spendSpacingBlocks?: number
  /** See `EvmChainConfig.reserveBalanceWei`: a payment that leaves its account at or above
   * this is not held to the spacing. */
  reserveBalanceWei?: bigint
  /** The wallet's one block watcher for this chain. Absent (a test of the payer alone): one is
   * made over `provider`. */
  watcher?: EvmBlockWatcher
  /** Called when a payment takes funded sub-accounts (there are now fewer ready). */
  onPoolCoinsClaimed?: () => void
  /**
   * True while `address` is held outside the coin list by something whose signed transfer is
   * not to be broadcast yet (a payment to a contact waiting for its message). No stamp is paid
   * from it, and a payment that could only have been paid from it is refused AT ONCE with
   * `heldRefusal` rather than waiting: the holder may be waiting for this very message.
   */
  accountHeld?: (address: string) => boolean
  /** Authoritative shared wallet reservation of this account/nonce state (the native journal). */
  canSelectAccount?: (address: string, nonce: number) => boolean
  heldRefusal?: () => Error
}

export class EvmStampPayer {
  readonly watcher: EvmBlockWatcher
  private fee: { value: StampFee; atMs: number } | undefined
  private feeRead: Promise<StampFee> | undefined
  private poolIndexByAddress = new Map<string, number>()
  /** Repeated insufficient quotes must not sweep the wallet on every composer change.
   * Payment construction retains its own unthrottled final inventory read. */
  private lastFullQuoteReadAt = -Infinity

  constructor(private readonly config: EvmStampPayerConfig) {
    this.watcher =
      config.watcher ?? new EvmBlockWatcher({ provider: config.provider })
  }

  /** A read of the chain on behalf of a payment: its failure marks the chain unreachable and
   * is reported as such; nothing was signed. */
  private async read<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new ChainWaitCancelledError()
    let cancel: (() => void) | undefined
    try {
      const stopped = new Promise<never>((_, reject) => {
        cancel = () => reject(new ChainWaitCancelledError())
        signal?.addEventListener('abort', cancel, { once: true })
      })
      let lastError: unknown
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const value = await Promise.race([task(), stopped])
          if (signal?.aborted) throw new ChainWaitCancelledError()
          this.watcher.noteSuccess()
          return value
        } catch (error) {
          if (error instanceof ChainWaitCancelledError) throw error
          lastError = error
          const msg = String((error as { message?: unknown })?.message ?? error)
          const isTransientRpcLimit =
            /upstream RPC error|-32007|-32005|-32016|429|50[234]|bad gateway|relay RPC transport failed|invalid_rpc_upstream_response|rpc_upstream_unavailable/i.test(
              msg,
            )
          if (!isTransientRpcLimit || attempt >= 4 || signal?.aborted) {
            throw error
          }
          await Promise.race([
            new Promise<void>(resolve => setTimeout(resolve, attempt * 250)),
            stopped,
          ])
        }
      }
      throw lastError
    } catch (error) {
      if (error instanceof ChainWaitCancelledError) throw error
      this.watcher.noteFailure(error)
      throw new ChainUnreachableError(error)
    } finally {
      if (cancel) signal?.removeEventListener('abort', cancel)
    }
  }

  /** The transaction spending `(address, nonce)` was seen mined at `block`: its successor coin

  /** The pool index of a sub-account's address. */
  private indexOf(address: string): number | undefined {
    const key = address.toLowerCase()
    let index = this.poolIndexByAddress.get(key)
    if (index === undefined) {
      this.poolIndexByAddress = new Map(
        this.config.pool
          .records()
          .map(record => [record.address.toLowerCase(), record.index]),
      )
      index = this.poolIndexByAddress.get(key)
    }
    return index
  }

  /**
   * Whether a payment may take `coin` now, as far as anything outside the coin list says: the
   * caller's source filter, a contact payment's hold, the native journal's reservation of the
   * account at that nonce, and the pool's claims and row state. `held` is told when only a
   * contact payment's hold stood in the way; `claimedBy` when only another operation's pool
   * claim did.
   */
  private eligible(
    coin: EvmListCoin,
    allowed: (source: StampCoinSource) => boolean,
    seen?: { held?: boolean; claimedBy?: Set<string> },
  ): boolean {
    const { pool, sync } = this.config
    if (coin.origin === 'legacy-subaccount') return false
    const source = stampSourceOf(coin.origin)
    if (!allowed(source) || sync.isDirty(coin.account)) return false
    if (this.config.accountHeld?.(coin.account)) {
      if (seen) seen.held = true
      return false
    }
    if (this.config.canSelectAccount?.(coin.account, coin.nonce) === false) {
      // Another spender's record holds this nonce: whatever it did to the account is read
      // again before the account is offered.
      sync.markDirty(coin.account)
      return false
    }
    if (source === 'pool') {
      const index = this.indexOf(coin.account)
      if (index === undefined) return false
      const row = pool.getRecord(index)
      // Legacy status records prior use, not current spendability. The shared list's
      // chain-observed nonce/balance and the actual claims below are authoritative.
      if (row === undefined) return false
      const claimant = pool.claimedBy(index)
      if (claimant !== undefined) {
        seen?.claimedBy?.add(claimant)
        return false
      }
      return !pool.isSpendReserved(index)
    }
    const claimant = pool.accountClaimedBy(coin.account)
    if (claimant !== undefined) {
      seen?.claimedBy?.add(claimant)
      return false
    }
    return true
  }

  /** Whether `coin` may be offered to the chain at `head`, paying `amountWei` out of it. */
  private spendableNow(
    coin: EvmListCoin,
    head: number | undefined,
    amountWei: bigint,
    feeReserveWei: bigint,
  ): boolean {
    if (coin.spendableFromBlock === undefined) return true
    if (head !== undefined && head >= coin.spendableFromBlock) return true
    // The chain's rule only bites a transfer that takes the account below its reserve.
    const floor = this.config.reserveBalanceWei
    return (
      floor !== undefined &&
      coin.origin !== 'deterministic' &&
      coin.valueWei - amountWei - feeReserveWei >= floor
    )
  }

  /**
   * Signs the SAME payment again: the same account at the same nonce, the same destination and
   * value. Only the fee fields differ (the current fee, never more than the account can pay),
   * so the bytes and the hash differ. For a payment the node refuses to take: a node that has
   * refused a transaction goes on refusing those bytes. At most one transaction of an account
   * at a nonce is ever mined, so the two can never both pay. The coin carries the new
   * transaction, durably, before this returns; nothing is broadcast here.
   */
  async resign(payment: StampPayment, chainId: bigint): Promise<StampPayment> {
    const old = Transaction.from(payment.rawTx)
    const coin = this.config.coins.get(payment.address, old.nonce)
    if (coin === undefined || coin.state !== 'pending_receipt')
      throw new Error('The payment has no coin out to sign again')
    const [fee, balance] = await this.read(() =>
      Promise.all([
        this.currentFee(),
        this.config.provider.getBalance(payment.address),
      ]),
    )
    const affordable =
      balance > old.value ? (balance - old.value) / STAMP_GAS_LIMIT : 0n
    let cap = (fee.maxFeePerGas ?? fee.gasPrice)!
    if (affordable < cap) cap = affordable
    if (cap === (old.maxFeePerGas ?? old.gasPrice)) cap -= 1n
    if (cap < fee.chargedPerGas)
      throw new Error(
        `${payment.address} cannot pay the fee of its payment again (it holds ${balance} wei)`,
      )
    const tip = fee.maxPriorityFeePerGas ?? cap
    const rawTx = await this.signTransfer({
      privateKey: coin.privateKey,
      address: coin.account,
      chainId,
      nonce: old.nonce,
      to: old.to!,
      valueWei: old.value,
      fee:
        fee.maxFeePerGas !== undefined
          ? {
              chargedPerGas: fee.chargedPerGas,
              maxFeePerGas: cap,
              maxPriorityFeePerGas: tip < cap ? tip : cap,
            }
          : { chargedPerGas: fee.chargedPerGas, gasPrice: cap },
    })
    if (Transaction.from(rawTx).hash === old.hash)
      throw new Error('The payment could not be signed again')
    await this.config.coins.recordResigned(coin, rawTx)
    return { ...payment, rawTx }
  }

  private currentFee(): Promise<StampFee> {
    if (this.fee && Date.now() - this.fee.atMs < FEE_TTL_MS)
      return Promise.resolve(this.fee.value)
    // One read serves every payment that asks while it is in flight.
    this.feeRead ??= this.config.provider
      .getFeeData()
      .then(data => {
        let value: StampFee
        const chargedPerGas =
          data.gasPrice ?? data.maxFeePerGas ?? undefined
        if (chargedPerGas === undefined)
          throw new Error('The chain returned no fee to pay a stamp with')
        if (data.maxFeePerGas != null)
          value = {
            chargedPerGas,
            maxFeePerGas: data.maxFeePerGas,
            maxPriorityFeePerGas:
              data.maxPriorityFeePerGas ?? data.maxFeePerGas,
          }
        else value = { chargedPerGas, gasPrice: chargedPerGas }
        this.fee = { value, atMs: Date.now() }
        return value
      })
      .finally(() => {
        this.feeRead = undefined
      })
    return this.feeRead
  }

  /**
   * The smallest value worth paying in one stamp payment: what the chain charges to move it.
   * One plain transfer as this wallet builds it, 21,000 gas, at the node's current gas price
   * (a chain that charges the gas limit, as Monad does, charges exactly this). Read from the
   * node with a short cache; never a constant.
   */
  async minimumPaymentWei(): Promise<bigint> {
    return STAMP_GAS_LIMIT * (await this.read(() => this.currentFee())).chargedPerGas
  }

  /** Snapshot of what the wallet's coins can pay, without taking anything, signing or waiting.
   * Coins held by an operation, or not spendable yet, are not counted. Exclusions let a host
   * account for an unsigned financial plan before it reserves its source. */
  async quote(input: {
    stampValueWei: bigint
    excludedAddresses?: readonly string[]
    /** A composed consumer's transaction-count admission limit. */
    maxPayments?: number
  }, readAll = false): Promise<StampAffordabilityQuote> {
    if (
      typeof input.stampValueWei !== 'bigint' ||
      input.stampValueWei < 0n ||
      input.stampValueWei >= 1n << 256n
    )
      throw new Error('Stamp amount must be a nonnegative bigint')
    const maxPayments = input.maxPayments ?? Number.MAX_SAFE_INTEGER
    if (!Number.isInteger(maxPayments) || maxPayments < 1)
      throw new Error('Stamp payment count must be a positive integer')
    const excluded = new Set(
      (input.excludedAddresses ?? []).map(address =>
        getAddress(address).toLowerCase(),
      ),
    )
    if (input.stampValueWei === 0n)
      return {
        status: 'available',
        stampValueWei: 0n,
        maximumFeeWei: 0n,
        capacityWei: 0n,
      }
    const fee = await this.read(() => this.currentFee())
    if (!this.config.sync.settled())
      await this.read(() => this.config.sync.refresh())
    if (readAll && Date.now() - this.lastFullQuoteReadAt >= 5_000) {
      await this.read(() => this.config.sync.refresh({ all: true }))
      this.lastFullQuoteReadAt = Date.now()
    }
    const reserve = STAMP_GAS_LIMIT * (fee.maxFeePerGas ?? fee.gasPrice)!
    const smallest = STAMP_GAS_LIMIT * fee.chargedPerGas
    const head = this.watcher.latest()
    const usable = this.config.coins
      .all()
      .filter(
        coin =>
          coin.state === 'unspent' &&
          !excluded.has(coin.account) &&
          coin.valueWei > reserve &&
          this.eligible(coin, () => true) &&
          this.spendableNow(coin, head, 0n, reserve),
      )
      .map((coin, index) => ({
        index,
        address: coin.account,
        capacityWei: coin.valueWei - reserve,
      }))
    const limit = Math.min(MAX_PARTS, maxPayments)
    const capacityWei = [...usable]
      .sort((a, b) => (a.capacityWei > b.capacityWei ? -1 : 1))
      .slice(0, limit)
      .reduce((sum, account) => sum + account.capacityWei, 0n)
    const result = { stampValueWei: input.stampValueWei, capacityWei }
    let selected
    try {
      selected = selectStampAccounts({
        amountWei: input.stampValueWei,
        accounts: usable,
        maxTransactions: limit,
      })
    } catch {
      selected = undefined
    }
    if (
      selected === undefined ||
      selected.some(part => part.paymentValueWei < smallest)
    ) {
      const whole = usable.find(
        account => account.capacityWei >= input.stampValueWei,
      )
      if (whole === undefined && !readAll) return this.quote(input, true)
      return whole === undefined
        ? { ...result, status: 'insufficient' }
        : { ...result, status: 'available', maximumFeeWei: reserve }
    }
    return {
      ...result,
      status: 'available',
      maximumFeeWei: reserve * BigInt(selected.length),
    }
  }

  /**
   * Takes, for `holder`, coins of the list that pay `stampValueWei`, in one synchronous step.
   * Nothing is funded, read or signed to choose them: the cost of a stamp is the gas of its own
   * payments.
   *
   * When the list does not cover the stamp, the accounts it may be out of date about are read
   * once (`EvmCoinListSync.refresh`) and the choice is made again. When coins that would cover
   * it are held by another payment (or not spendable yet under the chain's spacing rule), this
   * one waits its turn: `whileBusy` is called with the holder so the caller can ask the chain
   * about that one payment, and the choice is made again when a coin is released or the chain
   * moves on.
   *
   * Rejects with {@link InsufficientStampFundsError} when nothing the wallet has covers the
   * value; then, and on any other rejection, nothing this call took stays taken.
   */
  async claim(input: {
    holder: string
    stampValueWei: bigint
    /** Limit the coins considered. Default: every source. */
    sources?: readonly StampCoinSource[]
    whileBusy?: (holder: string) => Promise<void>
    /** Whether a holder's payment cannot finish by itself (asked after `whileBusy`): the error
     * to end this claim with, or `undefined` while it can still finish. A blocked holder ends the
     * claim only when its coins are needed (everything else that could come back does not cover
     * the value) and it is still blocked at the next look. */
    blockedBy?: (holder: string) => Error | undefined
    /** Called once when this payment starts waiting for an earlier one, and again with the
     * blocks still to pass when what it waits for is the chain's spacing. */
    onWaiting?: (blocksRemaining?: number) => void
    /** Ends the wait: the claim rejects with {@link ChainWaitCancelledError}, nothing taken. */
    signal?: AbortSignal
    /** The value is owed, not chosen: a payment smaller than its own transfer's fee is made
     * all the same (a settlement, or the repeat of a reverted payment). */
    allowBelowFee?: boolean
  }): Promise<StampClaim> {
    const { pool, coins, sync } = this.config
    const allowed = (source: StampCoinSource) =>
      input.sources === undefined || input.sources.includes(source)
    if (input.signal?.aborted) throw new ChainWaitCancelledError()
    const fee = await this.read(() => this.currentFee(), input.signal)
    const feeReserveWei = STAMP_GAS_LIMIT * (fee.maxFeePerGas ?? fee.gasPrice)!
    const smallest = STAMP_GAS_LIMIT * fee.chargedPerGas
    // What the list may be out of date about is read before falling back: first the accounts
    // it does not know or was told changed (so a sub-account funded a moment ago is preferred
    // to the main account), then, when still not covered, every account it holds a free coin of
    // (money may have arrived that nothing announced).
    let readDue = false
    let readAll = false
    let waiting = false
    // Consecutive looks at which a blocked holder's coins were needed: one is not enough (the
    // holder may be between two steps of its own send), two end the claim.
    let blockedLooks = 0
    // Reads of accounts waiting to be read again, made because only they could cover the value.
    let unreadLooks = 0
    for (;;) {
      if (input.signal?.aborted) throw new ChainWaitCancelledError()
      const head = this.watcher.latest()
      const seen: { held?: boolean; claimedBy: Set<string> } = {
        claimedBy: new Set(),
      }
      const usable = (coin: EvmListCoin) =>
        this.eligible(coin, allowed, seen) &&
        this.spendableNow(coin, head, input.stampValueWei, feeReserveWei)
      const selectFrom = (
        filter: (coin: EvmListCoin) => boolean,
        maxCoins: number,
      ) =>
        coins.select({
          holder: input.holder,
          amountWei: input.stampValueWei,
          feeReserveWei,
          head: Number.MAX_SAFE_INTEGER,
          maxCoins,
          ...(input.allowBelowFee === true ? {} : { minPartWei: smallest }),
          filter,
        })
      // In order, each a synchronous select-and-take: the sub-accounts funded for messages
      // (the Stamp split over them); else one account that covers the stamp alone (a main or
      // identity account spends one nonce, not several); else several coins together.
      const isPool = (coin: EvmListCoin) => coin.origin === 'deterministic'
      let parts = selectFrom(coin => isPool(coin) && usable(coin), MAX_PARTS)
      if (parts === undefined && !readDue && !sync.settled()) {
        readDue = true
        await this.read(() => sync.refresh(), input.signal)
        continue
      }
      parts ??=
        selectFrom(coin => !isPool(coin) && usable(coin), 1) ??
        selectFrom(usable, MAX_PARTS)
      if (parts !== undefined) {
        // Synchronous with the selection: the pool's claims say the same to its other spenders.
        const accounts: ClaimedStampCoin[] = parts.map(({ coin, paymentValueWei }) => {
          const source = stampSourceOf(coin.origin)
          const index = source === 'pool' ? this.indexOf(coin.account) : undefined
          if (index !== undefined) pool.restoreClaim(input.holder, [index])
          else pool.restoreAccountClaim(input.holder, coin.account)
          return {
            source,
            ...(index === undefined ? {} : { index }),
            address: coin.account,
            nonce: coin.nonce,
            paymentValueWei,
          }
        })
        if (accounts.some(account => account.source === 'pool'))
          this.config.onPoolCoinsClaimed?.()
        return { holder: input.holder, fee, accounts }
      }
      // Not covered by what the list knows: read every account it holds a free coin of, once.
      if (!readAll) {
        readAll = readDue = true
        await this.read(() => sync.refresh({ all: true }), input.signal)
        continue
      }
      // Would coins another operation holds, or coins not spendable yet, cover it?
      const free = (coin: EvmListCoin) =>
        coin.state === 'unspent' && this.eligible(coin, allowed)
      const capacity = (coin: EvmListCoin) =>
        coin.valueWei > feeReserveWei ? coin.valueWei - feeReserveWei : 0n
      const sum = (list: readonly EvmListCoin[]) =>
        list.reduce((total, coin) => total + capacity(coin), 0n)
      const all = coins.all().filter(coin => coin.origin !== 'legacy-subaccount')
      const ready = all.filter(
        coin =>
          free(coin) &&
          this.spendableNow(coin, head, input.stampValueWei, feeReserveWei),
      )
      const notYet = all.filter(
        coin =>
          free(coin) &&
          !this.spendableNow(coin, head, input.stampValueWei, feeReserveWei),
      )
      // Worth waiting for: an account another operation is spending from will hold its next
      // coin once the chain shows that spend. A sub-account is spent once (its first nonce):
      // nothing comes back to wait for.
      const comesBack = (coin: EvmListCoin) =>
        coin.origin !== 'deterministic' && allowed(stampSourceOf(coin.origin))
      const heldByOthers = all.filter(
        coin =>
          (coin.state === 'spend_pending' || coin.state === 'pending_receipt') &&
          coin.holder !== input.holder &&
          comesBack(coin),
      )
      const claimedOutside = all.filter(
        coin =>
          coin.state === 'unspent' &&
          !free(coin) &&
          comesBack(coin) &&
          (stampSourceOf(coin.origin) === 'pool'
            ? pool.claimedBy(this.indexOf(coin.account) ?? -1) !== undefined
            : pool.accountClaimedBy(coin.account) !== undefined),
      )
      const could =
        sum(ready) + sum(notYet) + sum(heldByOthers) + sum(claimedOutside)
      if (could < input.stampValueWei) {
        // Coins of accounts the list must read again before offering them: another spender of
        // the account (a funding pass, a native send) has just let it go, and its last transfer
        // may still be on its way into a block. That is not "no funds": the accounts are read
        // again at each look of the chain until they are known, a bounded number of times.
        const unread = all.filter(
          coin =>
            coin.state === 'unspent' &&
            sync.isDirty(coin.account) &&
            allowed(stampSourceOf(coin.origin)) &&
            !this.config.accountHeld?.(coin.account) &&
            !claimedOutside.includes(coin),
        )
        if (
          unread.length > 0 &&
          could + sum(unread) >= input.stampValueWei &&
          unreadLooks < MAX_UNREAD_LOOKS
        ) {
          unreadLooks++
          await this.read(() => sync.refresh(), input.signal)
          if (unread.some(coin => sync.isDirty(coin.account)))
            await this.untilChanged(input.signal)
          continue
        }
        if (seen.held && this.config.heldRefusal) throw this.config.heldRefusal()
        throw new InsufficientStampFundsError(
          `No funds cover a stamp of ${input.stampValueWei} wei plus its fee of up to ${feeReserveWei} wei`,
        )
      }
      // This payment waits its turn.
      if (!waiting) {
        waiting = true
        input.onWaiting?.()
      }
      if (
        heldByOthers.length === 0 &&
        claimedOutside.length === 0 &&
        notYet.length > 0
      ) {
        // Only the chain's spacing stands in the way: the next block it allows.
        const from = Math.min(...notYet.map(coin => coin.spendableFromBlock!))
        input.onWaiting?.(Math.max(1, from - (head ?? from - 1)))
        await this.watcher.until(from, input.signal)
        continue
      }
      const holders = new Set<string>([
        ...heldByOthers.map(coin => coin.holder!),
        ...claimedOutside.flatMap(coin => {
          const holder =
            stampSourceOf(coin.origin) === 'pool'
              ? pool.claimedBy(this.indexOf(coin.account) ?? -1)
              : pool.accountClaimedBy(coin.account)
          return holder === undefined ? [] : [holder]
        }),
      ])
      for (const holder of holders) await input.whileBusy?.(holder)
      // A holder that cannot finish by itself is named, never waited for for ever: when, after
      // the others settled, what everyone else holds or will get back does not cover the value.
      const blocked = new Map<string, Error>()
      for (const holder of holders) {
        const error = input.blockedBy?.(holder)
        if (error) blocked.set(holder, error)
      }
      if (blocked.size === 0) blockedLooks = 0
      else {
        const after = coins.all()
        const claimant = (coin: EvmListCoin) =>
          stampSourceOf(coin.origin) === 'pool'
            ? pool.claimedBy(this.indexOf(coin.account) ?? -1)
            : pool.accountClaimedBy(coin.account)
        const comingBack = after.filter(coin => {
          if (!comesBack(coin)) return false
          if (coin.state === 'spend_pending' || coin.state === 'pending_receipt')
            return coin.holder !== input.holder && !blocked.has(coin.holder!)
          if (coin.state !== 'unspent' || free(coin)) return false
          const by = claimant(coin)
          return by !== undefined && !blocked.has(by)
        })
        const unblocked = after.filter(free).concat(comingBack)
        if (sum(unblocked) >= input.stampValueWei) blockedLooks = 0
        else if (++blockedLooks >= 2) throw blocked.values().next().value!
      }
      // Woken when the list changes, or at the watcher's next look: one look of the chain per
      // interval for every waiter of the wallet together, no timer of its own.
      await this.untilChanged(input.signal)
      readDue = false
    }
  }

  /** Resolves when the coin list next changes or the block watcher next looks. */
  private async untilChanged(signal?: AbortSignal): Promise<void> {
    const abort = new AbortController()
    const stop = () => abort.abort()
    signal?.addEventListener('abort', stop, { once: true })
    let unsubscribe: (() => void) | undefined
    try {
      const changed = new Promise<void>(resolve => {
        unsubscribe = this.config.coins.onChange(resolve)
      })
      const look = this.watcher.next(abort.signal)
      look.catch(() => undefined)
      await Promise.race([changed, look])
    } catch (error) {
      if (signal?.aborted) throw new ChainWaitCancelledError()
      if (!(error instanceof ChainWaitCancelledError)) throw error
    } finally {
      unsubscribe?.()
      signal?.removeEventListener('abort', stop)
      abort.abort()
    }
    if (signal?.aborted) throw new ChainWaitCancelledError()
  }

  private async signTransfer(input: {
    privateKey: string
    address: string
    chainId: bigint
    nonce: number
    to: string
    valueWei: bigint
    fee: StampFee
  }): Promise<string> {
    const signer = new MonadAccountTxSigner({
      privateKey: input.privateKey,
      provider: this.config.provider,
      httpClient: this.config.httpClient,
    })
    if (signer.address.toLowerCase() !== input.address.toLowerCase())
      throw new Error('Stamp account does not match its key')
    // A plain value transfer to the one-off child address: nothing on chain marks it as a
    // message payment.
    const unsigned = Transaction.from({
      type: input.fee.maxFeePerGas !== undefined ? 2 : 0,
      chainId: input.chainId,
      nonce: input.nonce,
      to: input.to,
      value: input.valueWei,
      gasLimit: STAMP_GAS_LIMIT,
      ...(input.fee.maxFeePerGas !== undefined
        ? {
            maxFeePerGas: input.fee.maxFeePerGas,
            maxPriorityFeePerGas: input.fee.maxPriorityFeePerGas,
          }
        : { gasPrice: input.fee.gasPrice }),
    })
    const signed = await signer.signFrozenUnsigned({
      from: input.address.toLowerCase(),
      unsignedSerialized: unsigned.unsignedSerialized,
    })
    return signed.rawTx
  }

  /** Signs one transfer from each claimed coin to `destination(i)`, with the key the coin
   * carries. No request is made. */
  async sign(
    claim: StampClaim,
    chainId: bigint,
    destination: (childIndex: number) => string,
  ): Promise<StampPayment[]> {
    const payments: StampPayment[] = []
    for (const [childIndex, account] of claim.accounts.entries()) {
      const coin = this.config.coins.get(account.address, account.nonce)
      if (
        coin === undefined ||
        coin.holder !== claim.holder ||
        coin.state !== 'spend_pending'
      )
        throw new Error('A stamp is signed only from a coin its payment took')
      const rawTx = await this.signTransfer({
        privateKey: coin.privateKey,
        address: coin.account,
        chainId,
        nonce: coin.nonce,
        to: destination(childIndex),
        valueWei: account.paymentValueWei,
        fee: claim.fee,
      })
      payments.push({
        source: account.source,
        ...(account.index === undefined ? {} : { index: account.index }),
        address: account.address,
        rawTx,
      })
    }
    return payments
  }

  /**
   * The signed payments go onto their coins, durably, BEFORE they are written anywhere they
   * could be sent from. From here only the chain frees those coins.
   */
  async recordSigned(
    holder: string,
    payments: readonly StampPayment[],
  ): Promise<void> {
    for (const payment of payments) {
      const tx = Transaction.from(payment.rawTx)
      await this.config.coins.recordSigned(
        holder,
        { account: payment.address, nonce: tx.nonce },
        payment.rawTx,
      )
    }
  }

  /** Frees the coins of `claim`, signed or not, and nothing else its holder holds. Only for a
   * payment none of whose signed bytes was written anywhere it could be sent from. */
  async release(claim: StampClaim): Promise<void> {
    const { pool, coins } = this.config
    // The pool's claims first: their release is seen while the coins still name their holder.
    for (const account of claim.accounts)
      if (account.index === undefined)
        pool.releaseAccountClaim(claim.holder, account.address)
      else pool.releaseClaim(claim.holder, [account.index])
    await coins.releaseUnexposed(
      claim.holder,
      claim.accounts.map(account => ({
        account: account.address,
        nonce: account.nonce,
      })),
    )
  }

  /**
   * The relay refused these signed payments before storing, delivering or broadcasting any of
   * them, and the wallet never handed them to anything else: their coins are free again. The
   * refusal may say a coin was spent elsewhere or holds less than the list thought, so each
   * account is read from the chain before it is selected again. Call it only AFTER the
   * message's own record no longer names these payments as pending.
   */
  async releaseRefused(
    holder: string,
    payments: readonly StampPayment[],
  ): Promise<void> {
    const { pool, coins, sync } = this.config
    const refused = payments.map(payment => ({
      payment,
      nonce: Transaction.from(payment.rawTx).nonce,
    }))
    // Dirty before free: no selection in between can take a coin the chain has not confirmed.
    for (const { payment } of refused) sync.markDirty(payment.address)
    for (const { payment } of refused)
      if (payment.index === undefined)
        pool.releaseAccountClaim(holder, payment.address)
      else pool.releaseClaim(holder, [payment.index])
    await coins.releaseUnexposed(
      holder,
      refused.map(({ payment, nonce }) => ({ account: payment.address, nonce })),
    )
  }

  /**
   * At open: the coins a stored, unsettled message of `holder` pays from are its again (the
   * newest transaction signed at each nonce is what it carries), and the pool's claims say so.
   * Returns the accounts another stored message already holds (two records naming one coin):
   * the wallet still opens, the first holder keeps the coin, and the chain decides both
   * payments. Call `finishRestore` once every message has been restored.
   */
  async restore(
    holder: string,
    payments: readonly Pick<StampPayment, 'source' | 'index' | 'address' | 'rawTx'>[],
  ): Promise<string[]> {
    const { pool, coins } = this.config
    const contested: string[] = []
    const writes: Promise<void>[] = []
    for (const payment of payments) {
      let tx: Transaction
      try {
        tx = Transaction.from(payment.rawTx)
      } catch {
        contested.push(payment.address)
        continue
      }
      const account = payment.address.toLowerCase()
      // Named by a stored message whatever happens below: `finishRestore` never frees it.
      this.restored.add(`${account}:${tx.nonce}`)
      try {
        if (payment.index !== undefined) pool.restoreClaim(holder, [payment.index])
        else pool.restoreAccountClaim(holder, account)
      } catch {
        // Another stored message holds this account: it keeps it; the chain decides both.
        contested.push(payment.address)
        continue
      }
      const existing = coins.get(account, tx.nonce)
      const privateKey =
        existing?.privateKey ??
        (payment.index !== undefined
          ? pool.privateKeyOf(payment.index)
          : this.config.sync.keyOf(account))
      // No key: not a coin the list can hold. The pool's claim above still holds the account.
      if (privateKey === undefined) continue
      try {
        // Held in memory at once; the write follows.
        writes.push(
          coins.restoreHeld(holder, {
            account,
            nonce: tx.nonce,
            privateKey,
            origin: existing?.origin ?? originOf(payment.source),
            rawTx: payment.rawTx,
          }),
        )
      } catch (error) {
        if (!(error instanceof EvmCoinListError)) throw error
        contested.push(payment.address)
      }
    }
    // A write that fails leaves the coin held in memory (fail closed) and is not hidden: the
    // wallet does not open over it.
    const failed = (await Promise.allSettled(writes)).find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failed !== undefined) throw failed.reason
    return contested
  }

  private readonly restored = new Set<string>()

  /** At open, after `restore` of every stored message: a coin with a transaction out that no
   * message names never left the wallet, and is free again. */
  async finishRestore(): Promise<void> {
    await this.config.coins.releaseUnreferenced((account, nonce) =>
      this.restored.has(`${account}:${nonce}`),
    )
    this.restored.clear()
  }

  /** Hands one signed transaction to the chain. A node that already has it is not an error.
   * Callers outside this class use `submitPaymentSet`. */
  private async broadcast(rawTx: string): Promise<void> {
    try {
      await this.config.provider.broadcastTransaction(rawTx)
    } catch (error) {
      // "Already known" and "nonce too low" are what a second broadcaster of the same bytes is
      // told. Whether the payment landed is read from the chain (`observe`), never from here.
      if (
        !/already known|known transaction|already imported|nonce too low|nonce has already been used/i.test(
          String((error as { message?: unknown })?.message ?? error),
        )
      )
        throw error
    }
  }

  /**
   * One look at the chain for one signed payment: what the node says of it now, read directly
   * (the receipt, the transaction by its hash, the account's nonce). With a node that answers
   * there is no "unknown": the payment is mined (succeeded or reverted), in the mempool, not
   * known to the node (never arrived, or dropped: the same bytes may be offered again), or can
   * never land because another transaction consumed its nonce. Rejects with
   * {@link ChainUnreachableError} when the node does not answer.
   */
  async observe(rawTx: string): Promise<StampPaymentObservation> {
    const { provider } = this.config
    const tx = Transaction.from(rawTx)
    const [receipt, known, used] = await this.read(() =>
      Promise.all([
        provider.getTransactionReceipt(tx.hash!),
        provider.getTransaction(tx.hash!),
        provider.getTransactionCount(tx.from!, 'latest'),
      ]),
    )
    if (receipt !== null) {
      if (receipt.status === 0) {
        const [block, head] = await this.read(() =>
          Promise.all([
            provider.getBlock(receipt.blockNumber),
            provider.getBlockNumber(),
          ]),
        )
        if (
          block?.hash !== receipt.blockHash ||
          head - receipt.blockNumber + 1 < EVM_FAILURE_CONFIRMATIONS
        ) return { state: 'pending', where: 'included' }
      }
      return {
        state: 'included',
        reverted: receipt.status === 0,
        block: receipt.blockNumber,
      }
    }
    if (known !== null) return { state: 'pending', where: 'mempool' }
    // The node knows neither the transaction nor a receipt for it.
    if (used <= tx.nonce) return { state: 'pending', where: 'unknown-to-node' }
    // The nonce is consumed. The three reads above ran side by side: a block that landed
    // between them can show the nonce used and not yet the receipt (or a load-balanced node
    // answers each from a different replica). The receipt is read again, after the count,
    // before the payment is called replaced.
    const again = await this.read(() =>
      provider.getTransactionReceipt(tx.hash!),
    )
    if (again !== null) return { state: 'pending', where: 'included' }
    return { state: 'replaced' }
  }

  /**
   * THE place a message's signed payment set is handed to the chain: the whole set, in order,
   * with what became of each hand-over. Today one broadcast per transaction (a node that
   * already has the bytes is not an error); a chain whose node takes a set atomically replaces
   * the loop here and nowhere else. Whether a payment landed is read from the chain
   * (`observe`), never from this.
   */
  async submitPaymentSet(
    rawTransactions: readonly string[],
  ): Promise<{ rawTx: string; error?: unknown }[]> {
    return Promise.all(
      rawTransactions.map(async rawTx => {
        try {
          await this.broadcast(rawTx)
          return { rawTx }
        } catch (error) {
          return { rawTx, error }
        }
      }),
    )
  }

  /** The chain shows the payment included at block `included`: its coin is spent, and what
   * its account held at THAT block is the account's next coin (read at the block, not at
   * `latest`: a node behind the block would answer with the balance before the payment, and a
   * coin worth more than the account holds signs a transfer the node refuses). Money that
   * arrives later is learned by reading the account again. A sub-account's row records its
   * first spend. The claim is NOT ended here (see `releasePayment`). Rejects, changing nothing,
   * when the balance cannot be read: settlement looks again later. Without `included` the coin
   * is marked spent with no next coin, and the account is read again. */
  async recordSpent(
    holder: string,
    payment: StampPayment,
    included?: number,
  ): Promise<void> {
    const { pool, coins } = this.config
    const tx = Transaction.from(payment.rawTx)
    const account = payment.address.toLowerCase()
    const coin = coins.get(account, tx.nonce)
    if (coin !== undefined && coin.state !== 'spent') {
      if (included === undefined) {
        await coins.recordMined(coin, { block: this.watcher.latest() ?? 0 })
        this.config.sync.markDirty(account)
      } else {
        let balance: bigint | undefined
        try {
          // Straight to the node: a refusal to answer for an old block says nothing about
          // whether the chain can be reached.
          balance = await this.config.provider.getBalance(account, included)
        } catch (error) {
          // A node that keeps only recent state (about 128 blocks on many RPCs) cannot answer
          // for an old block, as when settlement runs long after the payment (a restart). Once
          // the chain shows the nonce consumed, the coin is spent all the same: no successor
          // is made from a guess, the account is read again and the sync lists what it holds.
          const nonce = await this.read(() =>
            this.config.provider.getTransactionCount(account, 'latest'),
          )
          if (nonce <= tx.nonce) throw error
        }
        if (balance === undefined) {
          await coins.recordMined(coin, { block: included })
          this.config.sync.markDirty(account)
        } else {
          const spacing = this.config.spendSpacingBlocks ?? 0
          await coins.recordMined(coin, {
            block: included,
            successor: {
              valueWei: balance,
              ...(spacing > 0
                ? { spendableFromBlock: included + spacing - 1 }
                : {}),
            },
          })
        }
      }
    }
    if (payment.index === undefined || tx.nonce !== 0) return
    const index = payment.index
    try {
      pool.commitSpend(index, payment.rawTx)
    } catch (error) {
      // The chain shows this account spent, and its row cannot take the record (it disagrees
      // with something else stored about this one account). The account goes out of use,
      // visibly; nothing else in the wallet is affected.
      console.warn(
        `[evm-stamp-payer] sub-account ${index} is spent on chain but its row refused the record; retiring it:`,
        error,
      )
      const row = pool.getRecord(index)
      if (row && row.status !== 'spent' && row.status !== 'retired')
        pool.setStatus(index, 'retired')
    }
    await pool.flush()
  }

  /** The chain shows the coin's nonce consumed by another transaction: this payment can never
   * land. The coin leaves the list and its account is read again; a sub-account at its first
   * nonce is retired. */
  async recordFailed(holder: string, payment: StampPayment): Promise<void> {
    const { pool, coins } = this.config
    const tx = Transaction.from(payment.rawTx)
    // A coin already spent was spent by another transaction of this payment at the same nonce
    // (it was signed again): only that one's record counts.
    if (coins.get(payment.address, tx.nonce)?.state !== 'spent') {
      await coins.recordGone({ account: payment.address, nonce: tx.nonce })
      this.config.sync.markDirty(payment.address)
    }
    if (payment.index === undefined || tx.nonce !== 0) return
    const row = pool.getRecord(payment.index)
    if (row && row.status !== 'spent' && row.status !== 'retired')
      pool.setStatus(payment.index, 'retired')
    await pool.flush()
  }

  /** Ends the hold on one payment's coin. Call it only AFTER the message's own record of what
   * became of the payment is on disk: until then the hold is what keeps the coin from a second
   * spender, across a crash too. A coin taken and never signed is simply given back. */
  releasePayment(
    holder: string,
    payment: Pick<StampPayment, 'index' | 'address'> & { nonce?: number },
  ): void {
    const { pool, coins } = this.config
    if (payment.index === undefined)
      pool.releaseAccountClaim(holder, payment.address)
    else pool.releaseClaim(holder, [payment.index])
    if (payment.nonce !== undefined)
      coins.abandon(holder, [{ account: payment.address, nonce: payment.nonce }])
  }
}

function originOf(source: StampCoinSource): EvmCoinListOrigin {
  switch (source) {
    case 'pool':
      return 'deterministic'
    case 'main':
      return 'root'
    case 'identity':
      return 'identity'
    default:
      return 'stamp'
  }
}
