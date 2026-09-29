/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'
import { validateWalletComponentBeforeOpen } from './wallet-root-guard'

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
  /** Canonical signed incoming payment transaction retained for recovery validation. */
  rawTx: string
  /** Compressed recipient identity public key that owns this derived child. */
  recipientPublicKeyHex: string
  /** Recipient address parsed from the retained encrypted envelope. */
  envelopeRecipientAddress: string
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
    childIndex: number
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
    childIndex: number
  ): StampPaymentRecoveryRecord | undefined {
    const record = this.records.get(key(payloadHashHex, childIndex))
    return record === undefined ? undefined : { ...record }
  }

  async put(record: StampPaymentRecoveryRecord): Promise<void> {
    assertPaymentAuthorityShape(record)
    assertCompatiblePaymentRecord(
      this.records.get(key(record.payloadHashHex, record.childIndex)),
      record
    )
    this.records.set(key(record.payloadHashHex, record.childIndex), {
      ...record,
    })
  }

  getAll(): StampPaymentRecoveryRecord[] {
    return Array.from(this.records.values()).map((record) => ({ ...record }))
  }
}

export class LevelStampPaymentJournal implements StampPaymentJournal {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private readonly records = new Map<string, StampPaymentRecoveryRecord>()
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
    this.dbLocation = join(location, 'stamp-payment-journal')
    this.expectedBindingId = expectedBindingId
    this.allowUnboundForMigration = allowUnboundForMigration
    this.assertMutationAllowed = assertMutationAllowed
    this.rootLocation = location
  }

  private get db(): LevelDB {
    if (this.openedDb === undefined) throw new Error('No db opened')
    return this.openedDb
  }

  async Open(): Promise<void> {
    this.assertMutationAllowed()
    validateWalletComponentBeforeOpen(
      this.rootLocation,
      'stamp-payment-journal',
      false
    )
    this.openedDb = level(this.dbLocation)
    await (this.openedDb as any).open()
    let storedBindingId: string | undefined
    for await (const [dbKey, value] of this.db.iterator({}) as any) {
      if (dbKey === WALLET_BINDING_KEY) {
        storedBindingId = value
        continue
      }
      const record = JSON.parse(value) as StampPaymentRecoveryRecord
      const expectedKey = key(record.payloadHashHex, record.childIndex)
      if (dbKey !== expectedKey) {
        throw new Error('Stamp-payment key does not match its identity')
      }
      this.records.set(expectedKey, record)
    }
    if (this.expectedBindingId !== undefined) {
      if (
        storedBindingId !== undefined &&
        storedBindingId !== this.expectedBindingId
      ) {
        throw new Error(
          'Stamp-payment journal belongs to a different wallet root'
        )
      }
      if (storedBindingId === undefined && !this.allowUnboundForMigration) {
        throw new Error('Refusing to open an unbound stamp-payment journal')
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
    await this.db.put(WALLET_BINDING_KEY, this.expectedBindingId)
  }

  async Close(): Promise<void> {
    await this.db.close()
  }

  get(
    payloadHashHex: string,
    childIndex: number
  ): StampPaymentRecoveryRecord | undefined {
    const record = this.records.get(key(payloadHashHex, childIndex))
    return record === undefined ? undefined : { ...record }
  }

  async put(record: StampPaymentRecoveryRecord): Promise<void> {
    this.assertMutationAllowed()
    assertPaymentAuthorityShape(record)
    const recordKey = key(record.payloadHashHex, record.childIndex)
    assertCompatiblePaymentRecord(this.records.get(recordKey), record)
    await this.db.put(recordKey, JSON.stringify(record))
    this.records.set(recordKey, { ...record })
  }

  getAll(): StampPaymentRecoveryRecord[] {
    return Array.from(this.records.values()).map((record) => ({ ...record }))
  }
}

function assertPaymentAuthorityShape(record: StampPaymentRecoveryRecord): void {
  if (
    typeof record.rawTx !== 'string' ||
    typeof record.recipientPublicKeyHex !== 'string' ||
    typeof record.envelopeRecipientAddress !== 'string'
  ) {
    throw new Error('Stamp-payment recovery authority is incomplete')
  }
}

function assertCompatiblePaymentRecord(
  prior: StampPaymentRecoveryRecord | undefined,
  next: StampPaymentRecoveryRecord
): void {
  if (prior === undefined) return
  for (const field of [
    'payloadHashHex',
    'childIndex',
    'txHash',
    'rawTx',
    'recipientPublicKeyHex',
    'envelopeRecipientAddress',
    'address',
    'valueWei',
  ] as const) {
    if (prior[field] !== next[field]) {
      throw new Error(
        `Conflicting stamp-payment recovery authority for ${next.payloadHashHex}:${next.childIndex}`
      )
    }
  }
}
