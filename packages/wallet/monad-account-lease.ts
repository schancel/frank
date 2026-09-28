/**
 * Per-sub-account in-flight lease + stuck-nonce recovery for Monad (ticket #18).
 *
 * `MonadAccountTxSigner` (#11) fetches a fresh nonce from the chain on every build call with no
 * local caching — by design (see that module's header). That means two concurrent transactions
 * signed for the *same* sub-account will race for the same "next" nonce: one queues behind the
 * other, or double-spends it outright if both get built from the same pending-nonce snapshot.
 * `MonadSubAccountPool` (#14) derives/persists a pool of sub-accounts and exposes
 * `{ index, address, status: 'available' | 'in-use' | 'spent' | 'retired' }` records plus a
 * `setStatus` write hook and a read-only `selectForStamp` picker — but, per #14's own header,
 * deliberately never mutates status itself. This module is that missing mutation layer:
 *
 *   - `acquireLease` / `acquireForIndex`: `'available' -> 'in-use'`, handed out as an opaque
 *     `AccountLeaseHandle` representing exclusive ownership of that sub-account for exactly one
 *     in-flight (unconfirmed) transaction. Attempting to acquire an already-`'in-use'`,
 *     `'spent'`, or `'retired'` account throws `SubAccountAlreadyLeasedError` rather than silently
 *     proceeding.
 *   - `releaseLease`: on the tx's `'confirmed'` outcome, `'in-use' -> 'spent'`. On `'failed'` or
 *     `'stuck'` (never confirmed within a timeout), `'in-use' -> 'retired'`. **Neither outcome ever
 *     returns the account to `'available'`** — both are terminal, and both are equally excluded
 *     from `MonadSubAccountPool.selectForStamp()` forever (see that module's own header). A
 *     stuck/failed account is additionally never silently reused with a guessed next nonce, per
 *     `PLAN.md` M5's explicit non-goal of fee-bumping/nonce-guessing recovery. `'spent'` vs.
 *     `'retired'` is purely a bookkeeping distinction (did the tx actually confirm and consume the
 *     account's funds, or did it fail/get abandoned, possibly leaving a balance to reclaim later) —
 *     functionally, for selection purposes, they're identical.
 *
 *     **Correction (ticket #34, after #14/#18/#21 shipped):** this module originally mapped
 *     `'confirmed'` back to `'available'`, treating the pool as a small, cyclically-reused set of
 *     addresses. That defeated Stamp's UTXO-style unlinkability goal (`PLAN.md` constraint 3): reuse
 *     accumulates a linkable on-chain history per address, the opposite of the "spend it once, like
 *     a UTXO" property Stamp relies on. `MonadSubAccountPool` (see that file) now continuously
 *     derives and pre-funds fresh indices so a used-up pool never needs to fall back to reuse.
 *   - `awaitLeaseSettlement`: polls a tx-status source (anything shaped like
 *     `MonadAccountTxSigner.getStatus`, #11) until it reports `'confirmed'`/`'failed'`, or until a
 *     configurable timeout elapses (treated as `'stuck'`), then calls `releaseLease` with the
 *     resulting outcome. This is the "how do we detect stuck" mechanism the ticket asks for.
 *
 * Ownership/scope note: this file only ever calls `pool.selectForStamp()`, `pool.getRecord()`, and
 * `pool.setStatus()` — all public API `monad-account-pool.ts` already exposes for this purpose. It
 * does not modify that file's public shape, `monad-account-tx.ts`, or `monad-http.ts`.
 *
 * Non-goals (per the ticket): no automatic unsticking / fee-bump / replace-by-fee resubmission —
 * retirement is the only recovery path here. No Stamp or POP logic — this is pure wallet-pool
 * plumbing for #13 (Stamp client-side) and #5 (POP client-side) to build on. Sweeping/reclaiming any
 * leftover balance on a `'retired'` account is also not implemented here (ticket #34 non-goal) —
 * flagged, not solved.
 */
import { MonadSubAccountPool } from './monad-account-pool'
import {
  SubAccountRecord,
  SubAccountStatus,
} from './storage/sub-account-pool-storage'
import { MonadTxStatus } from './monad-account-tx'

/** Base class for every error this module throws, so callers can `catch (e) { if (e instanceof
 * AccountLeaseError) ... }` to distinguish lease-management failures from unrelated errors. */
export class AccountLeaseError extends Error {}

/** Thrown by `acquireLease()` when no sub-account in the pool is currently `'available'`. Per this
 * module's "reject, don't silently wait" default: callers that want to wait for one to free up
 * should use `acquireLeaseWhenAvailable` instead, which polls until either a lease is granted or
 * its own timeout elapses (re-throwing this same error type on timeout). */
export class NoAvailableSubAccountError extends AccountLeaseError {}

/** Thrown by `acquireForIndex()` (and therefore `acquireLease()`) when the target sub-account is
 * not currently `'available'` — i.e. it's already leased (`'in-use'`) or has been `'retired'`. */
export class SubAccountAlreadyLeasedError extends AccountLeaseError {}

/** Thrown by `releaseLease()` when given a handle that this manager instance did not issue, or
 * already released — guards against double-release double-mutating pool state. */
export class InvalidLeaseHandleError extends AccountLeaseError {}

/** Opaque proof of exclusive ownership over one sub-account for one in-flight transaction, handed
 * out by `SubAccountLeaseManager.acquireLease`/`acquireForIndex` and consumed by
 * `releaseLease`/`awaitLeaseSettlement`. Callers should treat this as an opaque token — pass it
 * back unmodified — rather than relying on its shape, though `index`/`address` are exposed
 * read-only since callers need them to actually build/sign the transaction (e.g. via
 * `pool.getSigner(handle.index, ...)`). */
export interface AccountLeaseHandle {
  readonly index: number
  readonly address: string
}

/** How a leased, in-flight transaction was ultimately settled — the input to `releaseLease`. Every
 * outcome is terminal: `'confirmed'` marks the account `'spent'`; `'failed'` (a reverted/failed
 * receipt) and `'stuck'` (never confirmed within the configured timeout) both mark it `'retired'`.
 * None of the three ever returns the account to `'available'` (see this file's header, "Correction
 * (ticket #34)") — `'failed'`/`'stuck'` additionally satisfy the ticket's "never guess the next
 * nonce" requirement by not silently reusing a possibly-desynced nonce. */
export type LeaseOutcome = 'confirmed' | 'failed' | 'stuck'

/** Structural subset of `MonadAccountTxSigner` (#11) that `awaitLeaseSettlement` needs — expressed
 * as an interface (rather than importing the class type) so tests can supply a plain mock, the
 * same pattern `monad-account-tx.ts`'s own `MonadTxSubmitter` uses. The real
 * `MonadAccountTxSigner.getStatus` already satisfies this shape. */
export interface LeaseTxStatusSource {
  getStatus(txHash: string): Promise<MonadTxStatus>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Enforces at most one live lease (one in-flight, unconfirmed tx) per sub-account in a given
 * `MonadSubAccountPool`, on top of that pool's `'available'`/`'in-use'`/`'retired'` status field.
 *
 * Intended usage is one `SubAccountLeaseManager` instance per pool, held for the app's lifetime
 * (mirroring the pool itself) and shared by every caller that leases accounts from that pool —
 * e.g. Stamp-over-Monad (#6) and the POP client (#5). Sharing one instance matters: the in-memory
 * "which handles are currently live" bookkeeping this class keeps (used to reject a stale/already-
 * released handle passed back to `releaseLease`) is per-instance, not persisted. The underlying
 * *contention* guard (an already-`'in-use'` account can't be re-acquired) is enforced against the
 * pool's own persisted `status` field regardless, so it holds even across multiple manager
 * instances or process restarts — only the stale-handle guard is instance-local.
 */
export class SubAccountLeaseManager {
  private readonly pool: MonadSubAccountPool
  private readonly liveLeases = new Map<number, AccountLeaseHandle>()

  constructor(pool: MonadSubAccountPool) {
    this.pool = pool
  }

  /** True if sub-account `index` currently has a live lease issued by *this* manager instance. */
  isLeased(index: number): boolean {
    return this.liveLeases.has(index)
  }

  /** Every sub-account index currently leased through this manager instance. */
  leasedIndices(): number[] {
    return Array.from(this.liveLeases.keys()).sort((a, b) => a - b)
  }

  /** Waits until lease-driven pool status transitions are durable. */
  async flush(): Promise<void> {
    await this.pool.flush()
  }

  /**
   * Picks the next `'available'` sub-account via `pool.selectForStamp()` and leases it (see
   * `acquireForIndex`). Throws `NoAvailableSubAccountError` immediately if none is available —
   * this method never waits. Use `acquireLeaseWhenAvailable` for wait-and-retry semantics.
   */
  acquireLease(): AccountLeaseHandle {
    const selected = this.pool.selectForStamp()
    if (selected === undefined) {
      throw new NoAvailableSubAccountError('No available sub-account to lease')
    }
    return this.acquireForIndex(selected.index)
  }

  /**
   * Leases a specific sub-account by index. Throws `SubAccountAlreadyLeasedError` if it isn't
   * currently `'available'` (already `'in-use'` — i.e. someone else holds an unresolved lease on
   * it — or `'retired'`). Synchronous end-to-end (the `'available'` check and the `'in-use'`
   * write happen with no `await` between them), so two same-tick calls targeting the same index
   * can't both observe `'available'` and both "win" — the second always sees the first's write.
   */
  acquireForIndex(index: number): AccountLeaseHandle {
    const record = this.pool.getRecord(index)
    if (record === undefined) {
      throw new Error(`No sub-account at index ${index} in the pool`)
    }
    if (record.status !== 'available') {
      throw new SubAccountAlreadyLeasedError(
        `Sub-account ${index} is not available for lease (status: ${record.status})`,
      )
    }
    this.pool.setStatus(index, 'in-use')
    const handle: AccountLeaseHandle = { index, address: record.address }
    this.liveLeases.set(index, handle)
    return handle
  }

  /**
   * Releases a lease previously granted by this manager, transitioning the sub-account per
   * `outcome`: `'confirmed'` -> `'spent'`; `'failed'`/`'stuck'` -> `'retired'`. Both destinations
   * are terminal — excluded from `pool.selectForStamp()` forever, never `'available'` again (see
   * this file's header, "Correction (ticket #34)": a used sub-account, whether its transaction
   * succeeded or not, is never reused — that's the whole point of modeling it like a UTXO).
   *
   * Throws `InvalidLeaseHandleError` if `handle` was not issued by this manager instance or has
   * already been released — this method is not idempotent by design, to catch double-release
   * bugs (e.g. calling it from both a success callback and a timeout path for the same tx).
   */
  releaseLease(
    handle: AccountLeaseHandle,
    outcome: LeaseOutcome,
  ): SubAccountRecord {
    const live = this.liveLeases.get(handle.index)
    if (live === undefined || live !== handle) {
      throw new InvalidLeaseHandleError(
        `No live lease for sub-account ${handle.index} on this manager (already released, or not issued by it)`,
      )
    }
    this.liveLeases.delete(handle.index)
    const nextStatus: SubAccountStatus =
      outcome === 'confirmed' ? 'spent' : 'retired'
    return this.pool.setStatus(handle.index, nextStatus)
  }
}

/** Options for `acquireLeaseWhenAvailable`. */
export interface AcquireLeaseWhenAvailableOptions {
  /** Delay between retries, in ms. Default 250. */
  pollIntervalMs?: number
  /** Total time budget to wait for an account to free up, in ms, before giving up and throwing
   * `NoAvailableSubAccountError`. Default 30_000 (30s). */
  timeoutMs?: number
  /** Injectable in place of the real `setTimeout`-based delay, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable in place of `Date.now`, for deterministic tests. */
  now?: () => number
}

/**
 * Wait-and-retry counterpart to `SubAccountLeaseManager.acquireLease()`: retries on
 * `NoAvailableSubAccountError` every `pollIntervalMs` until either a lease is granted or
 * `timeoutMs` elapses, at which point it re-throws `NoAvailableSubAccountError`. Any other error
 * from `acquireLease()` (there currently is none, but future-proofing) propagates immediately.
 *
 * This is the "wait" half of the ticket's "reject/wait if no available accounts exist" choice —
 * `SubAccountLeaseManager.acquireLease()` itself always rejects immediately; callers that would
 * rather block until capacity frees up (e.g. a background sender with no user waiting
 * synchronously) opt into that behavior explicitly by calling this function instead.
 */
export async function acquireLeaseWhenAvailable(
  manager: SubAccountLeaseManager,
  options: AcquireLeaseWhenAvailableOptions = {},
): Promise<AccountLeaseHandle> {
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const timeoutMs = options.timeoutMs ?? 30_000
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const deadline = now() + timeoutMs

  for (;;) {
    try {
      return manager.acquireLease()
    } catch (err) {
      if (!(err instanceof NoAvailableSubAccountError)) throw err
      if (now() >= deadline) throw err
      await sleep(pollIntervalMs)
    }
  }
}

/** Options/params for `awaitLeaseSettlement`. */
export interface AwaitLeaseSettlementParams {
  manager: SubAccountLeaseManager
  handle: AccountLeaseHandle
  /** Hash of the transaction that was submitted using `handle`'s sub-account. */
  txHash: string
  /** Anything exposing `getStatus(txHash)` the way `MonadAccountTxSigner` (#11) does — pass the
   * signer used to build/submit the leased tx. */
  statusSource: LeaseTxStatusSource
  /** Delay between status polls, in ms. Default 1000. */
  pollIntervalMs?: number
  /** How long to keep polling a `'pending'` status before treating it as `'stuck'` and retiring
   * the account, in ms. Default 60_000 (60s). */
  timeoutMs?: number
  /** Injectable in place of the real `setTimeout`-based delay, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable in place of `Date.now`, for deterministic tests. */
  now?: () => number
}

/** Result of `awaitLeaseSettlement`: the terminal outcome plus the sub-account record as it stands
 * immediately after the resulting `releaseLease` call. */
export interface LeaseSettlementResult {
  outcome: LeaseOutcome
  record: SubAccountRecord
}

/**
 * Polls `statusSource.getStatus(txHash)` until it settles, then releases the lease accordingly —
 * this is the ticket's stuck-nonce *detection* mechanism, built on top of #11's `getStatus`
 * (`'pending' | 'confirmed' | 'failed'`, itself backed by `MonadHttpClient.getTransactionReceipt`):
 *
 *   - `'confirmed'` -> `releaseLease(handle, 'confirmed')` (account becomes `'spent'` — terminal,
 *     never reused).
 *   - `'failed'` (reverted receipt) -> `releaseLease(handle, 'failed')` (account `'retired'`).
 *   - still `'pending'` once `timeoutMs` has elapsed since this call started -> treated as
 *     `'stuck'` -> `releaseLease(handle, 'stuck')` (account `'retired'`).
 *
 * Per the ticket's explicit non-goal, there is no fee-bump/replace-by-tx recovery attempted for
 * the `'stuck'` case — retirement is the only recovery path this module implements.
 */
export async function awaitLeaseSettlement(
  params: AwaitLeaseSettlementParams,
): Promise<LeaseSettlementResult> {
  const pollIntervalMs = params.pollIntervalMs ?? 1000
  const timeoutMs = params.timeoutMs ?? 60_000
  const sleep = params.sleep ?? defaultSleep
  const now = params.now ?? Date.now
  const deadline = now() + timeoutMs

  for (;;) {
    const status = await params.statusSource.getStatus(params.txHash)
    if (status === 'confirmed') {
      return {
        outcome: 'confirmed',
        record: params.manager.releaseLease(params.handle, 'confirmed'),
      }
    }
    if (status === 'failed') {
      return {
        outcome: 'failed',
        record: params.manager.releaseLease(params.handle, 'failed'),
      }
    }
    // status === 'pending'
    if (now() >= deadline) {
      return {
        outcome: 'stuck',
        record: params.manager.releaseLease(params.handle, 'stuck'),
      }
    }
    await sleep(pollIntervalMs)
  }
}
