/**
 * Message framing. Every protocol message is
 *
 *   "FDK1" (4) || protocol (1) || round (1) || frame binding (32) || body
 *
 * The frame binding hashes everything both parties must agree on before the
 * first message: the session id, both identities in role order and, for
 * signing, the key, the digest and the lock. A message of any other session,
 * key, digest, lock or role assignment fails the header check before a body
 * byte is interpreted.
 *
 * The frame binding cannot contain the parties' fresh salts (they travel in
 * the first two messages). Everything after them is bound to the FULL
 * binding, which adds 32 fresh bytes from each party, so neither party can
 * make the other run two sessions under the same binding.
 */
import { asciiBytes, concat, equalBytes, snapshotBounded } from './bytes.js'
import { ENCODED_CHOICES_BYTES, OPENINGS_BYTES } from './base-ot.js'
import { HASH_BYTES, transcript } from './group.js'
import { EXTENSION_MESSAGE_BYTES } from './ot-extension.js'
import type { DklsErrorCode } from './result.js'
import { VOLE_MESSAGE_BYTES } from './vole.js'

const MAGIC = asciiBytes('FDK1')
export const HEADER_BYTES = MAGIC.length + 2 + HASH_BYTES

export const PROTOCOL_KEYGEN = 1
export const PROTOCOL_SIGN = 2
export const PROTOCOL_PRE_SIGN = 3

export const SALT_BYTES = 32
export const SESSION_ID_BYTES = 32
export const DIGEST_BYTES = 32
export const MIN_IDENTITY_BYTES = 1
export const MAX_IDENTITY_BYTES = 64

/**
 * Upper bound on any message of this package, checked before parsing. The
 * largest is signing message 2: two salts-sized fields, one OT-extension
 * message and one multiplication message.
 */
export const MAX_MESSAGE_BYTES =
  HEADER_BYTES +
  SALT_BYTES +
  HASH_BYTES +
  Math.max(
    EXTENSION_MESSAGE_BYTES + VOLE_MESSAGE_BYTES,
    ENCODED_CHOICES_BYTES + OPENINGS_BYTES,
  ) +
  1024

export type RoleName = 'initiator' | 'responder'

export function encodeMessage(
  protocol: number,
  round: number,
  frame: Uint8Array,
  body: Uint8Array,
): Uint8Array {
  return concat(MAGIC, Uint8Array.of(protocol, round), frame, body)
}

export interface Expected {
  readonly protocol: number
  readonly round: number
  readonly frame: Uint8Array
  readonly bodyBytes: number
}

export type Opened =
  | { readonly ok: true; readonly body: Uint8Array }
  | { readonly ok: false; readonly code: DklsErrorCode }

/**
 * Copies an incoming message and checks its frame against what the session
 * expects next. Nothing here touches secret state, so a rejection leaves the
 * session usable: a stray, duplicated or foreign message cannot kill it.
 * Every message body of this package has exactly one valid length.
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
    protocol !== PROTOCOL_PRE_SIGN
  ) {
    return { ok: false, code: 'malformed-message' }
  }
  if (
    protocol !== expected.protocol ||
    !equalBytes(copied.subarray(MAGIC.length + 2, HEADER_BYTES), expected.frame)
  ) {
    return { ok: false, code: 'wrong-session' }
  }
  if (round !== expected.round) {
    return { ok: false, code: 'unexpected-message' }
  }
  if (copied.length - HEADER_BYTES !== expected.bodyBytes) {
    return { ok: false, code: 'malformed-message' }
  }
  return { ok: true, body: copied.slice(HEADER_BYTES) }
}

export function keygenFrame(
  sessionId: Uint8Array,
  initiatorId: Uint8Array,
  responderId: Uint8Array,
): Uint8Array {
  return transcript('session/keygen', sessionId, initiatorId, responderId)
}

export function signFrame(input: {
  readonly protocol: number
  readonly sessionId: Uint8Array
  readonly initiatorId: Uint8Array
  readonly responderId: Uint8Array
  readonly keyId: Uint8Array
  readonly publicKey: Uint8Array
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
    input.digest,
    input.lock,
  )
}

/** Binding of the initiator's first message: the frame and its own salt. */
export function initiatorBinding(
  frame: Uint8Array,
  initiatorSalt: Uint8Array,
): Uint8Array {
  return transcript('session/initiator', frame, initiatorSalt)
}

/** The full binding: the frame and a fresh salt from EACH party. */
export function fullBinding(
  frame: Uint8Array,
  initiatorSalt: Uint8Array,
  responderSalt: Uint8Array,
): Uint8Array {
  return transcript('session/full', frame, initiatorSalt, responderSalt)
}
