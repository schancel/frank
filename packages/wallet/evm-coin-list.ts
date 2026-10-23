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
import type { PreparedEvmTransactionSet } from './evm-transaction-set-types'
import type { RecordStore } from './storage/evm-coin-store'
import {
  selectStampAccounts,
  type SelectedStampAccount,
} from './evm-stamp-account-selection'

/** Where a coin's key came from. `root`: the wallet's main account; `identity`: its identity
 * account; `deterministic`: an HD sub-account of the keyring; `stealth` / `stamp`: a one-time
 * account whose key came from a received message. */
export type EvmCoinListOrigin =
  | 'change'
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
  readonly changeIndex?: number
  readonly after?: { readonly account: string; readonly nonce: number }
  readonly state: EvmCoinListState
  /** The operation that took it (`spend_pending`, `pending_receipt`). */
  readonly holder?: string
  /** The signed transaction while unresolved (`pending_receipt`); optional after settlement. */
  readonly spendingTx?: string
  /** Not selectable before the chain's head reaches this block. */
  readonly spendableFromBlock?: number
  /** `spent`: the block that included its spending transaction. */
  readonly spentInBlock?: number
  /** Canonical inclusion/observation bound of the account nonce preceding this coin. */
  readonly lastSpentInBlock?: number
}

/** The coin as it is stored: wei as a decimal string. `spend_pending` is never stored. */
export interface StoredEvmListCoin {
  readonly account: string
  readonly nonce: number
  readonly privateKey: string
  readonly valueWei: string
  readonly origin: EvmCoinListOrigin
  readonly changeIndex?: number
  readonly after?: { readonly account: string; readonly nonce: number }
  readonly state: 'unspent' | 'pending_receipt' | 'spent'
  readonly holder?: string
  readonly spendingTx?: string
  readonly spendableFromBlock?: number
  readonly spentInBlock?: number
  /** Canonical inclusion/observation bound of the account nonce preceding this coin. */
  readonly lastSpentInBlock?: number
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
    ...(coin.lastSpentInBlock === undefined
      ? {}
      : { lastSpentInBlock: coin.lastSpentInBlock }),
    ...(coin.changeIndex === undefined
      ? {}
      : { changeIndex: coin.changeIndex }),
    ...(coin.after === undefined ? {} : { after: coin.after }),
    state: coin.state,
    ...(coin.holder === undefined ? {} : { holder: coin.holder }),
    ...(coin.spendingTx === undefined ? {} : { spendingTx: coin.spendingTx }),
    ...(coin.spendableFromBlock === undefined
      ? {}
      : { spendableFromBlock: coin.spendableFromBlock }),
    ...(coin.spentInBlock === undefined
      ? {}
      : { spentInBlock: coin.spentInBlock }),
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
    (row.state === 'pending_receipt' && row.spendingTx === undefined) ||
    (row.lastSpentInBlock !== undefined &&
      (!Number.isSafeInteger(row.lastSpentInBlock) || row.lastSpentInBlock < 0))
  )
    throw new EvmCoinListError(
      `Unreadable coin record ${String(row.account)}:${String(row.nonce)} ` +
        `(state=${String(row.state)}, spendingTx=${String(row.spendingTx)}). ` +
        'Development reset: delete only the evm-coin-list store; it is rebuilt from the keyring and the chain.',
    )
  return { ...row, valueWei: BigInt(row.valueWei) }
}

export interface EvmCoinAccountProjection {
  put: EvmCoinList['put']
  recordMined: EvmCoinList['recordMined']
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
      if (computeAddress(coin.privateKey).toLowerCase() !== coin.account)
        throw new EvmCoinListError(
          `Coin ${coinKey(
            coin.account,
            coin.nonce,
          )} is stored with another account's key`,
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

  /** Account-based maintenance must exclude provisional selections and unfinished inventory
   * projection. This synchronous observation can be paired with a legacy pool claim without
   * yielding; shared selection checks that claim in the reciprocal direction. */
  isAccountReserved(account: string): boolean {
    const key = account.toLowerCase()
    return !this.accountSelectable(key) || this.all().some(coin =>
      coin.account === key &&
      (coin.state === 'spend_pending' || coin.state === 'pending_receipt'),
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

  private readonly accountMutations = new Map<string, Promise<unknown>>()
  private readonly incompleteTransactionSetProjections = new Map<
    string,
    Set<string>
  >()

  private accountMutation<T>(
    account: string,
    write: () => Promise<T>,
  ): Promise<T> {
    const key = account.toLowerCase()
    const prior = this.accountMutations.get(key) ?? Promise.resolve()
    const result = prior.catch(() => undefined).then(write)
    this.accountMutations.set(key, result)
    void result
      .finally(() => {
        if (this.accountMutations.get(key) === result)
          this.accountMutations.delete(key)
      })
      .catch(() => undefined)
    return result
  }

  requireTransactionSetProjection(account: string, reference: string): void {
    const key = account.toLowerCase(),
      pending =
        this.incompleteTransactionSetProjections.get(key) ?? new Set<string>()
    pending.add(reference)
    this.incompleteTransactionSetProjections.set(key, pending)
  }
  completeTransactionSetProjection(account: string, reference: string): void {
    const key = account.toLowerCase(),
      pending = this.incompleteTransactionSetProjections.get(key)
    pending?.delete(reference)
    if (pending?.size === 0)
      this.incompleteTransactionSetProjections.delete(key)
  }

  /** One authoritative account, including normal sync writes. Only local durable work;
   * callers perform network reads before entering. Other accounts continue independently.
   * Preparers share this authoritative list; independent live lists over one store are unsupported. */
  projectTransactionSetAccount(
    account: string,
    reference: string,
    apply: (writer: EvmCoinAccountProjection) => Promise<boolean>,
  ): Promise<boolean> {
    const key = account.toLowerCase()
    return this.accountMutation(key, async () => {
      let active = true
      const check = (target: string) => {
        if (!active || target.toLowerCase() !== key)
          throw new EvmCoinListError(
            'Projection belongs to another account or has completed',
          )
      }
      try {
        return await apply({
          put: input => {
            check(input.account)
            return this.putAccount(input)
          },
          recordMined: (coin, outcome) => {
            check(coin.account)
            return this.recordMinedAccount(coin, outcome)
          },
        })
      } catch (error) {
        this.requireTransactionSetProjection(key, reference)
        throw error
      } finally {
        active = false
      }
    })
  }

  private accountSelectable(account: string): boolean {
    return (
      !this.accountMutations.has(account) &&
      !this.incompleteTransactionSetProjections.has(account)
    )
  }

  /**
   * Money the wallet holds at `[account, nonce]`, free to spend: a new coin, or the new value of
   * an unspent one (what sync learned from the chain). An account has at most one live coin: an
   * unspent coin at an older nonce of the same account is replaced. A coin some operation holds
   * is never overwritten (the operation, then settlement, decides what became of it).
   */
  put(input: {
    account: string
    nonce: number
    privateKey: string
    valueWei: bigint
    origin: EvmCoinListOrigin
    changeIndex?: number
    lastSpentInBlock?: number
    spendableFromBlock?: number
  }): Promise<EvmListCoin> {
    const snapshot = { ...input }
    return this.accountMutation(snapshot.account, () =>
      this.putAccount(snapshot),
    )
  }

  private async putAccount(input: {
    account: string
    nonce: number
    privateKey: string
    valueWei: bigint
    origin: EvmCoinListOrigin
    changeIndex?: number
    lastSpentInBlock?: number
    spendableFromBlock?: number
  }): Promise<EvmListCoin> {
    const account = input.account.toLowerCase()
    if (computeAddress(input.privateKey).toLowerCase() !== account)
      throw new EvmCoinListError('A coin is added with its own account key')
    if (!Number.isSafeInteger(input.nonce) || input.nonce < 0)
      throw new EvmCoinListError('A coin nonce is a nonnegative integer')
    if (
      input.lastSpentInBlock !== undefined &&
      (!Number.isSafeInteger(input.lastSpentInBlock) ||
        input.lastSpentInBlock < 0)
    )
      throw new EvmCoinListError('Invalid last-spend block')
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
      ...((input.lastSpentInBlock ?? existing?.lastSpentInBlock) === undefined
        ? {}
        : {
            lastSpentInBlock:
              input.lastSpentInBlock ?? existing!.lastSpentInBlock,
          }),
      ...(input.changeIndex === undefined
        ? {}
        : { changeIndex: input.changeIndex }),
      state: 'unspent',
      ...(input.spendableFromBlock === undefined
        ? {}
        : { spendableFromBlock: input.spendableFromBlock }),
    }
    this.coinsByKey.set(key, coin)
    for (const old of stale)
      this.coinsByKey.delete(coinKey(old.account, old.nonce))
    this.notify()
    try {
      await this.persist(coin)
      await Promise.all(
        stale.map(old => this.store.delete(coinKey(old.account, old.nonce))),
      )
    } catch (error) {
      if (existing) this.coinsByKey.set(key, existing)
      else this.coinsByKey.delete(key)
      for (const old of stale)
        this.coinsByKey.set(coinKey(old.account, old.nonce), old)
      this.notify()
      throw error
    }
    return coin
  }

  /** Selection and ownership change form one synchronous section; no provider work occurs. */
  reserveTransactionSetSources(params: {
    holder: string
    amountWei: bigint
    feeWei: bigint | ((paymentIndex: number) => bigint)
    head: number
    sourceOrder: readonly EvmCoinListOrigin[]
    maxCoins?: number
    canSelect?: (coin: EvmListCoin) => boolean
    capacityWei?: (coin: EvmListCoin, feeWei: bigint) => bigint
  }): CoinPart[] | undefined {
    if (
      params.amountWei < 0n ||
      (typeof params.feeWei === 'bigint' && params.feeWei <= 0n)
    )
      throw new EvmCoinListError('Invalid transaction-set amount or fee')
    const rank = new Map(
      params.sourceOrder.map((origin, index) => [origin, index]),
    )
    const free = this.all().filter(
      coin =>
        coin.state === 'unspent' &&
        this.accountSelectable(coin.account) &&
        rank.has(coin.origin) &&
        (coin.spendableFromBlock === undefined ||
          coin.spendableFromBlock <= params.head) &&
        (params.canSelect?.(coin) ?? coin.after === undefined),
    )
    free.sort(
      (a, b) =>
        rank.get(a.origin)! - rank.get(b.origin)! ||
        (a.origin === 'change' && b.origin === 'change'
          ? (a.changeIndex ?? Number.MAX_SAFE_INTEGER) -
            (b.changeIndex ?? Number.MAX_SAFE_INTEGER)
          : 0) ||
        (a.valueWei > b.valueWei ? -1 : a.valueWei < b.valueWei ? 1 : 0),
    )
    let remaining = params.amountWei
    const picked: CoinPart[] = [],
      accounts = new Set<string>()
    for (const coin of free) {
      if (picked.length >= (params.maxCoins ?? Number.MAX_SAFE_INTEGER)) break
      if (accounts.has(coin.account)) continue
      const fee =
        typeof params.feeWei === 'bigint'
          ? params.feeWei
          : params.feeWei(picked.length)
      if (fee <= 0n) throw new EvmCoinListError('Invalid per-payment fee')
      if (coin.valueWei < fee) continue
      const available = coin.valueWei - fee
      const capacity = params.capacityWei?.(coin, fee) ?? available
      if (capacity < 0n || capacity > available)
        throw new EvmCoinListError('Invalid source capacity')
      if (capacity === 0n && remaining > 0n) continue
      const paymentValueWei = capacity < remaining ? capacity : remaining
      picked.push({ coin, paymentValueWei })
      accounts.add(coin.account)
      remaining -= paymentValueWei
      if (remaining === 0n) break
    }
    if (remaining > 0n || picked.length === 0) return undefined
    const reserved = picked.map(part => {
      const coin: EvmListCoin = {
        ...part.coin,
        state: 'spend_pending',
        holder: params.holder,
      }
      this.coinsByKey.set(coinKey(coin.account, coin.nonce), coin)
      return { ...part, coin }
    })
    this.notify()
    return reserved
  }

  private readonly transactionSetBuilds = new Map<
    string,
    Promise<PreparedEvmTransactionSet>
  >()
  constructTransactionSetOnce(
    operationId: string,
    build: () => Promise<PreparedEvmTransactionSet>,
  ): Promise<PreparedEvmTransactionSet> {
    const pending = this.transactionSetBuilds.get(operationId)
    if (pending) return pending
    const result = build()
    this.transactionSetBuilds.set(operationId, result)
    void result
      .finally(() => this.transactionSetBuilds.delete(operationId))
      .catch(() => undefined)
    return result
  }

  private readonly changeTargets = new Map<
    number,
    { account: string; operationId: string }
  >()

  /** Pending destinations are reserved before any async persistence or funding occurs. */
  reserveChangeTarget(
    operationId: string,
    index: number,
    account: string,
  ): void {
    const normalized = account.toLowerCase()
    const existing = this.changeTargets.get(index)
    if (
      existing &&
      existing.operationId === operationId &&
      existing.account === normalized
    )
      return
    if (
      existing ||
      this.all().some(
        coin => coin.account === normalized && coin.changeIndex !== index,
      ) ||
      [...this.changeTargets.values()].some(
        target => target.account === normalized,
      )
    )
      throw new EvmCoinListError(
        'Change destination is already owned or reserved',
      )
    this.changeTargets.set(index, { account: normalized, operationId })
  }

  nextChangeIndex(): number {
    let index = 0
    for (const coin of this.coinsByKey.values())
      if (coin.changeIndex !== undefined)
        index = Math.max(index, coin.changeIndex + 1)
    for (const reserved of this.changeTargets.keys())
      index = Math.max(index, reserved + 1)
    return index
  }

  /** Derived checkpoint only: the journal's complete signed set was committed first. */
  async checkpointTransactionSetReservations(
    operationId: string,
  ): Promise<void> {
    for (const coin of this.heldBy(operationId))
      if (coin.state !== 'spend_pending') await this.persist(coin)
  }

  private readonly transactionSetKeyReferences = new Set<string>()
  settleTransactionSetKeyReference(account: string, nonce: number): void {
    this.transactionSetKeyReferences.delete(coinKey(account, nonce))
  }

  /** Journal owns these signed facts; inventory is their derived reservation view. No I/O. */
  restoreTransactionSetCoin(
    holder: string,
    input: EvmListCoin,
    retainKey = true,
  ): void {
    const key = coinKey(input.account, input.nonce),
      existing = this.coinsByKey.get(key)
    if (retainKey) this.transactionSetKeyReferences.add(key)
    else this.transactionSetKeyReferences.delete(key)
    if (existing?.state === 'spent') return
    if (
      existing?.holder &&
      existing.holder !== holder &&
      existing.state !== 'unspent'
    )
      throw new EvmCoinListError(`Coin ${key} belongs to another operation`)
    this.coinsByKey.set(key, { ...input, holder })
    this.notify()
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
        this.accountSelectable(coin.account) &&
        coin.valueWei > params.feeReserveWei &&
        (coin.spendableFromBlock === undefined ||
          (params.head !== undefined &&
            params.head >= coin.spendableFromBlock)) &&
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
        .sort((a, b) =>
          a.valueWei < b.valueWei ? -1 : a.valueWei > b.valueWei ? 1 : 0,
        )[0]
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
  abandon(
    holder: string,
    coins?: readonly { account: string; nonce: number }[],
  ): void {
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
  ): Promise<void> {
    const key = coinKey(coin.account, coin.nonce)
    const current = this.coinsByKey.get(key)
    if (
      current === undefined ||
      current.holder !== holder ||
      (current.state !== 'spend_pending' &&
        !(current.state === 'pending_receipt' && current.spendingTx === rawTx))
    )
      throw new EvmCoinListError(
        `Coin ${key} is not being built from by ${holder}`,
      )
    const next: EvmListCoin = {
      ...current,
      state: 'pending_receipt',
      spendingTx: rawTx,
    }
    await this.store.put(key, toStored(next))
    this.coinsByKey.set(key, next)
    this.notify()
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
  recordMined(
    coin: { account: string; nonce: number },
    outcome: {
      block: number
      successor?: { valueWei: bigint; spendableFromBlock?: number }
    },
  ): Promise<void> {
    const source = { ...coin },
      evidence = {
        ...outcome,
        ...(outcome.successor ? { successor: { ...outcome.successor } } : {}),
      }
    return this.accountMutation(source.account, () =>
      this.recordMinedAccount(source, evidence),
    )
  }

  private async recordMinedAccount(
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
    const successor: EvmListCoin | undefined =
      outcome.successor !== undefined &&
      outcome.successor.valueWei > 0n &&
      !this.coinsByKey.has(successorKey)
        ? {
            account: current.account,
            nonce: current.nonce + 1,
            privateKey: current.privateKey,
            valueWei: outcome.successor.valueWei,
            origin: current.origin,
            lastSpentInBlock: outcome.block,
            ...(current.changeIndex === undefined
              ? {}
              : { changeIndex: current.changeIndex }),
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
  recordGone(coin: { account: string; nonce: number }): Promise<void> {
    const source = { ...coin }
    return this.accountMutation(source.account, () =>
      this.recordGoneAccount(source),
    )
  }
  private async recordGoneAccount(coin: {
    account: string
    nonce: number
  }): Promise<void> {
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
    if (
      current !== undefined &&
      current.holder !== undefined &&
      current.holder !== holder &&
      current.state !== 'unspent'
    )
      throw new EvmCoinListError(
        `Coin ${key} is held by ${current.holder} and by ${holder}`,
      )
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
        const free: EvmListCoin = { ...rest, state: 'unspent' }
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
      if (
        coin.state === 'pending_receipt' &&
        !referenced(coin.account, coin.nonce)
      ) {
        const { holder: _holder, spendingTx: _tx, ...rest } = coin
        const free: EvmListCoin = { ...rest, state: 'unspent' }
        this.coinsByKey.set(coinKey(coin.account, coin.nonce), free)
        await this.persist(free)
        count++
      }
    if (count > 0) this.notify()
    return count
  }

  /** Drops spent coins older than `beforeBlock` (the background worker's cleanup). */
  async prune(beforeBlock: number): Promise<number> {
    let count = 0
    for (const coin of this.all()) {
      await this.accountMutation(coin.account, async () => {
        const current = this.get(coin.account, coin.nonce)
        if (
          current?.state !== 'spent' ||
          this.incompleteTransactionSetProjections.has(coin.account) ||
          this.transactionSetKeyReferences.has(
            coinKey(coin.account, coin.nonce),
          ) ||
          current.spentInBlock === undefined ||
          current.spentInBlock >= beforeBlock
        )
          return
        await this.recordGoneAccount(coin)
        count++
      })
    }
    return count
  }
}
