/** Single-context public evidence only. Acceptance never authorizes financial execution. */
import { sha256 } from '@noble/hashes/sha256.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { standaloneItemBudget } from '@frank/codec'
import registry from '../../../docs/protocol/chains/v1.json'
import {
  negotiationLimits,
  reduceNegotiationStandalone,
  validateAuthenticatedNegotiationEvent,
  type AuthenticatedNegotiationContext,
  type NegotiationContext,
  type NegotiationReduction,
  type NegotiationPairPolicy,
} from './negotiation'

/**
 * The host MUST provide linearizable CAS across handles, durable success before true,
 * committed reads or observable failure, and no initialization on absent reads.
 * False means another committed writer won. An exception can mean an ambiguous write;
 * the engine propagates it without retrying or claiming absence. No production fallback.
 */
export interface NegotiationJournalStore {
  read(key: string): Promise<string | undefined>
  compareAndSwap(
    key: string,
    expectedRaw: string | undefined,
    nextRaw: string,
  ): Promise<boolean>
}
export interface NegotiationJournalOwner {
  readonly accountIncarnation: string
  readonly localPublicKey: Uint8Array
  readonly messagingChainIdentifier: string
}
export interface NegotiationJournalAdmission {
  readonly eventBytes: Uint8Array
  readonly authenticated: AuthenticatedNegotiationContext & {
    readonly messagingChainIdentifier: string
  }
  readonly messageId: Uint8Array
  /** The stamped outer payload digest, distinct from any contentDigest. */
  readonly stampedPayloadDigest: Uint8Array
}
export interface NegotiationJournalEvidence {
  readonly eventBytes: Uint8Array
  readonly senderPublicKey: Uint8Array
  readonly recipientPublicKey: Uint8Array
  readonly direction: 'incoming' | 'outbound-replay'
  readonly messageId: Uint8Array
  readonly stampedPayloadDigest: Uint8Array
}
export interface NegotiationJournalSnapshot {
  readonly presence: 'absent' | 'present'
  readonly entries: readonly NegotiationJournalEvidence[]
  readonly reduction: NegotiationReduction
}
export type NegotiationJournalErrorCode =
  | 'invalid-input'
  | 'corrupt-record'
  | 'capacity'
  | 'contention'
export class NegotiationJournalError extends Error {
  readonly name = 'NegotiationJournalError'
  constructor(readonly code: NegotiationJournalErrorCode, detail: string) {
    super(detail)
  }
}
export const negotiationJournalLimits = Object.freeze({
  rawBytes: 262144,
  casAttempts: 8,
})

interface StoredEntry {
  eventBytes: string
  senderPublicKey: string
  recipientPublicKey: string
  direction: 'incoming' | 'outbound-replay'
  messageId: string
  stampedPayloadDigest: string
}
const fail = (code: NegotiationJournalErrorCode, detail: string): never => {
  throw new NegotiationJournalError(code, detail)
}
function copy(value: unknown, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length)
    fail('invalid-input', name)
  // Buffer.slice aliases; normalize all admitted byte inputs before awaiting storage.
  return new Uint8Array(value as Uint8Array)
}
function same(a: Uint8Array, b: Uint8Array): boolean {
  return bytesToHex(a) === bytesToHex(b)
}
function object(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('corrupt-record', 'Expected exact record object')
  const row = value as Record<string, unknown>
  const keys = Object.keys(row)
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.prototype.hasOwnProperty.call(row, field))
  )
    fail('corrupt-record', 'Unexpected record fields')
  return row
}
function storedHex(value: unknown, maximum: number, exact = maximum): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum * 2 ||
    value.length !== exact * 2 ||
    !/^[0-9a-f]*$/.test(value)
  )
    fail('corrupt-record', 'Invalid normalized bytes')
  return value as string
}
function boundedRaw(raw: unknown): asserts raw is string {
  if (
    typeof raw !== 'string' ||
    raw.length > negotiationJournalLimits.rawBytes ||
    utf8ToBytes(raw).length > negotiationJournalLimits.rawBytes
  )
    fail('corrupt-record', 'Journal raw JSON limit/type')
}
function framed(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + 4 + part.length, 0),
  )
  const view = new DataView(output.buffer)
  let offset = 0
  for (const part of parts) {
    view.setUint32(offset, part.length, false)
    output.set(part, offset + 4)
    offset += 4 + part.length
  }
  return output
}

/** Pure engine; no keys, clock, outgoing signing, host activation or storage implementation. */
class JournalBinding {
  readonly rowKey: string
  readonly owner: NegotiationJournalOwner
  readonly context: NegotiationContext
  readonly binding: ReturnType<JournalBinding['normalizedBinding']>

  constructor(input: {
    owner: NegotiationJournalOwner
    context: NegotiationContext
  }) {
    const owner = input?.owner,
      context = input?.context
    const incarnation = owner?.accountIncarnation
    // Reject non-scalar strings rather than letting UTF-8 replacement cause key collisions.
    if (
      typeof incarnation !== 'string' ||
      incarnation.length === 0 ||
      incarnation.length > 256 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        incarnation,
      ) ||
      utf8ToBytes(incarnation).length > 256
    )
      fail('invalid-input', 'Bounded UTF-8 account incarnation required')
    if (
      typeof owner.messagingChainIdentifier !== 'string' ||
      !registry.chains.some(
        (chain) => chain.id === owner.messagingChainIdentifier,
      )
    )
      fail('invalid-input', 'Canonical messaging chain required')
    if (!Array.isArray(context?.parties) || context.parties.length !== 2)
      fail('invalid-input', 'Two ordered parties required')
    this.context = {
      swapId: copy(context.swapId, 32, 'swap ID'),
      conversationId: copy(context.conversationId, 16, 'conversation ID'),
      parties: [
        copy(context.parties[0], 33, 'party A'),
        copy(context.parties[1], 33, 'party B'),
      ],
      policy: {
        name: context.policy?.name,
        xecChainIdentifier: context.policy?.xecChainIdentifier,
        evmChainIdentifier: context.policy?.evmChainIdentifier,
      },
    }
    const checked = reduceNegotiationStandalone([], this.context)
    if (!checked.ok)
      fail('invalid-input', checked.error.detail ?? checked.error.code)
    this.owner = {
      accountIncarnation: incarnation,
      localPublicKey: copy(owner.localPublicKey, 33, 'local key'),
      messagingChainIdentifier: owner.messagingChainIdentifier,
    }
    if (
      !this.context.parties.some((key) => same(key, this.owner.localPublicKey))
    )
      fail('invalid-input', 'Local key is not a negotiated party')
    this.binding = this.normalizedBinding()
    // Each component, including domain/version, has a four-byte BE byte-length prefix.
    this.rowKey = bytesToHex(
      sha256(
        framed([
          utf8ToBytes('frank/swap-negotiation-journal-key/v1'),
          utf8ToBytes('1'),
          utf8ToBytes(incarnation),
          this.owner.localPublicKey,
          utf8ToBytes(this.owner.messagingChainIdentifier),
          this.context.swapId,
          this.context.conversationId,
          ...this.context.parties,
          utf8ToBytes(this.context.policy.name),
          utf8ToBytes(this.context.policy.xecChainIdentifier),
          utf8ToBytes(this.context.policy.evmChainIdentifier),
        ]),
      ),
    )
  }

  private normalizedBinding() {
    return {
      owner: {
        accountIncarnation: this.owner.accountIncarnation,
        localPublicKey: bytesToHex(this.owner.localPublicKey),
        messagingChainIdentifier: this.owner.messagingChainIdentifier,
      },
      context: {
        swapId: bytesToHex(this.context.swapId),
        conversationId: bytesToHex(this.context.conversationId),
        parties: this.context.parties.map(bytesToHex),
        policy: { ...this.context.policy },
      },
    }
  }
  authenticate(entry: StoredEntry, code: NegotiationJournalErrorCode): void {
    const checked = validateAuthenticatedNegotiationEvent(
      hexToBytes(entry.eventBytes),
      this.context,
      {
        direction: entry.direction,
        localPublicKey: this.owner.localPublicKey,
        senderPublicKey: hexToBytes(entry.senderPublicKey),
        recipientPublicKey: hexToBytes(entry.recipientPublicKey),
        conversationId: this.context.conversationId,
      },
      standaloneItemBudget(),
    )
    if (!checked.ok) fail(code, checked.error.detail ?? checked.error.code)
  }
  reconstruct(
    entries: readonly StoredEntry[],
    presence: 'absent' | 'present',
  ): NegotiationJournalSnapshot {
    const reduction = reduceNegotiationStandalone(
      entries.map((entry) => hexToBytes(entry.eventBytes)),
      this.context,
    )
    if (!reduction.ok)
      return fail(
        'corrupt-record',
        reduction.error.detail ?? reduction.error.code,
      )
    return {
      presence,
      entries: entries.map((entry) => ({
        ...entry,
        eventBytes: hexToBytes(entry.eventBytes),
        senderPublicKey: hexToBytes(entry.senderPublicKey),
        recipientPublicKey: hexToBytes(entry.recipientPublicKey),
        messageId: hexToBytes(entry.messageId),
        stampedPayloadDigest: hexToBytes(entry.stampedPayloadDigest),
      })),
      reduction: reduction.value,
    }
  }
  parse(raw: string | undefined): StoredEntry[] {
    if (raw === undefined) return []
    return this.parseRecord(parseRawRecord(raw))
  }
  private parseRecord(row: Record<string, unknown>): StoredEntry[] {
    const owner = object(row.owner, [
      'accountIncarnation',
      'localPublicKey',
      'messagingChainIdentifier',
    ])
    const context = object(row.context, [
      'swapId',
      'conversationId',
      'parties',
      'policy',
    ])
    const policy = object(context.policy, [
      'name',
      'xecChainIdentifier',
      'evmChainIdentifier',
    ])
    for (const field of [
      'accountIncarnation',
      'localPublicKey',
      'messagingChainIdentifier',
    ] as const)
      if (owner[field] !== this.binding.owner[field])
        fail('corrupt-record', 'Journal owner binding mismatch')
    for (const field of ['swapId', 'conversationId'] as const)
      if (context[field] !== this.binding.context[field])
        fail('corrupt-record', 'Journal context binding mismatch')
    if (
      !Array.isArray(context.parties) ||
      context.parties.length !== 2 ||
      context.parties.some((key, i) => key !== this.binding.context.parties[i])
    )
      fail('corrupt-record', 'Journal parties mismatch')
    for (const field of [
      'name',
      'xecChainIdentifier',
      'evmChainIdentifier',
    ] as const)
      if (policy[field] !== this.binding.context.policy[field])
        fail('corrupt-record', 'Journal policy mismatch')
    if (
      !Array.isArray(row.entries) ||
      row.entries.length > negotiationLimits.events
    )
      fail('corrupt-record', 'Journal entry count limit')
    let total = 0
    const seen = new Set<string>()
    const entries = (row.entries as unknown[]).map((value) => {
      const entry = object(value, [
        'eventBytes',
        'senderPublicKey',
        'recipientPublicKey',
        'direction',
        'messageId',
        'stampedPayloadDigest',
      ])
      const bytes = entry.eventBytes
      if (
        typeof bytes !== 'string' ||
        bytes.length === 0 ||
        bytes.length % 2 ||
        bytes.length > negotiationLimits.eventBytes * 2
      )
        fail('corrupt-record', 'Journal event byte limit/type')
      const eventBytes = storedHex(
        bytes,
        negotiationLimits.eventBytes,
        (bytes as string).length / 2,
      )
      total += eventBytes.length / 2
      if (total > negotiationLimits.totalBytes || seen.has(eventBytes))
        fail('corrupt-record', 'Journal aggregate limit or duplicate evidence')
      seen.add(eventBytes)
      if (
        entry.direction !== 'incoming' &&
        entry.direction !== 'outbound-replay'
      )
        fail('corrupt-record', 'Journal direction')
      return {
        eventBytes,
        senderPublicKey: storedHex(entry.senderPublicKey, 33),
        recipientPublicKey: storedHex(entry.recipientPublicKey, 33),
        direction: entry.direction as StoredEntry['direction'],
        messageId: storedHex(entry.messageId, 16),
        stampedPayloadDigest: storedHex(entry.stampedPayloadDigest, 32),
      }
    })
    for (const entry of entries) this.authenticate(entry, 'corrupt-record')
    return entries
  }
  inspectRecord(row: Record<string, unknown>): NegotiationJournalInspection {
    return {
      rowKey: this.rowKey,
      owner: {
        ...this.owner,
        localPublicKey: new Uint8Array(this.owner.localPublicKey),
      },
      context: {
        ...this.context,
        swapId: new Uint8Array(this.context.swapId),
        conversationId: new Uint8Array(this.context.conversationId),
        parties: [
          new Uint8Array(this.context.parties[0]),
          new Uint8Array(this.context.parties[1]),
        ],
        policy: { ...this.context.policy },
      },
      ...this.reconstruct(this.parseRecord(row), 'present'),
    }
  }
}

export interface NegotiationJournalInspection
  extends NegotiationJournalSnapshot {
  readonly rowKey: string
  readonly owner: NegotiationJournalOwner
  readonly context: NegotiationContext
}
function parseRawRecord(raw: string): Record<string, unknown> {
  boundedRaw(raw)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return fail('corrupt-record', 'Malformed journal JSON')
  }
  const row = object(value, ['version', 'owner', 'context', 'entries'])
  if (row.version !== 1) fail('corrupt-record', 'Unsupported journal version')
  return row
}
/** Full pure validation, with no assumed host affinity. The adapter MUST compare owner/key. */
export function inspectNegotiationJournalRecord(
  raw: string,
): NegotiationJournalInspection {
  const row = parseRawRecord(raw)
  const owner = object(row.owner, [
    'accountIncarnation',
    'localPublicKey',
    'messagingChainIdentifier',
  ])
  const context = object(row.context, [
    'swapId',
    'conversationId',
    'parties',
    'policy',
  ])
  const policy = object(context.policy, [
    'name',
    'xecChainIdentifier',
    'evmChainIdentifier',
  ])
  if (!Array.isArray(context.parties) || context.parties.length !== 2)
    fail('corrupt-record', 'Journal ordered parties')
  let binding: JournalBinding
  try {
    binding = new JournalBinding({
      owner: {
        accountIncarnation: owner.accountIncarnation as string,
        localPublicKey: hexToBytes(storedHex(owner.localPublicKey, 33)),
        messagingChainIdentifier: owner.messagingChainIdentifier as string,
      },
      context: {
        swapId: hexToBytes(storedHex(context.swapId, 32)),
        conversationId: hexToBytes(storedHex(context.conversationId, 16)),
        parties: [
          (context.parties as unknown[])[0],
          (context.parties as unknown[])[1],
        ].map((value) => hexToBytes(storedHex(value, 33))) as [
          Uint8Array,
          Uint8Array,
        ],
        policy: {
          name: policy.name as NegotiationPairPolicy['name'],
          xecChainIdentifier: policy.xecChainIdentifier as string,
          evmChainIdentifier: policy.evmChainIdentifier as string,
        },
      },
    })
  } catch (error) {
    if (error instanceof NegotiationJournalError)
      return fail('corrupt-record', error.message)
    throw error
  }
  return binding.inspectRecord(row)
}

export class NegotiationJournal {
  readonly rowKey: string
  private readonly bound: JournalBinding
  private readonly store: NegotiationJournalStore
  constructor(input: {
    owner: NegotiationJournalOwner
    context: NegotiationContext
    store: NegotiationJournalStore
  }) {
    this.bound = new JournalBinding(input)
    this.rowKey = this.bound.rowKey
    if (
      typeof input.store?.read !== 'function' ||
      typeof input.store?.compareAndSwap !== 'function'
    )
      fail('invalid-input', 'Explicit durable CAS capability required')
    this.store = {
      read: input.store.read.bind(input.store),
      compareAndSwap: input.store.compareAndSwap.bind(input.store),
    }
  }
  /** Fresh committed inspection only; absence never writes a default record. */
  async read(): Promise<NegotiationJournalSnapshot> {
    const raw = await this.store.read(this.rowKey)
    return this.bound.reconstruct(
      this.bound.parse(raw),
      raw === undefined ? 'absent' : 'present',
    )
  }
  async admit(input: NegotiationJournalAdmission): Promise<
    NegotiationJournalSnapshot & {
      readonly admission: 'inserted' | 'duplicate'
    }
  > {
    const encoded = input?.eventBytes,
      auth = input?.authenticated
    if (
      !(encoded instanceof Uint8Array) ||
      encoded.length === 0 ||
      encoded.length > negotiationLimits.eventBytes
    )
      fail('invalid-input', 'Bounded original event bytes required')
    if (
      !auth ||
      auth.messagingChainIdentifier !==
        this.bound.owner.messagingChainIdentifier
    )
      fail('invalid-input', 'Authenticated messaging chain mismatch')
    if (auth.direction !== 'incoming' && auth.direction !== 'outbound-replay')
      fail('invalid-input', 'Explicit authenticated direction required')
    if (
      !same(
        copy(auth.localPublicKey, 33, 'authenticated local key'),
        this.bound.owner.localPublicKey,
      ) ||
      !same(
        copy(auth.conversationId, 16, 'authenticated conversation'),
        this.bound.context.conversationId,
      )
    )
      fail(
        'invalid-input',
        'Authenticated local identity/conversation mismatch',
      )
    const entry: StoredEntry = {
      eventBytes: bytesToHex(new Uint8Array(encoded)),
      senderPublicKey: bytesToHex(copy(auth.senderPublicKey, 33, 'sender key')),
      recipientPublicKey: bytesToHex(
        copy(auth.recipientPublicKey, 33, 'recipient key'),
      ),
      direction: auth.direction,
      messageId: bytesToHex(copy(input.messageId, 16, 'canonical message ID')),
      stampedPayloadDigest: bytesToHex(
        copy(input.stampedPayloadDigest, 32, 'stamped payload digest'),
      ),
    }
    for (
      let attempt = 0;
      attempt < negotiationJournalLimits.casAttempts;
      attempt++
    ) {
      const raw = await this.store.read(this.rowKey)
      const entries = this.bound.parse(raw)
      this.bound.authenticate(entry, 'invalid-input') // Even duplicate delivery must authenticate first.
      if (entries.some((previous) => previous.eventBytes === entry.eventBytes))
        return {
          ...this.bound.reconstruct(entries, 'present'),
          admission: 'duplicate',
        }
      if (
        entries.length >= negotiationLimits.events ||
        entries.reduce(
          (sum, item) => sum + item.eventBytes.length / 2,
          entry.eventBytes.length / 2,
        ) > negotiationLimits.totalBytes
      )
        fail('capacity', 'Negotiation evidence capacity reached; no eviction')
      const next = [...entries, entry]
      const result = this.bound.reconstruct(next, 'present') // Violations are retained signed evidence.
      const serialized = JSON.stringify({
        version: 1,
        ...this.bound.binding,
        entries: next,
      })
      if (utf8ToBytes(serialized).length > negotiationJournalLimits.rawBytes)
        fail('capacity', 'Negotiation raw record capacity reached')
      if (await this.store.compareAndSwap(this.rowKey, raw, serialized))
        return { ...result, admission: 'inserted' }
    }
    return fail('contention', 'Negotiation journal CAS contention exhausted')
  }
}
