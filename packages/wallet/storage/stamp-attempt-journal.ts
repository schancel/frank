/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'
import { validateWalletComponentBeforeOpen } from './wallet-root-guard'
import {
  durableBatch,
  durableDelete,
  durablePut,
  openDurableLevel,
} from './level-durability'

const WALLET_BINDING_KEY = '__wallet_binding__'

export interface OutgoingStampAttempt {
  payloadHashHex: string
  messageBytes: number[]
  leaseIndices: number[]
  /** Compressed recipient public key needed to validate every journaled one-time destination
   * without trusting the relay or performing network I/O during restart. */
  recipientPublicKeyHex?: string
  /** Conservative terminal authority state for bytes rejected as noncanonical by a relay that
   * may nevertheless have broadcast a prefix before upgrading its canonicality rules. */
  authorityState?: 'pending' | 'incompatible-protobuf'
  authorityReason?: 'noncanonical_protobuf'
}

export interface StampAttemptJournal {
  put(attempt: OutgoingStampAttempt): Promise<void>
  delete(payloadHashHex: string): Promise<void>
  getAll(): OutgoingStampAttempt[]
  referencesLeaseIndex(index: number): boolean
}

function cloneAttempt(attempt: OutgoingStampAttempt): OutgoingStampAttempt {
  return {
    ...attempt,
    messageBytes: [...attempt.messageBytes],
    leaseIndices: [...attempt.leaseIndices],
  }
}

function assertAttemptReplacement(
  prior: OutgoingStampAttempt | undefined,
  next: OutgoingStampAttempt
): void {
  if (prior === undefined) return
  const immutablePrior = {
    ...prior,
    authorityState: undefined,
    authorityReason: undefined,
  }
  const immutableNext = {
    ...next,
    authorityState: undefined,
    authorityReason: undefined,
  }
  if (JSON.stringify(immutablePrior) !== JSON.stringify(immutableNext)) {
    throw new Error('Cannot replace a stamp attempt with different exact bytes')
  }
  const priorState = prior.authorityState ?? 'pending'
  const nextState = next.authorityState ?? 'pending'
  if (
    (priorState === 'incompatible-protobuf' && nextState !== priorState) ||
    (nextState === 'incompatible-protobuf' &&
      next.authorityReason !== 'noncanonical_protobuf')
  ) {
    throw new Error('Stamp-attempt authority state cannot move backward')
  }
}

export class InMemoryStampAttemptJournal implements StampAttemptJournal {
  private readonly attempts = new Map<string, OutgoingStampAttempt>()
  private readonly leaseReferenceCounts = new Map<number, number>()
  async put(attempt: OutgoingStampAttempt): Promise<void> {
    const prior = this.attempts.get(attempt.payloadHashHex)
    assertAttemptReplacement(prior, attempt)
    this.attempts.set(attempt.payloadHashHex, cloneAttempt(attempt))
    if (prior === undefined) this.addLeaseReferences(attempt, 1)
  }
  async delete(payloadHashHex: string): Promise<void> {
    const prior = this.attempts.get(payloadHashHex)
    this.attempts.delete(payloadHashHex)
    if (prior !== undefined) this.addLeaseReferences(prior, -1)
  }
  getAll(): OutgoingStampAttempt[] {
    return Array.from(this.attempts.values()).map(cloneAttempt)
  }
  referencesLeaseIndex(index: number): boolean {
    return this.leaseReferenceCounts.has(index)
  }
  private addLeaseReferences(
    attempt: OutgoingStampAttempt,
    delta: 1 | -1
  ): void {
    for (const index of attempt.leaseIndices) {
      const next = (this.leaseReferenceCounts.get(index) ?? 0) + delta
      if (next === 0) this.leaseReferenceCounts.delete(index)
      else this.leaseReferenceCounts.set(index, next)
    }
  }
}

export class LevelStampAttemptJournal implements StampAttemptJournal {
  private readonly dbLocation: string
  private openedDb?: LevelDB
  private readonly attempts = new Map<string, OutgoingStampAttempt>()
  private readonly leaseReferenceCounts = new Map<number, number>()
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
    this.dbLocation = join(location, 'outgoing-stamp-attempts')
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
      'outgoing-stamp-attempts',
      false
    )
    this.openedDb = level(this.dbLocation)
    await openDurableLevel(
      this.openedDb,
      this.rootLocation,
      'outgoing-stamp-attempts'
    )
    let storedBindingId: string | undefined
    for await (const [key, value] of this.db.iterator({}) as any) {
      if (key === WALLET_BINDING_KEY) {
        storedBindingId = value
        continue
      }
      const attempt = JSON.parse(value) as OutgoingStampAttempt
      if (key !== attempt.payloadHashHex) {
        throw new Error('Stamp-attempt key does not match its payload hash')
      }
      this.attempts.set(attempt.payloadHashHex, attempt)
      this.addLeaseReferences(attempt, 1)
    }
    if (this.expectedBindingId !== undefined) {
      if (
        storedBindingId !== undefined &&
        storedBindingId !== this.expectedBindingId
      ) {
        throw new Error(
          'Stamp-attempt journal belongs to a different wallet root'
        )
      }
      if (storedBindingId === undefined && !this.allowUnboundForMigration) {
        throw new Error('Refusing to open an unbound stamp-attempt journal')
      }
    }
    this.loadedBindingId = storedBindingId
  }
  bindingId(): string | undefined {
    return this.loadedBindingId
  }
  async Bind(
    resolvedAttempts: readonly OutgoingStampAttempt[] = []
  ): Promise<void> {
    if (this.expectedBindingId === undefined) return
    this.assertMutationAllowed()
    await durableBatch(this.db, [
      { type: 'put', key: WALLET_BINDING_KEY, value: this.expectedBindingId },
      ...resolvedAttempts.map((attempt) => ({
        type: 'put' as const,
        key: attempt.payloadHashHex,
        value: JSON.stringify(attempt),
      })),
    ])
    for (const attempt of resolvedAttempts) {
      this.attempts.set(attempt.payloadHashHex, cloneAttempt(attempt))
    }
  }
  async Close(): Promise<void> {
    await this.db.close()
  }
  async put(attempt: OutgoingStampAttempt): Promise<void> {
    this.assertMutationAllowed()
    const prior = this.attempts.get(attempt.payloadHashHex)
    assertAttemptReplacement(prior, attempt)
    await durablePut(this.db, attempt.payloadHashHex, JSON.stringify(attempt))
    this.attempts.set(attempt.payloadHashHex, cloneAttempt(attempt))
    if (prior === undefined) this.addLeaseReferences(attempt, 1)
  }
  async delete(payloadHashHex: string): Promise<void> {
    this.assertMutationAllowed()
    const prior = this.attempts.get(payloadHashHex)
    await durableDelete(this.db, payloadHashHex)
    this.attempts.delete(payloadHashHex)
    if (prior !== undefined) this.addLeaseReferences(prior, -1)
  }
  getAll(): OutgoingStampAttempt[] {
    return Array.from(this.attempts.values()).map(cloneAttempt)
  }
  referencesLeaseIndex(index: number): boolean {
    return this.leaseReferenceCounts.has(index)
  }
  private addLeaseReferences(
    attempt: OutgoingStampAttempt,
    delta: 1 | -1
  ): void {
    for (const index of attempt.leaseIndices) {
      const next = (this.leaseReferenceCounts.get(index) ?? 0) + delta
      if (next === 0) this.leaseReferenceCounts.delete(index)
      else this.leaseReferenceCounts.set(index, next)
    }
  }
}
