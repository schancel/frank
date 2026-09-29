/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'
import { getAddress, getBytes, Transaction } from 'ethers'
import { deriveMonadStampChildPublic } from '../monad-stamp-stealth'
import { validateWalletComponentBeforeOpen } from './wallet-root-guard'

const WALLET_BINDING_KEY = '__wallet_binding__'

export type StampPaymentRecoveryStatus =
  | 'discovered'
  | 'sweep-pending'
  | 'sweep-failed'
  | 'swept'

export interface FailedStampPaymentSweep {
  txHash: string
  rawTx: string
  valueWei: string
  destinationAddress: string
}

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
  /** Append-only terminal ledger for mined reverts. The active sweep fields may advance to a
   * fresh nonce only after the reverted intent has been retained here. */
  failedSweeps?: FailedStampPaymentSweep[]
}

export interface StampPaymentJournal {
  get(
    payloadHashHex: string,
    childIndex: number
  ): StampPaymentRecoveryRecord | undefined
  put(record: StampPaymentRecoveryRecord): Promise<void>
  /** Pure immutable-authority preflight; it never mutates the journal. */
  assertDiscovered(records: StampPaymentRecoveryRecord[]): void
  /** Atomically records one completely prevalidated message's discovered child set. Exact rows
   * already in a later lifecycle are preserved; any conflicting authority aborts the whole set. */
  putDiscovered(records: StampPaymentRecoveryRecord[]): Promise<void>
  /** Serializes the complete read/sign/journal/submit lifecycle for one payment across every
   * wallet handle sharing this durable journal. */
  withPaymentLock<T>(
    payloadHashHex: string,
    childIndex: number,
    operation: (locked: LockedStampPaymentJournal) => Promise<T>
  ): Promise<T>
  assertOpen(): void
  getAll(): StampPaymentRecoveryRecord[]
  Close(): Promise<void>
}

export interface LockedStampPaymentJournal {
  get(): StampPaymentRecoveryRecord | undefined
  put(record: StampPaymentRecoveryRecord): Promise<void>
}

function key(payloadHashHex: string, childIndex: number): string {
  return `${payloadHashHex}:${childIndex}`
}

function assertLockedRecordIdentity(
  recordKey: string,
  record: StampPaymentRecoveryRecord
): void {
  if (key(record.payloadHashHex, record.childIndex) !== recordKey) {
    throw new Error('Locked stamp-payment record identity cannot change')
  }
}

function cloneRecord(
  record: StampPaymentRecoveryRecord
): StampPaymentRecoveryRecord {
  return {
    ...record,
    ...(record.failedSweeps === undefined
      ? {}
      : {
          failedSweeps: record.failedSweeps.map((failed) => ({ ...failed })),
        }),
  }
}

export class InMemoryStampPaymentJournal implements StampPaymentJournal {
  private readonly records = new Map<string, StampPaymentRecoveryRecord>()
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly paymentQueues = new Map<string, Promise<void>>()
  private lifecycle: 'open' | 'closing' | 'closed' = 'open'
  private closePromise?: Promise<void>

  assertOpen(): void {
    if (this.lifecycle !== 'open') {
      throw new Error('Stamp-payment journal is closing or closed')
    }
  }

  private mutate<T>(
    operation: () => T | Promise<T>,
    admitted = false
  ): Promise<T> {
    if (!admitted) this.assertOpen()
    const run = this.mutationTail.then(operation)
    this.mutationTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  get(
    payloadHashHex: string,
    childIndex: number
  ): StampPaymentRecoveryRecord | undefined {
    this.assertOpen()
    const record = this.records.get(key(payloadHashHex, childIndex))
    return record === undefined ? undefined : cloneRecord(record)
  }

  async put(record: StampPaymentRecoveryRecord): Promise<void> {
    await this.mutate(() => {
      assertPaymentAuthorityShape(record)
      assertMonotonicPaymentRecord(
        this.records.get(key(record.payloadHashHex, record.childIndex)),
        record
      )
      this.records.set(
        key(record.payloadHashHex, record.childIndex),
        cloneRecord(record)
      )
    })
  }

  assertDiscovered(records: StampPaymentRecoveryRecord[]): void {
    this.assertOpen()
    preflightDiscoveredSet(this.records, records)
  }

  async putDiscovered(records: StampPaymentRecoveryRecord[]): Promise<void> {
    await this.mutate(() => {
      const staged = preflightDiscoveredSet(this.records, records)
      for (const [recordKey, record] of staged) {
        this.records.set(recordKey, cloneRecord(record))
      }
    })
  }

  withPaymentLock<T>(
    payloadHashHex: string,
    childIndex: number,
    operation: (locked: LockedStampPaymentJournal) => Promise<T>
  ): Promise<T> {
    this.assertOpen()
    const recordKey = key(payloadHashHex, childIndex)
    const run = (this.paymentQueues.get(recordKey) ?? Promise.resolve())
      .then(() => this.mutationTail)
      .then(() => {
        const locked: LockedStampPaymentJournal = {
          get: () => {
            const record = this.records.get(recordKey)
            return record === undefined ? undefined : cloneRecord(record)
          },
          put: (record) =>
            this.mutate(() => {
              assertLockedRecordIdentity(recordKey, record)
              assertPaymentAuthorityShape(record)
              assertMonotonicPaymentRecord(this.records.get(recordKey), record)
              this.records.set(recordKey, cloneRecord(record))
            }, true),
        }
        return operation(locked)
      })
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.paymentQueues.set(recordKey, tail)
    void tail.then(() => {
      if (this.paymentQueues.get(recordKey) === tail) {
        this.paymentQueues.delete(recordKey)
      }
    })
    return run
  }

  getAll(): StampPaymentRecoveryRecord[] {
    this.assertOpen()
    return Array.from(this.records.values()).map(cloneRecord)
  }

  Close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.lifecycle = 'closing'
    this.closePromise = (async () => {
      await Promise.all(Array.from(this.paymentQueues.values()))
      await this.mutationTail
      this.lifecycle = 'closed'
    })()
    return this.closePromise
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
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly paymentQueues = new Map<string, Promise<void>>()
  private lifecycle: 'new' | 'opening' | 'open' | 'closing' | 'closed' = 'new'
  private closePromise?: Promise<void>

  assertOpen(): void {
    if (this.lifecycle !== 'open') {
      throw new Error('Stamp-payment journal is not open')
    }
  }

  private mutate<T>(operation: () => Promise<T>, admitted = false): Promise<T> {
    if (!admitted) this.assertOpen()
    const run = this.mutationTail.then(operation)
    this.mutationTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

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
    if (this.lifecycle !== 'new') {
      throw new Error('Stamp-payment journal cannot be reopened')
    }
    this.lifecycle = 'opening'
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
    this.lifecycle = 'open'
  }

  bindingId(): string | undefined {
    return this.loadedBindingId
  }

  async Bind(
    resolvedLegacyRecords: StampPaymentRecoveryRecord[] = []
  ): Promise<void> {
    if (this.expectedBindingId === undefined) return
    this.assertOpen()
    this.assertMutationAllowed()
    for (const record of resolvedLegacyRecords) {
      const recordKey = key(record.payloadHashHex, record.childIndex)
      const existing = this.records.get(recordKey)
      if (
        existing === undefined ||
        existing.txHash !== record.txHash ||
        existing.address !== record.address
      ) {
        throw new Error(
          'Legacy payment resolution no longer matches stored row'
        )
      }
      assertPaymentAuthorityShape(record)
    }
    await (this.db as any).batch([
      { type: 'put', key: WALLET_BINDING_KEY, value: this.expectedBindingId },
      ...resolvedLegacyRecords.map((record) => ({
        type: 'put' as const,
        key: key(record.payloadHashHex, record.childIndex),
        value: JSON.stringify(record),
      })),
    ])
    for (const record of resolvedLegacyRecords) {
      this.records.set(
        key(record.payloadHashHex, record.childIndex),
        cloneRecord(record)
      )
    }
    this.loadedBindingId = this.expectedBindingId
  }

  async Close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    if (this.lifecycle === 'new' && this.openedDb === undefined) {
      this.lifecycle = 'closed'
      return
    }
    this.lifecycle = 'closing'
    this.closePromise = (async () => {
      await Promise.all(Array.from(this.paymentQueues.values()))
      await this.mutationTail
      await this.openedDb?.close()
      this.lifecycle = 'closed'
    })()
    return this.closePromise
  }

  get(
    payloadHashHex: string,
    childIndex: number
  ): StampPaymentRecoveryRecord | undefined {
    this.assertOpen()
    const record = this.records.get(key(payloadHashHex, childIndex))
    return record === undefined ? undefined : cloneRecord(record)
  }

  async put(record: StampPaymentRecoveryRecord): Promise<void> {
    await this.mutate(async () => {
      this.assertMutationAllowed()
      assertPaymentAuthorityShape(record)
      const recordKey = key(record.payloadHashHex, record.childIndex)
      assertMonotonicPaymentRecord(this.records.get(recordKey), record)
      await this.db.put(recordKey, JSON.stringify(record))
      this.records.set(recordKey, cloneRecord(record))
    })
  }

  assertDiscovered(records: StampPaymentRecoveryRecord[]): void {
    this.assertOpen()
    preflightDiscoveredSet(this.records, records)
  }

  async putDiscovered(records: StampPaymentRecoveryRecord[]): Promise<void> {
    await this.mutate(async () => {
      this.assertMutationAllowed()
      const staged = preflightDiscoveredSet(this.records, records)
      if (staged.size > 0) {
        await (this.db as any).batch(
          Array.from(staged, ([recordKey, record]) => ({
            type: 'put' as const,
            key: recordKey,
            value: JSON.stringify(record),
          }))
        )
      }
      for (const [recordKey, record] of staged) {
        this.records.set(recordKey, cloneRecord(record))
      }
    })
  }

  withPaymentLock<T>(
    payloadHashHex: string,
    childIndex: number,
    operation: (locked: LockedStampPaymentJournal) => Promise<T>
  ): Promise<T> {
    this.assertOpen()
    const recordKey = key(payloadHashHex, childIndex)
    const run = (this.paymentQueues.get(recordKey) ?? Promise.resolve())
      .then(() => this.mutationTail)
      .then(() => {
        const locked: LockedStampPaymentJournal = {
          get: () => {
            const record = this.records.get(recordKey)
            return record === undefined ? undefined : cloneRecord(record)
          },
          put: (record) =>
            this.mutate(async () => {
              this.assertMutationAllowed()
              assertLockedRecordIdentity(recordKey, record)
              assertPaymentAuthorityShape(record)
              assertMonotonicPaymentRecord(this.records.get(recordKey), record)
              await this.db.put(recordKey, JSON.stringify(record))
              this.records.set(recordKey, cloneRecord(record))
            }, true),
        }
        return operation(locked)
      })
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.paymentQueues.set(recordKey, tail)
    void tail.then(() => {
      if (this.paymentQueues.get(recordKey) === tail) {
        this.paymentQueues.delete(recordKey)
      }
    })
    return run
  }

  getAll(): StampPaymentRecoveryRecord[] {
    this.assertOpen()
    return Array.from(this.records.values()).map(cloneRecord)
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
  if (
    !['discovered', 'sweep-pending', 'sweep-failed', 'swept'].includes(
      record.status
    ) ||
    (record.status !== 'discovered' &&
      (typeof record.sweepTxHash !== 'string' ||
        typeof record.sweepRawTx !== 'string' ||
        typeof record.sweepValueWei !== 'string' ||
        typeof record.sweepDestinationAddress !== 'string'))
  ) {
    throw new Error('Stamp-payment sweep authority is incomplete')
  }
  if (
    record.status === 'discovered' &&
    (record.sweepTxHash !== undefined ||
      record.sweepRawTx !== undefined ||
      record.sweepValueWei !== undefined ||
      record.sweepDestinationAddress !== undefined ||
      (record.failedSweeps?.length ?? 0) > 0)
  ) {
    throw new Error('Discovered stamp-payment row cannot contain sweep state')
  }
  if (
    record.failedSweeps !== undefined &&
    (!Array.isArray(record.failedSweeps) ||
      record.failedSweeps.some(
        (failed) =>
          typeof failed.txHash !== 'string' ||
          typeof failed.rawTx !== 'string' ||
          typeof failed.valueWei !== 'string' ||
          typeof failed.destinationAddress !== 'string'
      ))
  ) {
    throw new Error('Stamp-payment failed sweep ledger is invalid')
  }
  for (const failed of record.failedSweeps ?? []) {
    const transaction = decodeSweepTransaction(failed.rawTx, failed.txHash)
    if (
      transaction.value.toString() !== failed.valueWei ||
      transaction.to?.toLowerCase() !== failed.destinationAddress.toLowerCase()
    ) {
      throw new Error('Stamp-payment failed sweep transaction is inconsistent')
    }
  }
  if (record.status === 'sweep-failed') {
    const terminal = record.failedSweeps?.[record.failedSweeps.length - 1]
    if (
      terminal === undefined ||
      terminal.txHash !== record.sweepTxHash ||
      terminal.rawTx !== record.sweepRawTx ||
      terminal.valueWei !== record.sweepValueWei ||
      terminal.destinationAddress !== record.sweepDestinationAddress
    ) {
      throw new Error('Failed stamp-payment sweep authority is incomplete')
    }
  }
  if (record.status !== 'discovered') {
    const derivedAddress = deriveMonadStampChildPublic({
      payloadHash: getBytes(`0x${record.payloadHashHex}`),
      recipientPublicKey: getBytes(record.recipientPublicKeyHex),
      paymentIndex: record.childIndex,
    }).address
    if (getAddress(record.address) !== getAddress(derivedAddress)) {
      throw new Error('Stamp-payment sweep sender is not the derived child')
    }
    assertSweepTransaction(record, {
      txHash: record.sweepTxHash as string,
      rawTx: record.sweepRawTx as string,
      valueWei: record.sweepValueWei as string,
      destinationAddress: record.sweepDestinationAddress as string,
    })
    for (const failed of record.failedSweeps ?? []) {
      assertSweepTransaction(record, failed)
    }
  }
}

function preflightDiscoveredSet(
  current: ReadonlyMap<string, StampPaymentRecoveryRecord>,
  records: StampPaymentRecoveryRecord[]
): Map<string, StampPaymentRecoveryRecord> {
  const staged = new Map<string, StampPaymentRecoveryRecord>()
  for (const record of records) {
    assertPaymentAuthorityShape(record)
    if (record.status !== 'discovered') {
      throw new Error(
        'A discovered stamp-payment set must contain discovered rows'
      )
    }
    const recordKey = key(record.payloadHashHex, record.childIndex)
    if (staged.has(recordKey)) {
      throw new Error(`Duplicate stamp-payment recovery row ${recordKey}`)
    }
    const prior = current.get(recordKey)
    assertCompatibleStampPaymentAuthority(prior, record)
    if (prior === undefined) staged.set(recordKey, cloneRecord(record))
  }
  return staged
}

export function assertCompatibleStampPaymentAuthority(
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

function assertMonotonicPaymentRecord(
  prior: StampPaymentRecoveryRecord | undefined,
  next: StampPaymentRecoveryRecord
): void {
  assertCompatibleStampPaymentAuthority(prior, next)
  assertFailedSweepLedger(
    prior?.failedSweeps,
    next.failedSweeps,
    prior?.status === 'sweep-pending' && next.status === 'sweep-failed'
  )
  if (prior === undefined) return
  if (
    (prior.status === 'discovered' &&
      next.status !== 'discovered' &&
      next.status !== 'sweep-pending') ||
    (prior.status === 'sweep-pending' && next.status === 'discovered') ||
    (prior.status === 'sweep-failed' && next.status === 'discovered') ||
    (prior.status === 'sweep-failed' && next.status === 'swept') ||
    (prior.status === 'swept' && next.status !== 'swept')
  ) {
    throw new Error('Stamp-payment recovery lifecycle cannot move backward')
  }
  if (prior.status === 'sweep-pending' && next.status !== 'sweep-failed') {
    for (const field of [
      'sweepTxHash',
      'sweepRawTx',
      'sweepValueWei',
      'sweepDestinationAddress',
    ] as const) {
      if (prior[field] !== next[field]) {
        throw new Error('Stamp-payment signed sweep intent is immutable')
      }
    }
  }
  if (prior.status === 'sweep-pending' && next.status === 'sweep-failed') {
    if (
      (next.failedSweeps ?? []).length !==
      (prior.failedSweeps ?? []).length + 1
    ) {
      throw new Error('A failed sweep must append exactly one terminal row')
    }
    const appended = next.failedSweeps?.[next.failedSweeps.length - 1]
    if (
      appended === undefined ||
      appended.txHash !== prior.sweepTxHash ||
      appended.rawTx !== prior.sweepRawTx ||
      appended.valueWei !== prior.sweepValueWei ||
      appended.destinationAddress !== prior.sweepDestinationAddress
    ) {
      throw new Error(
        'A failed sweep must durably retain its exact signed intent'
      )
    }
    assertSweepFieldsEqual(prior, next)
  }
  if (prior.status === 'sweep-failed' && next.status === 'sweep-pending') {
    if (
      (prior.failedSweeps ?? []).length !== (next.failedSweeps ?? []).length
    ) {
      throw new Error('A fresh sweep cannot alter the failed sweep ledger')
    }
    const candidate = decodeSweepTransaction(
      next.sweepRawTx as string,
      next.sweepTxHash as string
    )
    let highestFailedNonce = -1
    for (const failed of prior.failedSweeps ?? []) {
      if (
        failed.txHash.toLowerCase() ===
          (next.sweepTxHash as string).toLowerCase() ||
        failed.rawTx.toLowerCase() === (next.sweepRawTx as string).toLowerCase()
      ) {
        throw new Error('A mined failed sweep transaction cannot be replayed')
      }
      highestFailedNonce = Math.max(
        highestFailedNonce,
        decodeSweepTransaction(failed.rawTx, failed.txHash).nonce
      )
    }
    if (candidate.nonce <= highestFailedNonce) {
      throw new Error(
        'A fresh sweep nonce must exceed every mined failed nonce'
      )
    }
  }
  if (
    (prior.status === 'sweep-failed' && next.status === 'sweep-failed') ||
    (prior.status === 'swept' && next.status === 'swept')
  ) {
    assertSweepFieldsEqual(prior, next)
    if (
      (prior.failedSweeps ?? []).length !== (next.failedSweeps ?? []).length
    ) {
      throw new Error('A terminal sweep ledger cannot be extended')
    }
  }
}

function decodeSweepTransaction(rawTx: string, txHash: string): Transaction {
  const transaction = Transaction.from(rawTx)
  if (
    transaction.hash === null ||
    transaction.hash.toLowerCase() !== txHash.toLowerCase() ||
    transaction.serialized.toLowerCase() !== rawTx.toLowerCase()
  ) {
    throw new Error('Stamp-payment sweep transaction bytes are invalid')
  }
  return transaction
}

function assertSweepTransaction(
  record: StampPaymentRecoveryRecord,
  sweep: FailedStampPaymentSweep
): Transaction {
  const transaction = decodeSweepTransaction(sweep.rawTx, sweep.txHash)
  if (
    transaction.from === null ||
    getAddress(transaction.from) !== getAddress(record.address) ||
    transaction.to === null ||
    getAddress(transaction.to) !== getAddress(sweep.destinationAddress) ||
    transaction.value.toString() !== sweep.valueWei
  ) {
    throw new Error('Stamp-payment sweep transaction authority is inconsistent')
  }
  return transaction
}

function assertSweepFieldsEqual(
  prior: StampPaymentRecoveryRecord,
  next: StampPaymentRecoveryRecord
): void {
  for (const field of [
    'sweepTxHash',
    'sweepRawTx',
    'sweepValueWei',
    'sweepDestinationAddress',
  ] as const) {
    if (prior[field] !== next[field]) {
      throw new Error('Stamp-payment signed sweep intent is immutable')
    }
  }
}

function assertFailedSweepLedger(
  prior: FailedStampPaymentSweep[] | undefined,
  next: FailedStampPaymentSweep[] | undefined,
  allowExactAppend: boolean
): void {
  const priorRows = prior ?? []
  const nextRows = next ?? []
  if (nextRows.length !== priorRows.length + (allowExactAppend ? 1 : 0)) {
    throw new Error('Stamp-payment failed sweep ledger cannot be fabricated')
  }
  for (let index = 0; index < priorRows.length; index++) {
    if (JSON.stringify(priorRows[index]) !== JSON.stringify(nextRows[index])) {
      throw new Error('Stamp-payment failed sweep ledger is immutable')
    }
  }
}
