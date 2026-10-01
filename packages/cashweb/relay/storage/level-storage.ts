/* eslint-disable @typescript-eslint/no-explicit-any */
import { MessageStore, MessageResult, MessageReturnResult } from './storage'
import { MessageWrapper } from '../../types/messages'
import level, { LevelDB } from 'level'
import { join } from 'path'

const metadataKeys = {
  schemaVersion: 'schemaVersion',
  lastServerTime: 'lastServerTime',
}

function relayCursorKey(recipientAddress: string): string {
  return `relayCursor:${recipientAddress.toLowerCase()}`
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
      if (entry.key !== metadataKeys.lastServerTime) {
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

const currentSchemaVersion = 2

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
      // v2 remains able to read v1 records, whose Monad wei fields were absent (JSON.stringify
      // could not encode bigint). New and rewritten records use exact decimal strings.
      await this.setSchemaVersion(currentSchemaVersion)
    } else if (dbSchemaVersion > currentSchemaVersion) {
      console.warn('Newer DB found. Client downgraded?')
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
    const deletion = this.mutationQueue.then(() => this.db.del(payloadDigest))
    this.mutationQueue = deletion.then(
      () => undefined,
      () => undefined,
    )
    await deletion
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
      await (this.db as any).batch([
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
      ])
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
   * migrated: it mixed identities and local/outbound clocks, so replaying from zero is the only
   * conservative migration. Duplicate relay rows are already idempotent by payload digest. */
  async relayCursor(recipientAddress: string): Promise<number> {
    try {
      return JSON.parse(
        await this.metadataDb.get(relayCursorKey(recipientAddress)),
      )
    } catch (err: any) {
      if (err.type === 'NotFoundError') return 0
      throw err
    }
  }

  async advanceRelayCursor(
    recipientAddress: string,
    nextReceivedTime: number,
  ): Promise<number> {
    const advance = this.mutationQueue.then(async () => {
      const current = await this.relayCursor(recipientAddress)
      const next = Math.max(current, nextReceivedTime)
      if (next !== current) {
        await this.metadataDb.put(
          relayCursorKey(recipientAddress),
          JSON.stringify(next),
        )
      }
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
