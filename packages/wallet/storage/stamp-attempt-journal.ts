/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'

const WALLET_BINDING_KEY = '__wallet_binding__'

export interface OutgoingStampAttempt {
  payloadHashHex: string
  messageBytes: number[]
  leaseIndices: number[]
}

export interface StampAttemptJournal {
  put(attempt: OutgoingStampAttempt): Promise<void>
  delete(payloadHashHex: string): Promise<void>
  getAll(): OutgoingStampAttempt[]
}

export class InMemoryStampAttemptJournal implements StampAttemptJournal {
  private readonly attempts = new Map<string, OutgoingStampAttempt>()
  async put(attempt: OutgoingStampAttempt): Promise<void> {
    this.attempts.set(attempt.payloadHashHex, { ...attempt })
  }
  async delete(payloadHashHex: string): Promise<void> {
    this.attempts.delete(payloadHashHex)
  }
  getAll(): OutgoingStampAttempt[] {
    return Array.from(this.attempts.values())
  }
}

export class LevelStampAttemptJournal implements StampAttemptJournal {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private readonly attempts = new Map<string, OutgoingStampAttempt>()
  private readonly expectedBindingId?: string

  constructor(location: string, expectedBindingId?: string) {
    this.dbLocation = join(location, 'outgoing-stamp-attempts')
    this.expectedBindingId = expectedBindingId
  }
  private get db(): LevelDB {
    if (this.openedDb === undefined) throw new Error('No db opened')
    return this.openedDb
  }
  async Open(): Promise<void> {
    this.openedDb = level(this.dbLocation)
    let storedBindingId: string | undefined
    let hasRecords = false
    for await (const [key, value] of this.db.iterator({}) as any) {
      if (key === WALLET_BINDING_KEY) {
        storedBindingId = value
        continue
      }
      hasRecords = true
      const attempt = JSON.parse(value) as OutgoingStampAttempt
      this.attempts.set(attempt.payloadHashHex, attempt)
    }
    if (this.expectedBindingId !== undefined) {
      if (
        storedBindingId !== undefined &&
        storedBindingId !== this.expectedBindingId
      ) {
        throw new Error(
          'Stamp-attempt journal belongs to a different wallet root',
        )
      }
      if (storedBindingId === undefined && hasRecords) {
        throw new Error(
          'Refusing to adopt an unbound non-empty stamp-attempt journal',
        )
      }
    }
  }
  async Bind(): Promise<void> {
    if (this.expectedBindingId === undefined) return
    await this.db.put(WALLET_BINDING_KEY, this.expectedBindingId)
  }
  async Close(): Promise<void> {
    await this.db.close()
  }
  async put(attempt: OutgoingStampAttempt): Promise<void> {
    await this.db.put(attempt.payloadHashHex, JSON.stringify(attempt))
    this.attempts.set(attempt.payloadHashHex, { ...attempt })
  }
  async delete(payloadHashHex: string): Promise<void> {
    await this.db.del(payloadHashHex)
    this.attempts.delete(payloadHashHex)
  }
  getAll(): OutgoingStampAttempt[] {
    return Array.from(this.attempts.values())
  }
}
