/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { LevelDB } from 'level'
import { join } from 'path'

import {
  assertSubAccountIndex,
  cloneCheckpoint,
  cloneSubAccountRecord,
  SubAccountPoolStore,
  SubAccountRecord,
  TerminalSubAccountCheckpoint,
} from './sub-account-pool-storage'
import { validateWalletComponentBeforeOpen } from './wallet-root-guard'

const NEXT_INDEX_KEY = '__next_index__'
const CHECKPOINT_PREFIX = '__terminal_checkpoint__:'
const WALLET_BINDING_KEY = '__wallet_binding__'

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
  private sortedRecordIndices: number[] = []
  private checkpoints = new Map<number, TerminalSubAccountCheckpoint>()
  private nextIndex = 0
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
    assertMutationAllowed: () => void = () => undefined
  ) {
    this.dbLocation = join(location, 'sub-account-pool')
    this.cache = new Map<number, SubAccountRecord>()
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
   * called (and awaited) before using the store — same lifecycle as `LevelUtxoStore.Open()`. */
  async Open(): Promise<void> {
    this.assertMutationAllowed()
    validateWalletComponentBeforeOpen(
      this.rootLocation,
      'sub-account-pool',
      false
    )
    this.openedDb = level(this.dbLocation)
    await (this.openedDb as any).open()
    await this.loadData()
  }

  async Close(): Promise<void> {
    await this.flush()
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
    let storedBindingId: string | undefined
    for await (const [key, value] of this.db.iterator({}) as any) {
      if (key === WALLET_BINDING_KEY) {
        storedBindingId = value
        continue
      }
      if (key === NEXT_INDEX_KEY) {
        const parsed: unknown = JSON.parse(value)
        assertSubAccountIndex(parsed as number, 'Stored next sub-account index')
        this.nextIndex = parsed as number
        continue
      }
      if (key.startsWith(CHECKPOINT_PREFIX)) {
        const checkpoint = JSON.parse(value) as TerminalSubAccountCheckpoint
        if (`${CHECKPOINT_PREFIX}${checkpoint.index}` !== key) {
          throw new Error('Terminal checkpoint key does not match its index')
        }
        this.checkpoints.set(checkpoint.index, checkpoint)
        this.nextIndex = Math.max(this.nextIndex, checkpoint.index + 1)
        continue
      }
      const record: SubAccountRecord = JSON.parse(value)
      if (String(record.index) !== key || !/^\d+$/.test(key)) {
        throw new Error('Sub-account key does not match its index')
      }
      if (this.checkpoints.has(record.index)) {
        throw new Error(`Sub-account ${record.index} also has a checkpoint`)
      }
      this.cache.set(record.index, record)
      this.sortedRecordIndices.push(record.index)
      this.nextIndex = Math.max(this.nextIndex, record.index + 1)
      void key // key is the stringified index; the parsed record's own `index` field is used.
    }
    for (const index of this.checkpoints.keys()) {
      if (this.cache.has(index)) {
        throw new Error(`Sub-account ${index} also has a checkpoint`)
      }
    }
    this.sortedRecordIndices.sort((left, right) => left - right)
    if (this.expectedBindingId !== undefined) {
      if (
        storedBindingId !== undefined &&
        storedBindingId !== this.expectedBindingId
      ) {
        throw new Error('Sub-account store belongs to a different wallet root')
      }
      if (storedBindingId === undefined && !this.allowUnboundForMigration) {
        throw new Error('Refusing to open an unbound sub-account store')
      }
    }
    this.loadedBindingId = storedBindingId
  }

  bindingId(): string | undefined {
    return this.loadedBindingId
  }

  async Bind(): Promise<void> {
    if (this.expectedBindingId === undefined) return
    this.assertMutationAllowed()
    await (this.db as any).batch([
      { type: 'put', key: WALLET_BINDING_KEY, value: this.expectedBindingId },
      {
        type: 'put',
        key: NEXT_INDEX_KEY,
        value: JSON.stringify(this.nextIndex),
      },
    ])
  }

  getByIndex(index: number): SubAccountRecord | undefined {
    const record = this.cache.get(index)
    return record === undefined ? undefined : cloneSubAccountRecord(record)
  }

  put(record: SubAccountRecord): void {
    this.putMany([record])
  }

  putMany(records: readonly SubAccountRecord[]): void {
    this.assertMutationAllowed()
    const staged = records.map(cloneSubAccountRecord)
    let nextIndex = this.nextIndex
    const writes: Array<{ type: 'put'; key: string; value: string }> = []
    for (const record of staged) {
      if (this.checkpoints.has(record.index)) {
        throw new Error(
          `Cannot recreate compacted sub-account index ${record.index}`
        )
      }
      nextIndex = Math.max(nextIndex, record.index + 1)
      writes.push({
        type: 'put',
        key: String(record.index),
        value: JSON.stringify(record),
      })
    }
    if (nextIndex !== this.nextIndex) {
      writes.push({
        type: 'put',
        key: NEXT_INDEX_KEY,
        value: JSON.stringify(nextIndex),
      })
    }
    this.pendingWrites.push((this.db as any).batch(writes))
    for (const record of staged) {
      if (!this.cache.has(record.index)) {
        const position = this.sortedRecordIndices.findIndex(
          (index) => index > record.index
        )
        if (position < 0) this.sortedRecordIndices.push(record.index)
        else this.sortedRecordIndices.splice(position, 0, record.index)
      }
      this.cache.set(record.index, record)
    }
    this.nextIndex = nextIndex
  }

  getAll(): SubAccountRecord[] {
    return Array.from(this.cache.values())
      .sort((a, b) => a.index - b.index)
      .map(cloneSubAccountRecord)
  }

  scanRecords(afterIndex: number, limit: number): SubAccountRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error('Sub-account scan limit must be non-negative')
    }
    const start = this.sortedRecordIndices.findIndex(
      (index) => index > afterIndex
    )
    if (start < 0) return []
    return this.sortedRecordIndices
      .slice(start, start + limit)
      .map((index) =>
        cloneSubAccountRecord(this.cache.get(index) as SubAccountRecord)
      )
  }

  getNextIndex(): number {
    return this.nextIndex
  }

  setNextIndex(index: number): void {
    this.assertMutationAllowed()
    assertSubAccountIndex(index, 'Next sub-account index')
    if (index < this.nextIndex) {
      throw new Error(
        'Sub-account allocation high-water mark cannot move backward'
      )
    }
    this.nextIndex = index
    this.pendingWrites.push(this.db.put(NEXT_INDEX_KEY, JSON.stringify(index)))
  }

  replaceWithCheckpoint(checkpoint: TerminalSubAccountCheckpoint): void {
    this.assertMutationAllowed()
    this.checkpoints.set(checkpoint.index, cloneCheckpoint(checkpoint))
    this.cache.delete(checkpoint.index)
    this.sortedRecordIndices = this.sortedRecordIndices.filter(
      (index) => index !== checkpoint.index
    )
    this.pendingWrites.push(
      (this.db as any).batch([
        {
          type: 'put',
          key: `${CHECKPOINT_PREFIX}${checkpoint.index}`,
          value: JSON.stringify(checkpoint),
        },
        { type: 'del', key: String(checkpoint.index) },
      ])
    )
  }

  getCheckpoints(): TerminalSubAccountCheckpoint[] {
    return Array.from(this.checkpoints.values())
      .sort((a, b) => a.index - b.index)
      .map(cloneCheckpoint)
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
    this.cache = new Map<number, SubAccountRecord>()
    this.sortedRecordIndices = []
    this.checkpoints = new Map<number, TerminalSubAccountCheckpoint>()
    this.nextIndex = 0
    await this.db.clear()
  }
}
