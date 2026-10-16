/** Local authorization/recovery only. Neither a claim nor delivery is journal admission. */
import {
  encodeCanonical,
  standaloneItemBudget,
  toHex,
  fromHex,
  type Encodable,
} from '@frank/codec'
import {
  buildNegotiationOffer,
  buildNegotiationResponse,
  decodeNegotiationEventStandalone,
  encodeOfferPayload,
  negotiationIdentityKeyId,
  negotiationTermsHash,
  TESTNET_NEGOTIATION_POLICY,
  type NegotiationContext,
  type NegotiationDigestSigner,
  type NegotiationEvent,
} from './negotiation'
import { encodeSignedSwapEvent, type SwapResult } from './index'

const unwrap = <T>(value: SwapResult<T>): T => {
  if (!value.ok) throw new Error(value.error.detail ?? value.error.code)
  return value.value
}
const equal = (a: Uint8Array, b: Uint8Array) => toHex(a) === toHex(b)
const checkedBytes = (value: unknown, length: number): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw new Error('Invalid local intent bytes')
  return new Uint8Array(value)
}
export type LocalNegotiationIntent = {
  readonly context: NegotiationContext
} & (
  | {
      readonly action: 'offer'
      readonly xecPrincipal: bigint
      readonly evmPrincipal: bigint
      readonly expiry: bigint
    }
  | { readonly action: 'accept' | 'reject'; readonly offerBytes: Uint8Array }
)
export interface NegotiationClaim {
  readonly version: 1
  readonly intentKey: string
  readonly accountId: string
  readonly signerKeyId: string
  readonly messagingChainIdentifier: string
  readonly recipientPublicKey: string
  readonly conversationId: string
  readonly stampValueWei: string
  readonly intentHex: string
}
export type NegotiationRecord = NegotiationClaim &
  (
    | { readonly phase: 'claimed' }
    | {
        readonly phase: 'signed'
        readonly signedPayloadHex: string
        readonly messageId: string
      }
  )
export interface OutgoingNegotiationOwner {
  claimOutgoingApplicationMessage(
    claim: NegotiationClaim,
  ): Promise<NegotiationRecord>
  completeOutgoingApplicationMessage(input: {
    claim: NegotiationClaim
    signedPayloadHex: string
    messageId: string
  }): Promise<NegotiationRecord>
  getOutgoingApplicationMessage(
    intentKey: string,
  ): Promise<NegotiationRecord | undefined>
}
export interface NegotiationAuthorization {
  readonly accountId: string
  readonly publicKey: Uint8Array
  readonly messagingChainIdentifier: string
  readonly conversationId: string
  readonly recipientPublicKey: Uint8Array
  /** Checks captured account, revision, chain and directory session. */
  assertCurrent(): void
  intentKey(transcript: Uint8Array): string
  messageId(transcript: Uint8Array): string
  assertAdmittedOffer(
    context: NegotiationContext,
    offerBytes: Uint8Array,
    decision: 'accept' | 'reject',
  ): void
  signDigest: NegotiationDigestSigner
}
function uint256(value: bigint): Uint8Array {
  if (value <= 0n || value >= 1n << 256n)
    throw new Error('Invalid EVM principal')
  return fromHex(value.toString(16).padStart(64, '0'))
}
function validate(intent: LocalNegotiationIntent): void {
  const { context } = intent
  if (
    context.policy.name !== TESTNET_NEGOTIATION_POLICY.name ||
    context.policy.xecChainIdentifier !==
      TESTNET_NEGOTIATION_POLICY.xecChainIdentifier ||
    context.policy.evmChainIdentifier !==
      TESTNET_NEGOTIATION_POLICY.evmChainIdentifier
  )
    throw new Error('Unsupported negotiation policy')
  checkedBytes(context.swapId, 32)
  if (intent.action === 'offer')
    unwrap(
      encodeOfferPayload(
        {
          payloadVersion: 1,
          pairPolicyVersion: 1,
          conversationId: context.conversationId,
          parties: context.parties,
          xecChainIdentifier: context.policy.xecChainIdentifier,
          evmChainIdentifier: context.policy.evmChainIdentifier,
          xecPrincipal: intent.xecPrincipal,
          evmPrincipal: intent.evmPrincipal,
          expiry: intent.expiry,
        },
        context,
      ),
    )
  else if (
    unwrap(decodeNegotiationEventStandalone(intent.offerBytes, context))
      .kind !== 'offer'
  )
    throw new Error('Response requires signed offer')
}
export function encodeLocalNegotiationIntent(
  intent: LocalNegotiationIntent,
): Uint8Array {
  validate(intent)
  const { context: c } = intent
  const detail: Encodable =
    intent.action === 'offer'
      ? [intent.xecPrincipal, uint256(intent.evmPrincipal), intent.expiry]
      : [intent.offerBytes]
  const bytes = encodeCanonical([
    'frank/swap-negotiation-local-intent/v1',
    ['offer', 'accept', 'reject'].indexOf(intent.action),
    c.swapId,
    c.conversationId,
    [...c.parties],
    c.policy.name,
    c.policy.xecChainIdentifier,
    c.policy.evmChainIdentifier,
    detail,
  ])
  if (bytes.length > 4096) throw new Error('Local intent size limit')
  return bytes
}
export function decodeLocalNegotiationIntent(
  bytes: Uint8Array,
): LocalNegotiationIntent {
  if (bytes.length > 4096) throw new Error('Local intent size limit')
  const v = standaloneItemBudget().decodeCbor(
    bytes,
    'swap-negotiation/local-intent',
  )
  if (
    !Array.isArray(v) ||
    v.length !== 9 ||
    v[0] !== 'frank/swap-negotiation-local-intent/v1' ||
    ![0n, 1n, 2n].includes(v[1] as bigint) ||
    !Array.isArray(v[4]) ||
    v[4].length !== 2 ||
    !Array.isArray(v[8]) ||
    v[5] !== TESTNET_NEGOTIATION_POLICY.name ||
    v[6] !== TESTNET_NEGOTIATION_POLICY.xecChainIdentifier ||
    v[7] !== TESTNET_NEGOTIATION_POLICY.evmChainIdentifier
  )
    throw new Error('Invalid local intent schema')
  const context: NegotiationContext = {
    swapId: checkedBytes(v[2], 32),
    conversationId: checkedBytes(v[3], 16),
    parties: [checkedBytes(v[4][0], 33), checkedBytes(v[4][1], 33)],
    policy: TESTNET_NEGOTIATION_POLICY,
  }
  const detail = v[8]
  let intent: LocalNegotiationIntent
  if (v[1] === 0n) {
    if (
      detail.length !== 3 ||
      typeof detail[0] !== 'bigint' ||
      typeof detail[2] !== 'bigint'
    )
      throw new Error('Invalid offer intent')
    intent = {
      context,
      action: 'offer',
      xecPrincipal: detail[0],
      evmPrincipal: BigInt('0x' + toHex(checkedBytes(detail[1], 32))),
      expiry: detail[2],
    }
  } else {
    if (detail.length !== 1 || !(detail[0] instanceof Uint8Array))
      throw new Error('Invalid response intent')
    intent = {
      context,
      action: v[1] === 1n ? 'accept' : 'reject',
      offerBytes: new Uint8Array(detail[0]),
    }
  }
  if (!equal(encodeLocalNegotiationIntent(intent), bytes))
    throw new Error('Noncanonical local intent')
  return intent
}
export function negotiationSlotTranscript(
  swapId: Uint8Array,
  signerKeyId: Uint8Array,
): Uint8Array {
  return encodeCanonical([
    'frank/swap-negotiation-intent-key/v1',
    checkedBytes(swapId, 32),
    0,
    checkedBytes(signerKeyId, 32),
    0,
  ])
}
export function negotiationMessageTranscript(
  chainIdentifier: string,
  conversationId: Uint8Array,
  recipient: Uint8Array,
  eventId: Uint8Array,
): Uint8Array {
  return encodeCanonical([
    'frank/swap-negotiation-message/v1',
    chainIdentifier,
    checkedBytes(conversationId, 16),
    checkedBytes(recipient, 33),
    checkedBytes(eventId, 32),
  ])
}
function bind(
  intent: LocalNegotiationIntent,
  auth: NegotiationAuthorization,
): string {
  auth.assertCurrent()
  const role = intent.action === 'offer' ? 0 : 1
  if (
    auth.messagingChainIdentifier !==
      TESTNET_NEGOTIATION_POLICY.evmChainIdentifier ||
    !equal(intent.context.parties[role], auth.publicKey) ||
    !equal(intent.context.parties[1 - role]!, auth.recipientPublicKey) ||
    toHex(intent.context.conversationId) !==
      auth.conversationId.replace(/-/g, '')
  )
    throw new Error('Negotiation authorization context changed')
  return toHex(unwrap(negotiationIdentityKeyId(auth.publicKey)))
}
function claimFor(
  intent: LocalNegotiationIntent,
  auth: NegotiationAuthorization,
  stampValueWei: string,
): NegotiationClaim {
  const signerKeyId = bind(intent, auth)
  return {
    version: 1,
    accountId: auth.accountId,
    signerKeyId,
    intentKey: auth.intentKey(
      negotiationSlotTranscript(intent.context.swapId, fromHex(signerKeyId)),
    ),
    messagingChainIdentifier: auth.messagingChainIdentifier,
    conversationId: auth.conversationId,
    recipientPublicKey: toHex(auth.recipientPublicKey),
    stampValueWei,
    intentHex: toHex(encodeLocalNegotiationIntent(intent)),
  }
}
function signedRecord(
  record: NegotiationRecord,
  intent: LocalNegotiationIntent,
  auth: NegotiationAuthorization,
): NegotiationRecord & {
  phase: 'signed'
  signedPayloadHex: string
  messageId: string
} {
  if (record.phase !== 'signed') throw new Error('Signature incomplete')
  const event = unwrap(
    decodeNegotiationEventStandalone(
      fromHex(record.signedPayloadHex),
      intent.context,
    ),
  )
  if (event.kind !== intent.action)
    throw new Error('Stored signature action differs')
  if (intent.action === 'offer' && event.kind === 'offer') {
    if (
      event.terms.xecPrincipal !== intent.xecPrincipal ||
      event.terms.evmPrincipal !== intent.evmPrincipal ||
      event.terms.expiry !== intent.expiry
    )
      throw new Error('Stored offer differs')
  } else if (intent.action !== 'offer' && event.kind !== 'offer') {
    const offer = unwrap(
      decodeNegotiationEventStandalone(intent.offerBytes, intent.context),
    )
    if (
      !equal(event.terms.offerEventId, offer.event.eventId) ||
      !equal(event.terms.termsHash, unwrap(negotiationTermsHash(offer)))
    )
      throw new Error('Stored response differs')
  }
  if (
    record.messageId !==
    auth.messageId(
      negotiationMessageTranscript(
        auth.messagingChainIdentifier,
        intent.context.conversationId,
        auth.recipientPublicKey,
        event.event.eventId,
      ),
    )
  )
    throw new Error('Stored message identity differs')
  return record
}
function validateStoredClaim(
  record: NegotiationRecord,
  expected: NegotiationClaim,
  auth: NegotiationAuthorization,
): void {
  const reconstructed = claimFor(
    decodeLocalNegotiationIntent(fromHex(record.intentHex)),
    auth,
    record.stampValueWei,
  )
  for (const key of Object.keys(expected) as (keyof NegotiationClaim)[]) {
    if (expected[key] !== record[key] || reconstructed[key] !== record[key])
      throw new Error('Outgoing negotiation claim conflict')
  }
}
/** Revalidates opaque storage before it can authorize a signer or a send. */
export async function authorizeNegotiation(input: {
  intent: LocalNegotiationIntent
  auth: NegotiationAuthorization
  owner: OutgoingNegotiationOwner
  stampValueWei: string
  now: () => bigint
}): Promise<
  NegotiationRecord & {
    phase: 'signed'
    signedPayloadHex: string
    messageId: string
  }
> {
  const intent = decodeLocalNegotiationIntent(
    encodeLocalNegotiationIntent(input.intent),
  )
  const claim = claimFor(intent, input.auth, input.stampValueWei)
  // An existing completed signature may be delivered after expiry; new signing may not.
  let record = await input.owner.getOutgoingApplicationMessage(claim.intentKey)
  input.auth.assertCurrent()
  if (record) {
    validateStoredClaim(record, claim, input.auth)
    if (record.phase === 'signed')
      return signedRecord(record, intent, input.auth)
  }
  const offer: NegotiationEvent | undefined =
    intent.action === 'offer'
      ? undefined
      : unwrap(
          decodeNegotiationEventStandalone(intent.offerBytes, intent.context),
        )
  const expiry =
    intent.action === 'offer'
      ? intent.expiry
      : offer?.kind === 'offer'
      ? offer.terms.expiry
      : 0n
  if (input.now() >= expiry) throw new Error('Negotiation expired')
  if (intent.action !== 'offer')
    input.auth.assertAdmittedOffer(
      intent.context,
      intent.offerBytes,
      intent.action,
    )
  record = await input.owner.claimOutgoingApplicationMessage(claim)
  input.auth.assertCurrent()
  if (record.phase === 'signed') return signedRecord(record, intent, input.auth)
  const sign: NegotiationDigestSigner = async (digest) => {
    input.auth.assertCurrent()
    if (input.now() >= expiry) throw new Error('Negotiation expired')
    if (intent.action !== 'offer')
      input.auth.assertAdmittedOffer(
        intent.context,
        intent.offerBytes,
        intent.action,
      )
    const value = await input.auth.signDigest(digest)
    input.auth.assertCurrent()
    return value
  }
  const event = unwrap(
    await (intent.action === 'offer'
      ? buildNegotiationOffer(intent.context, intent, sign)
      : buildNegotiationResponse(
          intent.context,
          intent.offerBytes,
          intent.action,
          sign,
        )),
  )
  input.auth.assertCurrent()
  const signedPayloadHex = toHex(unwrap(encodeSignedSwapEvent(event)))
  const messageId = input.auth.messageId(
    negotiationMessageTranscript(
      input.auth.messagingChainIdentifier,
      intent.context.conversationId,
      input.auth.recipientPublicKey,
      event.eventId,
    ),
  )
  try {
    record = await input.owner.completeOutgoingApplicationMessage({
      claim,
      signedPayloadHex,
      messageId,
    })
  } catch (error) {
    // Another tab's valid DER representation can win. Only its exact persisted bytes escape.
    const winner = await input.owner.getOutgoingApplicationMessage(
      claim.intentKey,
    )
    if (!winner || winner.phase !== 'signed') throw error
    record = winner
  }
  input.auth.assertCurrent()
  validateStoredClaim(record, claim, input.auth)
  return signedRecord(record, intent, input.auth)
}
export function parseNegotiationAmount(
  text: string,
  decimals: number,
  bits: 64 | 256,
): bigint {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    text.length > decimals + 80 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text)
  )
    throw new Error('Enter an exact positive decimal amount')
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > decimals)
    throw new Error('Amount exceeds native precision')
  const amount = BigInt(whole! + fraction.padEnd(decimals, '0'))
  if (amount <= 0n || amount >= 1n << BigInt(bits))
    throw new Error('Amount outside protocol range')
  return amount
}

/** Exact presentation of configured native units; never rounds principal value. */
export function formatNegotiationAmount(
  value: bigint,
  decimals: number,
): string {
  const raw = value.toString().padStart(decimals + 1, '0')
  if (!decimals) return raw
  const fraction = raw.slice(-decimals).replace(/0+$/, '')
  return raw.slice(0, -decimals) + (fraction ? '.' + fraction : '')
}
