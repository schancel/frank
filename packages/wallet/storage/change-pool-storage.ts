/**
 * Storage interface for the Monad HD change-account pool (ticket #36), following the same pattern
 * as `SubAccountPoolStore` (`./sub-account-pool-storage.ts`, ticket #14): a small persistence
 * boundary so the pool's state survives app restarts, with a concrete `level`-backed
 * implementation (`./level-change-pool-store.ts`) mirroring `LevelSubAccountPoolStore`.
 *
 * This is a *new*, separate interface from `SubAccountPoolStore` rather than a reuse of it --
 * per this ticket's own ownership rules ("reuse the same store with a different key namespace,
 * your call"), a separate interface was chosen because the two shapes genuinely differ: a change
 * account has no `status` lifecycle (it's never leased/spent/retired the way a burn account is --
 * it's purely a sweep *destination*), but does need a persisted "next unused index" pointer
 * (`SubAccountPoolStore` has no equivalent -- `MonadSubAccountPool` derives that value on the fly
 * from `Math.max` over its records, which works there because every record it stores is durable;
 * here the pointer must persist *before* a record for that index may even exist yet -- see
 * `monad-change-pool.ts`'s `peekNextChangeAddress`).
 *
 * What's persisted, and what isn't: `ChangeAccountRecord` (below) plus the raw "next unused index"
 * pointer. Never a private key -- change-account keys are cheaply and deterministically re-derived
 * from the root secret + index on demand via `MonadChangeKeyring`, exactly like burn accounts.
 */

/** Persisted record of one change output actually swept into existence -- i.e. one that has a
 * real on-chain funding transaction, not merely a derived-but-unused index. `sweptValueWei` is a
 * decimal string (not a `bigint`) so this record stays trivially JSON-serializable, the same
 * reason `SubAccountRecord` never holds a private key or other non-JSON-safe field. */
export interface ChangeAccountRecord {
  /** BIP-44 index (`m/44'/60'/0'/1/{index}`); the durable identity of this change output. */
  index: number
  address: string
  /** Index of the burn sub-account (`m/44'/60'/0'/0/{sourceBurnIndex}`) whose leftover balance
   * funded this change output -- kept for audit/observability and as the join key a future
   * consolidation step (see `monad-change-pool.ts`'s file header) would need. */
  sourceBurnIndex: number
  sourceBurnAddress: string
  /** Decimal-string wei amount actually transferred into this change output (post-dust-threshold,
   * i.e. the burn account's leftover balance minus the sweep's own reserved gas cost). */
  sweptValueWei: string
  /** Hash of the sweep transaction that funded this change output. */
  txHash: string
  /** `Date.now()` at the time this record was persisted (informational only). */
  createdAt: number
}

/** Crash-recovery journal for the one change sweep currently being submitted. The raw signed
 * transaction is safe to replay byte-for-byte: its sender, nonce, destination and value cannot
 * change. Keeping only one intent also preserves the contiguous HD prefix used by seed recovery. */
export interface ChangeSweepIntent {
  index: number
  address: string
  sourceBurnIndex: number
  sourceBurnAddress: string
  sweptValueWei: string
  rawTx: string
  txHash: string
  createdAt: number
}

/**
 * Persistence boundary for `MonadChangePool`'s state: the "next unused change index" pointer
 * (ticket #36 acceptance criterion 2) plus the audit trail of change outputs actually swept into
 * existence. Concrete implementations: an in-memory one (`InMemoryChangePoolStore`, below) and a
 * `level`-backed one (`LevelChangePoolStore`, in `./level-change-pool-store.ts`).
 */
export interface ChangePoolStore {
  /** The next change index that has never been allocated a sweep yet -- `0` for a fresh store. */
  getNextIndex(): number
  /** Overwrites the "next unused index" pointer directly. Callers should generally prefer
   * `MonadChangePool`'s higher-level, guarded wrapper (`setNextUnusedIndex`) over calling this
   * directly, except when initializing a brand-new store. */
  setNextIndex(index: number): void
  putRecord(record: ChangeAccountRecord): void
  getRecord(index: number): ChangeAccountRecord | undefined
  getBySourceBurnIndex(index: number): ChangeAccountRecord | undefined
  /** Every persisted change record, sorted by index. */
  getAll(): ChangeAccountRecord[]
  getPendingIntent(): ChangeSweepIntent | undefined
  setPendingIntent(intent: ChangeSweepIntent): void
  clearPendingIntent(): void
  /** Wait until every preceding mutation is durable. */
  flush(): Promise<void>
  clear(): Promise<void>
}

function assertValidIndex(index: number, label: string): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${index}`)
  }
}

/** Simple in-memory `ChangePoolStore`. Does not survive app restarts on its own -- useful for
 * tests, and as a default before a persisted store is wired up. */
export class InMemoryChangePoolStore implements ChangePoolStore {
  private nextIndex = 0
  private recordsByIndex = new Map<number, ChangeAccountRecord>()
  private recordsBySourceBurnIndex = new Map<number, ChangeAccountRecord>()
  private pendingIntent?: ChangeSweepIntent

  getNextIndex(): number {
    return this.nextIndex
  }

  setNextIndex(index: number): void {
    assertValidIndex(index, 'Next change index')
    this.nextIndex = index
  }

  putRecord(record: ChangeAccountRecord): void {
    const priorSource = this.recordsBySourceBurnIndex.get(
      record.sourceBurnIndex
    )
    if (priorSource !== undefined && priorSource.index !== record.index) {
      throw new Error(
        `Source sub-account ${record.sourceBurnIndex} already has change index ${priorSource.index}`
      )
    }
    this.recordsByIndex.set(record.index, { ...record })
    this.recordsBySourceBurnIndex.set(record.sourceBurnIndex, { ...record })
  }

  getRecord(index: number): ChangeAccountRecord | undefined {
    return this.recordsByIndex.get(index)
  }

  getBySourceBurnIndex(index: number): ChangeAccountRecord | undefined {
    return this.recordsBySourceBurnIndex.get(index)
  }

  getAll(): ChangeAccountRecord[] {
    return Array.from(this.recordsByIndex.values()).sort(
      (a, b) => a.index - b.index
    )
  }

  getPendingIntent(): ChangeSweepIntent | undefined {
    return this.pendingIntent === undefined
      ? undefined
      : { ...this.pendingIntent }
  }

  setPendingIntent(intent: ChangeSweepIntent): void {
    this.pendingIntent = { ...intent }
  }

  clearPendingIntent(): void {
    this.pendingIntent = undefined
  }

  async flush(): Promise<void> {}

  async clear(): Promise<void> {
    this.nextIndex = 0
    this.recordsByIndex.clear()
    this.recordsBySourceBurnIndex.clear()
    this.pendingIntent = undefined
  }
}
