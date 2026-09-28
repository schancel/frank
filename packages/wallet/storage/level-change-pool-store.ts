/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { LevelDB } from 'level'
import { join } from 'path'

import { ChangePoolStore, ChangeAccountRecord } from './change-pool-storage'

/** Reserved `level` key for the persisted "next unused change index" pointer. Never collides with
 * a record key (`String(record.index)`, i.e. plain decimal digits only) since this key contains a
 * non-digit character. */
const NEXT_INDEX_KEY = '__next_index__'

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
  private nextIndex = 0
  private pendingWrites: Promise<unknown>[] = []

  constructor(location: string) {
    this.dbLocation = join(location, 'change-pool')
    this.cache = new Map<number, ChangeAccountRecord>()
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
    this.openedDb = level(this.dbLocation)
    await this.loadData()
  }

  async Close(): Promise<void> {
    await this.flush()
    await this.db.close()
  }

  private async loadData(): Promise<void> {
    // Same stale-ambient-type workaround `LevelSubAccountPoolStore.loadData` uses -- see that
    // file's header for the full explanation of why `iterator()` is typed `any` here.
    for await (const [key, value] of this.db.iterator({}) as any) {
      if (key === NEXT_INDEX_KEY) {
        this.nextIndex = JSON.parse(value)
        continue
      }
      const record: ChangeAccountRecord = JSON.parse(value)
      this.cache.set(record.index, record)
    }
  }

  getNextIndex(): number {
    return this.nextIndex
  }

  setNextIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(
        `Next change index must be a non-negative integer, got ${index}`,
      )
    }
    this.nextIndex = index
    // TODO: Handle errors here (same caveat as `LevelSubAccountPoolStore.put`).
    this.pendingWrites.push(this.db.put(NEXT_INDEX_KEY, JSON.stringify(index)))
  }

  putRecord(record: ChangeAccountRecord): void {
    this.cache.set(record.index, { ...record })
    this.pendingWrites.push(
      this.db.put(String(record.index), JSON.stringify(record)),
    )
  }

  getRecord(index: number): ChangeAccountRecord | undefined {
    return this.cache.get(index)
  }

  getAll(): ChangeAccountRecord[] {
    return Array.from(this.cache.values()).sort((a, b) => a.index - b.index)
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
    await this.flush()
    this.cache = new Map<number, ChangeAccountRecord>()
    this.nextIndex = 0
    await this.db.clear()
  }
}
