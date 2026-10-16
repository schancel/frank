/** HD pool persistence owns committed rows, terminal projections and monotonic allocation.
 * Revision metadata belongs to the version 3 envelope. Detached snapshots carry the captured
 * revision so every owner mutation compares the row it actually observed before any awaits.
 * Custody derives signing keys independently; this store never initializes or deletes them.
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
  /** Explicit migration marker for a base-era terminal row that predates retained transaction
   * bytes. It remains terminal/non-reusable without fabricating authority that never existed. */
  legacyTerminal?: { version: 1; reason: 'base-era-terminal' }
}

/** Durable replacement for a compacted terminal account row. It deliberately retains the
 * transactions and residual disposition needed to audit/recover the account without retaining
 * the mutable pool row forever. */
export interface TerminalSubAccountCheckpoint {
  version: 1
  /** Detached committed snapshot revision; persisted in the v3 envelope. */
  readonly revision?: number
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
  /** Detached committed snapshot revision; persisted in the v3 envelope. */
  readonly revision?: number
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
  const { funding, spend, recovery, legacyTerminal } = record.lifecycle ?? {}
  const isLegacyTerminal =
    (legacyTerminal?.version === 1 &&
      legacyTerminal.reason === 'base-era-terminal') ||
    (record.status === 'spent' && spend === undefined)
  if (
    ((record.status === 'unfunded' || record.status === 'funding') &&
      (funding !== undefined ||
        spend !== undefined ||
        recovery !== undefined ||
        legacyTerminal !== undefined)) ||
    (record.status === 'available' &&
      (spend !== undefined ||
        recovery !== undefined ||
        legacyTerminal !== undefined)) ||
    (record.status === 'in-use' &&
      (recovery !== undefined || legacyTerminal !== undefined)) ||
    (record.status === 'spent' && spend === undefined && !isLegacyTerminal) ||
    (spend !== undefined && legacyTerminal !== undefined) ||
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
export class SubAccountRevisionMismatchError extends Error {
  constructor(index: number) {
    super(`Stale pool revision for index ${index}`)
    this.name = 'SubAccountRevisionMismatchError'
  }
}

export interface PoolMutationSnapshot {
  readonly records: readonly SubAccountRecord[]
  readonly checkpoints: readonly TerminalSubAccountCheckpoint[]
  readonly nextIndex: number
}
export interface PoolMutation<T> {
  readonly records?: readonly {
    record: SubAccountRecord
    expectedRevision: number
  }[]
  readonly checkpoints?: readonly {
    checkpoint: TerminalSubAccountCheckpoint
    expectedRevision: number
  }[]
  readonly nextIndex?: number
  readonly result: T
}
export interface SubAccountPoolStore {
  getByIndex(index: number): SubAccountRecord | undefined
  getAll(): SubAccountRecord[]
  scanRecords(afterIndex: number, limit: number): SubAccountRecord[]
  getNextIndex(): number
  getCheckpoints(): TerminalSubAccountCheckpoint[]
  mutate<T>(
    reducer: (snapshot: PoolMutationSnapshot) => PoolMutation<T>
  ): Promise<T>
  flush(): Promise<void>
}

export function validatePoolEntry(
  entry: SubAccountRecord | TerminalSubAccountCheckpoint
): void {
  assertSubAccountIndex(entry.index, 'Sub-account index')
  if (
    typeof entry.address !== 'string' ||
    entry.address.length === 0 ||
    ![
      'unfunded',
      'funding',
      'available',
      'in-use',
      'spent',
      'retired',
    ].includes(entry.status)
  )
    throw new Error('Invalid pool row')
  if ('version' in entry) {
    if (
      entry.version !== 1 ||
      (entry.status !== 'spent' && entry.status !== 'retired') ||
      !entry.lifecycle?.funding ||
      !entry.lifecycle.spend ||
      !entry.lifecycle.recovery ||
      typeof entry.denominationWei !== 'string' ||
      !Number.isSafeInteger(entry.compactedAt) ||
      entry.compactedAt < 0
    )
      throw new Error('Invalid terminal pool checkpoint')
  } else {
    if ((entry.status === 'funding') !== (entry.fundingAttempt !== undefined))
      throw new Error('Invalid pool funding state')
    assertSubAccountLifecycleMatrix(entry)
  }
}
function samePoolPayload(
  left: { readonly revision?: number },
  right: { readonly revision?: number }
): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)])
        )
      : value
  return (
    JSON.stringify(canonical(poolPayload(left))) ===
    JSON.stringify(canonical(poolPayload(right)))
  )
}

export function poolPayload<T extends { readonly revision?: number }>(
  value: T
): Omit<T, 'revision'> {
  const { revision: _revision, ...payload } = value
  return payload
}

/** One authority per opened store; all wrappers share this committed state and short queue. */
export class InMemorySubAccountPoolStore implements SubAccountPoolStore {
  protected recordsByIndex = new Map<number, SubAccountRecord>()
  protected checkpointsByIndex = new Map<number, TerminalSubAccountCheckpoint>()
  protected nextIndex = 0
  protected tail: Promise<unknown> = Promise.resolve()
  protected uncertain = false
  protected closed = false

  protected assertReadable(): void {
    if (this.closed) throw new Error('Pool store is closed')
    if (this.uncertain)
      throw new Error(
        'Pool store is uncertain; close and reopen for authoritative validation'
      )
  }
  getByIndex(index: number): SubAccountRecord | undefined {
    this.assertReadable()
    const record = this.recordsByIndex.get(index)
    return record === undefined ? undefined : cloneSubAccountRecord(record)
  }
  getAll(): SubAccountRecord[] {
    this.assertReadable()
    return Array.from(this.recordsByIndex.values())
      .sort((a, b) => a.index - b.index)
      .map(cloneSubAccountRecord)
  }
  scanRecords(afterIndex: number, limit: number): SubAccountRecord[] {
    assertSubAccountIndex(limit, 'Sub-account scan limit')
    return this.getAll()
      .filter((record) => record.index > afterIndex)
      .slice(0, limit)
  }
  getNextIndex(): number {
    this.assertReadable()
    return this.nextIndex
  }
  getCheckpoints(): TerminalSubAccountCheckpoint[] {
    this.assertReadable()
    return Array.from(this.checkpointsByIndex.values())
      .sort((a, b) => a.index - b.index)
      .map(cloneCheckpoint)
  }
  protected async persist(
    _records: ReadonlyMap<number, SubAccountRecord>,
    _checkpoints: ReadonlyMap<number, TerminalSubAccountCheckpoint>,
    _nextIndex: number
  ): Promise<void> {}
  protected coordinated<T>(task: () => Promise<T>): Promise<T> {
    return task()
  }
  protected async reloadAuthority(): Promise<void> {}
  protected needsInitialization(): boolean {
    return false
  }
  mutate<T>(
    reducer: (snapshot: PoolMutationSnapshot) => PoolMutation<T>
  ): Promise<T> {
    this.assertReadable()
    const run = this.tail.then(() =>
      this.coordinated(async () => {
        this.assertReadable()
        try {
          await this.reloadAuthority()
        } catch (error) {
          this.uncertain = true
          throw error
        }
        const mutation = reducer({
          records: this.getAll(),
          checkpoints: this.getCheckpoints(),
          nextIndex: this.nextIndex,
        })
        if (
          mutation === null ||
          typeof mutation !== 'object' ||
          'then' in mutation
        )
          throw new Error('Pool mutation reducer must be synchronous')
        const records = new Map(this.recordsByIndex),
          checkpoints = new Map(this.checkpointsByIndex)
        const touched = new Set<number>()
        let nextIndex = mutation.nextIndex ?? this.nextIndex
        assertSubAccountIndex(nextIndex, 'Next sub-account index')
        if (nextIndex < this.nextIndex)
          throw new Error(
            'Sub-account allocation high-water mark cannot move backward'
          )
        let changed = false
        const revision = (
          index: number,
          expected: number,
          candidate: SubAccountRecord | TerminalSubAccountCheckpoint
        ): number => {
          assertSubAccountIndex(index, 'Sub-account index')
          if (touched.has(index))
            throw new Error('Duplicate row in pool mutation')
          touched.add(index)
          const prior =
            this.recordsByIndex.get(index) ?? this.checkpointsByIndex.get(index)
          const actual = prior?.revision ?? 0
          if (
            !Number.isSafeInteger(expected) ||
            expected < 0 ||
            expected !== actual
          )
            throw new SubAccountRevisionMismatchError(index)
          if (prior && samePoolPayload(prior, candidate)) return actual
          if (actual === Number.MAX_SAFE_INTEGER)
            throw new Error('Pool revision overflow')
          changed = true
          return actual + 1
        }
        for (const { record, expectedRevision } of mutation.records ?? []) {
          validatePoolEntry(record)
          if (checkpoints.has(record.index))
            throw new Error(
              `Cannot recreate compacted sub-account index ${record.index}`
            )
          if (!records.has(record.index) && record.index < this.nextIndex)
            throw new Error('Cannot reuse allocated sub-account index')
          const next = revision(record.index, expectedRevision, record)
          const prior = records.get(record.index)
          if (
            (prior?.status === 'spent' || prior?.status === 'retired') &&
            record.status !== 'spent' &&
            record.status !== 'retired'
          )
            throw new Error(
              'Terminal sub-account cannot return to a nonterminal state'
            )
          records.set(record.index, {
            ...cloneSubAccountRecord(record),
            revision: next,
          })
          nextIndex = Math.max(nextIndex, record.index + 1)
        }
        for (const { checkpoint, expectedRevision } of mutation.checkpoints ??
          []) {
          validatePoolEntry(checkpoint)
          if (
            !records.has(checkpoint.index) &&
            !checkpoints.has(checkpoint.index)
          )
            throw new Error('Cannot compact missing sub-account')
          const next = revision(checkpoint.index, expectedRevision, checkpoint)
          checkpoints.set(checkpoint.index, {
            ...cloneCheckpoint(checkpoint),
            revision: next,
          })
          records.delete(checkpoint.index)
        }
        assertSubAccountIndex(nextIndex, 'Next sub-account index')
        if (
          changed ||
          nextIndex !== this.nextIndex ||
          this.needsInitialization()
        ) {
          try {
            await this.persist(records, checkpoints, nextIndex)
          } catch (error) {
            this.uncertain = true
            throw error
          }
          this.recordsByIndex = records
          this.checkpointsByIndex = checkpoints
          this.nextIndex = nextIndex
        }
        return mutation.result
      })
    )
    this.tail = run.catch(() => undefined)
    return run
  }
  async flush(): Promise<void> {
    await this.tail
    this.assertReadable()
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
