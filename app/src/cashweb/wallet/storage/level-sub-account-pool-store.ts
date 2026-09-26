/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { LevelDB } from 'level'
import { join } from 'path'

import {
  SubAccountPoolStore,
  SubAccountRecord,
} from './sub-account-pool-storage'

/**
 * `level`-backed `SubAccountPoolStore`, mirroring `LevelUtxoStore` (`./level-storage.ts`): an
 * in-memory cache backed by a `level` database on disk, so the HD sub-account pool's state
 * (`index`/`address`/`status` only — never private keys, see `sub-account-pool-storage.ts`'s file
 * header) survives app restarts.
 *
 * Keys are the sub-account's BIP-44 index, stringified (`level`'s default keyEncoding is `'utf8'`,
 * so string keys sort lexicographically, not numerically — `getAll()` sorts numerically itself
 * rather than relying on key order).
 */
export class LevelSubAccountPoolStore implements SubAccountPoolStore {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private cache: Map<number, SubAccountRecord>

  constructor(location: string) {
    this.dbLocation = join(location, 'sub-account-pool')
    this.cache = new Map<number, SubAccountRecord>()
  }

  private get db() {
    if (!this.openedDb) {
      throw new Error('No db opened')
    }
    return this.openedDb
  }

  /** Opens the underlying `level` database and populates the in-memory cache from it. Must be
   * called (and awaited) before using the store — same lifecycle as `LevelUtxoStore.Open()`. */
  async Open(): Promise<void> {
    this.openedDb = level(this.dbLocation)
    await this.loadData()
  }

  async Close(): Promise<void> {
    await this.db.close()
  }

  private async loadData(): Promise<void> {
    // The hand-written ambient type for `level` (`src/types/level/level.d.ts`, outside this
    // ticket's file-ownership scope) declares `iterator()` as returning
    // `Promise<LevelDBIterator>` with a callback-shaped `next()` — that doesn't match the actually
    // installed `level@7` package's real behavior (verified directly against node_modules): calling
    // `db.iterator()` returns a value that's immediately async-iterable, yielding `[key, value]`
    // tuples, with no separate "open" promise to await first. `LevelUtxoStore`'s own iterator
    // (`./level-storage.ts`) sidesteps the same stale-type mismatch by typing its iterator field
    // `any`; this does the same, locally, rather than editing that shared ambient declaration.
    for await (const [key, value] of this.db.iterator({}) as any) {
      const record: SubAccountRecord = JSON.parse(value)
      this.cache.set(record.index, record)
      void key // key is the stringified index; the parsed record's own `index` field is used.
    }
  }

  getByIndex(index: number): SubAccountRecord | undefined {
    return this.cache.get(index)
  }

  put(record: SubAccountRecord): void {
    this.cache.set(record.index, { ...record })
    // TODO: Handle errors here (same caveat as `LevelUtxoStore.put`).
    this.db
      .put(String(record.index), JSON.stringify(record))
      .catch((err: any) =>
        console.error(
          `Failed to persist sub-account pool record ${record.index}`,
          err,
        ),
      )
  }

  getAll(): SubAccountRecord[] {
    return Array.from(this.cache.values()).sort((a, b) => a.index - b.index)
  }

  /**
   * This will delete everything in the store! Don't call it by accident!
   */
  async clear(): Promise<void> {
    this.cache = new Map<number, SubAccountRecord>()
    await this.db.clear()
  }
}
