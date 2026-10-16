/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { LevelDB } from 'level'
import { join, resolve } from 'path'
import { runNativeTransactionExclusive } from '../chain/chain-wallet'
import {
  assertSubAccountIndex,
  InMemorySubAccountPoolStore,
  poolPayload,
  validatePoolEntry,
  SubAccountRecord,
  TerminalSubAccountCheckpoint,
} from './sub-account-pool-storage'
import { durableBatch, openDurableLevel } from './level-durability'

const NEXT_INDEX_KEY = '__next_index__'
const CHECKPOINT_PREFIX = '__terminal_checkpoint__:'
const WALLET_BINDING_KEY = '__wallet_binding__'
const FORMAT_KEY = '__pool_format__'
const FORMAT = 'sub-account-pool-v4-funding-evidence'

/** Node Level owns physical exclusion. Browser Web Locks enclose authoritative reload and
 * durable batch across contexts; an instance cache is only a committed read projection. */
export class LevelSubAccountPoolStore extends InMemorySubAccountPoolStore {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private loadedBindingId?: string
  private accepting = false
  private bound = false
  private initialized = false
  constructor(
    private readonly rootLocation: string,
    private readonly expectedBindingId?: string,
    private readonly assertMutationAllowed: () => void = () => undefined
  ) {
    super()
    this.closed = true
    this.dbLocation = join(rootLocation, 'sub-account-pool')
  }
  private get db(): LevelDB {
    if (!this.openedDb) throw new Error('Pool backend is not open')
    return this.openedDb
  }
  async Open(): Promise<void> {
    if (this.openedDb) throw new Error('Pool store already has an open backend')
    const database = level(this.dbLocation)
    this.openedDb = database
    try {
      await openDurableLevel(database, this.rootLocation, 'sub-account-pool')
      await this.coordinated(() => this.reloadAuthority())
      this.uncertain = false
      this.closed = false
      this.accepting = true
    } catch (error) {
      await database.close()
      this.openedDb = undefined
      throw error
    }
  }
  protected coordinated<T>(task: () => Promise<T>): Promise<T> {
    return runNativeTransactionExclusive(
      `hd-pool:${resolve(this.dbLocation)}`,
      'single-realm',
      task
    )
  }
  protected async reloadAuthority(): Promise<void> {
    const records = new Map<number, SubAccountRecord>(),
      checkpoints = new Map<number, TerminalSubAccountCheckpoint>()
    let format: string | undefined,
      nextIndex = 0,
      binding: string | undefined
    let hasAuthority = false
    for await (const [key, value] of this.openedDb!.iterator({}) as any) {
      if (key === FORMAT_KEY) {
        format = value
        continue
      }
      if (key === WALLET_BINDING_KEY) {
        binding = value
        continue
      }
      if (key === NEXT_INDEX_KEY) {
        nextIndex = JSON.parse(value)
        assertSubAccountIndex(nextIndex, 'Stored next sub-account index')
        hasAuthority = true
        continue
      }
      hasAuthority = true
      const envelope = JSON.parse(value)
      if (
        Object.keys(envelope).sort().join(',') !== 'revision,value,version' ||
        envelope.version !== 4 ||
        !Number.isSafeInteger(envelope.revision) ||
        envelope.revision < 1 ||
        !envelope.value ||
        envelope.value.revision !== undefined
      )
        throw new Error(
          'Unsupported or corrupt authoritative pool envelope; owner disposition required'
        )
      const entry = { ...envelope.value, revision: envelope.revision }
      validatePoolEntry(entry)
      if (key === `${CHECKPOINT_PREFIX}${entry.index}`)
        checkpoints.set(entry.index, entry)
      else if (String(entry.index) === key) records.set(entry.index, entry)
      else throw new Error('Pool key does not match index')
    }
    if (
      (format !== undefined && format !== FORMAT) ||
      (format === undefined && hasAuthority)
    )
      throw new Error(
        'Unsupported pool baseline; owner disposition required; existing bytes preserved'
      )
    for (const [index] of records)
      if (checkpoints.has(index))
        throw new Error('Pool row also has terminal checkpoint')
    for (const index of [...records.keys(), ...checkpoints.keys()])
      if (index >= nextIndex)
        throw new Error('Pool high-water mark is inconsistent')
    if (
      this.expectedBindingId !== undefined &&
      ((binding !== undefined && binding !== this.expectedBindingId) ||
        (binding === undefined && hasAuthority))
    )
      throw new Error(
        'Sub-account store wallet binding mismatch or missing binding'
      )
    this.recordsByIndex = records
    this.checkpointsByIndex = checkpoints
    this.nextIndex = nextIndex
    this.loadedBindingId = binding
    this.bound = binding !== undefined
    this.initialized = format === FORMAT
  }
  protected assertReadable(): void {
    super.assertReadable()
    if (!this.accepting) throw new Error('Pool store is closing')
  }
  bindingId(): string | undefined {
    this.assertReadable()
    return this.loadedBindingId
  }
  async Bind(): Promise<void> {
    this.assertMutationAllowed()
    await this.mutate(() => ({ result: undefined }))
  }
  protected needsInitialization(): boolean {
    return (
      !this.initialized || (this.expectedBindingId !== undefined && !this.bound)
    )
  }
  protected async persist(
    records: ReadonlyMap<number, SubAccountRecord>,
    checkpoints: ReadonlyMap<number, TerminalSubAccountCheckpoint>,
    nextIndex: number
  ): Promise<void> {
    this.assertMutationAllowed()
    const writes: Array<
      { type: 'put'; key: string; value: string } | { type: 'del'; key: string }
    > = [
      { type: 'put', key: FORMAT_KEY, value: FORMAT },
      { type: 'put', key: NEXT_INDEX_KEY, value: JSON.stringify(nextIndex) },
    ]
    if (this.expectedBindingId !== undefined && !this.bound)
      writes.push({
        type: 'put',
        key: WALLET_BINDING_KEY,
        value: this.expectedBindingId,
      })
    for (const [index, value] of records) {
      if (
        JSON.stringify(value) !== JSON.stringify(this.recordsByIndex.get(index))
      )
        writes.push({
          type: 'put',
          key: String(index),
          value: JSON.stringify({
            version: 4,
            revision: value.revision,
            value: poolPayload(value),
          }),
        })
    }
    for (const [index, value] of checkpoints) {
      if (
        JSON.stringify(value) !==
        JSON.stringify(this.checkpointsByIndex.get(index))
      ) {
        writes.push({
          type: 'put',
          key: `${CHECKPOINT_PREFIX}${index}`,
          value: JSON.stringify({
            version: 4,
            revision: value.revision,
            value: poolPayload(value),
          }),
        })
        writes.push({ type: 'del', key: String(index) })
      }
    }
    await durableBatch(this.openedDb!, writes)
    this.initialized = true
    if (this.expectedBindingId !== undefined) {
      this.loadedBindingId = this.expectedBindingId
      this.bound = true
    }
  }
  async Close(): Promise<void> {
    if (!this.openedDb) return
    this.accepting = false
    await this.tail
    await this.openedDb.close()
    this.openedDb = undefined
    this.closed = true
  }
}
