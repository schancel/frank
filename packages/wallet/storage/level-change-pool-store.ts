/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { LevelDB } from 'level'
import { join } from 'path'

import {
  ChangePoolStore,
  ChangeAccountRecord,
  ChangeSweepIntent,
  RecoveredChangeAccount,
  assertFinalizedIntent,
} from './change-pool-storage'
import {
  durableBatch,
  durableClear,
  durableDelete,
  durablePut,
  openDurableLevel,
} from './level-durability'

/** Reserved `level` key for the persisted "next unused change index" pointer. Never collides with
 * a record key (`String(record.index)`, i.e. plain decimal digits only) since this key contains a
 * non-digit character. */
const NEXT_INDEX_KEY = '__next_index__'
const PENDING_INTENT_KEY = '__pending_sweep_intent__'
const WALLET_BINDING_KEY = '__wallet_binding__'
const BY_SOURCE_PREFIX = '__by_source__:'
const RECOVERED_PREFIX = '__recovered_change__:'

/**
 * `level`-backed `ChangePoolStore`, mirroring `LevelSubAccountPoolStore`
 * (`./level-sub-account-pool-store.ts`): an in-memory cache backed by a `level` database on disk,
 * so the change pool's "next unused index" pointer and swept-record audit trail
 * (`ChangeAccountRecord`, never private keys -- see `change-pool-storage.ts`'s file header) survive
 * app restarts.
 *
 * Uses its own on-disk location (`<location>/change-pool`, as opposed to
 * `LevelSubAccountPoolStore`'s `<location>/sub-account-pool`) so the two pools' persisted state
 * never collides even when pointed at the same parent `location`.
 */
export class LevelChangePoolStore implements ChangePoolStore {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private cache: Map<number, ChangeAccountRecord>
  private bySourceBurnIndex = new Map<number, ChangeAccountRecord>()
  private nextIndex = 0
  private pendingIntent?: ChangeSweepIntent
  private recoveredAccountsByIndex = new Map<number, RecoveredChangeAccount>()
  private pendingWrites: Promise<unknown>[] = []
  private readonly expectedBindingId?: string
  private readonly allowUnboundForMigration: boolean
  private readonly assertMutationAllowed: () => void
  private readonly rootLocation: string
  private loadedBindingId?: string

  constructor(
    location: string,
    expectedBindingId?: string,
    allowUnboundForMigration = false,
    assertMutationAllowed: () => void = () => undefined,
  ) {
    this.dbLocation = join(location, 'change-pool')
    this.cache = new Map<number, ChangeAccountRecord>()
    this.expectedBindingId = expectedBindingId
    this.allowUnboundForMigration = allowUnboundForMigration
    this.assertMutationAllowed = assertMutationAllowed
    this.rootLocation = location
  }

  private get db() {
    if (!this.openedDb) {
      throw new Error('No db opened')
    }
    return this.openedDb
  }

  /** Opens the underlying `level` database and populates the in-memory cache from it. Must be
   * called (and awaited) before using the store -- same lifecycle as `LevelSubAccountPoolStore.
   * Open()`. */
  async Open(): Promise<void> {
    this.assertMutationAllowed()
    this.openedDb = level(this.dbLocation)
    await openDurableLevel(this.openedDb!, this.rootLocation, 'change-pool')
    await this.loadData()
  }

  async Close(): Promise<void> {
    await this.flush()
    await this.db.close()
  }

  private async loadData(): Promise<void> {
    // Same stale-ambient-type workaround `LevelSubAccountPoolStore.loadData` uses -- see that
    // file's header for the full explanation of why `iterator()` is typed `any` here.
    let storedBindingId: string | undefined
    const storedSourceIndices = new Map<number, number>()
    for await (const [key, value] of this.db.iterator({}) as any) {
      if (key === WALLET_BINDING_KEY) {
        storedBindingId = value
        continue
      }
      if (key === NEXT_INDEX_KEY) {
        this.nextIndex = JSON.parse(value)
        if (!Number.isSafeInteger(this.nextIndex) || this.nextIndex < 0) {
          throw new Error('Invalid stored next change index')
        }
        continue
      }
      if (key === PENDING_INTENT_KEY) {
        this.pendingIntent = JSON.parse(value)
        continue
      }
      if (key.startsWith(BY_SOURCE_PREFIX)) {
        const source = Number(key.slice(BY_SOURCE_PREFIX.length))
        const target = JSON.parse(value) as number
        if (!Number.isSafeInteger(source) || !Number.isSafeInteger(target)) {
          throw new Error('Invalid stored change source index')
        }
        storedSourceIndices.set(source, target)
        continue
      }
      if (key.startsWith(RECOVERED_PREFIX)) {
        const record = JSON.parse(value) as RecoveredChangeAccount
        if (`${RECOVERED_PREFIX}${record.index}` !== key) {
          throw new Error(
            'Recovered change-account key does not match its index',
          )
        }
        this.recoveredAccountsByIndex.set(record.index, record)
        this.nextIndex = Math.max(this.nextIndex, record.index + 1)
        continue
      }
      const record: ChangeAccountRecord = JSON.parse(value)
      if (String(record.index) !== key || !/^\d+$/.test(key)) {
        throw new Error('Change-account key does not match its index')
      }
      if (this.bySourceBurnIndex.has(record.sourceBurnIndex)) {
        throw new Error(
          `Duplicate change source sub-account ${record.sourceBurnIndex}`,
        )
      }
      this.cache.set(record.index, record)
      this.bySourceBurnIndex.set(record.sourceBurnIndex, record)
      this.nextIndex = Math.max(this.nextIndex, record.index + 1)
    }
    for (const [source, target] of storedSourceIndices) {
      const record = this.cache.get(target)
      if (record === undefined || record.sourceBurnIndex !== source) {
        throw new Error('Stored change source index does not match its record')
      }
    }
    if (this.expectedBindingId !== undefined) {
      if (
        storedBindingId !== undefined &&
        storedBindingId !== this.expectedBindingId
      ) {
        throw new Error('Change store belongs to a different wallet root')
      }
      if (storedBindingId === undefined && !this.allowUnboundForMigration) {
        throw new Error('Refusing to open an unbound change store')
      }
    }
    this.loadedBindingId = storedBindingId
  }

  bindingId(): string | undefined {
    return this.loadedBindingId
  }

  async Bind(resolvedLegacyRecords: ChangeAccountRecord[] = []): Promise<void> {
    if (this.expectedBindingId === undefined) return
    this.assertMutationAllowed()
    for (const record of resolvedLegacyRecords) {
      const existing = this.cache.get(record.index)
      if (
        existing === undefined ||
        existing.txHash !== record.txHash ||
        existing.sourceBurnIndex !== record.sourceBurnIndex
      ) {
        throw new Error('Legacy change resolution no longer matches stored row')
      }
    }
    await durableBatch(this.db, [
      { type: 'put', key: WALLET_BINDING_KEY, value: this.expectedBindingId },
      {
        type: 'put',
        key: NEXT_INDEX_KEY,
        value: JSON.stringify(this.nextIndex),
      },
      ...Array.from(this.cache.values()).map(record => ({
        type: 'put' as const,
        key: `${BY_SOURCE_PREFIX}${record.sourceBurnIndex}`,
        value: JSON.stringify(record.index),
      })),
      ...resolvedLegacyRecords.map(record => ({
        type: 'put' as const,
        key: String(record.index),
        value: JSON.stringify(record),
      })),
    ])
    for (const record of resolvedLegacyRecords) {
      this.cache.set(record.index, { ...record })
      this.bySourceBurnIndex.set(record.sourceBurnIndex, { ...record })
    }
    this.loadedBindingId = this.expectedBindingId
  }

  getNextIndex(): number {
    return this.nextIndex
  }

  setNextIndex(index: number): void {
    this.assertMutationAllowed()
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(
        `Next change index must be a non-negative integer, got ${index}`,
      )
    }
    this.nextIndex = index
    // TODO: Handle errors here (same caveat as `LevelSubAccountPoolStore.put`).
    this.pendingWrites.push(
      durablePut(this.db, NEXT_INDEX_KEY, JSON.stringify(index)),
    )
  }

  putRecord(record: ChangeAccountRecord): void {
    this.assertMutationAllowed()
    const priorSource = this.bySourceBurnIndex.get(record.sourceBurnIndex)
    if (priorSource !== undefined && priorSource.index !== record.index) {
      throw new Error(
        `Source sub-account ${record.sourceBurnIndex} already has change index ${priorSource.index}`,
      )
    }
    this.cache.set(record.index, { ...record })
    this.bySourceBurnIndex.set(record.sourceBurnIndex, { ...record })
    this.pendingWrites.push(
      durableBatch(this.db, [
        {
          type: 'put',
          key: String(record.index),
          value: JSON.stringify(record),
        },
        {
          type: 'put',
          key: `${BY_SOURCE_PREFIX}${record.sourceBurnIndex}`,
          value: JSON.stringify(record.index),
        },
      ]),
    )
  }

  getRecord(index: number): ChangeAccountRecord | undefined {
    const record = this.cache.get(index)
    return record === undefined ? undefined : { ...record }
  }

  getBySourceBurnIndex(index: number): ChangeAccountRecord | undefined {
    const record = this.bySourceBurnIndex.get(index)
    return record === undefined ? undefined : { ...record }
  }

  getAll(): ChangeAccountRecord[] {
    return Array.from(this.cache.values())
      .sort((a, b) => a.index - b.index)
      .map(record => ({ ...record }))
  }

  putRecoveredAccounts(records: readonly RecoveredChangeAccount[]): void {
    this.assertMutationAllowed()
    if (records.length === 0) return
    this.pendingWrites.push(
      durableBatch(
        this.db,
        records.map(record => ({
          type: 'put' as const,
          key: `${RECOVERED_PREFIX}${record.index}`,
          value: JSON.stringify(record),
        })),
      ),
    )
    for (const record of records) {
      this.recoveredAccountsByIndex.set(record.index, { ...record })
      this.nextIndex = Math.max(this.nextIndex, record.index + 1)
    }
  }

  getRecoveredAccounts(): RecoveredChangeAccount[] {
    return Array.from(this.recoveredAccountsByIndex.values())
      .sort((left, right) => left.index - right.index)
      .map(record => ({ ...record }))
  }

  getPendingIntent(): ChangeSweepIntent | undefined {
    return this.pendingIntent === undefined
      ? undefined
      : { ...this.pendingIntent }
  }

  setPendingIntent(intent: ChangeSweepIntent): void {
    this.assertMutationAllowed()
    if (this.pendingIntent !== undefined) {
      if (JSON.stringify(this.pendingIntent) === JSON.stringify(intent)) return
      throw new Error('Cannot replace an active change sweep intent')
    }
    this.pendingIntent = { ...intent }
    this.pendingWrites.push(
      durablePut(this.db, PENDING_INTENT_KEY, JSON.stringify(intent)),
    )
  }

  clearPendingIntent(): void {
    this.assertMutationAllowed()
    this.pendingIntent = undefined
    this.pendingWrites.push(durableDelete(this.db, PENDING_INTENT_KEY))
  }

  finalizePendingIntent(
    intent: ChangeSweepIntent,
    record: ChangeAccountRecord,
  ): void {
    this.assertMutationAllowed()
    assertFinalizedIntent(this, intent, record)
    const nextIndex = Math.max(this.nextIndex, intent.index + 1)
    this.pendingWrites.push(
      durableBatch(this.db, [
        {
          type: 'put',
          key: String(record.index),
          value: JSON.stringify(record),
        },
        {
          type: 'put',
          key: `${BY_SOURCE_PREFIX}${record.sourceBurnIndex}`,
          value: JSON.stringify(record.index),
        },
        {
          type: 'put',
          key: NEXT_INDEX_KEY,
          value: JSON.stringify(nextIndex),
        },
        { type: 'del', key: PENDING_INTENT_KEY },
      ]),
    )
    this.cache.set(record.index, { ...record })
    this.bySourceBurnIndex.set(record.sourceBurnIndex, { ...record })
    this.nextIndex = nextIndex
    this.pendingIntent = undefined
  }

  async flush(): Promise<void> {
    const writes = this.pendingWrites
    this.pendingWrites = []
    await Promise.all(writes)
  }

  /**
   * This will delete everything in the store! Don't call it by accident!
   */
  async clear(): Promise<void> {
    this.assertMutationAllowed()
    await this.flush()
    this.cache = new Map<number, ChangeAccountRecord>()
    this.bySourceBurnIndex = new Map<number, ChangeAccountRecord>()
    this.nextIndex = 0
    this.pendingIntent = undefined
    await durableClear(this.db)
  }
}
