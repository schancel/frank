/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'

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

  constructor(location: string) {
    this.dbLocation = join(location, 'outgoing-stamp-attempts')
  }
  private get db(): LevelDB {
    if (this.openedDb === undefined) throw new Error('No db opened')
    return this.openedDb
  }
  async Open(): Promise<void> {
    this.openedDb = level(this.dbLocation)
    for await (const [, value] of this.db.iterator({}) as any) {
      const attempt = JSON.parse(value) as OutgoingStampAttempt
      this.attempts.set(attempt.payloadHashHex, attempt)
    }
  }
  async Close(): Promise<void> {
    await this.db.close()
  }
  async put(attempt: OutgoingStampAttempt): Promise<void> {
    this.attempts.set(attempt.payloadHashHex, { ...attempt })
    await this.db.put(attempt.payloadHashHex, JSON.stringify(attempt))
  }
  async delete(payloadHashHex: string): Promise<void> {
    this.attempts.delete(payloadHashHex)
    await this.db.del(payloadHashHex)
  }
  getAll(): OutgoingStampAttempt[] {
    return Array.from(this.attempts.values())
  }
}
