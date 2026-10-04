/**
 * Everything that differs between plain signing and adaptor pre-signing.
 * `sign.ts` calls these functions and is otherwise the same protocol for
 * both; with `lockPoint === null` they reduce to plain ECDSA.
 *
 * OUR OWN CONSTRUCTION (README section 5). For lock point L:
 *
 *  1. A party's nonce commitment covers (R_i = k_i*G, K_i = k_i*L,
 *     A_i = a_i*G, A'_i = a_i*L) instead of R_i alone.
 *  2. When it opens the commitment it proves log_G R_i = log_L K_i
 *     (Chaum-Pedersen, bound to the full session binding and its identity).
 *     The peer checks this BEFORE the joint r exists.
 *  3. The joint r is the x coordinate of K_I + K_R = k*L instead of
 *     R_I + R_R = k*G. Nothing else in the signing arithmetic changes.
 *  4. The 162-byte encoding of `@frank/adaptor-signatures` carries one
 *     equality proof (b, c) for the JOINT nonce k, which neither party knows:
 *     b is that package's challenge over (R_a, L, R, A_I + A_R, A'_I + A'_R),
 *     each party answers z_i = a_i + b*k_i, and c = z_I + z_R.
 *  5. The result is checked with that package's verifier.
 *
 * `a_i` and the nonce of the proof in step 2 are independent hedged values
 * under distinct labels: answering two challenges with one nonce would
 * reveal k_i.
 */
import {
  hashToScalar,
  taggedHash,
} from '@frank/adaptor-signatures/src/curve.js'
import {
  encodeAdaptorSignature,
  verifyEncryptedSignature,
} from '@frank/adaptor-signatures/src/ecdsa-adaptor.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'

import { concat, Reader } from './bytes.js'
import {
  CURVE_ORDER,
  DLEQ_PROOF_BYTES,
  encodePoint,
  G,
  hedgedScalar,
  modAdd,
  modMul,
  multiply,
  parsePoint,
  POINT_BYTES,
  pointBytes,
  proveDleq,
  requireDleqProof,
  SCALAR_BYTES,
  scalarBytes,
  type Point,
} from './group.js'
import { fail } from './result.js'
import type { RandomBytes } from './rng.js'

const HALF_ORDER = CURVE_ORDER >> 1n

/** Bytes of the committed nonce payload. */
export function payloadBytes(locked: boolean): number {
  return locked ? 4 * POINT_BYTES : POINT_BYTES
}

/** Bytes of the proof sent with the opening. */
export function proofBytes(locked: boolean): number {
  return locked ? DLEQ_PROOF_BYTES : 0
}

/** Bytes of the response sent with (u, w). */
export function responseBytes(locked: boolean): number {
  return locked ? SCALAR_BYTES : 0
}

export interface NonceShare {
  /** SECRET nonce share k_i. */
  readonly k: bigint
  /** SECRET proof nonce a_i; null for plain signing. */
  readonly a: bigint | null
  /** What the party commits to and later opens. */
  readonly payload: Uint8Array
}

/** Draws a nonce share and builds the payload to commit to. */
export function drawNonceShare(
  rng: RandomBytes,
  lockPoint: Uint8Array | null,
  context: Uint8Array,
  ...secrets: readonly Uint8Array[]
): NonceShare {
  const k = hedgedScalar(rng, 'sign/nonce', context, ...secrets)
  const plain = pointBytes(multiply(G, k))
  if (lockPoint === null) return { k, a: null, payload: plain }
  const lock = parsePoint(lockPoint)
  const a = hedgedScalar(rng, 'presign/joint-proof-nonce', context, ...secrets)
  return {
    k,
    a,
    payload: concat(
      plain,
      pointBytes(multiply(lock, k)),
      pointBytes(multiply(G, a)),
      pointBytes(multiply(lock, a)),
    ),
  }
}

/** The proof a party sends when it opens its nonce commitment. */
export function proveNonceShare(
  rng: RandomBytes,
  lockPoint: Uint8Array | null,
  binding: Uint8Array,
  proverId: Uint8Array,
  k: bigint,
  payload: Uint8Array,
): Uint8Array {
  if (lockPoint === null) return new Uint8Array(0)
  return proveDleq(
    rng,
    binding,
    proverId,
    k,
    parsePoint(lockPoint),
    parsePoint(payload.subarray(0, POINT_BYTES)),
    parsePoint(payload.subarray(POINT_BYTES, 2 * POINT_BYTES)),
  )
}

export interface OpenedNonce {
  /** R_i = k_i * G. */
  readonly plain: Point
  /** K_i = k_i * L. */
  readonly locked: Point | null
  /** A_i = a_i * G. */
  readonly announce: Point | null
  /** A'_i = a_i * L. */
  readonly announceLocked: Point | null
}

/**
 * Parses an opened payload. With `proof` given (the peer's payload) the
 * equality proof is verified; a party's own payload is parsed without one.
 */
export function openNonceShare(
  lockPoint: Uint8Array | null,
  payload: Uint8Array,
  peer?: {
    readonly binding: Uint8Array
    readonly proverId: Uint8Array
    readonly proof: Uint8Array
  },
): OpenedNonce {
  const locked = lockPoint !== null
  if (payload.length !== payloadBytes(locked)) fail('malformed-message')
  const reader = new Reader(payload)
  const plain = parsePoint(reader.take(POINT_BYTES))
  if (lockPoint === null) {
    reader.finish()
    return { plain, locked: null, announce: null, announceLocked: null }
  }
  const onLock = parsePoint(reader.take(POINT_BYTES))
  const announce = parsePoint(reader.take(POINT_BYTES))
  const announceLocked = parsePoint(reader.take(POINT_BYTES))
  reader.finish()
  if (peer !== undefined) {
    requireDleqProof(
      peer.binding,
      peer.proverId,
      parsePoint(lockPoint),
      plain,
      onLock,
      peer.proof,
    )
  }
  return { plain, locked: onLock, announce, announceLocked }
}

export interface JointNonce {
  /** R_a = R_I + R_R = k*G. */
  readonly plain: Point
  /** R = k*L; null for plain signing. */
  readonly locked: Point | null
  /** The r of the signature: x of `locked` if present, else of `plain`. */
  readonly r: bigint
  /** The joint proof challenge b; null for plain signing. */
  readonly challenge: bigint | null
}

function sum(left: Point, right: Point): Point {
  const total = left.add(right)
  try {
    total.assertValidity()
  } catch {
    return fail('invalid-point')
  }
  return total
}

/**
 * The challenge of `@frank/adaptor-signatures`' equality proof
 * (`dleq.ts`, not exported there): H_DLEQ(X, Y, Z, A_G, A_Y) with X = R_a,
 * Y = L, Z = R. The final check with that package's verifier fails if this
 * ever differs from it.
 */
function jointChallenge(
  plain: Point,
  lock: Point,
  locked: Point,
  announce: Point,
  announceLocked: Point,
): bigint {
  return hashToScalar(
    taggedHash(
      'DLEQ',
      pointBytes(plain),
      pointBytes(lock),
      pointBytes(locked),
      pointBytes(announce),
      pointBytes(announceLocked),
    ),
  )
}

/** Combines both opened nonce shares. The order of the arguments is irrelevant. */
export function jointNonce(
  lockPoint: Uint8Array | null,
  one: OpenedNonce,
  two: OpenedNonce,
): JointNonce {
  const plain = sum(one.plain, two.plain)
  if (lockPoint === null) {
    const x = plain.toAffine().x
    // r must be the x coordinate itself for the recovery bit to be 0 or 1.
    if (x === 0n || x >= CURVE_ORDER) fail('invalid-signature')
    return { plain, locked: null, r: x, challenge: null }
  }
  if (
    one.locked === null ||
    two.locked === null ||
    one.announce === null ||
    two.announce === null ||
    one.announceLocked === null ||
    two.announceLocked === null
  ) {
    return fail('internal-error')
  }
  const locked = sum(one.locked, two.locked)
  const r = locked.toAffine().x % CURVE_ORDER
  if (r === 0n) fail('invalid-signature')
  const challenge = jointChallenge(
    plain,
    parsePoint(lockPoint),
    locked,
    sum(one.announce, two.announce),
    sum(one.announceLocked, two.announceLocked),
  )
  if (challenge === 0n) fail('invalid-signature')
  return { plain, locked, r, challenge }
}

/** z_i = a_i + b * k_i, or nothing for plain signing. */
export function nonceResponse(
  joint: JointNonce,
  a: bigint | null,
  k: bigint,
): Uint8Array {
  if (joint.challenge === null || a === null) return new Uint8Array(0)
  return scalarBytes(modAdd(a, modMul(joint.challenge, k)))
}

export type SignResult =
  | {
      readonly kind: 'signature'
      /** r (32) || s (32), low-s. */
      readonly signature: Uint8Array
      /** EIP-1559 yParity. */
      readonly recovery: 0 | 1
    }
  | {
      readonly kind: 'adaptor-signature'
      /** 162 bytes, the encoding of `@frank/adaptor-signatures`. */
      readonly adaptorSignature: Uint8Array
    }

/**
 * Builds the output from s = w / u and verifies it against the joint key.
 * Fails with `invalid-signature` when it does not verify.
 */
export function finish(input: {
  readonly lockPoint: Uint8Array | null
  readonly publicKey: Uint8Array
  readonly digest: Uint8Array
  readonly joint: JointNonce
  readonly s: bigint
  /** z_I and z_R; empty for plain signing. */
  readonly responses: readonly Uint8Array[]
}): SignResult {
  const { joint, s } = input
  if (s === 0n) fail('invalid-signature')
  if (input.lockPoint === null || joint.locked === null) {
    const high = s > HALF_ORDER
    const signature = concat(
      scalarBytes(joint.r),
      scalarBytes(high ? CURVE_ORDER - s : s),
    )
    let valid = false
    try {
      valid = secp256k1.verify(signature, input.digest, input.publicKey, {
        prehash: false,
        lowS: true,
      })
    } catch {
      valid = false
    }
    if (!valid) fail('invalid-signature')
    const odd = (joint.plain.toAffine().y & 1n) === 1n
    return {
      kind: 'signature',
      signature,
      recovery: (odd !== high ? 1 : 0) as 0 | 1,
    }
  }
  let c = 0n
  for (const response of input.responses) {
    if (response.length !== SCALAR_BYTES) fail('malformed-message')
    let value = 0n
    for (const byte of response) value = (value << 8n) | BigInt(byte)
    if (value >= CURVE_ORDER) fail('out-of-range')
    c = modAdd(c, value)
  }
  const pre = {
    R: joint.locked,
    Ra: joint.plain,
    sa: s,
    proof: { b: joint.challenge ?? 0n, c },
  }
  const lock = parsePoint(input.lockPoint)
  let valid = false
  try {
    valid = verifyEncryptedSignature(
      parsePoint(input.publicKey),
      lock,
      input.digest,
      pre,
    )
  } catch {
    valid = false
  }
  if (!valid) fail('invalid-signature')
  // Encoding is only reached for a verified pre-signature.
  void encodePoint
  return { kind: 'adaptor-signature', adaptorSignature: encodeAdaptorSignature(pre) }
}
