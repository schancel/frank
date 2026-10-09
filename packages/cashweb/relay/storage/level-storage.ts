/* eslint-disable @typescript-eslint/no-explicit-any */
import {
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

// Relay delivery bookkeeping lives in the METADATA database, never in the message database: a
// pre-#420 (schema v2) reader iterates every message-database row and feeds it to
// `deserializeMessageWrapper`, so any non-message row here would wedge chat restoration after a
// client rollback. See the class header for the full durability contract.
const suppressionIndexPrefix = 'relaySuppressionIndex:'
const quarantineIndexPrefix = 'relayQuarantineIndex:'
function suppressionIndexKey(recipientAddress: string): string {
  return `${suppressionIndexPrefix}${recipientAddress.toLowerCase()}`
}

function quarantineIndexKey(recipientAddress: string): string {
  return `${quarantineIndexPrefix}${recipientAddress.toLowerCase()}`
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

export class MessageStoreError extends Error {
  constructor(
    readonly code: 'unsupported-schema' | 'unavailable' | 'write-uncertain',
    readonly cause?: unknown,
  ) {
    super(`Message store ${code}`)
    this.name = 'MessageStoreError'
  }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { notFound?: unknown; type?: unknown; code?: unknown }
  return (
    value.notFound === true ||
    value.type === 'NotFoundError' ||
    value.code === 'LEVEL_NOT_FOUND'
  )
}

class MessageIterator implements AsyncIterableIterator<MessageWrapper> {
  private readonly iterator: ReturnType<LevelDB['iterator']>
  private ending?: Promise<void>

  constructor(
    db: LevelDB,
    private readonly assertReadable: () => void,
    private readonly released: () => void,
  ) {
    this.iterator = db.iterator({})
  }

  private end(): Promise<void> {
    if (!this.ending) {
      this.ending = new Promise<void>((resolve, reject) => {
        this.iterator.end((error?: Error) => {
          this.released()
          if (error) reject(error)
          else resolve()
        })
      })
    }
    return this.ending
  }

  async next(): Promise<IteratorResult<MessageWrapper>> {
    this.assertReadable()
    if (this.ending) {
      await this.ending
      return new MessageReturnResult()
    }
    try {
      while (true) {
        const entry = await new Promise<
          { key: string; value: string } | undefined
        >((resolve, reject) => {
          this.iterator.next(
            (error: Error, key: string | undefined, value: string) => {
              if (error) reject(error)
              else resolve(key === undefined ? undefined : { key, value })
            },
          )
        })
        if (!entry) {
          await this.end()
          return new MessageReturnResult()
        }
        if (entry.key !== metadataKeys.lastServerTime)
          return new MessageResult(deserializeMessageWrapper(entry.value))
      }
    } catch (error) {
      await this.end().catch(() => undefined)
      throw error
    }
  }

  async return(): Promise<IteratorResult<MessageWrapper>> {
    await this.end()
    return new MessageReturnResult()
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<MessageWrapper> {
    return this
  }
}

const currentSchemaVersion = 2

/**
 * Message persistence with a crash-safe relay mailbox frontier.
 *
 * ## Why the frontier is derived, never persisted (browser receipt durability)
 *
 * The frontier for a recipient is recomputed from the durable records that justify it: inbound
 * message receipts plus suppression/quarantine anchors. It is deliberately NOT written as its own
 * row. On Node `level` (RocksDB) a `{ sync: true }` write is durable and completed writes survive
 * as an ordered prefix, so the previous receipt-put-then-cursor-batch sequencing was safe. The
 * browser build resolves `level` to `level-js`, which runs every write as its own default-
 * durability IndexedDB transaction, ignores the sync option, and does not promise that separately
 * completed transactions survive as an ordered prefix: a power loss could retain a later cursor
 * batch while losing the earlier receipt put, permanently skipping a delivered row. With no
 * persisted cursor, that unsafe state is unrepresentable -- the frontier can never name a time
 * whose receipt evidence is missing, because it is computed FROM that evidence. The cost is one
 * extra re-fetched (and digest-deduped) timestamp group after a restart.
 *
 * ## Suppression and quarantine anchors
 *
 * A deleted message's receipt must never redeliver, and a terminally undeliverable row (registry
 * says the sender has no account) must not pin the bounded inbox scan. Both are durable anchors
 * in the metadata database; like receipts they only ever RAISE the derived frontier. Tombstone
 * collection (dropping an anchor once the frontier has passed it) is intentionally absent: an
 * anchor dropped while the receipt evidence behind it was lost to relaxed writeback would let a
 * deleted message redeliver. Anchors are bounded by user deletions instead.
 */
export class LevelMessageStore implements MessageStore {
  private messageDbLocation: string
  private metadataDbLocation: string
  private schemaVersion?: number
  private openedDb?: LevelDB
  private openedMetadataDb?: LevelDB
  private mutationQueue: Promise<void> = Promise.resolve()
  private state: 'new' | 'opening' | 'open' | 'failed' | 'closed' = 'new'
  private opening?: Promise<void>
  private closing?: Promise<void>
  private readonly iterators = new Set<MessageIterator>()

  constructor(location: string) {
    this.messageDbLocation = join(location, 'messages')
    this.metadataDbLocation = join(location, 'metadata')
  }

  /** A closed or failed lifetime is never reused; recovery opens a fresh instance. */
  Open(): Promise<void> {
    if (this.closing || this.state === 'closed' || this.state === 'failed')
      return Promise.reject(new MessageStoreError('unavailable'))
    if (this.opening) return this.opening
    this.state = 'opening'
    this.opening = this.openValidated()
    return this.opening
  }

  private openDatabase(
    location: string,
    installed: (db: LevelDB) => void,
  ): Promise<void> {
    // level auto-opens on construction. Supply its actual callback so an opening
    // failure is observed instead of emitted as an unhandled EventEmitter error.
    const factory = level as unknown as (
      path: string,
      options: object,
      callback: (error?: Error) => void,
    ) => LevelDB
    return new Promise<void>((resolve, reject) => {
      installed(
        factory(location, {}, error => (error ? reject(error) : resolve())),
      )
    })
  }

  private async hasAnyKey(db: LevelDB): Promise<boolean> {
    const iterator = db.iterator({ limit: 1, values: false })
    return new Promise<boolean>((resolve, reject) => {
      iterator.next((error: Error, key: string | undefined) => {
        iterator.end((endError?: Error) => {
          if (error || endError) reject(error || endError)
          else resolve(key !== undefined)
        })
      })
    })
  }

  private async openValidated(): Promise<void> {
    try {
      await this.openDatabase(this.messageDbLocation, db => {
        this.openedDb = db
      })
      await this.openDatabase(this.metadataDbLocation, db => {
        this.openedMetadataDb = db
      })
      let marker: string | undefined
      try {
        marker = await this.openedMetadataDb!.get(metadataKeys.schemaVersion)
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      if (marker === undefined) {
        if (
          (await this.hasAnyKey(this.openedDb!)) ||
          (await this.hasAnyKey(this.openedMetadataDb!))
        )
          throw new MessageStoreError('unsupported-schema')
      } else {
        let parsed: unknown
        try {
          parsed = JSON.parse(marker)
        } catch (cause) {
          throw new MessageStoreError('unsupported-schema', cause)
        }
        if (parsed !== currentSchemaVersion)
          throw new MessageStoreError('unsupported-schema')
        this.schemaVersion = currentSchemaVersion
      }
      this.state = 'open'
    } catch (error) {
      this.state = 'failed'
      await this.closeHandles().catch(() => undefined)
      throw error instanceof MessageStoreError
        ? error
        : new MessageStoreError('unavailable', error)
    }
  }

  private assertValidated(): void {
    if (this.state !== 'open') throw new MessageStoreError('unavailable')
  }

  private assertAvailable(): void {
    this.assertValidated()
    if (this.closing) throw new MessageStoreError('unavailable')
  }

  private async closeHandles(): Promise<void> {
    const handles = [this.openedDb, this.openedMetadataDb]
    const results = await Promise.allSettled(handles.map(db => db?.close()))
    // Keep a failed cleanup handle available to a subsequent Close; validation
    // failure must not abandon a backend that still owns its lock.
    if (results[0].status === 'fulfilled') this.openedDb = undefined
    if (results[1].status === 'fulfilled') this.openedMetadataDb = undefined
    for (const result of results)
      if (result.status === 'rejected') throw result.reason
  }

  Close(): Promise<void> {
    if (!this.closing) {
      const closing = (async () => {
        await this.opening?.catch(() => undefined)
        await this.mutationQueue
        const ended = await Promise.allSettled(
          [...this.iterators].map(iterator => iterator.return()),
        )
        this.state = 'closed'
        const closed = await Promise.allSettled([this.closeHandles()])
        for (const result of [...ended, ...closed])
          if (result.status === 'rejected') throw result.reason
      })()
      this.closing = closing
      void closing.catch(() => {
        if (this.closing === closing) this.closing = undefined
      })
    }
    return this.closing
  }

  get db(): LevelDB {
    this.assertValidated()
    return this.openedDb!
  }

  get metadataDb(): LevelDB {
    this.assertValidated()
    return this.openedMetadataDb!
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAvailable()
    const mutation = this.mutationQueue.then(() => {
      this.assertValidated()
      return operation()
    })
    this.mutationQueue = mutation.then(
      () => undefined,
      () => undefined,
    )
    return mutation
  }

  /** Marker-first application ordering, not a transaction across the two databases. */
  private async initializeForWrite(): Promise<void> {
    if (this.schemaVersion === currentSchemaVersion) return
    try {
      await this.metadataDb.put(
        metadataKeys.schemaVersion,
        JSON.stringify(currentSchemaVersion),
        { sync: true },
      )
      this.schemaVersion = currentSchemaVersion
    } catch (cause) {
      this.state = 'failed'
      throw new MessageStoreError('write-uncertain', cause)
    }
  }

  async getMessage(payloadDigest: string): Promise<MessageWrapper | undefined> {
    this.assertAvailable()
    try {
      const value = await this.db.get(payloadDigest)
      return deserializeMessageWrapper(value)
    } catch (err: any) {
      if (isNotFound(err)) {
        return
      }
      throw err
    }
  }

  async deleteMessage(payloadDigest: string): Promise<void> {
    await this.mutate(async () => {
      if (!(await this.hasMessageKey(payloadDigest))) return
      await this.initializeForWrite()
      await this.db.del(payloadDigest, { sync: true })
    })
  }

  private async hasMessageKey(key: string): Promise<boolean> {
    try {
      await this.db.get(key)
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  }

  private async suppressionIndex(
    recipientAddress: string,
  ): Promise<StoredSuppression[]> {
    return this.readStoredSuppression(suppressionIndexKey(recipientAddress))
  }

  private async readStoredSuppression(
    key: string,
  ): Promise<StoredSuppression[]> {
    try {
      const parsed = JSON.parse(await this.metadataDb.get(key))
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
      if (isNotFound(err)) return []
      throw err
    }
  }

  async suppressAndDelete(
    recipientAddress: string,
    payloadDigests: string[],
    suppressions: RelayDeliverySuppression[],
  ): Promise<void> {
    const requested = suppressions.map(entry => ({ ...entry }))
    const digests = [...new Set(payloadDigests)]
    await this.mutate(async () => {
      const byDigest = new Map(
        (await this.suppressionIndex(recipientAddress)).map(entry => [
          entry.payloadDigest,
          entry.receivedTime,
        ]),
      )
      let changed = false
      for (const suppression of requested) {
        if (
          suppression.receivedTime !== undefined &&
          !isSafeRelayTimestamp(suppression.receivedTime)
        )
          throw new Error('Unsafe relay receipt timestamp in suppression')
        const time =
          suppression.receivedTime ??
          byDigest.get(suppression.payloadDigest) ??
          null
        if (
          !byDigest.has(suppression.payloadDigest) ||
          byDigest.get(suppression.payloadDigest) !== time
        )
          changed = true
        byDigest.set(suppression.payloadDigest, time)
      }
      const deleted: string[] = []
      for (const digest of digests)
        if (await this.hasMessageKey(digest)) deleted.push(digest)
      if (!changed && deleted.length === 0) return
      await this.initializeForWrite()
      // Anchor-before-deletion is application ordering, not cross-database atomicity.
      if (changed)
        await (this.metadataDb as any).batch(
          [
            {
              type: 'put',
              key: suppressionIndexKey(recipientAddress),
              value: JSON.stringify(
                [...byDigest].map(([payloadDigest, receivedTime]) => ({
                  payloadDigest,
                  receivedTime,
                })),
              ),
            },
          ],
          { sync: true },
        )
      if (deleted.length)
        await (this.db as any).batch(
          deleted.map(key => ({ type: 'del', key })),
          { sync: true },
        )
    })
  }

  /** This operation can write: a delayed receipt resolves an existing suppression anchor. */
  async suppressedRelayReceipts(
    recipientAddress: string,
    receipts: RelayReceiptIdentity[],
  ): Promise<Set<string>> {
    const requested = receipts.map(entry => ({ ...entry }))
    return this.mutate(async () => {
      const entries = await this.suppressionIndex(recipientAddress)
      const byDigest = new Map(
        entries.map(entry => [entry.payloadDigest, entry.receivedTime]),
      )
      const suppressed = new Set<string>()
      let changed = false
      for (const receipt of requested) {
        if (!isSafeRelayTimestamp(receipt.receivedTime))
          throw new Error('Unsafe relay receipt timestamp')
        if (!byDigest.has(receipt.payloadDigest)) continue
        suppressed.add(receipt.payloadDigest)
        if (byDigest.get(receipt.payloadDigest) === null) {
          byDigest.set(receipt.payloadDigest, receipt.receivedTime)
          changed = true
        }
      }
      if (changed) {
        await this.initializeForWrite()
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
  }

  async quarantineRelayReceipts(
    recipientAddress: string,
    receipts: RelayReceiptIdentity[],
  ): Promise<void> {
    const requested = receipts.map(entry => ({ ...entry }))
    await this.mutate(async () => {
      const existing = await this.readStoredSuppression(
        quarantineIndexKey(recipientAddress),
      )
      const byDigest = new Map(
        existing.map(entry => [entry.payloadDigest, entry.receivedTime]),
      )
      let changed = false
      for (const receipt of requested) {
        if (!isSafeRelayTimestamp(receipt.receivedTime))
          throw new Error('Unsafe relay receipt timestamp')
        if (byDigest.get(receipt.payloadDigest) !== receipt.receivedTime)
          changed = true
        byDigest.set(receipt.payloadDigest, receipt.receivedTime)
      }
      if (!changed) return
      await this.initializeForWrite()
      await this.metadataDb.put(
        quarantineIndexKey(recipientAddress),
        JSON.stringify(
          [...byDigest].map(([payloadDigest, receivedTime]) => ({
            payloadDigest,
            receivedTime,
          })),
        ),
        { sync: true },
      )
    })
  }

  async saveMessage(
    messageWrapper: MessageWrapper,
    { advanceCursor = true }: { advanceCursor?: boolean } = {},
  ): Promise<void> {
    const index = messageWrapper.index
    const value = serializeMessageWrapper(messageWrapper)
    const serverTime = messageWrapper.message.serverTime
    await this.mutate(async () => {
      if (!Number.isSafeInteger(serverTime) || serverTime < 0)
        throw new Error('Invalid message server timestamp')
      if (!advanceCursor) {
        await this.initializeForWrite()
        await this.db.put(index, value, { sync: true })
        return
      }
      const nextServerTime = Math.max(
        await this.readMostRecentMessageTime(),
        serverTime,
      )
      await this.initializeForWrite()
      // The message and timestamp remain one atomic batch in their shared database.
      await (this.db as any).batch(
        [
          { type: 'put', key: index, value },
          {
            type: 'put',
            key: metadataKeys.lastServerTime,
            value: JSON.stringify(nextServerTime),
          },
        ],
        { sync: true },
      )
    })
  }

  async mostRecentMessageTime(): Promise<number> {
    this.assertAvailable()
    return this.readMostRecentMessageTime()
  }

  private async readMostRecentMessageTime(): Promise<number> {
    let value: string
    try {
      value = await this.db.get(metadataKeys.lastServerTime)
    } catch (error) {
      if (isNotFound(error)) return 0
      throw error
    }
    const time: unknown = JSON.parse(value)
    if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0)
      throw new Error('Invalid stored message timestamp')
    return time
  }

  /** Recipient-scoped mailbox frontier, as an INCLUSIVE relay timestamp. Derived from the
   * durable receipt evidence only -- see the class header. Legacy metadata-database cursors from
   * earlier layouts are deliberately not trusted: those cursors predate same-evidence ordering
   * and replaying from the receipts is the conservative answer (duplicate relay rows are already
   * idempotent by payload digest). */
  async relayCursor(recipientAddress: string): Promise<number> {
    this.assertAvailable()
    const recipient = recipientAddress.toLowerCase()
    let frontier = 0
    await new Promise<void>((resolve, reject) => {
      const iterator = this.db.iterator({})
      const step = () => {
        iterator.next((error: Error, key: string, value: string) => {
          if (error) {
            iterator.end(() => reject(error))
            return
          }
          if (!key) {
            iterator.end((endError: Error | undefined) => {
              if (endError) {
                reject(endError)
                return
              }
              resolve()
            })
            return
          }
          if (key === metadataKeys.lastServerTime) {
            step()
            return
          }
          try {
            const parsed = JSON.parse(value)
            const message = parsed?.message
            if (
              message?.outbound === false &&
              typeof message.destinationAddress === 'string' &&
              message.destinationAddress.toLowerCase() === recipient &&
              isSafeRelayTimestamp(message.receivedTime)
            ) {
              frontier = Math.max(frontier, message.receivedTime)
            }
          } catch {
            // A corrupt row has no usable receipt evidence; restore surfaces it separately.
          }
          step()
        })
      }
      step()
    })
    for (const entry of await this.suppressionIndex(recipient)) {
      if (entry.receivedTime !== null) {
        frontier = Math.max(frontier, entry.receivedTime)
      }
    }
    for (const entry of await this.readStoredSuppression(
      quarantineIndexKey(recipient),
    )) {
      if (entry.receivedTime !== null) {
        frontier = Math.max(frontier, entry.receivedTime)
      }
    }
    return frontier
  }

  async getIterator(): Promise<AsyncIterableIterator<MessageWrapper>> {
    this.assertAvailable()
    const iterator = new MessageIterator(
      this.db,
      () => this.assertAvailable(),
      () => this.iterators.delete(iterator),
    )
    this.iterators.add(iterator)
    return iterator
  }

  /** Explicit destructive operation; never used to recover a rejected store. */
  async clear(): Promise<void> {
    await this.mutate(async () => {
      if (this.schemaVersion === undefined) return
      try {
        await this.db.clear()
        await this.metadataDb.clear()
        this.schemaVersion = undefined
      } catch (cause) {
        this.state = 'failed'
        throw new MessageStoreError('write-uncertain', cause)
      }
    })
  }
}
