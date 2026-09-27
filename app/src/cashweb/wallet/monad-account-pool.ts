/**
 * HD sub-account pool + fan-out funding for Monad (ticket #14).
 *
 * Implements `PLAN.md`'s M5/constraint-3 privacy pool: instead of one hot wallet address
 * accumulating a linkable on-chain history across every stamp/burn, we derive independent
 * `m/44'/60'/0'/0/i` sub-account EOAs (`./monad-hd-keyring.ts`) from a single root secret, fund
 * each one from a main account (`fanOutFundSubAccounts`, below), and hand out each one exactly
 * once (`MonadSubAccountPool.selectForStamp`) — never reusing an address, like a UTXO.
 *
 * **Correction (ticket #34, after #14/#18/#21 shipped):** this pool originally operated over a
 * fixed size fixed once at startup (`ensureSize(N)`), on the (incorrect) assumption that
 * `SubAccountLeaseManager.releaseLease` (#18) would keep cycling accounts back to `'available'`
 * for reuse — see that file's header. Now that a used account is permanently `'spent'`/`'retired'`
 * (never `'available'` again), a fixed-size pool would eventually run out and dead-end every future
 * stamp. Two additions fix that:
 *
 *   - **Indefinite growth**: `nextFreshIndex()`/`topUpPool()` derive indices beyond whatever
 *     `ensureSize()` was first called with, growing the pool for as long as accounts keep getting
 *     spent. `MonadHdKeyring.deriveSubAccount(index)` already supports arbitrary, ever-increasing
 *     indices on demand (it has no fixed range) — nothing there needed to change.
 *   - **Look-ahead funding buffer**: `topUpPool()` tops the pool's count of `'available'`
 *     (funded, unused) records back up to a target buffer size, deriving+funding only the
 *     shortfall. It's exposed as an explicit, separately-callable async method rather than being
 *     invoked automatically from inside `selectForStamp()`, for one concrete reason:
 *     `selectForStamp()` is called synchronously today, from `SubAccountLeaseManager.acquireLease()`
 *     (itself called synchronously by `MonadStampClient.submitStampedMessage`, #13) — funding is
 *     unavoidably async (it submits real transactions via `fanOutFundSubAccounts`), so it can't run
 *     inside that synchronous call chain without restructuring callers this ticket doesn't own.
 *     Instead, production callers are expected to invoke `topUpPool()` periodically (e.g. a
 *     background interval, or opportunistically after each successful lease release) to keep the
 *     buffer replenished ahead of actual demand. If the buffer is ever fully drained before a
 *     top-up lands, `selectForStamp()` simply returns `undefined` (same "no available account"
 *     behavior as before) rather than blocking on a top-up — callers that want to wait already have
 *     `acquireLeaseWhenAvailable` (`monad-account-lease.ts`) for that.
 *
 *     Buffer size is a caller-supplied `bufferSize` (default `DEFAULT_TOPUP_BUFFER_SIZE = 5`,
 *     below). Tradeoff: a bigger buffer means fewer, larger fan-out batches — cheaper in aggregate
 *     (fewer separate top-up transactions' worth of gas overhead) and less exposed to "just missed
 *     the buffer" stalls — but each fan-out batch is itself the correlation point `PLAN.md`
 *     constraint 3 already flags (funding N sub-accounts from one main account in a short window
 *     visibly links them as a same-origin batch on-chain): a bigger buffer means each such reveal
 *     links a bigger batch together at once. A smaller buffer tops up more often with smaller,
 *     less-linking batches, at the cost of more total top-up transactions and a higher chance of
 *     transient exhaustion under bursty demand. `5` is a reasonable, easily-overridden default for
 *     this hackathon's scale — solving the fan-out-as-correlation-point problem itself is an
 *     explicit non-goal (below), not attempted here beyond not making batches gratuitously large.
 *
 * Explicitly out of scope here (ticket #18's job — see that ticket and `PLAN.md`'s M5 nonce-race
 * section): the `'available' -> 'in-use'` lease acquire/release transition itself, and stuck-nonce
 * detection/retirement (`'in-use'`/`'spent'`/`'retired'` transitions). This module only derives
 * accounts, persists their `{ index, address, status }` records, funds them, and picks the next
 * `'available'` one for a caller to use — it never mutates a record's status to `'in-use'`,
 * `'spent'`, or `'retired'` on its own (only `topUpPool()` writes `'available'`, once funding for a
 * freshly-derived index actually succeeds). That keeps the state model (`SubAccountRecord`,
 * `SubAccountPoolStore`) ready for #18's lease logic to build on top of.
 *
 * Also explicitly out of scope, per the ticket's own non-goals and `PLAN.md` constraint 3: solving
 * the fan-out transactions themselves being a correlation point (funding N sub-accounts from one
 * main account is visible on-chain as a fan-out from a single origin) — flagged, not solved, here.
 * Likewise out of scope (ticket #34 non-goal): sweeping/reclaiming any leftover balance sitting on a
 * `'retired'` (failed/stuck) account — not attempted here.
 */
import { Provider } from 'ethers'

import { MonadHdKeyring } from './monad-hd-keyring'
import {
  MonadAccountTxSigner,
  MonadTxOverrides,
  MonadTxSubmitter,
  SignedMonadTx,
} from './monad-account-tx'
import {
  InMemorySubAccountPoolStore,
  SubAccountPoolStore,
  SubAccountRecord,
  SubAccountStatus,
} from './storage/sub-account-pool-storage'

export type {
  SubAccountPoolStore,
  SubAccountRecord,
  SubAccountStatus,
} from './storage/sub-account-pool-storage'

/** Default target number of pre-funded, unused (`'available'`) sub-accounts `topUpPool()` tries to
 * maintain ahead of demand when the caller doesn't specify its own `bufferSize` — see this file's
 * header ("Look-ahead funding buffer") for the tradeoff this default balances. */
export const DEFAULT_TOPUP_BUFFER_SIZE = 5

/**
 * Tracks an ever-growing pool of HD-derived sub-accounts, persisted via a `SubAccountPoolStore` so
 * the pool (its records and each account's status) survives app restarts. Private keys are never
 * held or persisted by the pool itself — `getSigner()` re-derives one on demand from the keyring.
 */
export class MonadSubAccountPool {
  private readonly keyring: MonadHdKeyring
  private readonly store: SubAccountPoolStore
  /** Absolute sub-account index most recently returned by `selectForStamp()` (or `-1` before the
   * first call), so rotation resumes from where it left off rather than restarting at 0 — see
   * `selectForStamp()`. Intentionally in-memory only/not persisted: losing rotation position
   * across a restart just means the round-robin order restarts, which affects fairness, not
   * correctness (an account is never selected while unavailable). */
  private lastSelectedIndex = -1

  constructor(params: {
    keyring: MonadHdKeyring
    store?: SubAccountPoolStore
  }) {
    this.keyring = params.keyring
    this.store = params.store ?? new InMemorySubAccountPoolStore()
  }

  /**
   * Ensures the pool has at least `size` derived sub-accounts recorded in the store, deriving
   * (from the keyring, deterministically) and persisting any missing ones as `'available'`.
   * Idempotent and safe to call on every app start with a fixed desired pool size — existing
   * records, and whatever status ticket #18's lease logic has since put them in, are left
   * untouched. Returns every record currently in the pool (not just the newly-added ones).
   */
  ensureSize(size: number): SubAccountRecord[] {
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`Pool size must be a non-negative integer, got ${size}`)
    }
    for (let index = 0; index < size; index++) {
      if (this.store.getByIndex(index) === undefined) {
        const derived = this.keyring.deriveSubAccount(index)
        this.store.put({
          index: derived.index,
          address: derived.address,
          status: 'available',
        })
      }
    }
    return this.store.getAll()
  }

  /** All sub-account records currently tracked by the pool, sorted by index. */
  records(): SubAccountRecord[] {
    return this.store.getAll()
  }

  getRecord(index: number): SubAccountRecord | undefined {
    return this.store.getByIndex(index)
  }

  /** Directly persists a status transition for sub-account `index` — the mechanism ticket #18's
   * lease/stuck-nonce logic is expected to call (`'available' -> 'in-use'`, then `-> 'spent'` or
   * `-> 'retired'`, both terminal — see `monad-account-lease.ts`). This ticket does not call it
   * itself (except from `topUpPool()`, to mark a freshly-funded index `'available'`); it exists so
   * #18 has a slot to write through without needing to touch the storage layer directly. Throws if
   * `index` isn't a known sub-account. */
  setStatus(index: number, status: SubAccountStatus): SubAccountRecord {
    const existing = this.store.getByIndex(index)
    if (existing === undefined) {
      throw new Error(`No sub-account at index ${index} in the pool`)
    }
    const updated: SubAccountRecord = { ...existing, status }
    this.store.put(updated)
    return updated
  }

  /** Re-derives the private key for sub-account `index` (deterministically, from the keyring —
   * never read from or written to the store) and wraps it in a `MonadAccountTxSigner` (#11) ready
   * to build/sign/submit/track transactions for it. Throws if `index` isn't a known sub-account,
   * to catch accidentally signing for an index the pool was never sized to include. */
  getSigner(
    index: number,
    params: { provider: Provider; httpClient: MonadTxSubmitter },
  ): MonadAccountTxSigner {
    if (this.store.getByIndex(index) === undefined) {
      throw new Error(`No sub-account at index ${index} in the pool`)
    }
    const derived = this.keyring.deriveSubAccount(index)
    return new MonadAccountTxSigner({
      privateKey: derived.privateKey,
      provider: params.provider,
      httpClient: params.httpClient,
    })
  }

  /**
   * Per-stamp account selection (ticket #14 acceptance criterion): round-robins over sub-accounts
   * currently `'available'`, skipping `'in-use'`, `'spent'`, and `'retired'` ones, and returns the
   * next one — without mutating its status. (The `'available' -> 'in-use'` transition is ticket
   * #18's lease acquire step, called separately, typically right after this.) Returns `undefined`
   * if no sub-account is currently available.
   *
   * Rotation resumes after the last-returned index (wrapping around), rather than filtering to
   * `'available'` records first and indexing into that shrinking/growing list — so the rotation
   * order stays stable as accounts move in and out of `'available'` between calls. Since ticket
   * #34, `'available'` accounts are consumed exactly once (never cycle back — see
   * `monad-account-lease.ts`), so this "round-robin" is really just "pick whichever currently-funded
   * account is next in line"; the pool is kept from running dry by `topUpPool()` (see this file's
   * header) rather than by anything selection itself does.
   */
  selectForStamp(): SubAccountRecord | undefined {
    const all = this.store.getAll()
    if (all.length === 0) return undefined
    for (let step = 1; step <= all.length; step++) {
      const candidatePosition =
        (((this.lastSelectedIndex + step) % all.length) + all.length) %
        all.length
      const candidate = all[candidatePosition]
      if (candidate.status === 'available') {
        this.lastSelectedIndex = candidatePosition
        return candidate
      }
    }
    return undefined
  }

  /**
   * Convenience wrapper around `fanOutFundSubAccounts` that funds every pool record matching
   * `statuses` (defaults to just `'available'`) from `mainAccountSigner`. See that function for
   * the funding semantics (burn value / gas reserve kept separate).
   */
  async fundAll(params: {
    mainAccountSigner: MonadAccountTxSigner
    burnValue: bigint
    gasReserve: bigint
    overrides?: MonadTxOverrides
    statuses?: SubAccountStatus[]
  }): Promise<FanOutFundingResult[]> {
    const statuses = params.statuses ?? ['available']
    const targets = this.store
      .getAll()
      .filter(record => statuses.includes(record.status))
    return fanOutFundSubAccounts({
      mainAccountSigner: params.mainAccountSigner,
      targets,
      burnValue: params.burnValue,
      gasReserve: params.gasReserve,
      overrides: params.overrides,
    })
  }

  /** The next sub-account index that has never been derived/persisted into this pool yet — i.e.
   * one past the highest index currently in the store, or `0` for an empty pool. Ticket #34's
   * growth mechanism (`topUpPool`) derives from here rather than from any fixed `ensureSize()`
   * bound, so the pool can keep extending indefinitely as accounts get spent. */
  private nextFreshIndex(): number {
    const all = this.store.getAll()
    if (all.length === 0) return 0
    return Math.max(...all.map(record => record.index)) + 1
  }

  /**
   * Look-ahead funding top-up (ticket #34 acceptance criterion): tops the pool's count of
   * currently-`'available'` (funded, unused) sub-accounts back up to `bufferSize` (default
   * `DEFAULT_TOPUP_BUFFER_SIZE`), deriving and funding only the shortfall — fresh indices, one past
   * whatever the pool's highest known index is (`nextFreshIndex()`), never indices already handed
   * out. See this file's header ("Look-ahead funding buffer") for why this is a separate,
   * explicitly-invoked async method rather than something `selectForStamp()` triggers itself.
   *
   * A freshly-derived index is only persisted into the store (as `'available'`) once its funding
   * transaction has actually been submitted — via `fanOutFundSubAccounts`'s `onFunded` hook, called
   * per-target as soon as that target's send succeeds, not batched at the end. That matters for
   * partial-failure recovery: if `fanOutFundSubAccounts` throws partway through this call (e.g. the
   * N-th of M targets' submit fails), every target funded *before* the throw is already durably
   * recorded as `'available'`, and the next `topUpPool()` call's `nextFreshIndex()` correctly
   * resumes after them rather than re-deriving (and re-funding) the same indices. The error still
   * propagates to this call's caller so the shortfall/failure is visible, rather than being
   * silently swallowed.
   *
   * Returns the funding results for whatever was actually topped up (empty if the buffer was
   * already full).
   */
  async topUpPool(params: {
    mainAccountSigner: MonadAccountTxSigner
    burnValue: bigint
    gasReserve: bigint
    bufferSize?: number
    overrides?: MonadTxOverrides
  }): Promise<FanOutFundingResult[]> {
    const bufferSize = params.bufferSize ?? DEFAULT_TOPUP_BUFFER_SIZE
    if (!Number.isInteger(bufferSize) || bufferSize < 0) {
      throw new Error(
        `bufferSize must be a non-negative integer, got ${bufferSize}`,
      )
    }
    const currentlyAvailable = this.store
      .getAll()
      .filter(record => record.status === 'available').length
    const deficit = bufferSize - currentlyAvailable
    if (deficit <= 0) return []

    const startIndex = this.nextFreshIndex()
    const targets = Array.from({ length: deficit }, (_, offset) => {
      const index = startIndex + offset
      const derived = this.keyring.deriveSubAccount(index)
      return { index, address: derived.address }
    })

    return fanOutFundSubAccounts({
      mainAccountSigner: params.mainAccountSigner,
      targets,
      burnValue: params.burnValue,
      gasReserve: params.gasReserve,
      overrides: params.overrides,
      onFunded: result => {
        this.store.put({
          index: result.index,
          address: result.address,
          status: 'available',
        })
      },
    })
  }
}

/** Result of funding one sub-account via `fanOutFundSubAccounts`. */
export interface FanOutFundingResult {
  index: number
  address: string
  /** `burnValue + gasReserve` for this sub-account. The two figures are combined only here, at the
   * point where `MonadAccountTxSigner.buildAndSignTransfer`'s single `value` parameter requires
   * one number — everywhere else in this module and its callers, `burnValue` and `gasReserve`
   * travel as two separate, explicit parameters (ticket #14's acceptance criterion). */
  fundedValue: bigint
  signedTx: SignedMonadTx
  txHash: string
}

/**
 * Fan-out funding routine (ticket #14 acceptance criterion): given a main funded account's
 * `MonadAccountTxSigner` (#11) and a list of target sub-accounts, sends `burnValue + gasReserve`
 * to each one as a plain native-value transfer. `burnValue` and `gasReserve` are always taken as
 * two separate, explicit parameters — never pre-combined by a caller into one opaque "amount" —
 * so this is the one place, right before the single `value` the underlying tx construction API
 * takes, where they're added together.
 *
 * Sequenced deliberately: each target is fully built, signed, *and submitted* before moving on to
 * the next, rather than building/submitting all N concurrently. `MonadAccountTxSigner` fetches a
 * fresh nonce from the chain (`eth_getTransactionCount(mainAccount, "pending")`) on every build
 * call with no local caching or reuse (see `monad-account-tx.ts`) — firing all N transfers from
 * the same main account concurrently would race every one of them for the same "next" nonce.
 * Awaiting each submit before building the next lets the node's pending-nonce view advance
 * normally between sends. (A future caller wanting throughput could pass explicit, pre-planned
 * `overrides.nonce` values per target and parallelize — out of scope here.)
 *
 * `onFunded`, if given, is invoked synchronously right after each individual target's send
 * succeeds (not batched at the end) — added for ticket #34's `MonadSubAccountPool.topUpPool()`, so
 * it can durably persist each freshly-funded index as `'available'` incrementally, rather than
 * losing already-funded targets' bookkeeping if a later target in the same batch throws.
 */
export async function fanOutFundSubAccounts(params: {
  mainAccountSigner: MonadAccountTxSigner
  targets: Array<Pick<SubAccountRecord, 'index' | 'address'>>
  burnValue: bigint
  gasReserve: bigint
  overrides?: MonadTxOverrides
  onFunded?: (result: FanOutFundingResult) => void
}): Promise<FanOutFundingResult[]> {
  // `BigInt(0)` rather than a `0n` literal: this app's tsconfig targets ES2017, which doesn't
  // support BigInt literal syntax (only the `bigint` type/`BigInt(...)` calls) — the same
  // constraint `monad-account-tx.ts` (#11) works under; see this file's header precedent.
  const zero = BigInt(0)
  if (params.burnValue < zero) {
    throw new Error(`burnValue must be >= 0, got ${params.burnValue}`)
  }
  if (params.gasReserve < zero) {
    throw new Error(`gasReserve must be >= 0, got ${params.gasReserve}`)
  }

  const results: FanOutFundingResult[] = []
  for (const target of params.targets) {
    const fundedValue = params.burnValue + params.gasReserve
    const signedTx = await params.mainAccountSigner.buildAndSignTransfer(
      target.address,
      fundedValue,
      params.overrides,
    )
    const txHash = await params.mainAccountSigner.submit(signedTx)
    const result: FanOutFundingResult = {
      index: target.index,
      address: target.address,
      fundedValue,
      signedTx,
      txHash,
    }
    results.push(result)
    params.onFunded?.(result)
  }
  return results
}
