/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  isSafeRelayCursor,
  isSafeRelayTimestamp,
  MessageStore,
  MessageResult,
  MessageReturnResult,
  RelayDeliverySuppression,
  RelayReceiptIdentity,
} from './storage'
import { MessageWrapper } from '../../types/messages'
import level, { LevelDB } from 'level'
import { join } from 'path'

const metadataKeys = {
  schemaVersion: 'schemaVersion',
  lastServerTime: 'lastServerTime',
}

const suppressionIndexPrefix = 'relaySuppressionIndex:'
const relayCursorPrefix = 'relayCursor:'
const relayReceiptPrefix = 'relayReceipt:'

function relayCursorKey(recipientAddress: string): string {
  return `${relayCursorPrefix}${recipientAddress.toLowerCase()}`
}

function suppressionIndexKey(recipientAddress: string): string {
  return `${suppressionIndexPrefix}${recipientAddress.toLowerCase()}`
}

function relayReceiptKey(
  recipientAddress: string,
  payloadDigest: string,
): string {
  return `${relayReceiptPrefix}${recipientAddress.toLowerCase()}:${payloadDigest}`
}

async function entriesWithPrefix(
  db: LevelDB,
  prefix: string,
): Promise<Array<{ key: string; value: string }>> {
  const entries: Array<{ key: string; value: string }> = []
  const iterator = db.iterator({
    gte: prefix,
    lt: `${prefix}\uffff`,
  })
  while (true) {
    const entry = await new Promise<
      { key: string; value: string } | undefined
    >((resolve, reject) => {
      iterator.next((error: Error, key: string, value: string) => {
        if (error) reject(error)
        else resolve(key ? { key, value } : undefined)
      })
    })
    if (!entry) break
    entries.push(entry)
  }
  await new Promise<void>((resolve, reject) => {
    iterator.end((error: Error) => (error ? reject(error) : resolve()))
  })
  return entries
}

type StoredSuppression = {
  payloadDigest: string
  receivedTime: number | null
}

type JsonMessageWrapper = Omit<MessageWrapper, 'message'> & {
  message: Omit<
    MessageWrapper['message'],
    'stampValueWei' | 'stampPayments'
  > & {
    stampValueWei?: string | number
    stampPayments?: Array<{
      txHash: string
      destinationAddress: string
      valueWei: string | number
    }>
  }
}

function parseStoredWei(
  value: string | number | undefined,
): bigint | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `Stored wei value is not a safe non-negative integer: ${value}`,
      )
    }
    return BigInt(value)
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(
      `Stored wei value is not an unsigned decimal integer: ${value}`,
    )
  }
  return BigInt(value)
}

/** Local schema v2: financial integers are decimal strings in JSON and bigint in memory. */
export function serializeMessageWrapper(
  messageWrapper: MessageWrapper,
): string {
  const { stampValueWei, stampPayments, ...message } = messageWrapper.message
  const stored: JsonMessageWrapper = {
    ...messageWrapper,
    message: {
      ...message,
      ...(stampValueWei === undefined
        ? {}
        : { stampValueWei: stampValueWei.toString() }),
      ...(stampPayments === undefined
        ? {}
        : {
            stampPayments: stampPayments.map(payment => ({
              ...payment,
              valueWei: payment.valueWei.toString(),
            })),
          }),
    },
  }
  return JSON.stringify(stored)
}

export function deserializeMessageWrapper(value: string): MessageWrapper {
  const stored = JSON.parse(value) as JsonMessageWrapper
  const { stampValueWei, stampPayments, ...message } = stored.message
  return {
    ...stored,
    message: {
      ...message,
      ...(stampValueWei === undefined
        ? {}
        : { stampValueWei: parseStoredWei(stampValueWei) }),
      ...(stampPayments === undefined
        ? {}
        : {
            stampPayments: stampPayments.map(payment => ({
              ...payment,
              valueWei: parseStoredWei(payment.valueWei) as bigint,
            })),
          }),
    },
  }
}

class MessageIterator implements AsyncIterableIterator<MessageWrapper> {
  iterator: any
  db: LevelDB

  constructor(db: LevelDB) {
    this.db = db
  }

  async next(): Promise<IteratorResult<MessageWrapper>> {
    while (true) {
      const entry = await new Promise<
        { key: string; value: string } | undefined
      >((resolve, reject) => {
        this.iterator.next((error: Error, key: string, value: string) => {
          if (error) {
            reject(error)
            return
          }
          if (!key) {
            this.iterator.end((error: Error) => {
              if (error) {
                reject(error)
                return
              }
              resolve(undefined)
            })
            return
          }
          resolve({ key, value })
        })
      })
      if (!entry) {
        return new MessageReturnResult()
      }
      if (
        entry.key !== metadataKeys.lastServerTime &&
        !entry.key.startsWith(suppressionIndexPrefix) &&
        !entry.key.startsWith(relayCursorPrefix) &&
        !entry.key.startsWith(relayReceiptPrefix)
      ) {
        return new MessageResult(deserializeMessageWrapper(entry.value))
      }
    }
  }

  async return(): Promise<IteratorResult<MessageWrapper>> {
    return new Promise((resolve, reject) => {
      this.iterator.end((error: Error) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ done: true, value: undefined })
      })
    })
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<MessageWrapper> {
    this.iterator = this.db.iterator({})
    return this
  }
}

const currentSchemaVersion = 4

export class LevelMessageStore implements MessageStore {
  private messageDbLocation: string
  private metadataDbLocation: string
  private schemaVersion?: number
  private openedDb?: LevelDB
  private openedMetadataDb?: LevelDB
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(location: string) {
    this.messageDbLocation = join(location, 'messages')
    this.metadataDbLocation = join(location, 'metadata')
  }

  async Open() {
    this.openedDb = level(this.messageDbLocation)
    this.openedMetadataDb = level(this.metadataDbLocation)

    const dbSchemaVersion = await this.getSchemaVersion()
    if (!dbSchemaVersion) {
      await this.setSchemaVersion(currentSchemaVersion)
    } else if (dbSchemaVersion < currentSchemaVersion) {
      // Records remain backward-readable. Schema v4 deliberately does not copy legacy cursors
      // from metadata: those cursors predate same-database receipt ordering and must replay.
      await this.setSchemaVersion(currentSchemaVersion)
    } else if (dbSchemaVersion > currentSchemaVersion) {
      console.warn('Newer DB found. Client downgraded?')
    }
    await this.migrateRelayAuthorityOutOfMessageDb()
    await this.recoverRelayReceipts()
  }

  /** c087f6e briefly wrote relay authority into the iterable message database. Move those keys
   * before Open resolves so the unchanged v2 reader can still open this store after a rollback. */
  private async migrateRelayAuthorityOutOfMessageDb(): Promise<void> {
    const legacy = [
      ...(await entriesWithPrefix(this.db, relayCursorPrefix)),
      ...(await entriesWithPrefix(this.db, suppressionIndexPrefix)),
    ]
    if (legacy.length === 0) return
    // The message-db copy was c087f6e's active authority; overwrite any older metadata-db value.
    await (this.metadataDb as any).batch(
      legacy.map(entry => ({ type: 'put', ...entry })),
      { sync: true },
    )
    await (this.db as any).batch(
      legacy.map(({ key }) => ({ type: 'del', key })),
      { sync: true },
    )
  }

  /** Relay receipt journals are authoritative browser crash-recovery copies committed in the
   * same IndexedDB/Level transaction as cursor authority. Reapply them on every Open; deletion
   * tombstones win and make an interrupted message-database delete repeatable. */
  private async recoverRelayReceipts(): Promise<void> {
    const suppressed = new Set<string>()
    for (const { value } of await entriesWithPrefix(
      this.metadataDb,
      suppressionIndexPrefix,
    )) {
      const parsed: unknown = JSON.parse(value)
      if (!Array.isArray(parsed)) continue
      for (const entry of parsed) {
        if (
          entry !== null &&
          typeof entry === 'object' &&
          typeof entry.payloadDigest === 'string'
        ) {
          suppressed.add(entry.payloadDigest)
        }
      }
    }
    const operations: Array<
      | { type: 'put'; key: string; value: string }
      | { type: 'del'; key: string }
    > = []
    for (const { value } of await entriesWithPrefix(
      this.metadataDb,
      relayReceiptPrefix,
    )) {
      const wrapper = deserializeMessageWrapper(value)
      operations.push(
        suppressed.has(wrapper.index)
          ? { type: 'del', key: wrapper.index }
          : { type: 'put', key: wrapper.index, value },
      )
    }
    for (const payloadDigest of suppressed) {
      operations.push({ type: 'del', key: payloadDigest })
    }
    if (operations.length > 0) {
      await (this.db as any).batch(operations, { sync: true })
    }
  }

  async Close() {
    await this.mutationQueue
    await Promise.all([this.db.close(), this.metadataDb.close()])
  }

  get db() {
    if (!this.openedDb) {
      throw new Error('No db opened')
    }
    return this.openedDb
  }

  get metadataDb() {
    if (!this.openedMetadataDb) {
      throw new Error('No db opened')
    }
    return this.openedMetadataDb
  }

  private getMetadataDatabase() {
    return level(this.messageDbLocation)
  }

  async getMessage(payloadDigest: string): Promise<MessageWrapper | undefined> {
    try {
      const value = await this.db.get(payloadDigest)
      return deserializeMessageWrapper(value)
    } catch (err: any) {
      if (err.type === 'NotFoundError') {
        return
      }
      throw err
    }
  }

  async deleteMessage(payloadDigest: string): Promise<void> {
    const deletion = this.mutationQueue.then(() =>
      this.db.del(payloadDigest, { sync: true }),
    )
    this.mutationQueue = deletion.then(
      () => undefined,
      () => undefined,
    )
    await deletion
  }

  private async suppressionIndex(
    recipientAddress: string,
  ): Promise<StoredSuppression[]> {
    try {
      const parsed = JSON.parse(
        await this.metadataDb.get(suppressionIndexKey(recipientAddress)),
      )
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((entry): StoredSuppression[] => {
        if (
          entry === null ||
          typeof entry !== 'object' ||
          typeof entry.payloadDigest !== 'string'
        ) {
          return []
        }
        // Corrupt timing metadata must not discard the deletion intent. Retain the tombstone as
        // unresolved so it can suppress a later authoritative relay receipt, but never use the
        // untrusted value for collection.
        return [
          {
            payloadDigest: entry.payloadDigest,
            receivedTime: isSafeRelayTimestamp(entry.receivedTime)
              ? entry.receivedTime
              : null,
          },
        ]
      })
    } catch (err: any) {
      if (err.type === 'NotFoundError') return []
      throw err
    }
  }

  async suppressAndDelete(
    recipientAddress: string,
    payloadDigests: string[],
    suppressions: RelayDeliverySuppression[],
  ): Promise<void> {
    const mutation = this.mutationQueue.then(async () => {
      const byDigest = new Map(
        (await this.suppressionIndex(recipientAddress)).map(entry => [
          entry.payloadDigest,
          entry.receivedTime,
        ]),
      )
      const cursor = await this.relayCursor(recipientAddress)
      for (const suppression of suppressions) {
        const receivedTime = suppression.receivedTime
        if (receivedTime !== undefined && !isSafeRelayTimestamp(receivedTime)) {
          throw new Error('Unsafe relay receipt timestamp in suppression')
        }
        // A known receipt strictly behind durable cursor authority cannot replay. Do not create
        // a tombstone that would have no future receipt available to collect it.
        if (receivedTime !== undefined && cursor > receivedTime) continue
        const existing = byDigest.get(suppression.payloadDigest)
        byDigest.set(
          suppression.payloadDigest,
          receivedTime ?? existing ?? null,
        )
      }
      const entries = [...byDigest].map(([payloadDigest, receivedTime]) => ({
        payloadDigest,
        receivedTime,
      }))
      await (this.metadataDb as any).batch(
        [
          entries.length === 0
            ? { type: 'del', key: suppressionIndexKey(recipientAddress) }
            : {
                type: 'put',
                key: suppressionIndexKey(recipientAddress),
                value: JSON.stringify(entries),
              },
          ...[...new Set(payloadDigests)].map(payloadDigest => ({
            type: 'del',
            key: relayReceiptKey(recipientAddress, payloadDigest),
          })),
        ],
        { sync: true },
      )
      await (this.db as any).batch(
        [...new Set(payloadDigests)].map(payloadDigest => ({
          type: 'del',
          key: payloadDigest,
        })),
        { sync: true },
      )
    })
    this.mutationQueue = mutation.then(
      () => undefined,
      () => undefined,
    )
    await mutation
  }

  async suppressedRelayReceipts(
    recipientAddress: string,
    receipts: RelayReceiptIdentity[],
  ): Promise<Set<string>> {
    const mutation = this.mutationQueue.then(async () => {
      const entries = await this.suppressionIndex(recipientAddress)
      const byDigest = new Map(
        entries.map(entry => [entry.payloadDigest, entry.receivedTime]),
      )
      const suppressed = new Set<string>()
      let changed = false
      for (const receipt of receipts) {
        if (!isSafeRelayTimestamp(receipt.receivedTime)) {
          throw new Error('Unsafe relay receipt timestamp')
        }
        if (!byDigest.has(receipt.payloadDigest)) continue
        suppressed.add(receipt.payloadDigest)
        if (byDigest.get(receipt.payloadDigest) === null) {
          byDigest.set(receipt.payloadDigest, receipt.receivedTime)
          changed = true
        }
      }
      if (changed) {
        await this.metadataDb.put(
          suppressionIndexKey(recipientAddress),
          JSON.stringify(
            [...byDigest].map(([payloadDigest, receivedTime]) => ({
              payloadDigest,
              receivedTime,
            })),
          ),
          { sync: true },
        )
      }
      return suppressed
    })
    this.mutationQueue = mutation.then(
      () => undefined,
      () => undefined,
    )
    return mutation
  }

  async saveMessage(
    messageWrapper: MessageWrapper,
    { advanceCursor = true }: { advanceCursor?: boolean } = {},
  ): Promise<void> {
    const save = this.mutationQueue.then(async () => {
      if (!advanceCursor) {
        await this.db.put(
          messageWrapper.index,
          serializeMessageWrapper(messageWrapper),
          { sync: true },
        )
        return
      }
      const lastServerTime = await this.mostRecentMessageTime()
      const nextServerTime = Math.max(
        lastServerTime,
        messageWrapper.message.serverTime,
      )
      // level@7 exposes atomic batch writes at runtime, but this repository's legacy `LevelDB`
      // type alias omits the method.
      await (this.db as any).batch(
        [
          {
            type: 'put',
            key: messageWrapper.index,
            value: serializeMessageWrapper(messageWrapper),
          },
          {
            type: 'put',
            key: metadataKeys.lastServerTime,
            value: JSON.stringify(nextServerTime),
          },
        ],
        { sync: true },
      )
    })
    this.mutationQueue = save.then(
      () => undefined,
      () => undefined,
    )
    await save
  }

  async mostRecentMessageTime(newLastServerTime?: number): Promise<number> {
    const jsonNewLastServerTime = JSON.stringify(newLastServerTime || 0)
    try {
      const lastServerTimeString: string = await this.db.get(
        metadataKeys.lastServerTime,
      )
      const lastServerTime = JSON.parse(lastServerTimeString)
      if (!lastServerTime) {
        await this.db.put(metadataKeys.lastServerTime, jsonNewLastServerTime)
      }
      if (!newLastServerTime) {
        return JSON.parse(lastServerTime)
      }
      if (lastServerTime < newLastServerTime) {
        await this.db.put(metadataKeys.lastServerTime, jsonNewLastServerTime)
      }
      return Math.max(newLastServerTime, lastServerTime)
    } catch (err: any) {
      if (err.type === 'NotFoundError') {
        if (newLastServerTime) {
          await this.db.put(metadataKeys.lastServerTime, jsonNewLastServerTime)
          return newLastServerTime
        }
        return 0
      }
      throw err
    }
  }

  /** Recipient-scoped mailbox progress. The legacy global `lastServerTime` is deliberately not
   * migrated because it mixed identities and local clocks. Recipient cursors live in the
   * non-iterable metadata database beside their authoritative receipt journals. */
  async relayCursor(recipientAddress: string): Promise<number> {
    try {
      const cursor: unknown = JSON.parse(
        await this.metadataDb.get(relayCursorKey(recipientAddress)),
      )
      return isSafeRelayCursor(cursor) ? cursor : 0
    } catch (err: any) {
      if (err.type === 'NotFoundError') return 0
      throw err
    }
  }

  async advanceRelayCursor(
    recipientAddress: string,
    nextReceivedTime: number,
    suppressedReceipts: RelayReceiptIdentity[] = [],
    durableReceipts: MessageWrapper[] = [],
  ): Promise<number> {
    const advance = this.mutationQueue.then(async () => {
      if (!isSafeRelayCursor(nextReceivedTime)) {
        throw new Error('Unsafe relay cursor timestamp')
      }
      if (
        suppressedReceipts.some(
          receipt => !isSafeRelayTimestamp(receipt.receivedTime),
        )
      ) {
        throw new Error('Unsafe relay receipt timestamp')
      }
      if (
        durableReceipts.some(
          receipt =>
            !isSafeRelayTimestamp(receipt.message.receivedTime) ||
            receipt.message.destinationAddress?.toLowerCase() !==
              recipientAddress.toLowerCase(),
        )
      ) {
        throw new Error('Invalid durable relay receipt')
      }
      const current = await this.relayCursor(recipientAddress)
      const next = Math.max(current, nextReceivedTime)
      // Cursor authority, a complete receipt journal, and suppression collection share one
      // metadata-database transaction. `level-js` maps this batch to one IndexedDB transaction,
      // so a browser crash can never retain the cursor without a recoverable receipt copy.
      const observed = new Map(
        suppressedReceipts.map(receipt => [
          receipt.payloadDigest,
          receipt.receivedTime,
        ]),
      )
      const remaining = (await this.suppressionIndex(recipientAddress)).filter(
        entry => {
          const receivedTime = observed.get(entry.payloadDigest)
          const safeAfter = receivedTime ?? entry.receivedTime
          return safeAfter === null || next <= safeAfter
        },
      )
      await (this.metadataDb as any).batch(
        [
          ...(next === current
            ? []
            : [
                {
                  type: 'put',
                  key: relayCursorKey(recipientAddress),
                  value: JSON.stringify(next),
                },
              ]),
          remaining.length === 0
            ? { type: 'del', key: suppressionIndexKey(recipientAddress) }
            : {
                type: 'put',
                key: suppressionIndexKey(recipientAddress),
                value: JSON.stringify(remaining),
              },
          ...durableReceipts.map(receipt => ({
            type: 'put',
            key: relayReceiptKey(recipientAddress, receipt.index),
            value: serializeMessageWrapper(receipt),
          })),
        ],
        { sync: true },
      )
      return next
    })
    this.mutationQueue = advance.then(
      () => undefined,
      () => undefined,
    )
    return advance
  }

  private async getSchemaVersion(): Promise<number> {
    if (this.schemaVersion) {
      return this.schemaVersion
    }

    try {
      const value: string = await this.metadataDb.get(
        metadataKeys.schemaVersion,
      )
      return JSON.parse(value)
    } catch (err: any) {
      if (err.type === 'NotFoundError') {
        return 0
      }
      throw err
    }
  }

  private async setSchemaVersion(schemaVersion: number): Promise<void> {
    await this.metadataDb.put(
      metadataKeys.schemaVersion,
      JSON.stringify(schemaVersion),
    )
    // Update cache
    this.schemaVersion = schemaVersion
  }

  async getIterator(): Promise<AsyncIterableIterator<MessageWrapper>> {
    return new MessageIterator(this.db)
  }

  /**
   * This will delete everything in the store! Don't call it by accident!
   */
  async clear() {
    const clearing = this.mutationQueue.then(async () => {
      await this.db.clear()
      await this.metadataDb.clear()
    })
    this.mutationQueue = clearing.then(
      () => undefined,
      () => undefined,
    )
    await clearing
  }
}
