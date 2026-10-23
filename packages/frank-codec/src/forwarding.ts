// Pure encoder and validator for Type 13 relay forwarding delivery envelope (docs/protocol/cbor).

import { cborMap } from './cbor'
import {
  ACCOUNT_REF,
  FORWARDING_DELIVERY_ENVELOPE,
  KEY_TYPE,
  MAX_FORWARDING_DELIVERY_FRAME_BYTES,
  MAX_PAYMENT_MEMBERS,
  PAYMENT_MEMBER,
  TYPE_FORWARDING_DELIVERY_ENVELOPE,
} from './constants'
import { FrankCodecError } from './errors'
import { encodeFrame } from './frame'
import { forwardingPayloadDigest } from './hash'
import type {
  AccountRef,
  ForwardingDeliveryEnvelope,
  ParsedFrame,
  PaymentMember,
  UnknownFields,
} from './types'
import {
  defaultContext,
  validateFrame,
  type ValidationContext,
} from './validate'

const bad = (msg: string, location = 'forwarding-envelope') =>
  new FrankCodecError('schema', '8.2', msg, location)

export interface CanonicalForwardingEnvelope {
  network: string
  destination: AccountRef
  /** Complete serialized inner frame (Type 10 direct message delivery). */
  payloadFrame: Uint8Array
  /** Digest of the inner frame. Defaults to `forwardingPayloadDigest(network, payloadFrame)`. */
  payloadDigest?: Uint8Array
  /** Storage payment stamps compensating the destination relay. */
  payments: PaymentMember[]
  /** Optional destination relay endpoint URI. */
  endpoint?: string
  /** Optional delivery TTL / expiration timestamp (seconds). */
  expiresAt?: number
  unknownFields?: UnknownFields
}

function encodeAccount(acc: AccountRef): Map<number | bigint, any> {
  if (acc.keyType !== KEY_TYPE.secp256k1) {
    throw bad('destination account must be key type 1')
  }
  if (acc.keyBytes.length !== 33) {
    throw bad('key type 1 requires 33 key bytes')
  }
  return cborMap([
    [ACCOUNT_REF.keyType, acc.keyType],
    [ACCOUNT_REF.keyBytes, acc.keyBytes],
  ])
}

function encodePaymentMember(p: PaymentMember): Map<number | bigint, any> {
  const entries: Array<[number, any]> = [
    [PAYMENT_MEMBER.childIndex, p.childIndex],
    [PAYMENT_MEMBER.transactionId, p.transactionId],
    [PAYMENT_MEMBER.value, typeof p.value === 'bigint' ? p.value : p.value],
    [PAYMENT_MEMBER.address, p.address],
    [PAYMENT_MEMBER.commitment, p.commitment],
  ]
  if (p.vout !== undefined) {
    entries.push([PAYMENT_MEMBER.vout, p.vout])
  }
  if (p.rawTx !== undefined) {
    entries.push([PAYMENT_MEMBER.rawTx, p.rawTx])
  }
  return cborMap(entries)
}

/**
 * Encodes a canonical Type 13 forwarding delivery envelope frame.
 */
export function encodeForwardingEnvelope(
  envelope: CanonicalForwardingEnvelope,
): Uint8Array {
  if (
    !envelope.network ||
    envelope.network.length === 0 ||
    envelope.network.length > 64
  ) {
    throw bad('network must be 1..64 characters')
  }
  if (!envelope.payloadFrame || envelope.payloadFrame.length < 9) {
    throw bad('payloadFrame must be a valid frame of at least 9 bytes')
  }
  if (
    !envelope.payments ||
    envelope.payments.length === 0 ||
    envelope.payments.length > MAX_PAYMENT_MEMBERS
  ) {
    throw bad(`payments must contain 1..${MAX_PAYMENT_MEMBERS} members`)
  }

  const digest =
    envelope.payloadDigest ??
    forwardingPayloadDigest(envelope.network, envelope.payloadFrame)
  if (digest.length !== 32) {
    throw bad('payloadDigest must be 32 bytes')
  }

  const entries: Array<[number, any]> = [
    [FORWARDING_DELIVERY_ENVELOPE.network, envelope.network],
    [
      FORWARDING_DELIVERY_ENVELOPE.destination,
      encodeAccount(envelope.destination),
    ],
    [FORWARDING_DELIVERY_ENVELOPE.payloadFrame, envelope.payloadFrame],
    [FORWARDING_DELIVERY_ENVELOPE.payloadDigest, digest],
    [
      FORWARDING_DELIVERY_ENVELOPE.payments,
      envelope.payments.map(encodePaymentMember),
    ],
  ]

  if (envelope.endpoint !== undefined) {
    if (envelope.endpoint.length < 1 || envelope.endpoint.length > 256) {
      throw bad('endpoint must be 1..256 characters')
    }
    entries.push([FORWARDING_DELIVERY_ENVELOPE.endpoint, envelope.endpoint])
  }

  if (envelope.expiresAt !== undefined) {
    if (
      !Number.isSafeInteger(envelope.expiresAt) ||
      envelope.expiresAt < 0 ||
      envelope.expiresAt > 4294967295
    ) {
      throw bad('expiresAt must be in 0..4294967295')
    }
    entries.push([FORWARDING_DELIVERY_ENVELOPE.expiresAt, envelope.expiresAt])
  }

  if (envelope.unknownFields) {
    for (const [key, val] of envelope.unknownFields) {
      entries.push([Number(key), val])
    }
  }

  const frameBytes = encodeFrame(
    {
      typeId: TYPE_FORWARDING_DELIVERY_ENVELOPE,
      schemaVersion: 1,
      minReaderVersion: 1,
    },
    cborMap(entries),
  )

  if (frameBytes.length > MAX_FORWARDING_DELIVERY_FRAME_BYTES) {
    throw bad(
      `frame exceeds maximum length of ${MAX_FORWARDING_DELIVERY_FRAME_BYTES} bytes`,
    )
  }

  return frameBytes
}

/**
 * Checks if a parsed frame is a valid Type 13 forwarding envelope.
 */
export function isForwardingEnvelopeFrame(
  frame: ParsedFrame,
): frame is ParsedFrame & { typed: ForwardingDeliveryEnvelope<ParsedFrame> } {
  return (
    frame.typeId === TYPE_FORWARDING_DELIVERY_ENVELOPE &&
    frame.typed?.type === TYPE_FORWARDING_DELIVERY_ENVELOPE
  )
}

/**
 * Projects a validated parsed Type 13 frame into a canonical representation.
 */
export function projectForwardingEnvelope(
  frame: ParsedFrame,
): CanonicalForwardingEnvelope {
  if (!isForwardingEnvelopeFrame(frame)) {
    throw bad('frame is not a valid forwarding envelope')
  }
  const typed = frame.typed
  return {
    network: typed.network,
    destination: typed.destination,
    payloadFrame: typed.payloadFrame.frame,
    payloadDigest: typed.payloadDigest,
    payments: typed.payments,
    endpoint: typed.endpoint,
    expiresAt: typed.expiresAt,
    unknownFields: typed.unknownFields,
  }
}

/**
 * Validates raw frame bytes as a Type 13 forwarding envelope through stages 1-9.
 */
export function validateForwardingEnvelope(
  frameBytes: Uint8Array,
  context?: Partial<ValidationContext>,
): ParsedFrame & { typed: ForwardingDeliveryEnvelope<ParsedFrame> } {
  const ctx = defaultContext(context)
  const result = validateFrame(frameBytes, ctx)
  if (result.kind !== 'parsed') {
    throw bad(`expected parsed frame, got ${result.kind}`)
  }
  if (!isForwardingEnvelopeFrame(result)) {
    throw bad(`expected Type 13 frame, got type ${result.typeId}`)
  }
  return result
}
