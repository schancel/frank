/**
 * The coins of one EVM chain wallet: one flat list, kept in memory and on disk.
 *
 * A coin is money at one of the wallet's accounts at one nonce: `[account, nonce]`. It carries
 * the account's private key (the send path signs with `coin.privateKey` and never derives a
 * key), its exact value in wei, where the key came from, and its state:
 *
 * - `unspent`: free. Selection may take it.
 * - `spend_pending`: taken by one operation (`holder`) that is building a payment from it. Nothing
 *   was signed, or what was signed never left the wallet: `abandon` frees it again. Process memory
 *   only: a build cut off by a restart left nothing anyone can broadcast, so after a restart the
 *   coin is `unspent` again.
 * - `pending_receipt`: its spending transaction is on the coin and on disk, and may have been
 *   handed to the relay or a node. It stays here, never selectable, until the chain shows what
 *   became of that transaction (`recordMined` / `recordGone`). A timeout, a restart, a relay
 *   refusal or a deleted message is not that.
 * - `spent`: the chain shows its spending transaction included. What the account holds after it
 *   is a new coin at the next nonce (the successor), added in the same step.
 *
 * An account's nonces stack: when a payment is signed from `[account, n]`, what the account
 * keeps after it (its value less the payment and the most its fee can be) is listed at once as
 * `[account, n + 1]`, so the next payment can sign at the next nonce without waiting for the
 * chain to show `n`. The chain mines them in order. Whether the chain lets the account spend
 * again that soon is the chain adapter's rule (`spendableFromBlock`).
 *
 * Selection (`select`) is one synchronous pass over the unspent coins: no request, no await, so
 * two payments built at the same moment can never take the same coin. Whatever has to be learned
 * from the chain (that a coin's money arrived, what an account holds after a spend) is learned out
 * of band, by the wallet's sync and settlement, and written here with `put` / `recordMined`.
 *
 * The chain's own rules stay with the chain adapter: a coin may carry `spendableFromBlock` (on
 * Monad, the block from which money newer than the reserve-balance window can be spent), and the
 * caller passes the head it knows to `select`.
 *
 * One list per wallet, and one wallet per chain: a coin carries no chain field.
 */
import { computeAddress } from 'ethers'
import type { RecordStore } from './storage/evm-coin-store'
import {
  selectStampAccounts,
  type SelectedStampAccount,
} from './evm-stamp-account-selection'

/** Where a coin's key came from. `root`: the wallet's main account; `identity`: its identity
 * account; `deterministic`: an HD sub-account of the keyring; `stealth` / `stamp`: a one-time
 * account whose key came from a received message. */
export type EvmCoinListOrigin =
  | 'root'
  | 'identity'
  | 'deterministic'
  | 'stealth'
  | 'stamp'

export type EvmCoinListState =
  | 'unspent'
  | 'spend_pending'
  | 'pending_receipt'
  | 'spent'

export interface EvmListCoin {
  /** Lower-case 0x address. */
  readonly account: string
  readonly nonce: number
  readonly privateKey: string
  readonly valueWei: bigint
  readonly origin: EvmCoinListOrigin
  readonly state: EvmCoinListState
  /** The operation that took it (`spend_pending`, `pending_receipt`). */
  readonly holder?: string
  /** The signed transaction spending it (`pending_receipt`, `spent`). */
  readonly spendingTx?: string
  /** Not selectable before the chain's head reaches this block. */
  readonly spendableFromBlock?: number
  /** `spent`: the block that included its spending transaction. */
  readonly spentInBlock?: number
}

/** The coin as it is stored: wei as a decimal string. `spend_pending` is never stored. */
export interface StoredEvmListCoin {
  readonly account: string
  readonly nonce: number
  readonly privateKey: string
  readonly valueWei: string
  readonly origin: EvmCoinListOrigin
  readonly state: 'unspent' | 'pending_receipt' | 'spent'
  readonly holder?: string
  readonly spendingTx?: string
  readonly spendableFromBlock?: number
  readonly spentInBlock?: number
}

export const EVM_COIN_LIST_NAMESPACE = 'evm-coin-list'

export function coinKey(account: string, nonce: number): string {
  return `${account.toLowerCase()}:${nonce}`
}

export interface CoinPart {
  readonly coin: EvmListCoin
  /** What this coin pays of the amount. Its fee comes on top. */
  readonly paymentValueWei: bigint
}

export class EvmCoinListError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvmCoinListError'
  }
}

function toStored(coin: EvmListCoin): StoredEvmListCoin {
  if (coin.state === 'spend_pending')
    throw new EvmCoinListError('A coin being built from is not stored')
  return {
    account: coin.account,
    nonce: coin.nonce,
    privateKey: coin.privateKey,
    valueWei: coin.valueWei.toString(),
    origin: coin.origin,
    state: coin.state,
    ...(coin.holder === undefined ? {} : { holder: coin.holder }),
    ...(coin.spendingTx === undefined ? {} : { spendingTx: coin.spendingTx }),
    ...(coin.spendableFromBlock === undefined
      ? {}
      : { spendableFromBlock: coin.spendableFromBlock }),
    ...(coin.spentInBlock === undefined ? {} : { spentInBlock: coin.spentInBlock }),
  }
}

function fromStored(row: StoredEvmListCoin): EvmListCoin {
  if (
    typeof row.account !== 'string' ||
    !/^0x[0-9a-f]{40}$/.test(row.account) ||
    !Number.isSafeInteger(row.nonce) ||
    row.nonce < 0 ||
    !/^(0|[1-9][0-9]*)$/.test(row.valueWei) ||
    !['unspent', 'pending_receipt', 'spent'].includes(row.state) ||
    (row.state !== 'unspent' && row.spendingTx === undefined)
  )
    throw new EvmCoinListError(
      `Unreadable coin record ${String(row.account)}:${String(row.nonce)}. ` +
        'Development reset: delete only the evm-coin-list store; it is rebuilt from the keyring and the chain.',
    )
  return { ...row, valueWei: BigInt(row.valueWei) }
}

export class EvmCoinList {
  private readonly coinsByKey = new Map<string, EvmListCoin>()
  private changed = new Set<() => void>()

  private constructor(private readonly store: RecordStore<StoredEvmListCoin>) {}

  /** Reads every stored coin. A coin whose spending transaction may have left the wallet is
   * read back as `pending_receipt`; nothing is ever read back as being built from. */
  static async open(
    store: RecordStore<StoredEvmListCoin>,
  ): Promise<EvmCoinList> {
    const list = new EvmCoinList(store)
    await store.refresh()
    for (const row of store.all()) {
      const coin = fromStored(row)
      if (
        computeAddress(coin.privateKey).toLowerCase() !== coin.account
      )
        throw new EvmCoinListError(
          `Coin ${coinKey(coin.account, coin.nonce)} is stored with another account's key`,
        )
      list.coinsByKey.set(coinKey(coin.account, coin.nonce), coin)
    }
    return list
  }

  /** Every coin, in no particular order. */
  all(): EvmListCoin[] {
    return [...this.coinsByKey.values()]
  }

  get(account: string, nonce: number): EvmListCoin | undefined {
    return this.coinsByKey.get(coinKey(account, nonce))
  }

  /** The account's newest coin (highest nonce), whatever its state. */
  latestOf(account: string): EvmListCoin | undefined {
    let latest: EvmListCoin | undefined
    const key = account.toLowerCase()
    for (const coin of this.coinsByKey.values())
      if (coin.account === key && (!latest || coin.nonce > latest.nonce))
        latest = coin
    return latest
  }

  /** The coins a holder holds, in any state but `spent`. */
  heldBy(holder: string): EvmListCoin[] {
    return this.all().filter(
      coin => coin.holder === holder && coin.state !== 'spent',
    )
  }

  /** What the unspent coins hold. */
  unspentTotal(filter?: (coin: EvmListCoin) => boolean): bigint {
    return this.all()
      .filter(coin => coin.state === 'unspent' && (filter?.(coin) ?? true))
      .reduce((sum, coin) => sum + coin.valueWei, 0n)
  }

  /** Called after every change. Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.changed.add(listener)
    return () => this.changed.delete(listener)
  }

  private notify(): void {
    for (const listener of this.changed) {
      try {
        listener()
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  private async persist(coin: EvmListCoin): Promise<void> {
    await this.store.put(coinKey(coin.account, coin.nonce), toStored(coin))
  }

  /**
   * Money the wallet holds at `[account, nonce]`, free to spend: a new coin, or the new value of
   * an unspent one (what sync learned from the chain). An account has at most one live coin: an
   * unspent coin at an older nonce of the same account is replaced. A coin some operation holds
   * is never overwritten (the operation, then settlement, decides what became of it).
   */
  async put(input: {
    account: string
    nonce: number
    privateKey: string
    valueWei: bigint
    origin: EvmCoinListOrigin
    spendableFromBlock?: number
  }): Promise<EvmListCoin> {
    const account = input.account.toLowerCase()
    if (computeAddress(input.privateKey).toLowerCase() !== account)
      throw new EvmCoinListError('A coin is added with its own account key')
    if (!Number.isSafeInteger(input.nonce) || input.nonce < 0)
      throw new EvmCoinListError('A coin nonce is a nonnegative integer')
    if (input.valueWei < 0n)
      throw new EvmCoinListError('A coin value is not negative')
    const key = coinKey(account, input.nonce)
    const existing = this.coinsByKey.get(key)
    if (existing !== undefined && existing.state !== 'unspent')
      throw new EvmCoinListError(
        `Coin ${key} is ${existing.state}; only settlement changes it`,
      )
    for (const coin of this.coinsByKey.values())
      if (coin.account === account && coin.nonce > input.nonce)
        throw new EvmCoinListError(
          `Coin ${key} is older than the account's coin at nonce ${coin.nonce}`,
        )
    const stale = this.all().filter(
      coin =>
        coin.account === account &&
        coin.nonce < input.nonce &&
        coin.state === 'unspent',
    )
    const coin: EvmListCoin = {
      account,
      nonce: input.nonce,
      privateKey: input.privateKey,
      valueWei: input.valueWei,
      origin: input.origin,
      state: 'unspent',
      ...(input.spendableFromBlock === undefined
        ? {}
        : { spendableFromBlock: input.spendableFromBlock }),
    }
    this.coinsByKey.set(key, coin)
    for (const old of stale) this.coinsByKey.delete(coinKey(old.account, old.nonce))
    this.notify()
    await this.persist(coin)
    await Promise.all(
      stale.map(old => this.store.delete(coinKey(old.account, old.nonce))),
    )
    return coin
  }

  /**
   * Takes, for `holder`, unspent coins that pay `amountWei`, each keeping `feeReserveWei` back
   * for its own transfer's fee. One synchronous pass: the coins are `spend_pending` when this
   * returns, and no other selection can be given them. `undefined`: the free coins do not cover
   * it, and nothing was taken.
   *
   * The choice is the stamp wallet's (`selectStampAccounts`): the amount spread over at least
   * two coins when it can be, none giving more than it holds after its fee. A split that would
   * make a part smaller than `minPartWei` is refused and the smallest single coin that covers
   * the whole amount is taken instead; when none does, nothing is taken.
   */
  select(params: {
    holder: string
    amountWei: bigint
    feeReserveWei: bigint
    /** The chain head the caller knows: coins not spendable yet at it are not taken. */
    head?: number
    minPartWei?: bigint
    maxCoins?: number
    filter?: (coin: EvmListCoin) => boolean
  }): CoinPart[] | undefined {
    if (params.amountWei <= 0n)
      throw new EvmCoinListError('A payment amount is positive')
    const free = this.all().filter(
      coin =>
        coin.state === 'unspent' &&
        coin.valueWei > params.feeReserveWei &&
        (coin.spendableFromBlock === undefined ||
          (params.head !== undefined && params.head >= coin.spendableFromBlock)) &&
        (params.filter?.(coin) ?? true),
    )
    const pick = (
      candidates: readonly EvmListCoin[],
    ): SelectedStampAccount[] | undefined => {
      try {
        return selectStampAccounts({
          amountWei: params.amountWei,
          accounts: candidates.map((coin, index) => ({
            index,
            address: coin.account,
            capacityWei: coin.valueWei - params.feeReserveWei,
          })),
          ...(params.maxCoins === undefined
            ? {}
            : { maxTransactions: params.maxCoins }),
        })
      } catch {
        return undefined
      }
    }
    let selected = pick(free)
    if (
      selected !== undefined &&
      params.minPartWei !== undefined &&
      selected.some(part => part.paymentValueWei < params.minPartWei!)
    ) {
      const whole = free
        .filter(
          coin => coin.valueWei - params.feeReserveWei >= params.amountWei,
        )
        .sort((a, b) => (a.valueWei < b.valueWei ? -1 : a.valueWei > b.valueWei ? 1 : 0))[0]
      selected =
        whole === undefined
          ? undefined
          : [
              {
                index: free.indexOf(whole),
                address: whole.account,
                capacityWei: whole.valueWei - params.feeReserveWei,
                paymentValueWei: params.amountWei,
              },
            ]
    }
    if (selected === undefined || selected.length === 0) return undefined
    const parts = selected.map(part => {
      const coin: EvmListCoin = {
        ...free[part.index]!,
        state: 'spend_pending',
        holder: params.holder,
      }
      this.coinsByKey.set(coinKey(coin.account, coin.nonce), coin)
      return { coin, paymentValueWei: part.paymentValueWei }
    })
    this.notify()
    return parts
  }

  /**
   * Gives back the coins `holder` took and never signed a transaction that left the wallet
   * (default: all of its `spend_pending` coins; `pending_receipt` coins are never given back).
   */
  abandon(holder: string, coins?: readonly { account: string; nonce: number }[]): void {
    const only =
      coins === undefined
        ? undefined
        : new Set(coins.map(coin => coinKey(coin.account, coin.nonce)))
    let any = false
    for (const [key, coin] of this.coinsByKey)
      if (
        coin.holder === holder &&
        coin.state === 'spend_pending' &&
        (only === undefined || only.has(key))
      ) {
        const { holder: _holder, ...free } = coin
        this.coinsByKey.set(key, { ...free, state: 'unspent' })
        any = true
      }
    if (any) this.notify()
  }

  /**
   * The signed transaction spending a coin `holder` took goes onto the coin, durably, BEFORE
   * the transaction is handed to anything that can broadcast it. From here only the chain frees
   * the coin. A failed write leaves the coin taken (`spend_pending`) for this session: whether
   * the record is on disk is not known, so the transaction must not be broadcast and the coin
   * is not offered to anyone else either.
   */
  async recordSigned(
    holder: string,
    coin: { account: string; nonce: number },
    rawTx: string,
    /** What the account keeps after this payment, listed at once at the next nonce. */
    successor?: { valueWei: bigint; spendableFromBlock?: number },
  ): Promise<void> {
    const key = coinKey(coin.account, coin.nonce)
    const current = this.coinsByKey.get(key)
    if (
      current === undefined ||
      current.holder !== holder ||
      (current.state !== 'spend_pending' &&
        !(current.state === 'pending_receipt' && current.spendingTx === rawTx))
    )
      throw new EvmCoinListError(`Coin ${key} is not being built from by ${holder}`)
    const next: EvmListCoin = { ...current, state: 'pending_receipt', spendingTx: rawTx }
    const successorKey = coinKey(current.account, current.nonce + 1)
    const stacked: EvmListCoin | undefined =
      successor !== undefined &&
      successor.valueWei > 0n &&
      !this.coinsByKey.has(successorKey)
        ? {
            account: current.account,
            nonce: current.nonce + 1,
            privateKey: current.privateKey,
            valueWei: successor.valueWei,
            origin: current.origin,
            state: 'unspent',
            ...(successor.spendableFromBlock === undefined
              ? {}
              : { spendableFromBlock: successor.spendableFromBlock }),
          }
        : undefined
    await this.store.put(key, toStored(next))
    if (stacked) await this.persist(stacked)
    this.coinsByKey.set(key, next)
    if (stacked) this.coinsByKey.set(successorKey, stacked)
    this.notify()
  }

  /** A coin whose transaction never left the wallet is free again: the successor stacked on it
   * goes when nothing took it; when something did, the coin keeps only what it had set aside
   * for its own payment (the rest is that successor's). */
  private unstack(coin: EvmListCoin): EvmListCoin {
    const successorKey = coinKey(coin.account, coin.nonce + 1)
    const successor = this.coinsByKey.get(successorKey)
    if (successor === undefined) return coin
    if (successor.state === 'unspent') {
      this.coinsByKey.delete(successorKey)
      void this.store.delete(successorKey)
      return coin
    }
    const own = coin.valueWei - successor.valueWei
    return { ...coin, valueWei: own > 0n ? own : 0n }
  }

  /**
   * A coin's spending transaction was replaced by another signing of the same payment at the
   * same nonce (a resign): the coin carries the newest one. At most one of them can be mined.
   */
  async recordResigned(
    coin: { account: string; nonce: number },
    rawTx: string,
  ): Promise<void> {
    const key = coinKey(coin.account, coin.nonce)
    const current = this.coinsByKey.get(key)
    if (current === undefined || current.state !== 'pending_receipt')
      throw new EvmCoinListError(`Coin ${key} has no transaction out`)
    const next: EvmListCoin = { ...current, spendingTx: rawTx }
    await this.store.put(key, toStored(next))
    this.coinsByKey.set(key, next)
    this.notify()
  }

  /**
   * The chain shows the coin's nonce consumed by an included transaction (this coin's, or a
   * replacement of it): the coin is spent, and what the account holds now is its successor at
   * the next nonce. No successor when it holds nothing worth a transfer's fee
   * (`successor.valueWei` 0 or absent). Idempotent.
   */
  async recordMined(
    coin: { account: string; nonce: number },
    outcome: {
      block: number
      successor?: { valueWei: bigint; spendableFromBlock?: number }
    },
  ): Promise<void> {
    const key = coinKey(coin.account, coin.nonce)
    const current = this.coinsByKey.get(key)
    if (current === undefined || current.state === 'spent') return
    const spent: EvmListCoin = {
      ...current,
      state: 'spent',
      spentInBlock: outcome.block,
    }
    const successorKey = coinKey(current.account, current.nonce + 1)
    // A successor stacked when the payment was signed and not taken since is replaced by what
    // the chain shows the account held at the block.
    const existing = this.coinsByKey.get(successorKey)
    const successor: EvmListCoin | undefined =
      outcome.successor !== undefined &&
      outcome.successor.valueWei > 0n &&
      (existing === undefined || existing.state === 'unspent')
        ? {
            account: current.account,
            nonce: current.nonce + 1,
            privateKey: current.privateKey,
            valueWei: outcome.successor.valueWei,
            origin: current.origin,
            state: 'unspent',
            ...(outcome.successor.spendableFromBlock === undefined
              ? {}
              : { spendableFromBlock: outcome.successor.spendableFromBlock }),
          }
        : undefined
    // The successor first: a crash between the two writes leaves the old coin pending (it is
    // settled again) next to its successor, never money with no coin.
    if (successor) await this.persist(successor)
    await this.persist(spent)
    if (successor) this.coinsByKey.set(successorKey, successor)
    this.coinsByKey.set(key, spent)
    this.notify()
  }

  /**
   * The coin can never be spent by what it carries: the chain shows its nonce taken by a
   * transaction this list does not know (another device, a restored wallet), or the node refuses
   * it for a nonce or balance it no longer has. It leaves the list; what the account holds now is
   * added again by the caller's next look (`put`).
   */
  async recordGone(coin: { account: string; nonce: number }): Promise<void> {
    const key = coinKey(coin.account, coin.nonce)
    if (!this.coinsByKey.has(key)) return
    await this.store.delete(key)
    this.coinsByKey.delete(key)
    this.notify()
  }

  /**
   * At open, from the durable record of an operation (a stored message): the coin
   * `[account, nonce]` is that operation's, and `rawTx` (the newest transaction signed at that
   * nonce) may have left the wallet. Synchronous in memory, so the wallet is handed out with the
   * coin held; the returned promise writes it. A coin the list does not have (its store was
   * reset) is recorded with an unknown value: settlement reads what the account holds.
   */
  restoreHeld(
    holder: string,
    coin: {
      account: string
      nonce: number
      privateKey: string
      origin: EvmCoinListOrigin
      rawTx: string
    },
  ): Promise<void> {
    const account = coin.account.toLowerCase()
    const key = coinKey(account, coin.nonce)
    const current = this.coinsByKey.get(key)
    if (current?.state === 'spent') return Promise.resolve()
    if (current !== undefined && current.holder !== undefined && current.holder !== holder && current.state !== 'unspent')
      throw new EvmCoinListError(`Coin ${key} is held by ${current.holder} and by ${holder}`)
    const next: EvmListCoin = {
      ...(current ?? {
        account,
        nonce: coin.nonce,
        privateKey: coin.privateKey,
        valueWei: 0n,
        origin: coin.origin,
      }),
      state: 'pending_receipt',
      holder,
      spendingTx: coin.rawTx,
    }
    this.coinsByKey.set(key, next)
    this.notify()
    return this.persist(next)
  }

  /**
   * Frees every coin `holder` holds, signed or not. ONLY for a caller that knows none of the
   * signed transactions was handed to anything that can broadcast it (the operation's own record
   * was never written).
   */
  async releaseUnexposed(
    holder: string,
    /** Only these coins; default: every coin the holder holds. */
    only?: readonly { account: string; nonce: number }[],
  ): Promise<void> {
    const keys =
      only === undefined
        ? undefined
        : new Set(only.map(coin => coinKey(coin.account, coin.nonce)))
    const freed: EvmListCoin[] = []
    for (const [key, coin] of this.coinsByKey)
      if (
        (keys === undefined || keys.has(key)) &&
        coin.holder === holder &&
        (coin.state === 'spend_pending' || coin.state === 'pending_receipt')
      ) {
        const { holder: _holder, spendingTx: _tx, ...rest } = coin
        const free: EvmListCoin = this.unstack({ ...rest, state: 'unspent' })
        this.coinsByKey.set(key, free)
        freed.push(free)
      }
    if (freed.length === 0) return
    this.notify()
    await Promise.all(freed.map(coin => this.persist(coin)))
  }

  /**
   * At open, after every durable record restored its coins: a coin with a transaction out that
   * no record names was signed and never written anywhere it could be sent from, so it never
   * left the wallet: free again.
   */
  async releaseUnreferenced(
    referenced: (account: string, nonce: number) => boolean,
  ): Promise<number> {
    let count = 0
    for (const coin of this.all())
      if (coin.state === 'pending_receipt' && !referenced(coin.account, coin.nonce)) {
        const { holder: _holder, spendingTx: _tx, ...rest } = coin
        const free: EvmListCoin = this.unstack({ ...rest, state: 'unspent' })
        this.coinsByKey.set(coinKey(coin.account, coin.nonce), free)
        await this.persist(free)
        count++
      }
    if (count > 0) this.notify()
    return count
  }

  /** Drops spent coins older than `beforeBlock` (the background worker's cleanup). */
  async prune(beforeBlock: number): Promise<number> {
    const old = this.all().filter(
      coin =>
        coin.state === 'spent' &&
        coin.spentInBlock !== undefined &&
        coin.spentInBlock < beforeBlock,
    )
    for (const coin of old) {
      await this.store.delete(coinKey(coin.account, coin.nonce))
      this.coinsByKey.delete(coinKey(coin.account, coin.nonce))
    }
    if (old.length > 0) this.notify()
    return old.length
  }
}
