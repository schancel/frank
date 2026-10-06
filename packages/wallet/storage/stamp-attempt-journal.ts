import { canonicalStampDestination } from '@frank/cashweb/relay/canonical-dm-stamp'
import { CANONICAL_TERMINAL_REASONS } from '@frank/cashweb/relay/canonical-dm-transport'
import { inspectCanonicalPreparedEnvelope } from '../monad-stamp-stealth'
/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'
import {
  compareBytes,
  decodeCanonical,
  parseFrame,
  toHex,
  paymentCommitment,
} from '@frank/codec'
import { hexlify, Transaction, sha256, toUtf8Bytes } from 'ethers'
import {
  restoreCanonicalRequest,
  equalCanonicalRequests,
  decodeCanonicalAcceptedStatus,
  type CanonicalExactRequest,
  type CanonicalAcceptedBody,
} from '@frank/cashweb/relay/canonical-dm-transport'
import { durableBatch, durablePut, openDurableLevel } from './level-durability'

export interface OutgoingStampAttempt {
  payloadHashHex: string
  messageBytes: number[]
  leaseIndices: number[]
  recipientPublicKeyHex?: string
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

/** Separate versioned namespace; opening it never rewrites the legacy exact-set journal. */
const CANONICAL_NAMESPACE = 'canonical-stamp-attempts-v1'
const CANONICAL_MANIFEST = 'manifest'
const CANONICAL_MAX_BODY = 8 * 1024 * 1024

export interface CanonicalPreparedAttempt {
  readonly walletBindingId: string
  readonly accountId: string
  readonly chainId: string
  readonly network: string
  readonly senderSubject: string
  readonly recipientSubject: string
  readonly senderT1: string
  readonly recipientT1: string
  readonly payload: Uint8Array
  readonly context: Uint8Array
  /** Exact caller-owned frozen economic policy/context; the journal does not confer authority. */
  readonly economicBinding: Uint8Array
}

export interface CanonicalAttemptReservation {
  readonly id: string
  readonly index: number
}

export type CanonicalAttemptTerminal = Exclude<
  CanonicalAcceptedBody,
  { phase: 'retained' }
>

export interface CanonicalJournalAttempt {
  readonly version: 1
  readonly attemptRef: string
  readonly prepared: CanonicalPreparedAttempt
  readonly request: CanonicalExactRequest
  readonly reservations: readonly CanonicalAttemptReservation[]
  readonly consumerId: string
  readonly terminal: CanonicalAttemptTerminal | null
  readonly cleanupComplete: boolean
  readonly acknowledged: boolean
}

/** Durable pre-sign owner. These public bytes confer neither custody nor admission. */
export interface CanonicalUnsignedMember {
  readonly reservation: CanonicalAttemptReservation
  readonly from: string
  readonly unsignedSerialized: string
  readonly rawTx: string | null
}
export interface CanonicalJournalIntent {
  readonly version: 1
  readonly attemptRef: string
  readonly prepared: CanonicalPreparedAttempt
  readonly consumerId: string
  readonly boundary: string
  readonly members: readonly CanonicalUnsignedMember[]
  /** Exact public-only stamp construction inputs, never a private scalar or Current. */
  readonly construction: Uint8Array
}
interface StoredCanonicalIntent {
  version: 1
  attemptRef: string
  sequence: number
  prepared: StoredBinding & { payload: string; context: string }
  consumerId: string
  boundary: string
  members: CanonicalUnsignedMember[]
  construction: string
  reservedBytes: number
}

/** Public funds bookkeeping; relay prefix metadata is not chain finality authority. */
export interface CanonicalImportedRecoveryAccount {
  readonly childIndex: number
  readonly transactionHash: string
  readonly address: string
  readonly valueWei: string
}
export interface CanonicalImportedRecovery {
  readonly version: 1
  readonly obligationId: string
  readonly walletBindingId: string
  readonly request: CanonicalExactRequest
  readonly confirmedChildren: readonly number[]
  readonly lifecycle: string
  readonly stampGeneration: string
  readonly stampKeyHex: string
  readonly sharedPointHex: string
  readonly recipientT1: string
  readonly accounts: readonly CanonicalImportedRecoveryAccount[]
  readonly recipientAcknowledged: boolean
}
interface StoredCanonicalRecovery {
  version: 1
  obligationId: string
  walletBindingId: string
  body: string
  contentType: string
  confirmedChildren: number[]
  lifecycle: string
  stampGeneration: string
  accounts: CanonicalImportedRecoveryAccount[]
  recipientAcknowledged: boolean
  reservedBytes: number
}
/** Opaque, live-owner proof of an already durable imported obligation. */
export interface CanonicalRecoveryCustody {
  readonly obligationId: string
}
const retainedRecoveryCustody = new WeakMap<
  object,
  () => CanonicalImportedRecovery
>()
export function inspectRetainedCanonicalRecovery(
  proof: CanonicalRecoveryCustody,
): CanonicalImportedRecovery {
  const read = retainedRecoveryCustody.get(proof)
  if (!read) canonicalFail('conflict')
  return read()
}
function terminalRecovery(lifecycle: string): boolean {
  return CANONICAL_TERMINAL_REASONS.some(
    reason => lifecycle === `terminal:${reason}`,
  )
}
function publicRecovery(
  row: StoredCanonicalRecovery,
): CanonicalImportedRecovery {
  const request = restoreCanonicalRequest({
    body: fromBase64(row.body, CANONICAL_MAX_BODY),
    contentType: row.contentType,
  })
  const delivery = parseFrame(request.parts.delivery)
  if (delivery.kind !== 'parsed' || delivery.typed?.type !== 1)
    canonicalFail('invalid')
  const envelope = inspectCanonicalPreparedEnvelope(
    delivery.typed.payloadFrame.frame,
    request.parts.context,
  )
  const chain =
    request.identity.network === 'monad-testnet'
      ? 10143n
      : request.identity.network === 'monad-mainnet'
      ? 143n
      : 0n
  if (
    !chain ||
    row.confirmedChildren.some(
      (i, n) =>
        !Number.isSafeInteger(i) ||
        i < 0 ||
        i >= request.parts.transactions.length ||
        (n > 0 && i <= row.confirmedChildren[n - 1]),
    )
  )
    canonicalFail('invalid')
  // Every retained raw member is checked, including an as-yet unconfirmed prefix suffix.
  const all = delivery.typed.payments.map((payment, childIndex) => {
    const tx = Transaction.from(hexlify(request.parts.transactions[childIndex]))
    const destination = canonicalStampDestination({
      network: request.identity.network,
      stampKey: envelope.stampKey,
      sharedPoint: envelope.payload.sharedPoint,
      childIndex,
    })
    const address = '0x' + toHex(destination.address)
    if (
      tx.chainId !== chain ||
      tx.to?.toLowerCase() !== address ||
      tx.value <= 0n ||
      tx.value !==
        (typeof payment.value === 'bigint'
          ? payment.value
          : BigInt('0x' + toHex(payment.value))) ||
      tx.hash?.toLowerCase() !== '0x' + toHex(payment.transactionId) ||
      toHex(payment.address) !== toHex(destination.address) ||
      toHex(payment.commitment) !==
        toHex(
          paymentCommitment(
            delivery.typed!.type === 1
              ? delivery.typed.payloadDigest
              : new Uint8Array(),
            childIndex,
          ),
        ) ||
      tx.data.toLowerCase() !== '0x504f4e4402' + toHex(payment.commitment)
    )
      canonicalFail('invalid')
    return {
      childIndex,
      transactionHash: tx.hash!.toLowerCase(),
      address,
      valueWei: tx.value.toString(),
    }
  })
  const accounts = row.confirmedChildren.map(i => all[i])
  if (JSON.stringify(accounts) !== JSON.stringify(row.accounts))
    canonicalFail('invalid')
  return {
    version: 1,
    obligationId: row.obligationId,
    walletBindingId: row.walletBindingId,
    request,
    confirmedChildren: [...row.confirmedChildren],
    lifecycle: row.lifecycle,
    stampGeneration: row.stampGeneration,
    stampKeyHex: toHex(envelope.stampKey.keyBytes),
    sharedPointHex: toHex(envelope.payload.sharedPoint),
    recipientT1: request.identity.recipient_t1,
    accounts,
    recipientAcknowledged: row.recipientAcknowledged,
  }
}
/** Fixed logical reservation, distinct from the current encoded prefix footprint. All raw
 * members and values are immutable already: reserve their exact complete public account set,
 * complete child prefix, longest accepted lifecycle, longest ACK boolean, and charge digits. */
function recoveryMaximumCharge(row: StoredCanonicalRecovery): number {
  const request = restoreCanonicalRequest({
    body: fromBase64(row.body, CANONICAL_MAX_BODY),
    contentType: row.contentType,
  })
  const accounts = request.parts.transactions.map((raw, childIndex) => {
    const tx = Transaction.from(hexlify(raw))
    return {
      childIndex,
      transactionHash: tx.hash!.toLowerCase(),
      address: tx.to!.toLowerCase(),
      valueWei: tx.value.toString(),
    }
  })
  const lifecycle = [
    'pending',
    'fully_confirmed',
    'delivered',
    ...CANONICAL_TERMINAL_REASONS.map(reason => `terminal:${reason}`),
  ].reduce(
    (longest, next) => (next.length > longest.length ? next : longest),
    '',
  )
  const maximum = {
    ...row,
    confirmedChildren: accounts.map(a => a.childIndex),
    accounts,
    lifecycle,
    recipientAcknowledged: false,
    reservedBytes: 0,
  }
  for (let iteration = 0; iteration < 8; iteration++) {
    const encodedBytes = Buffer.byteLength(JSON.stringify(maximum))
    if (encodedBytes === maximum.reservedBytes) return encodedBytes
    maximum.reservedBytes = encodedBytes
  }
  canonicalFail('invalid')
}
function validateRecovery(value: unknown): StoredCanonicalRecovery {
  exactObject(value, [
    'version',
    'obligationId',
    'walletBindingId',
    'body',
    'contentType',
    'confirmedChildren',
    'lifecycle',
    'stampGeneration',
    'accounts',
    'recipientAcknowledged',
    'reservedBytes',
  ])
  const row = value as unknown as StoredCanonicalRecovery
  if (
    row.version !== 1 ||
    !/^[0-9a-f]{64}$/.test(row.obligationId) ||
    !/^[0-9a-f]{64}$/.test(row.walletBindingId) ||
    typeof row.contentType !== 'string' ||
    row.contentType !==
      `multipart/form-data; boundary=frank-recovery-${row.obligationId.slice(
        0,
        32,
      )}` ||
    !Array.isArray(row.confirmedChildren) ||
    row.confirmedChildren.length > 64 ||
    !Array.isArray(row.accounts) ||
    row.accounts.length !== row.confirmedChildren.length ||
    typeof row.lifecycle !== 'string' ||
    !(
      ['pending', 'fully_confirmed', 'delivered'].includes(row.lifecycle) ||
      terminalRecovery(row.lifecycle)
    ) ||
    typeof row.stampGeneration !== 'string' ||
    !/^(0|[1-9][0-9]{0,9})$/.test(row.stampGeneration) ||
    BigInt(row.stampGeneration) > 0x7fffffffn ||
    typeof row.recipientAcknowledged !== 'boolean' ||
    (row.recipientAcknowledged && !terminalRecovery(row.lifecycle))
  )
    canonicalFail('invalid')
  for (const account of row.accounts)
    exactObject(account, [
      'childIndex',
      'transactionHash',
      'address',
      'valueWei',
    ])
  const view = publicRecovery(row)
  if (
    !Number.isSafeInteger(row.reservedBytes) ||
    row.reservedBytes !== recoveryMaximumCharge(row) ||
    Buffer.byteLength(JSON.stringify(row)) > row.reservedBytes
  )
    canonicalFail('invalid')
  if (
    (row.lifecycle === 'fully_confirmed' || row.lifecycle === 'delivered') &&
    row.confirmedChildren.length !== view.request.parts.transactions.length
  )
    canonicalFail('invalid')
  return row
}

export interface CanonicalAttemptCorrelation {
  readonly attemptRef: string
  readonly prepared: CanonicalPreparedAttempt
  readonly request: CanonicalExactRequest
  readonly reservations: readonly CanonicalAttemptReservation[]
  readonly consumerId: string
}

/** Opaque process-local eligibility. A reopened journal never inherits replay permission. */
export interface CanonicalReplayEligibility {
  readonly attemptRef: string
}

export type CanonicalAttemptReconciliation =
  | {
      readonly attemptRef: string
      readonly state: 'ready'
      readonly eligibility: CanonicalReplayEligibility
    }
  | {
      readonly attemptRef: string
      readonly state: 'terminal'
      readonly attempt: CanonicalJournalAttempt
    }
  | {
      readonly attemptRef: string
      readonly state: 'hold'
      readonly reason: 'missing' | 'orphan' | 'mismatch' | 'ambiguous'
    }

interface CanonicalManifest {
  version: 1
  nextSequence: number
  acknowledgedThrough: number
}

type StoredBinding = Omit<
  CanonicalPreparedAttempt,
  'payload' | 'context' | 'economicBinding'
> & {
  economicBinding: string
}

interface StoredCanonicalAttempt {
  version: 1
  attemptRef: string
  sequence: number
  binding: StoredBinding
  /** One original full body owner; exact part/raw bytes are derived only by the strict parser. */
  request: { body: string; contentType: string }
  reservations: CanonicalAttemptReservation[]
  consumerId: string
  terminal: CanonicalAttemptTerminal | null
  cleanupComplete: boolean
  acknowledged: boolean
}

export class CanonicalAttemptJournalError extends Error {
  constructor(
    readonly code:
      | 'invalid'
      | 'conflict'
      | 'capacity'
      | 'closed'
      | 'corrupt'
      | 'replay'
      | 'cleanup',
  ) {
    super(`canonical-attempt-journal:${code}`)
    this.name = 'CanonicalAttemptJournalError'
  }
}

function canonicalFail(code: CanonicalAttemptJournalError['code']): never {
  throw new CanonicalAttemptJournalError(code)
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    canonicalFail('invalid')
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key)))
    canonicalFail('invalid')
}

function boundedName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value))
    canonicalFail('invalid')
}

function boundedBytes(
  value: unknown,
  max: number,
): asserts value is Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.length === 0 ||
    value.length > max
  )
    canonicalFail('invalid')
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function fromBase64(value: unknown, max: number): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length > 4 * Math.ceil(max / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    canonicalFail('invalid')
  const result = new Uint8Array(Buffer.from(value, 'base64'))
  boundedBytes(result, max)
  if (base64(result) !== value) canonicalFail('invalid')
  return result
}

function refForSequence(sequence: number): string {
  return `canonical-v1:${sequence.toString().padStart(16, '0')}`
}

function attemptKey(sequence: number): string {
  return `attempt:${sequence.toString().padStart(16, '0')}`
}

function payloadFromRequest(request: CanonicalExactRequest): Uint8Array {
  const parsed = parseFrame(request.parts.delivery)
  if (parsed.kind !== 'parsed' || parsed.typed?.type !== 1)
    canonicalFail('invalid')
  return new Uint8Array(parsed.typed.payloadFrame.frame)
}

function bindingOf(prepared: CanonicalPreparedAttempt): StoredBinding {
  return {
    walletBindingId: prepared.walletBindingId,
    accountId: prepared.accountId,
    chainId: prepared.chainId,
    network: prepared.network,
    senderSubject: prepared.senderSubject,
    recipientSubject: prepared.recipientSubject,
    senderT1: prepared.senderT1,
    recipientT1: prepared.recipientT1,
    economicBinding: base64(prepared.economicBinding),
  }
}

function assertPrepared(
  prepared: CanonicalPreparedAttempt,
  request?: CanonicalExactRequest,
): void {
  exactObject(prepared, [
    'walletBindingId',
    'accountId',
    'chainId',
    'network',
    'senderSubject',
    'recipientSubject',
    'senderT1',
    'recipientT1',
    'payload',
    'context',
    'economicBinding',
  ])
  boundedName(prepared.walletBindingId)
  boundedName(prepared.accountId)
  if (
    typeof prepared.chainId !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(prepared.chainId) ||
    typeof prepared.network !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(prepared.network)
  )
    canonicalFail('invalid')
  for (const subject of [prepared.senderSubject, prepared.recipientSubject]) {
    if (typeof subject !== 'string' || !/^(02|03)[0-9a-f]{64}$/.test(subject))
      canonicalFail('invalid')
  }
  for (const t1 of [prepared.senderT1, prepared.recipientT1]) {
    if (typeof t1 !== 'string' || !/^[0-9a-f]{64}$/.test(t1))
      canonicalFail('invalid')
  }
  boundedBytes(prepared.payload, CANONICAL_MAX_BODY)
  boundedBytes(prepared.context, 4096)
  boundedBytes(prepared.economicBinding, 16384)
  inspectCanonicalPreparedEnvelope(prepared.payload, prepared.context)
  const parsed = parseFrame(prepared.payload)
  if (
    parsed.kind !== 'parsed' ||
    parsed.schemaVersion !== 2 ||
    parsed.typed?.type !== 5 ||
    parsed.typed.suite !== 1 ||
    parsed.typed.network !== prepared.network ||
    parsed.typed.sender.keyType !== 1 ||
    parsed.typed.recipient.keyType !== 1 ||
    toHex(parsed.typed.sender.keyBytes) !== prepared.senderSubject ||
    toHex(parsed.typed.recipient.keyBytes) !== prepared.recipientSubject
  )
    canonicalFail('invalid')
  const context = decodeCanonical(prepared.context)
  if (
    !(context instanceof Map) ||
    context.size !== 16 ||
    context.get(0n) !== 'frank/dm-crypto-context/v1' ||
    context.get(1n) !== prepared.network ||
    context.get(12n) !== 1n ||
    context.get(13n) !== 5n ||
    context.get(14n) !== 2n ||
    context.get(15n) !== 2n
  )
    canonicalFail('invalid')
  for (const [key, expected] of [
    [2n, prepared.senderSubject],
    [3n, prepared.recipientSubject],
  ] as const) {
    const subject = context.get(key)
    if (
      !(subject instanceof Map) ||
      subject.size !== 2 ||
      subject.get(0n) !== 1n ||
      !(subject.get(1n) instanceof Uint8Array) ||
      toHex(subject.get(1n) as Uint8Array) !== expected
    )
      canonicalFail('invalid')
  }
  for (const [key, expected] of [
    [4n, prepared.senderT1],
    [5n, prepared.recipientT1],
  ] as const) {
    const t1 = context.get(key)
    if (!(t1 instanceof Uint8Array) || toHex(t1) !== expected)
      canonicalFail('invalid')
  }
  if (
    request !== undefined &&
    request.parts.transactions.some(
      raw =>
        Transaction.from(hexlify(raw)).chainId.toString() !== prepared.chainId,
    )
  )
    canonicalFail('conflict')
  if (
    request !== undefined &&
    (request.identity.network !== prepared.network ||
      request.identity.sender_t1 !== prepared.senderT1 ||
      request.identity.recipient_t1 !== prepared.recipientT1 ||
      compareBytes(prepared.context, request.parts.context) !== 0 ||
      compareBytes(prepared.payload, payloadFromRequest(request)) !== 0)
  )
    canonicalFail('conflict')
}

function preparedOf(
  row: StoredCanonicalAttempt,
  request: CanonicalExactRequest,
): CanonicalPreparedAttempt {
  return {
    ...row.binding,
    economicBinding: fromBase64(row.binding.economicBinding, 16384),
    payload: payloadFromRequest(request),
    context: new Uint8Array(request.parts.context),
  }
}

function samePrepared(
  a: CanonicalPreparedAttempt,
  b: CanonicalPreparedAttempt,
): boolean {
  return (
    JSON.stringify(bindingOf(a)) === JSON.stringify(bindingOf(b)) &&
    compareBytes(a.payload, b.payload) === 0 &&
    compareBytes(a.context, b.context) === 0
  )
}

function assertReservations(
  value: unknown,
  count: number,
): asserts value is CanonicalAttemptReservation[] {
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    count < 1 ||
    count > 64
  )
    canonicalFail('invalid')
  const ids = new Set<string>(),
    indices = new Set<number>()
  for (const item of value) {
    exactObject(item, ['id', 'index'])
    boundedName(item.id)
    if (
      !Number.isSafeInteger(item.index) ||
      (item.index as number) < 0 ||
      ids.has(item.id) ||
      indices.has(item.index as number)
    )
      canonicalFail('invalid')
    ids.add(item.id)
    indices.add(item.index as number)
  }
}

function terminalFor(
  value: unknown,
  request: CanonicalExactRequest,
): CanonicalAttemptTerminal {
  const encoded = new TextEncoder().encode(JSON.stringify(value))
  const result = decodeCanonicalAcceptedStatus(
    200,
    'application/json',
    encoded,
    request,
  )
  if (result.phase !== 'delivered' && result.phase !== 'dead')
    canonicalFail('invalid')
  return result.phase === 'delivered'
    ? {
        version: 1,
        phase: 'delivered',
        identity: request.identity,
        mailbox_committed_at_ms: result.mailbox_committed_at_ms,
      }
    : {
        version: 1,
        phase: 'dead',
        identity: request.identity,
        reason: result.reason,
      }
}

/** Storage only. It never signs, submits, promotes directory evidence or starts replay on Open.
 * One Level owner serializes journal mutations; callers correlate their wallet/workflow records
 * before explicitly beginning replay. Integration into the bundle remains the Stage C owner's job. */
export class LevelCanonicalStampAttemptJournal {
  private database?: LevelDB
  private state: 'closed' | 'opening' | 'open' | 'closing' | 'faulted' =
    'closed'
  private faulted = false
  private tail: Promise<void> = Promise.resolve()
  private manifest: CanonicalManifest = {
    version: 1,
    nextSequence: 1,
    acknowledgedThrough: 0,
  }
  private readonly rows = new Map<string, StoredCanonicalAttempt>()
  private readonly intents = new Map<string, StoredCanonicalIntent>()
  private readonly recoveries = new Map<string, StoredCanonicalRecovery>()
  private publicBinding: string | undefined
  private readonly eligibility = new WeakMap<
    CanonicalReplayEligibility,
    { row: StoredCanonicalAttempt; epoch: number }
  >()
  private readonly replaying = new Set<string>()
  private readonly activeReplayTokens = new WeakMap<
    CanonicalReplayEligibility,
    { ref: string; generation: number }
  >()
  private generation = 0
  private epoch = 0
  private readonly maxRecords: number
  private readonly maxBytes: number

  constructor(
    private readonly location: string,
    limits: { maxRecords?: number; maxBytes?: number } = {},
  ) {
    this.maxRecords = limits.maxRecords ?? 1024
    this.maxBytes = limits.maxBytes ?? 64 * 1024 * 1024
    if (
      !Number.isSafeInteger(this.maxRecords) ||
      this.maxRecords < 1 ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1
    )
      canonicalFail('invalid')
  }

  async Open(): Promise<void> {
    if (this.state !== 'closed') canonicalFail('closed')
    this.state = 'opening'
    const database = level(join(this.location, CANONICAL_NAMESPACE))
    try {
      await openDurableLevel(database, this.location, CANONICAL_NAMESPACE)
      let manifest: CanonicalManifest | undefined
      const rows = new Map<string, StoredCanonicalAttempt>()
      const intents = new Map<string, StoredCanonicalIntent>()
      const recoveries = new Map<string, StoredCanonicalRecovery>()
      let publicBinding: string | undefined
      for await (const [key, encoded] of database.iterator({}) as any) {
        if (
          typeof encoded !== 'string' ||
          encoded.length > 4 * Math.ceil(CANONICAL_MAX_BODY / 3) + 65536
        )
          canonicalFail('corrupt')
        const value: unknown = JSON.parse(encoded)
        if (key === 'metadata:binding') {
          exactObject(value, ['version', 'tuple'])
          if (
            value.version !== 1 ||
            typeof value.tuple !== 'string' ||
            value.tuple.length > 8192
          )
            canonicalFail('corrupt')
          publicBinding = value.tuple
        } else if (typeof key === 'string' && key.startsWith('recovery:')) {
          const row = validateRecovery(value)
          if (
            key !== `recovery:${row.obligationId}` ||
            recoveries.has(row.obligationId)
          )
            canonicalFail('corrupt')
          recoveries.set(row.obligationId, row)
        } else if (typeof key === 'string' && key.startsWith('intent:')) {
          const intent = this.validateIntent(value)
          if (
            key !== `intent:${intent.sequence.toString().padStart(16, '0')}` ||
            intents.has(intent.attemptRef)
          )
            canonicalFail('corrupt')
          intents.set(intent.attemptRef, intent)
        } else if (key === CANONICAL_MANIFEST) {
          exactObject(value, ['version', 'nextSequence', 'acknowledgedThrough'])
          if (
            value.version !== 1 ||
            !Number.isSafeInteger(value.nextSequence) ||
            (value.nextSequence as number) < 1 ||
            !Number.isSafeInteger(value.acknowledgedThrough) ||
            (value.acknowledgedThrough as number) < 0 ||
            (value.acknowledgedThrough as number) >=
              (value.nextSequence as number)
          )
            canonicalFail('corrupt')
          manifest = value as unknown as CanonicalManifest
        } else {
          const row = this.validateRow(value)
          if (key !== attemptKey(row.sequence) || rows.has(row.attemptRef))
            canonicalFail('corrupt')
          rows.set(row.attemptRef, row)
        }
      }
      if (manifest === undefined) {
        if (rows.size !== 0 || intents.size !== 0 || recoveries.size !== 0)
          canonicalFail('corrupt')
        manifest = { version: 1, nextSequence: 1, acknowledgedThrough: 0 }
        await durablePut(database, CANONICAL_MANIFEST, JSON.stringify(manifest))
      }
      if (
        rows.size + intents.size !==
        manifest.nextSequence - manifest.acknowledgedThrough - 1
      )
        canonicalFail('corrupt')
      const submissions = new Set<string>(),
        owners = new Set<string>(),
        reservationIds = new Set<string>(),
        leaseIndices = new Set<number>()
      for (const row of rows.values()) {
        if (
          row.sequence <= manifest.acknowledgedThrough ||
          row.sequence >= manifest.nextSequence
        )
          canonicalFail('corrupt')
        const next = this.publicRow(row)
        const owner = `${next.prepared.network}:${next.prepared.recipientSubject}:${next.request.identity.payload_hash}`
        if (
          submissions.has(next.request.identity.submission_identity) ||
          owners.has(owner)
        )
          canonicalFail('corrupt')
        submissions.add(next.request.identity.submission_identity)
        owners.add(owner)
        if (!next.cleanupComplete)
          for (const reservation of next.reservations) {
            if (
              reservationIds.has(reservation.id) ||
              leaseIndices.has(reservation.index)
            )
              canonicalFail('corrupt')
            reservationIds.add(reservation.id)
            leaseIndices.add(reservation.index)
          }
      }
      for (const intent of intents.values()) {
        if (
          rows.has(intent.attemptRef) ||
          intent.sequence <= manifest.acknowledgedThrough ||
          intent.sequence >= manifest.nextSequence
        )
          canonicalFail('corrupt')
        for (const member of intent.members) {
          if (
            reservationIds.has(member.reservation.id) ||
            leaseIndices.has(member.reservation.index)
          )
            canonicalFail('corrupt')
          reservationIds.add(member.reservation.id)
          leaseIndices.add(member.reservation.index)
        }
        for (const other of rows.values())
          if (
            compareBytes(
              this.publicRow(other).prepared.payload,
              this.publicIntent(intent).prepared.payload,
            ) === 0
          )
            canonicalFail('corrupt')
      }
      for (const row of recoveries.values())
        this.assertRecoveryBinding(row, publicBinding)
      const retainedBytes =
        [...rows.values()].reduce(
          (n, row) =>
            n +
            Buffer.byteLength(JSON.stringify(row)) +
            (row.terminal === null ? 16384 : 0),
          0,
        ) +
        [...intents.values()].reduce((n, row) => n + row.reservedBytes, 0) +
        [...recoveries.values()].reduce((n, row) => n + row.reservedBytes, 0)
      if (
        rows.size + intents.size + recoveries.size > this.maxRecords ||
        retainedBytes > this.maxBytes
      )
        canonicalFail('corrupt')
      this.recoveries.clear()
      for (const [id, row] of recoveries) this.recoveries.set(id, row)
      this.database = database
      this.manifest = manifest
      this.publicBinding = publicBinding
      this.intents.clear()
      for (const [ref, row] of intents) this.intents.set(ref, row)
      this.rows.clear()
      for (const [ref, row] of rows) this.rows.set(ref, row)
      this.replaying.clear()
      this.epoch++
      this.generation++
      this.faulted = false
      this.state = 'open'
    } catch (error) {
      await database.close()
      this.state = 'closed'
      if (
        error instanceof CanonicalAttemptJournalError &&
        error.code === 'corrupt'
      )
        throw error
      throw new CanonicalAttemptJournalError('corrupt')
    }
  }

  async Close(): Promise<void> {
    if (this.state !== 'open' && this.state !== 'faulted')
      canonicalFail('closed')
    this.state = 'closing'
    await this.tail
    try {
      await this.database!.close()
    } finally {
      this.database = undefined
      this.rows.clear()
      this.intents.clear()
      this.recoveries.clear()
      this.publicBinding = undefined
      this.replaying.clear()
      this.epoch++
      this.generation++
      this.state = 'closed'
    }
  }

  private assertOpen(): void {
    if (this.faulted) canonicalFail('corrupt')
    if (this.state !== 'open') canonicalFail('closed')
  }

  private async persist(write: () => Promise<unknown>): Promise<void> {
    try {
      await write()
    } catch (error) {
      // A rejected I/O callback may still have committed bytes. Require reopen/correlation;
      // never let a stale in-memory map authorize another signed set after uncertain storage.
      this.faulted = true
      this.state = 'faulted'
      this.epoch++
      this.replaying.clear()
      throw error
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const result = this.tail.then(() => {
      if (this.faulted) canonicalFail('corrupt')
      return operation()
    })
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private publicRow(row: StoredCanonicalAttempt): CanonicalJournalAttempt {
    const request = restoreCanonicalRequest({
      body: fromBase64(row.request.body, CANONICAL_MAX_BODY),
      contentType: row.request.contentType,
    })
    return {
      version: 1,
      attemptRef: row.attemptRef,
      prepared: preparedOf(row, request),
      request,
      reservations: row.reservations.map(item => ({ ...item })),
      consumerId: row.consumerId,
      terminal:
        row.terminal === null ? null : JSON.parse(JSON.stringify(row.terminal)),
      cleanupComplete: row.cleanupComplete,
      acknowledged: row.acknowledged,
    }
  }

  private validateRow(value: unknown): StoredCanonicalAttempt {
    exactObject(value, [
      'version',
      'attemptRef',
      'sequence',
      'binding',
      'request',
      'reservations',
      'consumerId',
      'terminal',
      'cleanupComplete',
      'acknowledged',
    ])
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.sequence) ||
      (value.sequence as number) < 1 ||
      value.attemptRef !== refForSequence(value.sequence as number) ||
      typeof value.cleanupComplete !== 'boolean' ||
      typeof value.acknowledged !== 'boolean'
    )
      canonicalFail('invalid')
    exactObject(value.binding, [
      'walletBindingId',
      'accountId',
      'chainId',
      'network',
      'senderSubject',
      'recipientSubject',
      'senderT1',
      'recipientT1',
      'economicBinding',
    ])
    exactObject(value.request, ['body', 'contentType'])
    if (
      typeof value.request.contentType !== 'string' ||
      value.request.contentType.length > 256
    )
      canonicalFail('invalid')
    boundedName(value.consumerId)
    const row = value as unknown as StoredCanonicalAttempt
    const request = restoreCanonicalRequest({
      body: fromBase64(row.request.body, CANONICAL_MAX_BODY),
      contentType: row.request.contentType,
    })
    assertPrepared(preparedOf(row, request), request)
    assertReservations(row.reservations, request.parts.transactions.length)
    if (row.terminal === null) {
      if (row.cleanupComplete || row.acknowledged) canonicalFail('invalid')
    } else {
      row.terminal = terminalFor(row.terminal, request)
      if (row.acknowledged && !row.cleanupComplete) canonicalFail('invalid')
    }
    return row
  }

  /** Public identity supplements the real pool owner; it does not grant custody. */
  bindPublicTuple(tuple: string): Promise<void> {
    if (typeof tuple !== 'string' || tuple.length === 0 || tuple.length > 8192)
      canonicalFail('invalid')
    const parsed = JSON.parse(tuple)
    if (
      parsed.version !== 1 ||
      parsed.domain !== 'frank-canonical-wallet-binding-v1' ||
      JSON.stringify(parsed) !== tuple
    )
      canonicalFail('invalid')
    return this.serialize(async () => {
      if (this.publicBinding !== undefined) {
        if (this.publicBinding !== tuple) canonicalFail('conflict')
        return
      }
      if (this.rows.size || this.intents.size || this.recoveries.size)
        canonicalFail('conflict')
      await this.persist(() =>
        durablePut(
          this.database!,
          'metadata:binding',
          JSON.stringify({ version: 1, tuple }),
        ),
      )
      this.publicBinding = tuple
    })
  }

  private publicIntent(row: StoredCanonicalIntent): CanonicalJournalIntent {
    return {
      version: 1,
      attemptRef: row.attemptRef,
      prepared: {
        ...row.prepared,
        payload: fromBase64(row.prepared.payload, CANONICAL_MAX_BODY),
        context: fromBase64(row.prepared.context, 4096),
        economicBinding: fromBase64(row.prepared.economicBinding, 16384),
      },
      consumerId: row.consumerId,
      boundary: row.boundary,
      members: row.members.map(m => ({
        ...m,
        reservation: { ...m.reservation },
      })),
      construction: fromBase64(row.construction, 16384),
    }
  }

  private validateIntent(value: unknown): StoredCanonicalIntent {
    exactObject(value, [
      'version',
      'attemptRef',
      'sequence',
      'prepared',
      'consumerId',
      'boundary',
      'members',
      'construction',
      'reservedBytes',
    ])
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.sequence) ||
      (value.sequence as number) < 1 ||
      value.attemptRef !== refForSequence(value.sequence as number)
    )
      canonicalFail('invalid')
    exactObject(value.prepared, [
      'walletBindingId',
      'accountId',
      'chainId',
      'network',
      'senderSubject',
      'recipientSubject',
      'senderT1',
      'recipientT1',
      'economicBinding',
      'payload',
      'context',
    ])
    boundedName(value.consumerId)
    if (
      typeof value.boundary !== 'string' ||
      !/^[a-zA-Z0-9._-]{16,70}$/.test(value.boundary) ||
      !Array.isArray(value.members) ||
      value.members.length < 1 ||
      value.members.length > 64
    )
      canonicalFail('invalid')
    const row = value as unknown as StoredCanonicalIntent
    const publicRow = this.publicIntent(row)
    assertPrepared(publicRow.prepared)
    assertReservations(
      publicRow.members.map(m => m.reservation),
      publicRow.members.length,
    )
    const senders = new Set<string>(),
      nonces = new Set<string>()
    for (const member of row.members) {
      exactObject(member, [
        'reservation',
        'from',
        'unsignedSerialized',
        'rawTx',
      ])
      if (
        !/^0x[0-9a-f]{40}$/.test(member.from) ||
        typeof member.unsignedSerialized !== 'string' ||
        member.unsignedSerialized.length > 65536
      )
        canonicalFail('invalid')
      const tx = Transaction.from(member.unsignedSerialized)
      if (
        tx.signature !== null ||
        tx.unsignedSerialized !== member.unsignedSerialized ||
        tx.chainId.toString() !== publicRow.prepared.chainId ||
        tx.to === null ||
        tx.value <= 0n ||
        tx.gasLimit <= 0n ||
        (tx.type !== 0 && tx.type !== 2)
      )
        canonicalFail('invalid')
      const nonce = `${tx.chainId}:${member.from}:${tx.nonce}`
      if (senders.has(member.from) || nonces.has(nonce))
        canonicalFail('invalid')
      senders.add(member.from)
      nonces.add(nonce)
      if (member.rawTx !== null) {
        if (typeof member.rawTx !== 'string' || member.rawTx.length > 66000)
          canonicalFail('invalid')
        const signed = Transaction.from(member.rawTx)
        if (
          signed.signature === null ||
          signed.from?.toLowerCase() !== member.from ||
          signed.unsignedSerialized !== member.unsignedSerialized
        )
          canonicalFail('invalid')
      }
    }
    const minimum =
      Buffer.byteLength(JSON.stringify(row)) +
      (CANONICAL_MAX_BODY * 4) / 3 +
      65536
    if (
      !Number.isSafeInteger(row.reservedBytes) ||
      row.reservedBytes < minimum ||
      row.reservedBytes > 16 * 1024 * 1024
    )
      canonicalFail('invalid')
    return row
  }

  private recoveryBytes(): number {
    return [...this.recoveries.values()].reduce(
      (n, row) => n + row.reservedBytes,
      0,
    )
  }
  private assertRecoveryBinding(
    row: StoredCanonicalRecovery,
    tuple = this.publicBinding,
  ): void {
    if (!tuple) canonicalFail('conflict')
    const bound = JSON.parse(tuple),
      view = publicRecovery(row)
    const delivery = parseFrame(view.request.parts.delivery)
    if (delivery.kind !== 'parsed' || delivery.typed?.type !== 1)
      canonicalFail('conflict')
    const payload = parseFrame(delivery.typed.payloadFrame.frame)
    if (
      row.walletBindingId !== sha256(toUtf8Bytes(tuple)).slice(2) ||
      view.request.identity.network !== bound.network ||
      payload.kind !== 'parsed' ||
      payload.typed?.type !== 5 ||
      '0x' + toHex(payload.typed.recipient.keyBytes) !== bound.auth
    )
      canonicalFail('conflict')
  }
  getImportedRecoveries(): CanonicalImportedRecovery[] {
    this.assertOpen()
    return [...this.recoveries.values()].map(publicRecovery)
  }
  importedRecovery(
    obligationId: string,
  ): CanonicalImportedRecovery | undefined {
    this.assertOpen()
    const row = this.recoveries.get(obligationId)
    return row && publicRecovery(row)
  }
  retainedRecoveryCustody(obligationId: string): CanonicalRecoveryCustody {
    this.assertOpen()
    const row = this.recoveries.get(obligationId)
    if (!row) canonicalFail('conflict')
    const snapshot = JSON.stringify({
      body: row.body,
      stampGeneration: row.stampGeneration,
      walletBindingId: row.walletBindingId,
    })
    const proof = Object.freeze({ obligationId })
    retainedRecoveryCustody.set(proof, () => {
      this.assertOpen()
      const current = this.recoveries.get(obligationId)
      if (
        !current ||
        snapshot !==
          JSON.stringify({
            body: current.body,
            stampGeneration: current.stampGeneration,
            walletBindingId: current.walletBindingId,
          })
      )
        canonicalFail('conflict')
      this.assertRecoveryBinding(current)
      return publicRecovery(current)
    })
    return proof
  }
  importRecovery(
    input: Omit<
      CanonicalImportedRecovery,
      | 'version'
      | 'stampKeyHex'
      | 'sharedPointHex'
      | 'recipientT1'
      | 'accounts'
      | 'recipientAcknowledged'
    >,
  ): Promise<CanonicalImportedRecovery> {
    const request = restoreCanonicalRequest({
      body: input.request.body,
      contentType: input.request.contentType,
    })
    if (!equalCanonicalRequests(request, input.request))
      canonicalFail('conflict')
    const delivery = parseFrame(request.parts.delivery)
    if (delivery.kind !== 'parsed' || delivery.typed?.type !== 1)
      canonicalFail('invalid')
    // Compute public accounts from the complete raw set, then strictly compare on every reopen.
    if (
      !Array.isArray(input.confirmedChildren) ||
      input.confirmedChildren.length > 64 ||
      input.confirmedChildren.some(
        (i, n) =>
          !Number.isSafeInteger(i) ||
          i < 0 ||
          i >= request.parts.transactions.length ||
          (n > 0 && i <= input.confirmedChildren[n - 1]),
      )
    )
      canonicalFail('invalid')
    const accounts = input.confirmedChildren.map(childIndex => {
      const tx = Transaction.from(
        hexlify(request.parts.transactions[childIndex]),
      )
      return {
        childIndex,
        transactionHash: tx.hash!.toLowerCase(),
        address: tx.to!.toLowerCase(),
        valueWei: tx.value.toString(),
      }
    })
    const candidate: StoredCanonicalRecovery = {
      version: 1,
      obligationId: input.obligationId,
      walletBindingId: input.walletBindingId,
      body: Buffer.from(request.body).toString('base64'),
      contentType: request.contentType,
      confirmedChildren: [...input.confirmedChildren],
      lifecycle: input.lifecycle,
      stampGeneration: input.stampGeneration,
      accounts,
      recipientAcknowledged: false,
      reservedBytes: 0,
    }
    candidate.reservedBytes = recoveryMaximumCharge(candidate)
    const row = validateRecovery(candidate)
    this.assertRecoveryBinding(row)
    return this.serialize(async () => {
      for (const other of this.recoveries.values()) {
        if (other.obligationId === row.obligationId) continue
        const retained = publicRecovery(other),
          next = publicRecovery(row)
        if (
          retained.request.identity.submission_identity ===
            next.request.identity.submission_identity ||
          (retained.request.identity.network ===
            next.request.identity.network &&
            retained.request.identity.recipient ===
              next.request.identity.recipient &&
            retained.request.identity.payload_hash ===
              next.request.identity.payload_hash)
        )
          canonicalFail('conflict')
      }
      const prior = this.recoveries.get(row.obligationId)
      if (prior) {
        if (
          prior.body !== row.body ||
          prior.contentType !== row.contentType ||
          prior.walletBindingId !== row.walletBindingId ||
          prior.stampGeneration !== row.stampGeneration ||
          prior.confirmedChildren.some(
            i => !row.confirmedChildren.includes(i),
          ) ||
          (terminalRecovery(prior.lifecycle) &&
            (prior.lifecycle !== row.lifecycle ||
              JSON.stringify(prior.confirmedChildren) !==
                JSON.stringify(row.confirmedChildren))) ||
          (prior.lifecycle === 'fully_confirmed' &&
            row.lifecycle === 'pending') ||
          (prior.lifecycle === 'delivered' && row.lifecycle !== 'delivered')
        )
          canonicalFail('conflict')
        row.recipientAcknowledged = prior.recipientAcknowledged
        if (JSON.stringify(row) === JSON.stringify(prior))
          return publicRecovery(prior)
      }
      const bytes =
        [...this.rows.values()].reduce(
          (n, item) =>
            n +
            Buffer.byteLength(JSON.stringify(item)) +
            (item.terminal === null ? 16384 : 0),
          0,
        ) +
        this.intentBytes() +
        this.recoveryBytes() -
        (prior ? prior.reservedBytes : 0) +
        row.reservedBytes
      if (
        (!prior &&
          this.rows.size + this.intents.size + this.recoveries.size >=
            this.maxRecords) ||
        bytes > this.maxBytes
      )
        canonicalFail('capacity')
      await this.persist(() =>
        durablePut(
          this.database!,
          `recovery:${row.obligationId}`,
          JSON.stringify(row),
        ),
      )
      this.recoveries.set(row.obligationId, row)
      return publicRecovery(row)
    })
  }
  markRecoveryAcknowledged(obligationId: string): Promise<void> {
    return this.serialize(async () => {
      const prior = this.recoveries.get(obligationId)
      if (!prior || !terminalRecovery(prior.lifecycle))
        canonicalFail('conflict')
      if (prior.recipientAcknowledged) return
      const row = { ...prior, recipientAcknowledged: true }
      await this.persist(() =>
        durablePut(
          this.database!,
          `recovery:${obligationId}`,
          JSON.stringify(row),
        ),
      )
      this.recoveries.set(obligationId, row)
    })
  }
  private intentBytes(): number {
    return Array.from(this.intents.values()).reduce(
      (n, row) => n + row.reservedBytes,
      0,
    )
  }
  getIntents(): CanonicalJournalIntent[] {
    this.assertOpen()
    return Array.from(this.intents.values()).map(row => this.publicIntent(row))
  }
  lookupIntent(
    prepared: CanonicalPreparedAttempt,
  ): CanonicalJournalIntent | undefined {
    this.assertOpen()
    assertPrepared(prepared)
    for (const row of this.intents.values()) {
      const intent = this.publicIntent(row)
      if (samePrepared(intent.prepared, prepared)) return intent
      if (compareBytes(intent.prepared.payload, prepared.payload) === 0)
        canonicalFail('conflict')
    }
    this.lookup(prepared)
    return undefined
  }

  prepareIntent(
    input: Omit<CanonicalJournalIntent, 'version' | 'attemptRef'>,
  ): Promise<CanonicalJournalIntent> {
    assertPrepared(input.prepared)
    const snapshot = {
      version: 1 as const,
      attemptRef: refForSequence(1),
      sequence: 1,
      prepared: {
        ...bindingOf(input.prepared),
        payload: base64(input.prepared.payload),
        context: base64(input.prepared.context),
      },
      consumerId: input.consumerId,
      boundary: input.boundary,
      members: input.members.map(m => ({
        ...m,
        reservation: { ...m.reservation },
      })),
      construction: base64(input.construction),
      reservedBytes: 0,
    }
    if (snapshot.members.some(m => m.rawTx !== null)) canonicalFail('invalid')
    snapshot.reservedBytes = Math.ceil(
      Buffer.byteLength(JSON.stringify(snapshot)) +
        (CANONICAL_MAX_BODY * 4) / 3 +
        131072,
    )
    this.validateIntent(snapshot)
    const prepared = this.publicIntent(snapshot).prepared
    return this.serialize(async () => {
      if (this.publicBinding === undefined) canonicalFail('conflict')
      const bound = JSON.parse(this.publicBinding)
      if (
        sha256(toUtf8Bytes(this.publicBinding)).slice(2) !==
          prepared.walletBindingId ||
        bound.network !== prepared.network ||
        bound.chainId !== prepared.chainId ||
        bound.auth !== `0x${prepared.senderSubject}` ||
        bound.main !== prepared.accountId
      )
        canonicalFail('conflict')
      const prior = this.lookupIntent(prepared)
      if (prior !== undefined) {
        if (
          prior.consumerId !== snapshot.consumerId ||
          prior.boundary !== snapshot.boundary ||
          JSON.stringify(prior.members.map(m => ({ ...m, rawTx: null }))) !==
            JSON.stringify(snapshot.members) ||
          base64(prior.construction) !== snapshot.construction
        )
          canonicalFail('conflict')
        return prior
      }
      if (this.lookup(prepared) !== undefined) canonicalFail('conflict')
      const reservations = snapshot.members.map(m => m.reservation)
      for (const other of [
        ...this.getAll()
          .filter(a => !a.cleanupComplete)
          .map(a => a.reservations),
        ...this.getIntents().map(a => a.members.map(m => m.reservation)),
      ])
        if (
          other.some(a =>
            reservations.some(b => a.id === b.id || a.index === b.index),
          )
        )
          canonicalFail('conflict')
      const bytes = Array.from(this.rows.values()).reduce(
        (n, row) =>
          n +
          Buffer.byteLength(JSON.stringify(row)) +
          (row.terminal === null ? 16384 : 0),
        0,
      )
      if (
        this.rows.size + this.intents.size + this.recoveries.size >=
          this.maxRecords ||
        bytes +
          this.intentBytes() +
          this.recoveryBytes() +
          snapshot.reservedBytes >
          this.maxBytes ||
        this.manifest.nextSequence >= Number.MAX_SAFE_INTEGER
      )
        canonicalFail('capacity')
      const sequence = this.manifest.nextSequence
      const row = {
        ...snapshot,
        sequence,
        attemptRef: refForSequence(sequence),
      }
      const manifest = { ...this.manifest, nextSequence: sequence + 1 }
      await this.persist(() =>
        durableBatch(this.database!, [
          {
            type: 'put',
            key: `intent:${sequence.toString().padStart(16, '0')}`,
            value: JSON.stringify(row),
          },
          {
            type: 'put',
            key: CANONICAL_MANIFEST,
            value: JSON.stringify(manifest),
          },
        ]),
      )
      this.intents.set(row.attemptRef, row)
      this.manifest = manifest
      this.epoch++
      return this.publicIntent(row)
    })
  }

  checkpointSignedMember(
    attemptRef: string,
    index: number,
    rawTx: string,
  ): Promise<CanonicalJournalIntent> {
    return this.serialize(async () => {
      const old = this.intents.get(attemptRef)
      if (
        old === undefined ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= old.members.length
      )
        canonicalFail('conflict')
      if (
        old.members[index].rawTx !== null &&
        old.members[index].rawTx !== rawTx
      )
        canonicalFail('conflict')
      const row = {
        ...old,
        members: old.members.map((m, i) => (i === index ? { ...m, rawTx } : m)),
      }
      this.validateIntent(row)
      await this.persist(() =>
        durablePut(
          this.database!,
          `intent:${row.sequence.toString().padStart(16, '0')}`,
          JSON.stringify(row),
        ),
      )
      this.intents.set(attemptRef, row)
      this.epoch++
      return this.publicIntent(row)
    })
  }

  promoteIntent(
    attemptRef: string,
    input: CanonicalExactRequest,
  ): Promise<CanonicalJournalAttempt> {
    const request = restoreCanonicalRequest({
      body: new Uint8Array(input.body),
      contentType: input.contentType,
    })
    if (!equalCanonicalRequests(input, request)) canonicalFail('conflict')
    return this.serialize(async () => {
      const old = this.intents.get(attemptRef)
      if (old === undefined) canonicalFail('conflict')
      const intent = this.publicIntent(old)
      assertPrepared(intent.prepared, request)
      if (
        request.contentType !==
          `multipart/form-data; boundary=${intent.boundary}` ||
        intent.members.length !== request.parts.transactions.length ||
        intent.members.some(
          (m, i) =>
            m.rawTx === null ||
            hexlify(request.parts.transactions[i]) !== m.rawTx,
        )
      )
        canonicalFail('conflict')
      const row: StoredCanonicalAttempt = {
        version: 1,
        attemptRef,
        sequence: old.sequence,
        binding: bindingOf(intent.prepared),
        request: {
          body: base64(request.body),
          contentType: request.contentType,
        },
        reservations: intent.members.map(m => ({ ...m.reservation })),
        consumerId: intent.consumerId,
        terminal: null,
        cleanupComplete: false,
        acknowledged: false,
      }
      this.validateRow(row)
      if (Buffer.byteLength(JSON.stringify(row)) + 16384 > old.reservedBytes)
        canonicalFail('capacity')
      await this.persist(() =>
        durableBatch(this.database!, [
          {
            type: 'put',
            key: attemptKey(row.sequence),
            value: JSON.stringify(row),
          },
          {
            type: 'del',
            key: `intent:${old.sequence.toString().padStart(16, '0')}`,
          },
        ]),
      )
      this.intents.delete(attemptRef)
      this.rows.set(attemptRef, row)
      this.epoch++
      return this.publicRow(row)
    })
  }

  /** Effect-free full prepared identity lookup, including immutable policy and exact bytes. */
  lookup(
    prepared: CanonicalPreparedAttempt,
  ): CanonicalJournalAttempt | undefined {
    this.assertOpen()
    assertPrepared(prepared)
    for (const row of this.rows.values()) {
      const attempt = this.publicRow(row)
      if (samePrepared(attempt.prepared, prepared)) return attempt
      if (compareBytes(attempt.prepared.payload, prepared.payload) === 0)
        canonicalFail('conflict')
    }
    return undefined
  }

  getAll(): CanonicalJournalAttempt[] {
    this.assertOpen()
    return Array.from(this.rows.values()).map(row => this.publicRow(row))
  }

  /** Resolves only after the actual durable database barrier. No network callback is accepted. */
  prepare(input: {
    prepared: CanonicalPreparedAttempt
    request: CanonicalExactRequest
    reservations: readonly CanonicalAttemptReservation[]
    consumerId: string
  }): Promise<CanonicalJournalAttempt> {
    // Snapshot before any await; caller mutation cannot change the promised durable identity.
    const request = restoreCanonicalRequest({
      body: new Uint8Array(input.request.body),
      contentType: input.request.contentType,
    })
    if (!equalCanonicalRequests(input.request, request))
      canonicalFail('conflict')
    assertPrepared(input.prepared, request)
    assertReservations(input.reservations, request.parts.transactions.length)
    boundedName(input.consumerId)
    const binding = bindingOf(input.prepared)
    const reservations = input.reservations.map(item => ({ ...item }))
    const consumerId = input.consumerId
    return this.serialize(async () => {
      const candidatePrepared = {
        ...binding,
        economicBinding: fromBase64(binding.economicBinding, 16384),
        payload: payloadFromRequest(request),
        context: new Uint8Array(request.parts.context),
      }
      for (const old of this.rows.values()) {
        const prior = this.publicRow(old)
        if (samePrepared(prior.prepared, candidatePrepared)) {
          if (
            !equalCanonicalRequests(prior.request, request) ||
            prior.consumerId !== consumerId ||
            JSON.stringify(prior.reservations) !== JSON.stringify(reservations)
          )
            canonicalFail('conflict')
          return prior
        }
        // Full tuple/index collision and reservation conflicts hold rather than create a new set.
        if (
          prior.request.identity.submission_identity ===
            request.identity.submission_identity ||
          (prior.prepared.network === binding.network &&
            prior.prepared.recipientSubject === binding.recipientSubject &&
            prior.request.identity.payload_hash ===
              request.identity.payload_hash) ||
          (!prior.cleanupComplete &&
            prior.reservations.some(a =>
              reservations.some(b => a.id === b.id || a.index === b.index),
            ))
        )
          canonicalFail('conflict')
      }
      if (this.intents.size > 0) {
        for (const intent of this.intents.values()) {
          const prior = this.publicIntent(intent)
          if (
            compareBytes(prior.prepared.payload, candidatePrepared.payload) ===
              0 ||
            prior.members.some(a =>
              reservations.some(
                b =>
                  a.reservation.id === b.id || a.reservation.index === b.index,
              ),
            )
          )
            canonicalFail('conflict')
        }
      }
      const sequence = this.manifest.nextSequence
      if (sequence >= Number.MAX_SAFE_INTEGER) canonicalFail('capacity')
      const row: StoredCanonicalAttempt = {
        version: 1,
        attemptRef: refForSequence(sequence),
        sequence,
        binding,
        request: {
          body: base64(request.body),
          contentType: request.contentType,
        },
        reservations,
        consumerId,
        terminal: null,
        cleanupComplete: false,
        acknowledged: false,
      }
      // Reserve the bounded terminal response now, so a full journal can still record outcomes.
      const retainedBytes = (item: StoredCanonicalAttempt) =>
        Buffer.byteLength(JSON.stringify(item)) +
        (item.terminal === null ? 16384 : 0)
      const bytes =
        retainedBytes(row) +
        Array.from(this.rows.values()).reduce(
          (n, item) => n + retainedBytes(item),
          0,
        )
      if (
        this.rows.size + this.intents.size + this.recoveries.size >=
          this.maxRecords ||
        bytes + this.intentBytes() + this.recoveryBytes() > this.maxBytes
      )
        canonicalFail('capacity')
      const manifest = { ...this.manifest, nextSequence: sequence + 1 }
      await this.persist(() =>
        durableBatch(this.database!, [
          {
            type: 'put',
            key: attemptKey(sequence),
            value: JSON.stringify(row),
          },
          {
            type: 'put',
            key: CANONICAL_MANIFEST,
            value: JSON.stringify(manifest),
          },
        ]),
      )
      this.rows.set(row.attemptRef, row)
      this.manifest = manifest
      this.epoch++
      return this.publicRow(row)
    })
  }

  /** Correlates exact external workflow/reservation ownership. Missing/duplicate/mismatched
   * records remain held; this operation itself has no replay or payment effect. */
  reconcile(
    expected: readonly CanonicalAttemptCorrelation[],
  ): CanonicalAttemptReconciliation[] {
    this.assertOpen()
    this.epoch++ // A new correlation snapshot invalidates every earlier unused eligibility.
    const result: CanonicalAttemptReconciliation[] = []
    const refs = new Set([
      ...this.rows.keys(),
      ...expected.map(item => item.attemptRef),
    ])
    for (const ref of refs) {
      const matches = expected.filter(item => item.attemptRef === ref)
      const row = this.rows.get(ref)
      if (matches.length > 1) {
        result.push({ attemptRef: ref, state: 'hold', reason: 'ambiguous' })
        continue
      }
      if (row === undefined) {
        result.push({ attemptRef: ref, state: 'hold', reason: 'missing' })
        continue
      }
      if (matches.length === 0) {
        result.push({ attemptRef: ref, state: 'hold', reason: 'orphan' })
        continue
      }
      const attempt = this.publicRow(row),
        match = matches[0]
      try {
        assertPrepared(match.prepared, match.request)
        assertReservations(
          match.reservations,
          match.request.parts.transactions.length,
        )
        if (
          !samePrepared(attempt.prepared, match.prepared) ||
          !equalCanonicalRequests(attempt.request, match.request) ||
          attempt.consumerId !== match.consumerId ||
          JSON.stringify(attempt.reservations) !==
            JSON.stringify(match.reservations)
        )
          canonicalFail('conflict')
      } catch {
        result.push({ attemptRef: ref, state: 'hold', reason: 'mismatch' })
        continue
      }
      if (attempt.terminal !== null) {
        result.push({ attemptRef: ref, state: 'terminal', attempt })
        continue
      }
      const eligibility = Object.freeze({ attemptRef: ref })
      this.eligibility.set(eligibility, { row, epoch: this.epoch })
      result.push({ attemptRef: ref, state: 'ready', eligibility })
    }
    return result
  }

  beginReplay(
    eligibility: CanonicalReplayEligibility,
  ): Promise<CanonicalJournalAttempt> {
    return this.serialize(async () => {
      const admitted = this.eligibility.get(eligibility)
      this.eligibility.delete(eligibility)
      if (
        admitted === undefined ||
        admitted.epoch !== this.epoch ||
        this.rows.get(eligibility.attemptRef) !== admitted.row ||
        admitted.row.terminal !== null ||
        this.replaying.has(eligibility.attemptRef)
      )
        canonicalFail('replay')
      this.replaying.add(eligibility.attemptRef)
      this.activeReplayTokens.set(eligibility, {
        ref: eligibility.attemptRef,
        generation: this.generation,
      })
      return this.publicRow(admitted.row)
    })
  }

  endReplay(eligibility: CanonicalReplayEligibility): void {
    this.assertOpen()
    const active = this.activeReplayTokens.get(eligibility)
    if (active === undefined || active.generation !== this.generation)
      canonicalFail('replay')
    this.activeReplayTokens.delete(eligibility)
    this.replaying.delete(active.ref)
  }

  recordTerminal(
    attemptRef: string,
    terminal: CanonicalAttemptTerminal,
  ): Promise<CanonicalJournalAttempt> {
    const copy = JSON.parse(JSON.stringify(terminal))
    return this.serialize(async () => {
      const old = this.rows.get(attemptRef)
      if (old === undefined) canonicalFail('conflict')
      const accepted = terminalFor(copy, this.publicRow(old).request)
      if (old.terminal !== null) {
        if (JSON.stringify(old.terminal) !== JSON.stringify(accepted))
          canonicalFail('conflict')
        return this.publicRow(old)
      }
      const row = { ...old, terminal: accepted }
      await this.persist(() =>
        durablePut(
          this.database!,
          attemptKey(row.sequence),
          JSON.stringify(row),
        ),
      )
      this.rows.set(attemptRef, row)
      this.replaying.delete(attemptRef)
      this.epoch++
      return this.publicRow(row)
    })
  }

  /** The bundle invokes this only after reconciling/retiring the already-owned live leases. */
  completeCleanup(attemptRef: string): Promise<void> {
    return this.serialize(async () => {
      const old = this.rows.get(attemptRef)
      if (old === undefined || old.terminal === null) canonicalFail('cleanup')
      if (old.cleanupComplete) return
      const row = { ...old, cleanupComplete: true }
      await this.persist(() =>
        durablePut(
          this.database!,
          attemptKey(row.sequence),
          JSON.stringify(row),
        ),
      )
      this.rows.set(attemptRef, row)
      this.epoch++
    })
  }

  /** Frontier proof only; it makes no delivered/consumer inference for an arbitrary missing row. */
  wasAcknowledged(attemptRef: string): boolean {
    this.assertOpen()
    const match = /^canonical-v1:([0-9]{16})$/.exec(attemptRef)
    if (match === null) canonicalFail('invalid')
    const sequence = Number(match[1])
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      refForSequence(sequence) !== attemptRef
    )
      canonicalFail('invalid')
    return sequence <= this.manifest.acknowledgedThrough
  }

  /** Only this linked consumer's durable acknowledgement advances the contiguous frontier.
   * Out-of-order acknowledged results remain retained until every predecessor is acknowledged. */
  acknowledge(attemptRef: string, consumerId: string): Promise<void> {
    boundedName(consumerId)
    return this.serialize(async () => {
      const old = this.rows.get(attemptRef)
      if (
        old === undefined ||
        old.consumerId !== consumerId ||
        old.terminal === null ||
        !old.cleanupComplete
      )
        canonicalFail('cleanup')
      const row = { ...old, acknowledged: true }
      const rows = new Map(this.rows)
      rows.set(attemptRef, row)
      let frontier = this.manifest.acknowledgedThrough
      const removed: StoredCanonicalAttempt[] = []
      while (frontier + 1 < this.manifest.nextSequence) {
        const next = rows.get(refForSequence(frontier + 1))
        if (next === undefined || !next.acknowledged) break
        removed.push(next)
        frontier++
      }
      const manifest = { ...this.manifest, acknowledgedThrough: frontier }
      await this.persist(() =>
        durableBatch(this.database!, [
          {
            type: 'put',
            key: attemptKey(row.sequence),
            value: JSON.stringify(row),
          },
          ...removed.map(item => ({
            type: 'del' as const,
            key: attemptKey(item.sequence),
          })),
          {
            type: 'put',
            key: CANONICAL_MANIFEST,
            value: JSON.stringify(manifest),
          },
        ]),
      )
      this.rows.set(attemptRef, row)
      for (const item of removed) this.rows.delete(item.attemptRef)
      this.manifest = manifest
      this.epoch++
    })
  }
}
