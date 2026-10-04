/**
 * Message framing. Every protocol message is
 *
 *   "FTE1" (4) || protocol (1) || round (1) || session binding (32) || body
 *
 * The session binding is a hash of the session id, both identities and, for
 * signing, the key, tweak, digest and adaptor point (see `sessionBinding*`).
 * A message replayed from any other session therefore fails the header check
 * before a single body byte is interpreted, and every commitment and
 * Fiat-Shamir challenge inside the body hashes the same binding again.
 */
import { asciiBytes, concat, equalBytes, snapshotBounded } from './bytes.js'
import { HASH_BYTES, transcript } from './group.js'
import type { ThresholdErrorCode } from './result.js'

const MAGIC = asciiBytes('FTE1')
export const HEADER_BYTES = MAGIC.length + 2 + HASH_BYTES

export const PROTOCOL_KEYGEN = 1
export const PROTOCOL_SIGN = 2
export const PROTOCOL_ADAPTOR_SIGN = 3

/** Upper bound on any message of this package, checked before parsing. */
export const MAX_MESSAGE_BYTES = 47000

export const SESSION_ID_BYTES = 32
export const MIN_IDENTITY_BYTES = 1
export const MAX_IDENTITY_BYTES = 64

export function encodeMessage(
  protocol: number,
  round: number,
  session: Uint8Array,
  body: Uint8Array,
): Uint8Array {
  return concat(MAGIC, Uint8Array.of(protocol, round), session, body)
}

export interface Expected {
  readonly protocol: number
  readonly round: number
  readonly session: Uint8Array
  readonly minBody: number
  readonly maxBody: number
}

export type Opened =
  | { readonly ok: true; readonly body: Uint8Array }
  | { readonly ok: false; readonly code: ThresholdErrorCode }

/**
 * Copies an incoming message and checks its frame against what the session
 * expects next. Nothing here touches secret state, so a rejection leaves the
 * session usable: a stray, duplicated or foreign message cannot kill it.
 */
export function openMessage(message: unknown, expected: Expected): Opened {
  const copied = snapshotBounded(message, 0, MAX_MESSAGE_BYTES)
  if (copied === null || copied.length < HEADER_BYTES) {
    return { ok: false, code: 'malformed-message' }
  }
  if (!equalBytes(copied.subarray(0, MAGIC.length), MAGIC)) {
    return { ok: false, code: 'malformed-message' }
  }
  const protocol = copied[MAGIC.length]
  const round = copied[MAGIC.length + 1]
  if (
    protocol !== PROTOCOL_KEYGEN &&
    protocol !== PROTOCOL_SIGN &&
    protocol !== PROTOCOL_ADAPTOR_SIGN
  ) {
    return { ok: false, code: 'malformed-message' }
  }
  const session = copied.subarray(MAGIC.length + 2, HEADER_BYTES)
  if (
    protocol !== expected.protocol ||
    !equalBytes(session, expected.session)
  ) {
    return { ok: false, code: 'wrong-session' }
  }
  if (round !== expected.round) {
    return { ok: false, code: 'unexpected-message' }
  }
  const body = copied.slice(HEADER_BYTES)
  if (body.length < expected.minBody || body.length > expected.maxBody) {
    return { ok: false, code: 'malformed-message' }
  }
  return { ok: true, body }
}

/**
 * Frame binding of a key-generation session: session id and both identities.
 * It is all that is known when the first message is sent, so it is what the
 * message header carries.
 */
export function keygenFrameBinding(
  sessionId: Uint8Array,
  initiatorId: Uint8Array,
  responderId: Uint8Array,
): Uint8Array {
  return transcript('session/keygen', sessionId, initiatorId, responderId)
}

/** Binding of the initiator's first message: frame plus its fresh salt. */
export function keygenInitiatorBinding(
  frame: Uint8Array,
  initiatorSalt: Uint8Array,
): Uint8Array {
  return transcript('session/keygen-initiator', frame, initiatorSalt)
}

/**
 * Full binding, used by every proof and commitment after message 1: the
 * frame plus 32 fresh random bytes from EACH party. Neither party can make
 * the other run two key generations under the same binding.
 */
export function keygenFullBinding(
  frame: Uint8Array,
  initiatorSalt: Uint8Array,
  responderSalt: Uint8Array,
): Uint8Array {
  return transcript('session/keygen-full', frame, initiatorSalt, responderSalt)
}

/**
 * Binding of a signing session: everything both parties must agree on before
 * a nonce is used. `tweakCommitment` and `lock` are empty strings when
 * absent; the protocol byte separates plain from adaptor signing.
 */
export function signBinding(input: {
  readonly protocol: number
  readonly sessionId: Uint8Array
  readonly initiatorId: Uint8Array
  readonly responderId: Uint8Array
  readonly keyId: Uint8Array
  readonly publicKey: Uint8Array
  readonly tweakCommitment: Uint8Array
  readonly digest: Uint8Array
  /** Empty for plain signing, else the encoded lock (see lock.ts). */
  readonly lock: Uint8Array
}): Uint8Array {
  return transcript(
    'session/sign',
    Uint8Array.of(input.protocol),
    input.sessionId,
    input.initiatorId,
    input.responderId,
    input.keyId,
    input.publicKey,
    input.tweakCommitment,
    input.digest,
    input.lock,
  )
}
