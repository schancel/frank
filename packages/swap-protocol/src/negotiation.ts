/** Pure negotiation only: acceptance never authorizes funding or financial recovery changes. */
import { sha256 } from '@noble/hashes/sha256.js'
import {
  encodeCanonical,
  standaloneItemBudget,
  uncompressedPubkey,
  verifyAlgorithm1,
  type Encodable,
  type FrankValue,
  type NestedItemBudget,
} from '@frank/codec'
import registry from '../../../docs/protocol/chains/v1.json'
import {
  createSignedSwapEvent,
  decodeSignedSwapEvent,
  encodeSignedSwapEvent,
  frame,
  reduceSwapJournal,
  signaturePreimageForCore,
  type SignedSwapEvent,
  type SwapManifest,
  type SwapProtocolError,
  type SwapResult,
  type UnsignedSwapEventCore,
} from './index'

export const negotiationLimits = Object.freeze({
  events: 64,
  eventBytes: 1024,
  totalBytes: 65536,
  payloadBytes: 512,
})
export interface NegotiationPairPolicy {
  readonly name: 'xec-monad-testnet-v2' | 'xec-monad-regtest-proof-v2'
  readonly xecChainIdentifier: string
  readonly evmChainIdentifier: string
}
export const TESTNET_NEGOTIATION_POLICY: NegotiationPairPolicy = Object.freeze({
  name: 'xec-monad-testnet-v2',
  xecChainIdentifier: 'xec-testnet',
  evmChainIdentifier: 'monad-testnet',
})
export const REGTEST_PROOF_NEGOTIATION_POLICY: NegotiationPairPolicy =
  Object.freeze({
    name: 'xec-monad-regtest-proof-v2',
    xecChainIdentifier: 'xec-regtest',
    evmChainIdentifier: 'monad-regtest',
  })
/** Policy names of the retired v1 payload; their stored rows fail with a reset instruction. */
export const RETIRED_NEGOTIATION_POLICY_NAMES: readonly string[] =
  Object.freeze(['xec-monad-testnet-v1', 'xec-monad-regtest-proof-v1'])
/**
 * Deadline margins of one pair policy, in seconds (docs/plans/htlc-swaps/README.md, "Deadline
 * rules"). E = offer `expiry` (acceptance deadline), T_B = `evmExpiry`, T_A = `xecRefundTime`.
 * The reducer enforces R1 T_A − T_B ≥ minRefundGap, R2 T_B − E ≥ minClaimWindow and
 * R3 T_A − E ≤ maxSpan; the margins themselves are the runner's cutoffs (PR 6).
 */
export interface NegotiationDeadlineRules {
  /** M_evm: A withdraws only while now ≤ T_B − evmFinality. */
  readonly evmFinality: number
  /** M_xec: time for A's XEC funding output to become final. */
  readonly xecFinality: number
  /** S_xec: median-time-past skew of the eCash chain. */
  readonly xecTimeSkew: number
  /** W: tolerated watcher downtime. */
  readonly watcherDowntime: number
  /** R1 = M_xec + S_xec + W. */
  readonly minRefundGap: number
  /** R2 (T_B − E). */
  readonly minClaimWindow: number
  /** R3 (T_A − E) only. How far T_B lies ahead of the signing time is the separate lock-window
   * check (`negotiationLockWindow`), since it depends on the clock. */
  readonly maxSpan: number
  /** UI defaults: E = now + acceptance, T_B = E + evmAfterAcceptance, T_A = T_B + xecAfterEvm. */
  readonly defaults: {
    readonly acceptance: number
    readonly evmAfterAcceptance: number
    readonly xecAfterEvm: number
  }
}
const HOUR = 3600
const DEADLINE_RULES: Readonly<
  Record<NegotiationPairPolicy['name'], NegotiationDeadlineRules>
> = Object.freeze({
  'xec-monad-testnet-v2': Object.freeze({
    evmFinality: 600,
    xecFinality: 3 * HOUR,
    xecTimeSkew: 2 * HOUR,
    watcherDowntime: HOUR,
    minRefundGap: 6 * HOUR,
    minClaimWindow: 8 * HOUR,
    maxSpan: 72 * HOUR,
    defaults: Object.freeze({
      acceptance: HOUR,
      evmAfterAcceptance: 12 * HOUR,
      xecAfterEvm: 12 * HOUR,
    }),
  }),
  // Same formulas with margins in seconds; tests move time (setmocktime / evm_increaseTime).
  'xec-monad-regtest-proof-v2': Object.freeze({
    evmFinality: 5,
    xecFinality: 30,
    xecTimeSkew: 0,
    watcherDowntime: 10,
    minRefundGap: 40,
    minClaimWindow: 60,
    maxSpan: 72 * HOUR,
    defaults: Object.freeze({
      acceptance: 60,
      evmAfterAcceptance: 120,
      xecAfterEvm: 120,
    }),
  }),
})
/** BIP65: a CHECKLOCKTIMEVERIFY operand at or above this is a Unix time, not a height. */
const LOCKTIME_THRESHOLD = 500_000_000n
/** The eCash refund spend carries T_A as its 32-bit nLockTime. */
const MAX_LOCKTIME = 0xffffffffn
/** eCash dust limit: the smallest XEC principal an HTLC output may carry. */
export const XEC_MIN_PRINCIPAL_SATS = 546n
export interface NegotiationContext {
  readonly swapId: Uint8Array
  readonly conversationId: Uint8Array
  readonly parties: readonly [Uint8Array, Uint8Array]
  readonly policy: NegotiationPairPolicy
}
/** Everything A chooses for an offer; the builder adds version, conversation, parties, chains. */
export interface OfferFields {
  readonly xecPrincipal: bigint
  readonly evmPrincipal: bigint
  /** E: acceptance deadline (Unix seconds). */
  readonly expiry: bigint
  /** sha256 of A's 32-byte preimage. */
  readonly hashLock: Uint8Array
  /** A's compressed per-swap eCash refund key. */
  readonly xecRefundPublicKey: Uint8Array
  /** A's EVM main account: the HTLC recipient of B's MON. */
  readonly evmRecipient: Uint8Array
  /** T_A: absolute CLTV time of A's XEC refund branch (Unix seconds). */
  readonly xecRefundTime: bigint
  /** T_B: absolute expiry of B's MON lock (Unix seconds). */
  readonly evmExpiry: bigint
  /** The GenericHTLC contract both parties use on the EVM chain. */
  readonly evmHtlcContract: Uint8Array
}
export interface OfferTerms extends OfferFields {
  readonly payloadVersion: 2
  readonly pairPolicyVersion: 2
  readonly conversationId: Uint8Array
  readonly parties: readonly [Uint8Array, Uint8Array]
  readonly xecChainIdentifier: string
  readonly evmChainIdentifier: string
}
export interface ResponseTerms {
  readonly payloadVersion: 2
  readonly conversationId: Uint8Array
  readonly responder: Uint8Array
  readonly offerEventId: Uint8Array
  readonly termsHash: Uint8Array
}
/** What B adds when accepting. */
export interface AcceptFields {
  /** B's compressed per-swap eCash claim key. */
  readonly xecClaimPublicKey: Uint8Array
  /** B's EVM main account: sender and refund address of B's MON lock. */
  readonly evmSender: Uint8Array
}
export interface AcceptTerms extends ResponseTerms, AcceptFields {}
export type NegotiationEvent =
  | {
      readonly kind: 'offer'
      readonly event: SignedSwapEvent
      readonly terms: OfferTerms
    }
  | {
      readonly kind: 'accept'
      readonly event: SignedSwapEvent
      readonly terms: AcceptTerms
    }
  | {
      readonly kind: 'reject'
      readonly event: SignedSwapEvent
      readonly terms: ResponseTerms
    }
export interface NegotiationState {
  readonly offer: Extract<NegotiationEvent, { kind: 'offer' }> | null
  readonly decision: 'accept' | 'reject' | null
  /** The applied accept, whose terms the swap executes with; null otherwise. */
  readonly accept: Extract<NegotiationEvent, { kind: 'accept' }> | null
}
/** The signed terms of an accepted swap: the offer and B's accept, both validated. */
export interface AcceptedSwapTerms {
  readonly offer: OfferTerms
  readonly accept: AcceptTerms
}
export interface NegotiationReduction {
  /** Historical signed evidence only; inspect violation before using any partial state. */
  readonly history: NegotiationState
  readonly violation: SwapProtocolError | null
  /** Null on every violation, even when the core computed partial accepted history. */
  readonly usableAcceptance: AcceptedSwapTerms | null
  readonly applied: readonly SignedSwapEvent[]
  readonly buffered: readonly SignedSwapEvent[]
}
export interface AuthenticatedNegotiationContext {
  readonly direction: 'incoming' | 'outbound-replay'
  readonly localPublicKey: Uint8Array
  readonly senderPublicKey: Uint8Array
  readonly recipientPublicKey: Uint8Array
  readonly conversationId: Uint8Array
}
export type NegotiationDigestSigner = (
  digest: Uint8Array,
) => Promise<Uint8Array>

const U64 = (1n << 64n) - 1n
const U256 = (1n << 256n) - 1n
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])
class InvalidNegotiation extends Error {
  constructor(readonly error: SwapProtocolError) {
    super(error.detail ?? error.code)
  }
}
function invalid(code: SwapProtocolError['code'], detail: string): never {
  throw new InvalidNegotiation({ code, detail })
}
function result<T>(run: () => T): SwapResult<T> {
  try {
    return { ok: true, value: run() }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof InvalidNegotiation
          ? error.error
          : {
              code: 'bad-format',
              detail:
                error instanceof Error ? error.message : 'Invalid negotiation',
            },
    }
  }
}
function must<T>(value: SwapResult<T>): T {
  if (!value.ok) throw new InvalidNegotiation(value.error)
  return value.value
}
function bytes(value: unknown, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length)
    invalid('bad-length', name)
  return new Uint8Array(value)
}
function key(value: unknown, name = 'compressed identity key'): Uint8Array {
  const checked = bytes(value, 33, name)
  try {
    uncompressedPubkey(checked) // Actual secp256k1 point validation.
  } catch {
    invalid('bad-format', name)
  }
  return checked
}
const zero = (value: Uint8Array) => value.every(v => v === 0)
function uint(
  value: unknown,
  maximum: bigint,
  name: string,
  positive = false,
): bigint {
  if (
    typeof value !== 'bigint' ||
    value < (positive ? 1n : 0n) ||
    value > maximum
  )
    invalid('bad-format', name)
  return value
}
function policy(value: NegotiationPairPolicy): NegotiationPairPolicy {
  const expected =
    value?.name === TESTNET_NEGOTIATION_POLICY.name
      ? TESTNET_NEGOTIATION_POLICY
      : value?.name === REGTEST_PROOF_NEGOTIATION_POLICY.name
      ? REGTEST_PROOF_NEGOTIATION_POLICY
      : undefined
  if (
    !expected ||
    value.xecChainIdentifier !== expected.xecChainIdentifier ||
    value.evmChainIdentifier !== expected.evmChainIdentifier
  )
    invalid('wrong-context', 'Explicit supported ordered pair policy required')
  for (const [id, family] of [
    [value.xecChainIdentifier, 'bitcoin'],
    [value.evmChainIdentifier, 'evm'],
  ]) {
    const row = registry.chains.find(chain => chain.id === id)
    if (
      !row ||
      row.family !== family ||
      !row.allowed_proxy_capabilities.includes('json-rpc')
    )
      invalid(
        'wrong-context',
        'Pair does not match authoritative registry capabilities',
      )
  }
  return { ...expected }
}
function snapshot(context: NegotiationContext): NegotiationContext {
  if (!Array.isArray(context?.parties) || context.parties.length !== 2)
    invalid('bad-format', 'Exactly two expected parties required')
  const parties: [Uint8Array, Uint8Array] = [
    key(context?.parties?.[0]),
    key(context?.parties?.[1]),
  ]
  if (equal(parties[0], parties[1]))
    invalid('wrong-context', 'Distinct parties required')
  return {
    swapId: bytes(context.swapId, 32, 'swapId'),
    conversationId: bytes(context.conversationId, 16, 'conversationId'),
    parties,
    policy: policy(context.policy),
  }
}
function exactMap(
  value: FrankValue,
  count: number,
): ReadonlyMap<bigint, FrankValue> {
  if (
    !(value instanceof Map) ||
    value.size !== count ||
    Array.from({ length: count }, (_, i) => BigInt(i)).some(k => !value.has(k))
  )
    invalid('bad-format', 'Exact negotiation payload fields required')
  return value
}
function chainIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64)
    invalid('bad-format', 'Canonical chain identifier required')
  return value
}
function amountBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(value & 255n)
    value >>= 8n
  }
  return out
}
function amount(value: unknown): bigint {
  let n = 0n
  for (const v of bytes(value, 32, 'EVM principal')) n = (n << 8n) | BigInt(v)
  return uint(n, U256, 'EVM principal', true)
}
function payload(value: Encodable): Uint8Array {
  const encoded = encodeCanonical(value)
  if (encoded.length > negotiationLimits.payloadBytes)
    invalid('bad-length', 'Negotiation payload limit')
  return encoded
}
function offerPayload(
  terms: OfferTerms,
  selectedPolicy: NegotiationPairPolicy,
): Uint8Array {
  if (terms.payloadVersion !== 2 || terms.pairPolicyVersion !== 2)
    invalid('bad-version', 'Offer version')
  bytes(terms.conversationId, 16, 'conversationId')
  if (!Array.isArray(terms.parties) || terms.parties.length !== 2)
    invalid('bad-format', 'Exactly two offer parties required')
  const parties = [key(terms.parties[0]), key(terms.parties[1])]
  if (
    equal(parties[0]!, parties[1]!) ||
    terms.xecChainIdentifier !== selectedPolicy.xecChainIdentifier ||
    terms.evmChainIdentifier !== selectedPolicy.evmChainIdentifier
  )
    invalid(
      'wrong-context',
      'Distinct parties and explicit ordered chains required',
    )
  return payload(
    new Map<number, Encodable>([
      [0, 2],
      [1, 2],
      [2, terms.conversationId],
      [3, [...terms.parties]],
      [4, terms.xecChainIdentifier],
      [5, terms.evmChainIdentifier],
      [6, uint(terms.xecPrincipal, U64, 'XEC principal', true)],
      [7, amountBytes(uint(terms.evmPrincipal, U256, 'EVM principal', true))],
      [8, uint(terms.expiry, U64, 'expiry')],
      [9, bytes(terms.hashLock, 32, 'hashLock')],
      [10, key(terms.xecRefundPublicKey, 'xecRefundPublicKey')],
      [11, bytes(terms.evmRecipient, 20, 'evmRecipient')],
      [12, uint(terms.xecRefundTime, U64, 'xecRefundTime')],
      [13, uint(terms.evmExpiry, U64, 'evmExpiry')],
      [14, bytes(terms.evmHtlcContract, 20, 'evmHtlcContract')],
    ]),
  )
}
/** The deadline margins of a supported pair policy. */
export function negotiationDeadlineRules(
  selectedPolicy: NegotiationPairPolicy,
): SwapResult<NegotiationDeadlineRules> {
  return result(() => DEADLINE_RULES[policy(selectedPolicy).name])
}
/** UI default deadlines from `now`: on testnet E = now + 1 h, T_B = E + 12 h, T_A = T_B + 12 h. */
export function defaultNegotiationDeadlines(
  selectedPolicy: NegotiationPairPolicy,
  now: bigint,
): SwapResult<{ expiry: bigint; evmExpiry: bigint; xecRefundTime: bigint }> {
  return result(() => {
    const { defaults } = DEADLINE_RULES[policy(selectedPolicy).name]
    return deadlinesFrom(
      uint(now, U64, 'Current Unix seconds') + BigInt(defaults.acceptance),
      defaults,
    )
  })
}
/** The default T_B and T_A for a chosen acceptance deadline E. */
export function defaultNegotiationDeadlinesFor(
  selectedPolicy: NegotiationPairPolicy,
  expiry: bigint,
): SwapResult<{ expiry: bigint; evmExpiry: bigint; xecRefundTime: bigint }> {
  return result(() =>
    deadlinesFrom(
      uint(expiry, U64, 'expiry'),
      DEADLINE_RULES[policy(selectedPolicy).name].defaults,
    ),
  )
}
function deadlinesFrom(
  expiry: bigint,
  defaults: NegotiationDeadlineRules['defaults'],
) {
  const evmExpiry = expiry + BigInt(defaults.evmAfterAcceptance)
  return {
    expiry,
    evmExpiry,
    xecRefundTime: evmExpiry + BigInt(defaults.xecAfterEvm),
  }
}
/** Why the signed offer terms are not executable under the policy; undefined when they are. */
function offerViolation(
  terms: OfferFields,
  selectedPolicy: NegotiationPairPolicy,
): string | undefined {
  const rules = DEADLINE_RULES[selectedPolicy.name]
  const acceptBy = terms.expiry,
    evmExpiry = terms.evmExpiry,
    xecRefundTime = terms.xecRefundTime
  if (terms.xecPrincipal < XEC_MIN_PRINCIPAL_SATS)
    return 'XEC principal is below the eCash dust limit'
  if (zero(terms.evmRecipient)) return 'EVM recipient must be non-zero'
  if (zero(terms.evmHtlcContract)) return 'HTLC contract must be non-zero'
  if (xecRefundTime < LOCKTIME_THRESHOLD || xecRefundTime > MAX_LOCKTIME)
    return 'XEC refund time must be a 32-bit CLTV timestamp'
  if (evmExpiry - acceptBy < BigInt(rules.minClaimWindow))
    return `Deadline rule R2: the EVM expiry must be at least ${rules.minClaimWindow} s after the acceptance deadline`
  if (xecRefundTime - evmExpiry < BigInt(rules.minRefundGap))
    return `Deadline rule R1: the XEC refund time must be at least ${rules.minRefundGap} s after the EVM expiry`
  if (xecRefundTime - acceptBy > BigInt(rules.maxSpan))
    return `Deadline rule R3: the XEC refund time must be at most ${rules.maxSpan} s after the acceptance deadline`
  return undefined
}
/** Why B's accept fields cannot execute with this offer; undefined when they can. */
function acceptViolation(
  offer: OfferFields,
  accept: AcceptFields,
): string | undefined {
  if (equal(accept.xecClaimPublicKey, offer.xecRefundPublicKey))
    return 'eCash claim and refund keys must differ'
  if (zero(accept.evmSender)) return 'EVM sender must be non-zero'
  if (equal(accept.evmSender, offer.evmRecipient))
    return 'EVM sender must differ from the EVM recipient'
  return undefined
}
export function encodeOfferPayload(
  terms: OfferTerms,
  context: NegotiationContext,
): SwapResult<Uint8Array> {
  return result(() => {
    const bound = snapshot(context)
    bindOffer(terms, bound)
    return offerPayload(terms, bound.policy)
  })
}
function responsePayload(
  terms: ResponseTerms,
  accept?: AcceptFields,
): Uint8Array {
  if (terms.payloadVersion !== 2) invalid('bad-version', 'Response version')
  bytes(terms.conversationId, 16, 'conversationId')
  key(terms.responder)
  const fields: [number, Encodable][] = [
    [0, 2],
    [1, terms.conversationId],
    [2, terms.responder],
    [3, bytes(terms.offerEventId, 32, 'offerEventId')],
    [4, bytes(terms.termsHash, 32, 'termsHash')],
  ]
  if (accept)
    fields.push(
      [5, key(accept.xecClaimPublicKey, 'xecClaimPublicKey')],
      [6, bytes(accept.evmSender, 20, 'evmSender')],
    )
  return payload(new Map<number, Encodable>(fields))
}
/** Accept terms carry B's fields; reject terms carry none. */
export function encodeResponsePayload(
  terms: ResponseTerms | AcceptTerms,
  context: NegotiationContext,
): SwapResult<Uint8Array> {
  return result(() => {
    bindResponse(terms, snapshot(context))
    return responsePayload(
      terms,
      'xecClaimPublicKey' in terms ? terms : undefined,
    )
  })
}
export function negotiationIdentityKeyId(
  publicKey: Uint8Array,
): SwapResult<Uint8Array> {
  return result(() =>
    sha256(frame('frank/swap-identity-key-id/v1', key(publicKey))),
  )
}
function termsHash(event: SignedSwapEvent): Uint8Array {
  const bound = new Uint8Array(34 + event.payload.length)
  bound[0] = 1
  bound.set(event.swapId, 1)
  bound[33] = event.laneId
  bound.set(event.payload, 34)
  return sha256(frame('frank/swap-negotiation-terms/v2', bound))
}
export function negotiationTermsHash(
  offer: NegotiationEvent,
): SwapResult<Uint8Array> {
  return result(() => {
    if (offer.kind !== 'offer') invalid('bad-format', 'Offer required')
    return termsHash(offer.event)
  })
}
/**
 * The facts an offer's swapId is derived from: everything A chooses before the swapId exists
 * (the hash lock and A's eCash refund key are themselves derived from the swapId).
 */
export interface OfferSwapIdFacts {
  readonly policy: NegotiationPairPolicy
  readonly conversationId: Uint8Array
  readonly parties: readonly [Uint8Array, Uint8Array]
  readonly xecPrincipal: bigint
  readonly evmPrincipal: bigint
  readonly expiry: bigint
  readonly xecRefundTime: bigint
  readonly evmExpiry: bigint
  readonly evmRecipient: Uint8Array
  readonly evmHtlcContract: Uint8Array
}
export const OFFER_SWAP_ID_LABEL = 'frank/swap-offer-id/v1'
/**
 * Canonical transcript of `frank/swap-offer-id/v1`. A's swapId is a keyed hash of it under A's
 * private account salt (`deriveOfferSwapId`), so every device of A's account computes the same
 * swapId for the same offer, nobody else can, and a swapId is never taken from a peer or the
 * wire. The swap preimage depends on (account, policy, swapId) only (PR 4), so this is what keeps
 * a new offer from reusing the secret of another swap.
 */
export function offerSwapIdTranscript(
  facts: OfferSwapIdFacts,
): SwapResult<Uint8Array> {
  return result(() => {
    const selected = policy(facts?.policy)
    if (!Array.isArray(facts.parties) || facts.parties.length !== 2)
      invalid('bad-format', 'Exactly two offer parties required')
    return encodeCanonical([
      OFFER_SWAP_ID_LABEL,
      selected.name,
      selected.xecChainIdentifier,
      selected.evmChainIdentifier,
      bytes(facts.conversationId, 16, 'conversationId'),
      [key(facts.parties[0]), key(facts.parties[1])],
      uint(facts.xecPrincipal, U64, 'XEC principal', true),
      amountBytes(uint(facts.evmPrincipal, U256, 'EVM principal', true)),
      uint(facts.expiry, U64, 'expiry'),
      uint(facts.xecRefundTime, U64, 'xecRefundTime'),
      uint(facts.evmExpiry, U64, 'evmExpiry'),
      bytes(facts.evmRecipient, 20, 'evmRecipient'),
      bytes(facts.evmHtlcContract, 20, 'evmHtlcContract'),
    ])
  })
}
/**
 * A's swapId for an offer: `keyedHash(offerSwapIdTranscript(facts))`, where `keyedHash` is a
 * 32-byte keyed hash under A's private account salt (the app uses HMAC-SHA256 keyed by the
 * account's conversation-ID salt).
 */
export function deriveOfferSwapId(
  facts: OfferSwapIdFacts,
  keyedHash: (transcript: Uint8Array) => Uint8Array,
): SwapResult<Uint8Array> {
  return result(() => {
    const transcript = must(offerSwapIdTranscript(facts))
    return bytes(keyedHash(transcript), 32, 'Derived swapId')
  })
}
function decodeSchema(
  encoded: Uint8Array,
  selectedPolicy: NegotiationPairPolicy,
  budget: NestedItemBudget,
): NegotiationEvent {
  if (
    !(encoded instanceof Uint8Array) ||
    encoded.length > negotiationLimits.eventBytes
  )
    invalid('bad-length', 'Negotiation event limit')
  // Buffer.slice() aliases its input; normalize before the core decoder takes slices.
  const event = must(decodeSignedSwapEvent(new Uint8Array(encoded)))
  if (event.payload.length > negotiationLimits.payloadBytes)
    invalid('bad-length', 'Negotiation payload limit')
  if (event.laneId !== 0) invalid('wrong-context', 'Negotiation lane')
  if (event.sequence !== 0n || event.previousEventHash.some(v => v !== 0))
    invalid('non-canonical', 'Only first sender entries negotiate')
  if (![1, 2, 3].includes(event.messageType))
    invalid('unknown-message-type', 'Negotiation message type')
  const offer = event.messageType === 1
  const role = offer ? 0 : 1
  if (event.senderRole !== role)
    invalid('unknown-sender', 'Negotiation producer')
  if (
    event.signatureAlgorithm !== 1 ||
    event.signature.length < 8 ||
    event.signature.length > 72
  )
    invalid('invalid-signature', 'Algorithm-1 DER identity signature required')
  const decodedPayload = budget.decodeCbor(
    event.payload,
    'swap-negotiation/payload',
  )
  // Version first, so an old v1 event reports its version rather than its field count.
  if (
    !(decodedPayload instanceof Map) ||
    decodedPayload.get(0n) !== 2n ||
    (offer && decodedPayload.get(1n) !== 2n)
  )
    invalid('bad-version', 'Negotiation payload or pair policy version')
  const fields = exactMap(
    decodedPayload,
    offer ? 15 : event.messageType === 2 ? 7 : 5,
  )
  let decoded: NegotiationEvent
  if (offer) {
    const parties = fields.get(3n)
    if (!Array.isArray(parties) || parties.length !== 2)
      invalid('bad-format', 'Ordered two parties required')
    const terms: OfferTerms = {
      payloadVersion: 2,
      pairPolicyVersion: 2,
      conversationId: bytes(fields.get(2n), 16, 'conversationId'),
      parties: [key(parties[0]), key(parties[1])],
      xecChainIdentifier: chainIdentifier(fields.get(4n)),
      evmChainIdentifier: chainIdentifier(fields.get(5n)),
      xecPrincipal: uint(fields.get(6n), U64, 'XEC principal', true),
      evmPrincipal: amount(fields.get(7n)),
      expiry: uint(fields.get(8n), U64, 'expiry'),
      hashLock: bytes(fields.get(9n), 32, 'hashLock'),
      xecRefundPublicKey: key(fields.get(10n), 'xecRefundPublicKey'),
      evmRecipient: bytes(fields.get(11n), 20, 'evmRecipient'),
      xecRefundTime: uint(fields.get(12n), U64, 'xecRefundTime'),
      evmExpiry: uint(fields.get(13n), U64, 'evmExpiry'),
      evmHtlcContract: bytes(fields.get(14n), 20, 'evmHtlcContract'),
    }
    if (event.prerequisiteEventIds.length !== 0)
      invalid('non-canonical', 'Offer prerequisites')
    if (!equal(offerPayload(terms, selectedPolicy), event.payload))
      invalid('non-canonical', 'Offer encoding')
    decoded = { kind: 'offer', event, terms }
  } else {
    const terms: ResponseTerms = {
      payloadVersion: 2,
      conversationId: bytes(fields.get(1n), 16, 'conversationId'),
      responder: key(fields.get(2n)),
      offerEventId: bytes(fields.get(3n), 32, 'offerEventId'),
      termsHash: bytes(fields.get(4n), 32, 'termsHash'),
    }
    if (
      event.prerequisiteEventIds.length !== 1 ||
      !equal(event.prerequisiteEventIds[0]!, terms.offerEventId)
    )
      invalid(
        'non-canonical',
        'Response must name exactly its offer prerequisite',
      )
    const accept: AcceptFields | undefined =
      event.messageType === 2
        ? {
            xecClaimPublicKey: key(fields.get(5n), 'xecClaimPublicKey'),
            evmSender: bytes(fields.get(6n), 20, 'evmSender'),
          }
        : undefined
    if (!equal(responsePayload(terms, accept), event.payload))
      invalid('non-canonical', 'Response encoding')
    decoded = accept
      ? { kind: 'accept', event, terms: { ...terms, ...accept } }
      : { kind: 'reject', event, terms }
  }
  const digest = sha256(must(signaturePreimageForCore(event)))
  const signer =
    decoded.kind === 'offer'
      ? decoded.terms.parties[0]
      : decoded.terms.responder
  if (!equal(event.senderKeyId, must(negotiationIdentityKeyId(signer))))
    invalid('unknown-sender', 'Self-contained signing identity')
  if (!verifyAlgorithm1(digest, event.signature, signer))
    invalid('invalid-signature', 'Negotiation identity signature')
  return decoded
}
function bindOffer(terms: OfferTerms, context: NegotiationContext): void {
  if (
    !equal(terms.conversationId, context.conversationId) ||
    !equal(terms.parties[0], context.parties[0]) ||
    !equal(terms.parties[1], context.parties[1])
  )
    invalid('wrong-context', 'Expected offer conversation and ordered parties')
}
function bindResponse(terms: ResponseTerms, context: NegotiationContext): void {
  if (
    !equal(terms.conversationId, context.conversationId) ||
    !equal(terms.responder, context.parties[1])
  )
    invalid('wrong-context', 'Expected response conversation and B identity')
}
function decode(
  encoded: Uint8Array,
  context: NegotiationContext,
  budget: NestedItemBudget,
): NegotiationEvent {
  const value = decodeSchema(encoded, context.policy, budget)
  if (!equal(value.event.swapId, context.swapId))
    invalid('wrong-context', 'Expected swap ID')
  if (value.kind === 'offer') bindOffer(value.terms, context)
  else bindResponse(value.terms, context)
  return value
}
/** Schema and self-contained identity signature only; no operation admission or state authority.
 * A stateless transport plugin supplies its explicit pair policy and the enclosing budget.
 * Runtime must additionally bind the expected context and canonical authenticated record. */
export function decodeNegotiationEventSchema(
  encoded: Uint8Array,
  selectedPolicy: NegotiationPairPolicy,
  budget: NestedItemBudget,
): SwapResult<NegotiationEvent> {
  return result(() => decodeSchema(encoded, policy(selectedPolicy), budget))
}
/** Incoming plugins must supply their enclosing budget; this function never creates one. */
export function decodeNegotiationEvent(
  encoded: Uint8Array,
  context: NegotiationContext,
  budget: NestedItemBudget,
): SwapResult<NegotiationEvent> {
  return result(() => decode(encoded, snapshot(context), budget))
}
export function decodeNegotiationEventStandalone(
  encoded: Uint8Array,
  context: NegotiationContext,
): SwapResult<NegotiationEvent> {
  return decodeNegotiationEvent(encoded, context, standaloneItemBudget())
}
function authenticate(
  value: NegotiationEvent,
  context: AuthenticatedNegotiationContext,
): void {
  if (
    context.direction !== 'incoming' &&
    context.direction !== 'outbound-replay'
  )
    invalid('wrong-context', 'Explicit authenticated direction required')
  const role = value.event.senderRole
  const expectedSender =
    value.kind === 'offer' ? value.terms.parties[0] : value.terms.responder
  const local = key(context.localPublicKey),
    sender = key(context.senderPublicKey),
    recipient = key(context.recipientPublicKey)
  if (
    !equal(sender, expectedSender) ||
    equal(sender, recipient) ||
    !equal(
      bytes(context.conversationId, 16, 'Authenticated conversation'),
      value.terms.conversationId,
    ) ||
    !equal(local, context.direction === 'incoming' ? recipient : sender)
  )
    invalid('wrong-context', 'Authenticated sender, direction or conversation')
  // Caller additionally checks recipient against the negotiated counterparty in validateAuthenticated.
  if (role !== 0 && role !== 1) invalid('wrong-context', 'Negotiation role')
}
function validateAuthenticated(
  value: NegotiationEvent,
  context: NegotiationContext,
  authenticated: AuthenticatedNegotiationContext,
): void {
  authenticate(value, authenticated)
  if (
    !equal(
      authenticated.recipientPublicKey,
      context.parties[1 - value.event.senderRole]!,
    )
  )
    invalid('wrong-context', 'Authenticated recipient')
}
/** This validates provenance assertions supplied by a canonical host; it does not establish them. */
export function validateAuthenticatedNegotiationEvent(
  encoded: Uint8Array,
  context: NegotiationContext,
  authenticated: AuthenticatedNegotiationContext,
  budget: NestedItemBudget,
): SwapResult<NegotiationEvent> {
  return result(() => {
    const bound = snapshot(context)
    const value = decode(encoded, bound, budget)
    validateAuthenticated(value, bound, authenticated)
    return value
  })
}
async function sign(
  core: UnsignedSwapEventCore,
  signerKey: Uint8Array,
  signer: NegotiationDigestSigner,
): Promise<SwapResult<SignedSwapEvent>> {
  try {
    const digest = sha256(must(signaturePreimageForCore(core)))
    const suppliedSignature = await signer(new Uint8Array(digest))
    if (!(suppliedSignature instanceof Uint8Array))
      invalid('invalid-signature', 'Signer returned no signature bytes')
    const signature = new Uint8Array(suppliedSignature)
    if (!verifyAlgorithm1(digest, signature, signerKey))
      invalid('invalid-signature', 'Signer returned invalid DER authorization')
    const signed = must(
      createSignedSwapEvent({
        core,
        signatureAlgorithm: 1,
        sign: () => new Uint8Array(signature),
      }),
    )
    if (
      must(encodeSignedSwapEvent(signed)).length > negotiationLimits.eventBytes
    )
      invalid('bad-length', 'Negotiation event limit')
    return { ok: true, value: signed }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof InvalidNegotiation
          ? error.error
          : { code: 'invalid-signature', detail: 'Digest signer failed' },
    }
  }
}
function core(
  context: NegotiationContext,
  type: number,
  encodedPayload: Uint8Array,
  prerequisites: Uint8Array[],
): UnsignedSwapEventCore {
  const role = type === 1 ? 0 : 1
  return {
    protocolVersion: 1,
    swapId: context.swapId,
    laneId: 0,
    messageType: type,
    senderRole: role,
    senderKeyId: must(negotiationIdentityKeyId(context.parties[role])),
    sequence: 0n,
    previousEventHash: new Uint8Array(32),
    prerequisiteEventIds: prerequisites,
    payload: encodedPayload,
  }
}
function offerTermsOf(
  bound: NegotiationContext,
  fields: OfferFields,
): OfferTerms {
  // Snapshot every caller-owned value before any await.
  const terms: OfferTerms = {
    payloadVersion: 2,
    pairPolicyVersion: 2,
    conversationId: bound.conversationId,
    parties: bound.parties,
    xecChainIdentifier: bound.policy.xecChainIdentifier,
    evmChainIdentifier: bound.policy.evmChainIdentifier,
    xecPrincipal: fields?.xecPrincipal,
    evmPrincipal: fields?.evmPrincipal,
    expiry: fields?.expiry,
    hashLock: bytes(fields?.hashLock, 32, 'hashLock'),
    xecRefundPublicKey: bytes(
      fields?.xecRefundPublicKey,
      33,
      'xecRefundPublicKey',
    ),
    evmRecipient: bytes(fields?.evmRecipient, 20, 'evmRecipient'),
    xecRefundTime: fields?.xecRefundTime,
    evmExpiry: fields?.evmExpiry,
    evmHtlcContract: bytes(fields?.evmHtlcContract, 20, 'evmHtlcContract'),
  }
  offerPayload(terms, bound.policy) // Structural checks first.
  const violation = offerViolation(terms, bound.policy)
  if (violation) invalid('transition-rejected', violation)
  return terms
}
/** Checks offer fields exactly as the builder does (structure and policy rules), without signing. */
export function validateOfferFields(
  context: NegotiationContext,
  fields: OfferFields,
  /** When given, also the lock-window check at this Unix time (see `negotiationLockWindow`). */
  now?: bigint,
): SwapResult<OfferTerms> {
  return result(() => {
    const terms = offerTermsOf(snapshot(context), fields)
    if (now !== undefined) must(negotiationLockWindow(terms, now))
    return terms
  })
}
/** GenericHTLC's MAX_LOCK_DURATION: a lock's expiresAt may be at most this far after its block. */
export const EVM_HTLC_MAX_LOCK_SECONDS = 30 * 24 * 3600
/** Allowance for this device's clock running behind the chain's block.timestamp. */
export const EVM_HTLC_LOCK_CLOCK_MARGIN_SECONDS = 3600
/**
 * Refuses, at signing time `now`, terms whose MON lock GenericHTLC would reject: B locks after the
 * accept, so T_B − now must leave the lock inside MAX_LOCK_DURATION (less the clock margin).
 * Otherwise A's automatic XEC lock would fund a swap B can never lock, tying the XEC up until
 * T_A. The XEC side has no such cap; R3 bounds T_A by E. Not a reducer rule: it depends on the
 * clock, so offer and accept writers apply it when they sign.
 */
export function negotiationLockWindow(
  terms: { readonly evmExpiry: bigint },
  now: bigint,
): SwapResult<void> {
  return result(() => {
    uint(now, U64, 'Current Unix seconds')
    if (
      terms.evmExpiry - now >
      BigInt(EVM_HTLC_MAX_LOCK_SECONDS - EVM_HTLC_LOCK_CLOCK_MARGIN_SECONDS)
    )
      invalid(
        'transition-rejected',
        `EVM expiry is more than ${
          EVM_HTLC_MAX_LOCK_SECONDS - EVM_HTLC_LOCK_CLOCK_MARGIN_SECONDS
        } s ahead: the HTLC contract would refuse the lock`,
      )
  })
}
/** The latest acceptance deadline E whose default T_B passes `negotiationLockWindow` at `now`. */
export function latestNegotiationExpiry(
  selectedPolicy: NegotiationPairPolicy,
  now: bigint,
): SwapResult<bigint> {
  return result(
    () =>
      uint(now, U64, 'Current Unix seconds') +
      BigInt(
        EVM_HTLC_MAX_LOCK_SECONDS -
          EVM_HTLC_LOCK_CLOCK_MARGIN_SECONDS -
          DEADLINE_RULES[policy(selectedPolicy).name].defaults
            .evmAfterAcceptance,
      ),
  )
}
/** Builders refuse terms the reducer would treat as a violation. */
export async function buildNegotiationOffer(
  context: NegotiationContext,
  fields: OfferFields,
  signer: NegotiationDigestSigner,
): Promise<SwapResult<SignedSwapEvent>> {
  const prepared = result(() => {
    const bound = snapshot(context)
    const terms = offerTermsOf(bound, fields)
    return {
      bound,
      eventCore: core(bound, 1, offerPayload(terms, bound.policy), []),
    }
  })
  if (!prepared.ok) return prepared
  return sign(prepared.value.eventCore, prepared.value.bound.parties[0], signer)
}
export type NegotiationDecision =
  | { readonly kind: 'accept'; readonly fields: AcceptFields }
  | { readonly kind: 'reject' }
/** An accept needs B's fields and an executable offer; a reject needs neither. */
export async function buildNegotiationResponse(
  context: NegotiationContext,
  offerBytes: Uint8Array,
  decision: NegotiationDecision,
  signer: NegotiationDigestSigner,
): Promise<SwapResult<SignedSwapEvent>> {
  const prepared = result(() => {
    const bound = snapshot(context)
    if (decision?.kind !== 'accept' && decision?.kind !== 'reject')
      invalid('bad-format', 'Negotiation decision')
    const offer = decode(
      new Uint8Array(offerBytes),
      bound,
      standaloneItemBudget(),
    )
    if (offer.kind !== 'offer') invalid('bad-format', 'Response requires offer')
    const terms: ResponseTerms = {
      payloadVersion: 2,
      conversationId: bound.conversationId,
      responder: bound.parties[1],
      offerEventId: offer.event.eventId,
      termsHash: termsHash(offer.event),
    }
    let accept: AcceptFields | undefined
    if (decision.kind === 'accept') {
      accept = {
        xecClaimPublicKey: key(
          decision.fields?.xecClaimPublicKey,
          'xecClaimPublicKey',
        ),
        evmSender: bytes(decision.fields?.evmSender, 20, 'evmSender'),
      }
      const violation =
        offerViolation(offer.terms, bound.policy) ??
        acceptViolation(offer.terms, accept)
      if (violation) invalid('transition-rejected', violation)
    }
    return {
      bound,
      eventCore: core(
        bound,
        decision.kind === 'accept' ? 2 : 3,
        responsePayload(terms, accept),
        [offer.event.eventId],
      ),
    }
  })
  if (!prepared.ok) return prepared
  return sign(prepared.value.eventCore, prepared.value.bound.parties[1], signer)
}
/** Prevalidate every event, including orphans that core descriptor callbacks never visit. */
export function reduceNegotiation(
  encodedEvents: readonly Uint8Array[],
  context: NegotiationContext,
  budget: NestedItemBudget,
): SwapResult<NegotiationReduction> {
  return result(() => {
    if (
      !Array.isArray(encodedEvents) ||
      encodedEvents.length > negotiationLimits.events ||
      encodedEvents.some(
        value =>
          !(value instanceof Uint8Array) ||
          value.length > negotiationLimits.eventBytes,
      ) ||
      encodedEvents.reduce((sum, value) => sum + value.length, 0) >
        negotiationLimits.totalBytes
    )
      invalid('bad-length', 'Negotiation batch admission limit')
    const bound = snapshot(context)
    const admitted = encodedEvents.map(value => new Uint8Array(value))
    const decoded = admitted.map(value => decode(value, bound, budget))
    const byId = new Map(
      decoded.map(value => [Array.from(value.event.eventId).join(','), value]),
    )
    const manifest: SwapManifest<NegotiationState> = {
      swapId: bound.swapId,
      laneId: 0,
      participants: bound.parties.map((publicKey, role) => ({
        keyId: must(negotiationIdentityKeyId(publicKey)),
        role,
      })),
      initialState: { offer: null, decision: null, accept: null },
      verifySignature: (event, preimage) =>
        event.signatureAlgorithm === 1 &&
        verifyAlgorithm1(
          sha256(preimage),
          event.signature,
          bound.parties[event.senderRole]!,
        ),
      messageTypes: new Map(
        [1, 2, 3].map(type => [
          type,
          {
            budget: 'ordinary' as const,
            producerRoles: [type === 1 ? 0 : 1],
            effect: (event: SignedSwapEvent) => ({
              ok: true as const,
              value: {
                key: type === 1 ? 'offer' : 'decision',
                value: event.eventId,
              },
            }),
            transition: (state: NegotiationState, event: SignedSwapEvent) => {
              const value = byId.get(Array.from(event.eventId).join(','))!
              if (value.kind === 'offer') {
                // Signed but unexecutable terms are a violation, never an acceptable offer.
                const violation = offerViolation(value.terms, bound.policy)
                if (violation)
                  return {
                    disposition: 'violation' as const,
                    detail: violation,
                  }
                return {
                  disposition: 'apply' as const,
                  state: { ...state, offer: value },
                }
              }
              if (!state.offer) return { disposition: 'buffer' as const }
              if (
                !equal(value.terms.offerEventId, state.offer.event.eventId) ||
                !equal(value.terms.termsHash, termsHash(state.offer.event))
              )
                return {
                  disposition: 'violation' as const,
                  detail: 'Response does not bind actual offer terms',
                }
              if (value.kind === 'reject')
                return {
                  disposition: 'apply' as const,
                  state: { ...state, decision: value.kind },
                }
              const violation = acceptViolation(state.offer.terms, value.terms)
              if (violation)
                return { disposition: 'violation' as const, detail: violation }
              return {
                disposition: 'apply' as const,
                state: { ...state, decision: value.kind, accept: value },
              }
            },
          },
        ]),
      ),
    }
    const reduced = must(reduceSwapJournal(admitted, manifest))
    return {
      history: reduced.state,
      violation: reduced.violation,
      usableAcceptance:
        !reduced.violation &&
        reduced.state.decision === 'accept' &&
        reduced.state.accept
          ? {
              offer: reduced.state.offer!.terms,
              accept: reduced.state.accept.terms,
            }
          : null,
      applied: reduced.applied,
      buffered: reduced.buffered,
    }
  })
}
/** Journal reconstruction is a distinct standalone operation, never a transport decode budget. */
export function reduceNegotiationStandalone(
  encodedEvents: readonly Uint8Array[],
  context: NegotiationContext,
): SwapResult<NegotiationReduction> {
  return reduceNegotiation(encodedEvents, context, standaloneItemBudget())
}
export function negotiationEligibility(
  reduction: NegotiationReduction,
  now: bigint,
): SwapResult<{
  eligibleForPreparation: boolean
  reason: 'accepted' | 'expired' | 'not-accepted' | 'violation'
}> {
  return result(() => {
    uint(now, U64, 'Current Unix seconds')
    if (reduction.violation)
      return { eligibleForPreparation: false, reason: 'violation' }
    if (!reduction.usableAcceptance)
      return { eligibleForPreparation: false, reason: 'not-accepted' }
    if (now >= reduction.usableAcceptance.offer.expiry)
      return { eligibleForPreparation: false, reason: 'expired' }
    return { eligibleForPreparation: true, reason: 'accepted' }
  })
}
