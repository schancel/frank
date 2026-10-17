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
  readonly name: 'xec-monad-testnet-v1' | 'xec-monad-regtest-proof-v1'
  readonly xecChainIdentifier: string
  readonly evmChainIdentifier: string
}
export const TESTNET_NEGOTIATION_POLICY: NegotiationPairPolicy = Object.freeze({
  name: 'xec-monad-testnet-v1',
  xecChainIdentifier: 'xec-testnet',
  evmChainIdentifier: 'monad-testnet',
})
export const REGTEST_PROOF_NEGOTIATION_POLICY: NegotiationPairPolicy =
  Object.freeze({
    name: 'xec-monad-regtest-proof-v1',
    xecChainIdentifier: 'xec-regtest',
    evmChainIdentifier: 'monad-regtest',
  })
export interface NegotiationContext {
  readonly swapId: Uint8Array
  readonly conversationId: Uint8Array
  readonly parties: readonly [Uint8Array, Uint8Array]
  readonly policy: NegotiationPairPolicy
}
export interface OfferTerms {
  readonly payloadVersion: 1
  readonly pairPolicyVersion: 1
  readonly conversationId: Uint8Array
  readonly parties: readonly [Uint8Array, Uint8Array]
  readonly xecChainIdentifier: string
  readonly evmChainIdentifier: string
  readonly xecPrincipal: bigint
  readonly evmPrincipal: bigint
  readonly expiry: bigint
}
export interface ResponseTerms {
  readonly payloadVersion: 1
  readonly conversationId: Uint8Array
  readonly responder: Uint8Array
  readonly offerEventId: Uint8Array
  readonly termsHash: Uint8Array
}
export type NegotiationEvent =
  | {
      readonly kind: 'offer'
      readonly event: SignedSwapEvent
      readonly terms: OfferTerms
    }
  | {
      readonly kind: 'accept' | 'reject'
      readonly event: SignedSwapEvent
      readonly terms: ResponseTerms
    }
export interface NegotiationState {
  readonly offer: Extract<NegotiationEvent, { kind: 'offer' }> | null
  readonly decision: 'accept' | 'reject' | null
}
export interface NegotiationReduction {
  /** Historical signed evidence only; inspect violation before using any partial state. */
  readonly history: NegotiationState
  readonly violation: SwapProtocolError | null
  /** Null on every violation, even when the core computed partial accepted history. */
  readonly usableAcceptance: OfferTerms | null
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
function key(value: unknown): Uint8Array {
  const checked = bytes(value, 33, 'compressed identity key')
  uncompressedPubkey(checked)
  return checked
}
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
  if (terms.payloadVersion !== 1 || terms.pairPolicyVersion !== 1)
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
      [0, 1],
      [1, 1],
      [2, terms.conversationId],
      [3, [...terms.parties]],
      [4, terms.xecChainIdentifier],
      [5, terms.evmChainIdentifier],
      [6, uint(terms.xecPrincipal, U64, 'XEC principal', true)],
      [7, amountBytes(uint(terms.evmPrincipal, U256, 'EVM principal', true))],
      [8, uint(terms.expiry, U64, 'expiry')],
    ]),
  )
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
function responsePayload(terms: ResponseTerms): Uint8Array {
  if (terms.payloadVersion !== 1) invalid('bad-version', 'Response version')
  bytes(terms.conversationId, 16, 'conversationId')
  key(terms.responder)
  return payload(
    new Map<number, Encodable>([
      [0, 1],
      [1, terms.conversationId],
      [2, terms.responder],
      [3, bytes(terms.offerEventId, 32, 'offerEventId')],
      [4, bytes(terms.termsHash, 32, 'termsHash')],
    ]),
  )
}
export function encodeResponsePayload(
  terms: ResponseTerms,
  context: NegotiationContext,
): SwapResult<Uint8Array> {
  return result(() => {
    bindResponse(terms, snapshot(context))
    return responsePayload(terms)
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
  return sha256(frame('frank/swap-negotiation-terms/v1', bound))
}
export function negotiationTermsHash(
  offer: NegotiationEvent,
): SwapResult<Uint8Array> {
  return result(() => {
    if (offer.kind !== 'offer') invalid('bad-format', 'Offer required')
    return termsHash(offer.event)
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
  const fields = exactMap(
    budget.decodeCbor(event.payload, 'swap-negotiation/payload'),
    offer ? 9 : 5,
  )
  if (fields.get(0n) !== 1n || (offer && fields.get(1n) !== 1n))
    invalid('bad-version', 'Negotiation payload or pair policy version')
  let decoded: NegotiationEvent
  if (offer) {
    const parties = fields.get(3n)
    if (!Array.isArray(parties) || parties.length !== 2)
      invalid('bad-format', 'Ordered two parties required')
    const terms: OfferTerms = {
      payloadVersion: 1,
      pairPolicyVersion: 1,
      conversationId: bytes(fields.get(2n), 16, 'conversationId'),
      parties: [key(parties[0]), key(parties[1])],
      xecChainIdentifier: chainIdentifier(fields.get(4n)),
      evmChainIdentifier: chainIdentifier(fields.get(5n)),
      xecPrincipal: uint(fields.get(6n), U64, 'XEC principal', true),
      evmPrincipal: amount(fields.get(7n)),
      expiry: uint(fields.get(8n), U64, 'expiry'),
    }
    if (event.prerequisiteEventIds.length !== 0)
      invalid('non-canonical', 'Offer prerequisites')
    if (!equal(offerPayload(terms, selectedPolicy), event.payload))
      invalid('non-canonical', 'Offer encoding')
    decoded = { kind: 'offer', event, terms }
  } else {
    const terms: ResponseTerms = {
      payloadVersion: 1,
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
    if (!equal(responsePayload(terms), event.payload))
      invalid('non-canonical', 'Response encoding')
    decoded = {
      kind: event.messageType === 2 ? 'accept' : 'reject',
      event,
      terms,
    }
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
export async function buildNegotiationOffer(
  context: NegotiationContext,
  amounts: { xecPrincipal: bigint; evmPrincipal: bigint; expiry: bigint },
  signer: NegotiationDigestSigner,
): Promise<SwapResult<SignedSwapEvent>> {
  const prepared = result(() => {
    const bound = snapshot(context)
    const terms: OfferTerms = {
      payloadVersion: 1,
      pairPolicyVersion: 1,
      ...bound,
      xecChainIdentifier: bound.policy.xecChainIdentifier,
      evmChainIdentifier: bound.policy.evmChainIdentifier,
      xecPrincipal: amounts.xecPrincipal,
      evmPrincipal: amounts.evmPrincipal,
      expiry: amounts.expiry,
    }
    return {
      bound,
      eventCore: core(bound, 1, offerPayload(terms, bound.policy), []),
    }
  })
  if (!prepared.ok) return prepared
  return sign(prepared.value.eventCore, prepared.value.bound.parties[0], signer)
}
export async function buildNegotiationResponse(
  context: NegotiationContext,
  offerBytes: Uint8Array,
  decision: 'accept' | 'reject',
  signer: NegotiationDigestSigner,
): Promise<SwapResult<SignedSwapEvent>> {
  const prepared = result(() => {
    const bound = snapshot(context)
    if (decision !== 'accept' && decision !== 'reject')
      invalid('bad-format', 'Negotiation decision')
    const offer = decode(
      new Uint8Array(offerBytes),
      bound,
      standaloneItemBudget(),
    )
    if (offer.kind !== 'offer') invalid('bad-format', 'Response requires offer')
    const terms: ResponseTerms = {
      payloadVersion: 1,
      conversationId: bound.conversationId,
      responder: bound.parties[1],
      offerEventId: offer.event.eventId,
      termsHash: termsHash(offer.event),
    }
    return {
      bound,
      eventCore: core(
        bound,
        decision === 'accept' ? 2 : 3,
        responsePayload(terms),
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
      initialState: { offer: null, decision: null },
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
              if (value.kind === 'offer')
                return {
                  disposition: 'apply' as const,
                  state: { ...state, offer: value },
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
              return {
                disposition: 'apply' as const,
                state: { ...state, decision: value.kind },
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
        !reduced.violation && reduced.state.decision === 'accept'
          ? reduced.state.offer!.terms
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
    if (now >= reduction.usableAcceptance.expiry)
      return { eligibleForPreparation: false, reason: 'expired' }
    return { eligibleForPreparation: true, reason: 'accepted' }
  })
}
