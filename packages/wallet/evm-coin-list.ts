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
    ownedCandidates?: readonly EvmListCoin[]
    holder: string
    amountWei: bigint
    feeWei: bigint | ((paymentIndex: number) => bigint)
    head: number
    sourceOrder: readonly EvmCoinListOrigin[]
    maxCoins?: number
    canSelect?: (coin: EvmListCoin) => boolean
    minimumPaymentWei?: bigint
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
    const privateCandidates = (params.ownedCandidates ?? []).filter(coin => {
      const target = coin.changeIndex === undefined ? undefined : this.changeTargets.get(coin.changeIndex)
      if (!target || target.operationId !== params.holder || target.account !== coin.account || coin.holder !== params.holder || !coin.after || coin.nonce !== 0)
        throw new EvmCoinListError('Invalid operation-private source')
      const existing = this.get(coin.account, coin.nonce)
      return !existing || (existing.state === 'unspent' && (!existing.holder || existing.holder === params.holder))
    })
    const privateAccounts = new Set(privateCandidates.map(coin => coin.account))
    const free = [...privateCandidates, ...this.all().filter(
      coin =>
        !privateAccounts.has(coin.account) && coin.state === 'unspent' &&
        this.accountSelectable(coin.account) && rank.has(coin.origin) &&
        (coin.spendableFromBlock === undefined || coin.spendableFromBlock <= params.head) &&
        (params.canSelect?.(coin) ?? coin.after === undefined),
    )]
    free.sort(
      (a, b) =>
        Number(privateAccounts.has(b.account)) - Number(privateAccounts.has(a.account)) ||
        rank.get(a.origin)! - rank.get(b.origin)! ||
        (a.origin === 'change' && b.origin === 'change'
          ? (a.changeIndex ?? Number.MAX_SAFE_INTEGER) -
            (b.changeIndex ?? Number.MAX_SAFE_INTEGER)
          : 0) ||
        (a.valueWei > b.valueWei ? -1 : a.valueWei < b.valueWei ? 1 : 0),
    )
    const minimum = params.minimumPaymentWei ?? 0n
    if (minimum < 0n) throw new EvmCoinListError('Invalid minimum payment')
    if (params.amountWei < minimum) return undefined
    const maxCoins = Math.min(free.length, params.maxCoins ?? free.length,
      minimum > 0n ? Number(params.amountWei / minimum) : free.length)
    const fees = new Map<number, bigint>()
    const capacities = new Map<EvmListCoin, Map<number, bigint>>()
    const capacityAt = (coin: EvmListCoin, paymentIndex: number): bigint => {
      let fee = fees.get(paymentIndex)
      if (fee === undefined) {
        fee = typeof params.feeWei === 'bigint' ? params.feeWei : params.feeWei(paymentIndex)
        if (fee <= 0n) throw new EvmCoinListError('Invalid per-payment fee')
        fees.set(paymentIndex, fee)
      }
      const cached = capacities.get(coin)?.get(paymentIndex)
      if (cached !== undefined) return cached
      const available = coin.valueWei - fee
      const capacity = available < 0n ? -1n : params.capacityWei?.(coin, fee) ?? available
      if (available >= 0n && (capacity < 0n || capacity > available))
        throw new EvmCoinListError('Invalid source capacity')
      const byIndex = capacities.get(coin) ?? new Map<number, bigint>()
      byIndex.set(paymentIndex, capacity)
      capacities.set(coin, byIndex)
      return capacity
    }
    const eligible = (capacity: bigint) => capacity >= minimum &&
      (capacity > 0n || params.amountWei === 0n)
    let remaining = params.amountWei
    const picked: CoinPart[] = [], accounts = new Set<string>()
    for (const coin of free) {
      if (picked.length >= maxCoins) break
      if (accounts.has(coin.account)) continue
      const capacity = capacityAt(coin, picked.length)
      if (!eligible(capacity)) continue
      if (picked.length + 1 === maxCoins && capacity < remaining) continue
      const paymentValueWei = capacity < remaining ? capacity : remaining
      picked.push({ coin, paymentValueWei })
      accounts.add(coin.account)
      remaining -= paymentValueWei
      if (remaining === 0n) break
    }
    if (remaining > 0n && maxCoins > 0) {
      // A preferred small source can consume a part slot needed by a larger source.
      // Suffix feasibility reconsiders that choice without permuting source priority.
      // Each cell uses the recipient index's own fee/capacity, not index zero's quote.
      // One live coin per account is the inventory invariant; never count it twice.
      const unique = new Set<string>()
      const candidates = free.filter(coin => {
        if (unique.has(coin.account)) return false
        unique.add(coin.account)
        return true
      })
      const suffix: bigint[][] = Array.from({ length: candidates.length + 1 },
        () => Array<bigint>(maxCoins + 1).fill(0n))
      for (let offset = candidates.length - 1; offset >= 0; offset--)
        for (let index = maxCoins - 1; index >= 0; index--) {
          const capacity = capacityAt(candidates[offset]!, index)
          const take = eligible(capacity) ? capacity + suffix[offset + 1]![index + 1]! : 0n
          const skip = suffix[offset + 1]![index]!
          suffix[offset]![index] = take > skip ? take : skip
        }
      if (suffix[0]![0]! < params.amountWei) return undefined
      picked.length = 0
      remaining = params.amountWei
      for (const [offset, coin] of candidates.entries()) {
        if (picked.length >= maxCoins || remaining === 0n) break
        const capacity = capacityAt(coin, picked.length)
        if (!eligible(capacity) || capacity + suffix[offset + 1]![picked.length + 1]! < remaining) continue
        const paymentValueWei = capacity < remaining ? capacity : remaining
        picked.push({ coin, paymentValueWei })
        remaining -= paymentValueWei
      }
    }
    if (remaining > 0n || picked.length === 0) return undefined
    // Keep the intended total exact: move a small final tail out of earlier parts.
    // The part-count bound guarantees enough surplus without adding another input.
    const last = picked.at(-1)!
    if (last.paymentValueWei < minimum) {
      let deficit = minimum - last.paymentValueWei
      for (let index = picked.length - 2; index >= 0 && deficit > 0n; index--) {
        const part = picked[index]!, surplus = part.paymentValueWei - minimum
        const moved = surplus < deficit ? surplus : deficit
        picked[index] = { ...part, paymentValueWei: part.paymentValueWei - moved }
        deficit -= moved
      }
      if (deficit > 0n) return undefined
      picked[picked.length - 1] = { ...last, paymentValueWei: minimum }
    }
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

  private readonly transactionSetTails = new Map<string, Promise<void>>()
  private readonly transactionSetBuilds = new Map<
    string,
    Promise<PreparedEvmTransactionSet>
  >()
  runTransactionSetExclusive<T>(operationId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.transactionSetTails.get(operationId) ?? Promise.resolve()
    const result = previous.then(task)
    const tail = result.then(() => undefined, () => undefined)
    this.transactionSetTails.set(operationId, tail)
    void tail.then(() => {
      if (this.transactionSetTails.get(operationId) === tail) this.transactionSetTails.delete(operationId)
    })
    return result
  }

  constructTransactionSetOnce(
    operationId: string,
    build: () => Promise<PreparedEvmTransactionSet>,
    stageId = '',
  ): Promise<PreparedEvmTransactionSet> {
    const key = JSON.stringify([operationId, stageId])
    const pending = this.transactionSetBuilds.get(key)
    if (pending) return pending
    const result = this.runTransactionSetExclusive(operationId, build)
    this.transactionSetBuilds.set(key, result)
    void result
      .finally(() => this.transactionSetBuilds.delete(key))
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

  /** Roll back only this stage's unsigned selection after the journal proves no commit.
   * Restore exact prior entries; virtual inputs without a prior entry disappear. Derivation
   * target ownership remains allocated even when construction did not commit. */
  abandonTransactionSetSources(
    holder: string,
    selected: readonly { account: string; nonce: number }[],
    originals: readonly EvmListCoin[],
  ): void {
    const prior = new Map(originals.map(coin => [coinKey(coin.account, coin.nonce), coin]))
    let changed = false
    for (const source of selected) {
      const key = coinKey(source.account, source.nonce), current = this.coinsByKey.get(key)
      if (current?.holder !== holder || current.state !== 'spend_pending') continue
      const original = prior.get(key)
      if (original) this.coinsByKey.set(key, original)
      else this.coinsByKey.delete(key)
      changed = true
    }
    if (changed) this.notify()
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

  /** A cancelled journal proves these transitions never happened. Restore only external
   * inputs, never signed successors or operation-private destinations. No persistence here:
   * reopen reconstructs this derived view before any caller can select from it. */
  restoreTransactionSetCancellation(holder: string, originals: readonly EvmListCoin[]): void {
    const originalByAccount = new Map(originals.map(coin => [coin.account, coin]))
    const affected = new Set<string>()
    for (const [key, coin] of this.coinsByKey) {
      if (coin.holder !== holder) continue
      affected.add(coin.account)
      this.coinsByKey.delete(key)
      this.transactionSetKeyReferences.delete(key)
    }
    for (const account of affected) {
      const original = originalByAccount.get(account)
      if (!original) continue
      // A later confirmed nonce or another operation is authoritative over old cancellation.
      if (this.all().some(coin => coin.account === account && (coin.holder !== undefined || coin.nonce > original.nonce))) continue
      const { holder: _holder, spendingTx: _tx, after: _after, spentInBlock: _spent, ...source } = original
      this.coinsByKey.set(coinKey(account, original.nonce), { ...source, state: 'unspent' })
    }
    // Keep change allocation high-water ownership; cancelled targets are never reused.
    if (affected.size) this.notify()
  }

  /** Journal cancellation is committed first. Per-account write guards prevent a new
   * selection from racing projection cleanup; interrupted persistence is replayable. */
  async checkpointTransactionSetCancellation(holder: string, originals: readonly EvmListCoin[]): Promise<void> {
    const accounts = new Set([
      ...originals.map(coin => coin.account),
      ...this.store.all().filter(coin => coin.holder === holder).map(coin => coin.account),
    ])
    await Promise.all([...accounts].map(account => this.accountMutation(account, async () => {
      const reference = `cancelled:${holder}`
      try {
        const original = originals.find(coin => coin.account === account)
        const restored = original && this.get(account, original.nonce)
        if (restored?.state === 'unspent' && restored.holder === undefined) await this.persist(restored)
        for (const stored of this.store.all()) {
          if (stored.account !== account || stored.holder !== holder) continue
          const current = this.get(account, stored.nonce)
          if (current && current.holder !== holder) continue
          await this.store.delete(coinKey(account, stored.nonce))
        }
        this.completeTransactionSetProjection(account, reference)
      } catch (error) {
        this.requireTransactionSetProjection(account, reference)
        throw error
      }
    })))
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
        !this.transactionSetKeyReferences.has(coinKey(coin.account, coin.nonce)) &&
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
