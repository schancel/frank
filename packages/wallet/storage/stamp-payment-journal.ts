/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'

export type StampPaymentRecoveryStatus = 'discovered' | 'swept'

/** Public bookkeeping for a recipient-owned one-time stamp destination. Private child keys are
 * deliberately absent: they are reconstructed from the identity key only while attempting a
 * sweep. */
export interface StampPaymentRecoveryRecord {
  payloadHashHex: string
  childIndex: number
  txHash: string
  address: string
  valueWei: string
  status: StampPaymentRecoveryStatus
  sweepTxHash?: string
}

export interface StampPaymentJournal {
  get(
    payloadHashHex: string,
    childIndex: number,
  ): StampPaymentRecoveryRecord | undefined
  put(record: StampPaymentRecoveryRecord): Promise<void>
  getAll(): StampPaymentRecoveryRecord[]
}

function key(payloadHashHex: string, childIndex: number): string {
  return `${payloadHashHex}:${childIndex}`
}

export class InMemoryStampPaymentJournal implements StampPaymentJournal {
  private readonly records = new Map<string, StampPaymentRecoveryRecord>()

  get(
    payloadHashHex: string,
    childIndex: number,
  ): StampPaymentRecoveryRecord | undefined {
    return this.records.get(key(payloadHashHex, childIndex))
  }

  async put(record: StampPaymentRecoveryRecord): Promise<void> {
    this.records.set(key(record.payloadHashHex, record.childIndex), {
      ...record,
    })
  }

  getAll(): StampPaymentRecoveryRecord[] {
    return Array.from(this.records.values())
  }
}

export class LevelStampPaymentJournal implements StampPaymentJournal {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private readonly records = new Map<string, StampPaymentRecoveryRecord>()

  constructor(location: string) {
    this.dbLocation = join(location, 'stamp-payment-journal')
  }

  private get db(): LevelDB {
    if (this.openedDb === undefined) throw new Error('No db opened')
    return this.openedDb
  }

  async Open(): Promise<void> {
    this.openedDb = level(this.dbLocation)
    for await (const [, value] of this.db.iterator({}) as any) {
      const record = JSON.parse(value) as StampPaymentRecoveryRecord
      this.records.set(key(record.payloadHashHex, record.childIndex), record)
    }
  }

  async Close(): Promise<void> {
    await this.db.close()
  }

  get(
    payloadHashHex: string,
    childIndex: number,
  ): StampPaymentRecoveryRecord | undefined {
    return this.records.get(key(payloadHashHex, childIndex))
  }

  async put(record: StampPaymentRecoveryRecord): Promise<void> {
    const recordKey = key(record.payloadHashHex, record.childIndex)
    await this.db.put(recordKey, JSON.stringify(record))
    this.records.set(recordKey, { ...record })
  }

  getAll(): StampPaymentRecoveryRecord[] {
    return Array.from(this.records.values())
  }
}
