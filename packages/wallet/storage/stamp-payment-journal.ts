/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'

const WALLET_BINDING_KEY = '__wallet_binding__'

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
  private readonly expectedBindingId?: string

  constructor(location: string, expectedBindingId?: string) {
    this.dbLocation = join(location, 'stamp-payment-journal')
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
    for await (const [dbKey, value] of this.db.iterator({}) as any) {
      if (dbKey === WALLET_BINDING_KEY) {
        storedBindingId = value
        continue
      }
      hasRecords = true
      const record = JSON.parse(value) as StampPaymentRecoveryRecord
      this.records.set(key(record.payloadHashHex, record.childIndex), record)
    }
    if (this.expectedBindingId !== undefined) {
      if (
        storedBindingId !== undefined &&
        storedBindingId !== this.expectedBindingId
      ) {
        throw new Error(
          'Stamp-payment journal belongs to a different wallet root',
        )
      }
      if (storedBindingId === undefined && hasRecords) {
        throw new Error(
          'Refusing to adopt an unbound non-empty stamp-payment journal',
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
