/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'
import { durablePut, openDurableLevel } from './level-durability'

export type StampPaymentRecoveryStatus =
  | 'discovered'
  | 'sweep-pending'
  | 'swept'

/** Public bookkeeping for a recipient-owned one-time stamp destination. Private child keys are
 * deliberately absent: they are reconstructed from the identity key only while attempting a
 * sweep. A pending sweep retains only its already-signed transaction bytes so a restart can
 * reconcile or replay the exact transaction without creating a conflicting nonce spend. */
export interface StampPaymentRecoveryRecord {
  payloadHashHex: string
  childIndex: number
  txHash: string
  address: string
  valueWei: string
  status: StampPaymentRecoveryStatus
  sweepTxHash?: string
  sweepRawTx?: string
  sweepValueWei?: string
  sweepDestinationAddress?: string
}

export interface StampPaymentJournal {
  /** True only if `put` survives a process restart. Recovery obligations are acknowledged to the
   * relay (which then retires them) only after import into a durable journal; a non-durable
   * journal may still be used for the current session but must never trigger an ack. */
  readonly durable: boolean
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
  readonly durable: boolean = false
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
  readonly durable = true
  private openedDb?: LevelDB
  private faulted = false
  private readonly records = new Map<string, StampPaymentRecoveryRecord>()

  constructor(private readonly location: string) {}

  private assertHealthy(): void {
    if (this.faulted)
      throw new Error(
        'Journal storage is uncertain; close and reopen before use',
      )
  }
  private get db(): LevelDB {
    this.assertHealthy()
    if (this.openedDb === undefined) throw new Error('No db opened')
    return this.openedDb
  }

  async Open(): Promise<void> {
    if (this.openedDb !== undefined) throw new Error('Journal already opened')
    const database = level(join(this.location, 'stamp-payment-journal'))
    try {
      await openDurableLevel(database, this.location, 'stamp-payment-journal')
      const records = new Map<string, StampPaymentRecoveryRecord>()
      for await (const [, value] of database.iterator({}) as any) {
        const record = JSON.parse(value) as StampPaymentRecoveryRecord
        records.set(key(record.payloadHashHex, record.childIndex), record)
      }
      this.records.clear()
      for (const [key, record] of records) this.records.set(key, record)
      this.openedDb = database
      this.faulted = false
    } catch (error) {
      this.faulted = true
      await database.close()
      throw error
    }
  }

  async Close(): Promise<void> {
    await this.openedDb?.close()
    this.openedDb = undefined
  }

  get(
    payloadHashHex: string,
    childIndex: number,
  ): StampPaymentRecoveryRecord | undefined {
    this.assertHealthy()
    return this.records.get(key(payloadHashHex, childIndex))
  }

  async put(record: StampPaymentRecoveryRecord): Promise<void> {
    const recordKey = key(record.payloadHashHex, record.childIndex)
    this.assertHealthy()
    try {
      await durablePut(this.db, recordKey, JSON.stringify(record))
    } catch (error) {
      // A rejected callback may have committed. Only reopening can rebuild the cache safely.
      this.faulted = true
      throw error
    }
    this.records.set(recordKey, { ...record })
  }

  getAll(): StampPaymentRecoveryRecord[] {
    this.assertHealthy()
    return Array.from(this.records.values())
  }
}
