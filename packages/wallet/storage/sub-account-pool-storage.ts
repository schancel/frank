/**
 * Storage interface for the Monad HD sub-account pool (ticket #14), following the pattern of the
 * existing `UtxoStore` (`./storage.ts`) — a small persistence boundary the pool depends on so its
 * state survives app restarts, with a concrete `level`-backed implementation
 * (`./level-sub-account-pool-store.ts`) mirroring `LevelUtxoStore`.
 *
 * This is deliberately a *new*, separate interface from `UtxoStore` (per ticket #14's acceptance
 * criteria) rather than a reuse of it — the two stores persist unrelated shapes (UTXO
 * outpoints/values vs. sub-account index/address/status) and have no reason to share a contract.
 *
 * What's persisted, and what isn't: only `SubAccountRecord` (`index`, `address`, `status`) is ever
 * written here. Private keys are never persisted by this store or anything in
 * `monad-account-pool.ts` — they're cheaply and deterministically re-derived from the root secret
 * + index on demand via `MonadHdKeyring` (see that file's header). This keeps the on-disk pool
 * state safe to inspect/back up without it also being a wallet-draining secret.
 */

/**
 * A sub-account's lifecycle state within the pool.
 *   - `'unfunded'`: derived and persisted, but not yet funded or eligible for selection.
 *   - `'funding'`: an exact main-account funding transaction is durably recorded and awaiting a
 *     successful receipt. `fundingAttempt` is required in this state.
 *   - `'available'`: idle, receipt-confirmed, never-before-used, and eligible for a new stamp
 *     payment or broadcast transaction.
 *   - `'in-use'`: currently leased for an in-flight (unconfirmed) transaction. This ticket never
 *     transitions an account *into* this state — that's ticket #18's lease acquire/release logic.
 *     The field exists now purely as the hook #18 needs.
 *   - `'spent'`: the account's one-and-only transaction confirmed successfully. Terminal, like
 *     `'retired'` below — excluded from `selectForStamp()`/future selection forever — but recorded
 *     under a distinct name for bookkeeping/observability: unlike `'retired'`, a `'spent'` account's
 *     funds (minus the payment or broadcast value and gas) were deliberately consumed, not
 *     abandoned mid-flight. **Correction (ticket #34, after #14/#18/#21 shipped):** the original
 *     model routed a successful (`'confirmed'`) outcome back to `'available'` for reuse — that
 *     defeated Stamp's UTXO-style unlinkability goal (`PLAN.md` constraint 3) by letting a small
 *     fixed pool of addresses accumulate a linkable history across many messages. `'spent'` is the
 *     status that closes that hole: every used sub-account, success or failure, is now permanently
 *     excluded from reuse — see `monad-account-lease.ts`'s `releaseLease`.
 *   - `'retired'`: the account's transaction failed or got stuck (never confirmed within a
 *     timeout) — permanently skipped for future selection, same as `'spent'`, but distinguished
 *     because a `'retired'` account may still hold its funded balance un-spent (sweeping/reclaiming
 *     that leftover balance is a separate, currently-unimplemented sub-problem — see
 *     `monad-account-pool.ts`'s header for why it's out of scope here).
 */
export type SubAccountStatus =
  | 'unfunded'
  | 'funding'
  | 'available'
  | 'in-use'
  | 'spent'
  | 'retired'

export interface SubAccountFundingAttempt {
  /** Exact signed transaction retained so a restart retries the same nonce and transfer. */
  rawTx: string
  txHash: string
}

export interface SubAccountTransactionCheckpoint {
  rawTx: string
  txHash: string
  valueWei: string
}

export type SubAccountRecoveryDisposition =
  | {
      kind: 'change'
      changeIndex: number
      address: string
      txHash: string
      valueWei: string
    }
  | { kind: 'dust'; valueWei: string; thresholdWei: string }
  | { kind: 'none'; valueWei: '0' }

export interface SubAccountLifecycle {
  funding?: SubAccountTransactionCheckpoint
  spend?: SubAccountTransactionCheckpoint
  recovery?: SubAccountRecoveryDisposition
}

/** Durable replacement for a compacted terminal account row. It deliberately retains the
 * transactions and residual disposition needed to audit/recover the account without retaining
 * the mutable pool row forever. */
export interface TerminalSubAccountCheckpoint {
  version: 1
  index: number
  address: string
  status: 'spent' | 'retired'
  /** Selected payment denomination, separate from funding gas headroom. */
  denominationWei: string
  lifecycle: Required<
    Pick<SubAccountLifecycle, 'funding' | 'spend' | 'recovery'>
  >
  compactedAt: number
}

/** Persisted state for one HD-derived sub-account. Never carries a private key — see file header.
 */
interface SubAccountRecordBase {
  /** BIP-44 index (`m/44'/60'/0'/0/{index}`); the durable identity of this sub-account. */
  index: number
  address: string
  lifecycle?: SubAccountLifecycle
}

/** `fundingAttempt` is required exactly while funding, so persisted code cannot create a funding
 * state with no exact transaction to resume. The additive fields keep existing Level rows valid. */
export type SubAccountRecord = SubAccountRecordBase &
  (
    | { status: 'funding'; fundingAttempt: SubAccountFundingAttempt }
    | {
        status: Exclude<SubAccountStatus, 'funding'>
        fundingAttempt?: undefined
      }
  )

/** Shared structural lifecycle boundary for loaded and live sub-account state. */
export function assertSubAccountLifecycleMatrix(
  record: SubAccountRecord
): void {
  const { funding, spend, recovery } = record.lifecycle ?? {}
  if (
    ((record.status === 'unfunded' || record.status === 'funding') &&
      (funding !== undefined ||
        spend !== undefined ||
        recovery !== undefined)) ||
    (record.status === 'available' &&
      (spend !== undefined || recovery !== undefined)) ||
    (record.status === 'in-use' && recovery !== undefined) ||
    (record.status === 'spent' && spend === undefined) ||
    (recovery !== undefined && spend === undefined)
  ) {
    throw new Error(
      `Sub-account ${record.index} status/lifecycle combination is invalid`
    )
  }
}

export function assertSubAccountStatusTransition(
  prior: SubAccountStatus,
  next: SubAccountStatus
): void {
  if (prior === next) return
  const allowed: Record<SubAccountStatus, readonly SubAccountStatus[]> = {
    unfunded: ['funding'],
    funding: ['available', 'retired'],
    available: ['in-use', 'retired'],
    'in-use': ['spent', 'retired'],
    spent: [],
    retired: [],
  }
  if (!allowed[prior].includes(next)) {
    throw new Error(`Sub-account lifecycle cannot move ${prior} -> ${next}`)
  }
}

/**
 * Persistence boundary for `MonadSubAccountPool`'s state. Concrete implementations: an in-memory
 * one (`InMemorySubAccountPoolStore`, below — used in tests and as a lightweight default) and a
 * `level`-backed one (`LevelSubAccountPoolStore`, in `./level-sub-account-pool-store.ts`) for real
 * persistence across app restarts, mirroring `UtxoStore`/`LevelUtxoStore`.
 */
export interface SubAccountPoolStore {
  getByIndex(index: number): SubAccountRecord | undefined
  put(record: SubAccountRecord): void
  putMany(records: readonly SubAccountRecord[]): void
  getAll(): SubAccountRecord[]
  /** At most `limit` rows strictly after `afterIndex`, without materializing full history. */
  scanRecords(afterIndex: number, limit: number): SubAccountRecord[]
  /** Persistent allocation high-water mark. It never moves backward when rows are compacted. */
  getNextIndex(): number
  setNextIndex(index: number): void
  replaceWithCheckpoint(checkpoint: TerminalSubAccountCheckpoint): void
  getCheckpoints(): TerminalSubAccountCheckpoint[]
  /** Waits until every preceding mutation is durable. In-memory stores resolve immediately. */
  flush(): Promise<void>
  clear(): Promise<void>
}

/** Simple in-memory `SubAccountPoolStore`. Does not survive app restarts on its own — useful for
 * tests, and as a default before a persisted store is wired up. */
export class InMemorySubAccountPoolStore implements SubAccountPoolStore {
  private readonly recordsByIndex = new Map<number, SubAccountRecord>()
  private readonly checkpointsByIndex = new Map<
    number,
    TerminalSubAccountCheckpoint
  >()
  private sortedRecordIndices: number[] = []
  private nextIndex = 0

  getByIndex(index: number): SubAccountRecord | undefined {
    const record = this.recordsByIndex.get(index)
    return record === undefined ? undefined : cloneSubAccountRecord(record)
  }

  put(record: SubAccountRecord): void {
    if (this.checkpointsByIndex.has(record.index)) {
      throw new Error(
        `Cannot recreate compacted sub-account index ${record.index}`
      )
    }
    if (!this.recordsByIndex.has(record.index))
      this.insertSortedIndex(record.index)
    this.recordsByIndex.set(record.index, cloneSubAccountRecord(record))
    this.nextIndex = Math.max(this.nextIndex, record.index + 1)
  }

  putMany(records: readonly SubAccountRecord[]): void {
    const stagedRecords = new Map(this.recordsByIndex)
    let stagedNext = this.nextIndex
    for (const record of records) {
      if (this.checkpointsByIndex.has(record.index)) {
        throw new Error(
          `Cannot recreate compacted sub-account index ${record.index}`
        )
      }
      stagedRecords.set(record.index, cloneSubAccountRecord(record))
      stagedNext = Math.max(stagedNext, record.index + 1)
    }
    this.recordsByIndex.clear()
    for (const [index, record] of stagedRecords) {
      this.recordsByIndex.set(index, record)
    }
    this.sortedRecordIndices = Array.from(stagedRecords.keys()).sort(
      (left, right) => left - right
    )
    this.nextIndex = stagedNext
  }

  getAll(): SubAccountRecord[] {
    return Array.from(this.recordsByIndex.values())
      .sort((a, b) => a.index - b.index)
      .map(cloneSubAccountRecord)
  }

  scanRecords(afterIndex: number, limit: number): SubAccountRecord[] {
    const start = lowerBoundAfter(this.sortedRecordIndices, afterIndex)
    if (start === this.sortedRecordIndices.length) return []
    return this.sortedRecordIndices
      .slice(start, start + limit)
      .map((index) =>
        cloneSubAccountRecord(
          this.recordsByIndex.get(index) as SubAccountRecord
        )
      )
  }

  getNextIndex(): number {
    return this.nextIndex
  }

  setNextIndex(index: number): void {
    assertSubAccountIndex(index, 'Next sub-account index')
    if (index < this.nextIndex) {
      throw new Error(
        'Sub-account allocation high-water mark cannot move backward'
      )
    }
    this.nextIndex = index
  }

  replaceWithCheckpoint(checkpoint: TerminalSubAccountCheckpoint): void {
    this.checkpointsByIndex.set(checkpoint.index, cloneCheckpoint(checkpoint))
    this.recordsByIndex.delete(checkpoint.index)
    this.sortedRecordIndices = this.sortedRecordIndices.filter(
      (index) => index !== checkpoint.index
    )
  }

  getCheckpoints(): TerminalSubAccountCheckpoint[] {
    return Array.from(this.checkpointsByIndex.values())
      .sort((a, b) => a.index - b.index)
      .map(cloneCheckpoint)
  }

  async flush(): Promise<void> {}

  async clear(): Promise<void> {
    this.recordsByIndex.clear()
    this.sortedRecordIndices = []
    this.checkpointsByIndex.clear()
    this.nextIndex = 0
  }

  private insertSortedIndex(index: number): void {
    const last = this.sortedRecordIndices[this.sortedRecordIndices.length - 1]
    if (last === undefined || last < index) {
      this.sortedRecordIndices.push(index)
      return
    }
    const position = lowerBoundAfter(this.sortedRecordIndices, index)
    this.sortedRecordIndices.splice(position, 0, index)
  }
}

export function lowerBoundAfter(
  indices: readonly number[],
  value: number
): number {
  let low = 0
  let high = indices.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (indices[middle] <= value) low = middle + 1
    else high = middle
  }
  return low
}

export function assertSubAccountIndex(index: number, label: string): void {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(
      `${label} must be a non-negative safe integer, got ${index}`
    )
  }
}

export function cloneCheckpoint(
  checkpoint: TerminalSubAccountCheckpoint
): TerminalSubAccountCheckpoint {
  return JSON.parse(JSON.stringify(checkpoint)) as TerminalSubAccountCheckpoint
}

export function cloneSubAccountRecord(
  record: SubAccountRecord
): SubAccountRecord {
  return JSON.parse(JSON.stringify(record)) as SubAccountRecord
}
