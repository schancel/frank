import { RistrettoPoint } from '@noble/curves/ed25519'
import { hmac } from '@noble/hashes/hmac.js'
import { sha512 } from '@noble/hashes/sha512.js'
import { concatBytes, randomBytes } from '@noble/hashes/utils.js'

/**
 * CPace balanced PAKE, cipher suite CPACE-RISTR255-SHA512, as specified in
 * draft-irtf-cfrg-cpace-21 (sections 7, 8.1, 8.3 and 10.4). Two parties who
 * share a low-entropy password (PRS) agree on a strong key ISK. A passive
 * observer learns nothing to test passwords against offline; an active attacker
 * tests one password per session. cpace.jest.test.ts checks this module against
 * the draft's test vectors (appendix B.3).
 *
 * Key confirmation follows section 10.4: mac_key = H(b"CPaceMac" || sid || ISK),
 * Ta = HMAC(mac_key, lv_cat(Ya, ADa)), Tb = HMAC(mac_key, lv_cat(Yb, ADb)).
 */

const DSI = new TextEncoder().encode('CPaceRistretto255')
const DSI_ISK = new TextEncoder().encode('CPaceRistretto255_ISK')
const MAC_DSI = new TextEncoder().encode('CPaceMac')
/** SHA-512 input block size (H.s_in_bytes). */
const SHA512_BLOCK_BYTES = 128

/** LEB128 length followed by the bytes (draft appendix A.1.1). */
export function prependLen(data: Uint8Array): Uint8Array {
  const len: number[] = []
  let n = data.length
  do {
    let byte = n & 0x7f
    n >>>= 7
    if (n > 0) byte |= 0x80
    len.push(byte)
  } while (n > 0)
  return concatBytes(Uint8Array.from(len), data)
}

export function lvCat(...parts: Uint8Array[]): Uint8Array {
  return concatBytes(...parts.map(prependLen))
}

export function generatorString(
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
): Uint8Array {
  const zpad = Math.max(
    0,
    SHA512_BLOCK_BYTES - prependLen(prs).length - prependLen(DSI).length - 1,
  )
  return lvCat(DSI, prs, new Uint8Array(zpad), ci, sid)
}

type Point = InstanceType<typeof RistrettoPoint>

export function calculateGenerator(
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
): Point {
  return RistrettoPoint.hashToCurve(sha512(generatorString(prs, ci, sid)))
}

function scalarFromLittleEndian(bytes: Uint8Array): bigint {
  let value = BigInt(0)
  for (let i = bytes.length - 1; i >= 0; i--) {
    value = (value << BigInt(8)) | BigInt(bytes[i])
  }
  return value
}

/** 32 random bytes with the bits above 252 cleared, little-endian (section 8.3). */
export function sampleScalar(): Uint8Array {
  const scalar = randomBytes(32)
  scalar[31] &= 0x0f
  return scalar
}

/** encode(y * g). */
export function scalarMult(y: Uint8Array, g: Point): Uint8Array {
  return g.multiply(scalarFromLittleEndian(y)).toRawBytes()
}

/**
 * encode(y * decode(X)), or null where the draft returns the identity: X does
 * not decode, or decodes to the identity. A party MUST abort on null.
 */
export function scalarMultVfy(y: Uint8Array, X: Uint8Array): Uint8Array | null {
  let point: Point
  try {
    point = RistrettoPoint.fromHex(X)
  } catch {
    return null
  }
  if (point.equals(RistrettoPoint.ZERO)) return null
  const K = point.multiply(scalarFromLittleEndian(y))
  return K.equals(RistrettoPoint.ZERO) ? null : K.toRawBytes()
}

/** transcript_ir: A is the initiator, B the responder. */
export function transcriptIr(
  Ya: Uint8Array,
  ADa: Uint8Array,
  Yb: Uint8Array,
  ADb: Uint8Array,
): Uint8Array {
  return concatBytes(lvCat(Ya, ADa), lvCat(Yb, ADb))
}

export function deriveIsk(
  sid: Uint8Array,
  K: Uint8Array,
  Ya: Uint8Array,
  ADa: Uint8Array,
  Yb: Uint8Array,
  ADb: Uint8Array,
): Uint8Array {
  return sha512(
    concatBytes(lvCat(DSI_ISK, sid, K), transcriptIr(Ya, ADa, Yb, ADb)),
  )
}

/** Key-confirmation tag over the message a party sent: HMAC(mac_key, lv_cat(Y, AD)). */
export function confirmationTag(
  sid: Uint8Array,
  isk: Uint8Array,
  Y: Uint8Array,
  AD: Uint8Array,
): Uint8Array {
  const macKey = sha512(concatBytes(MAC_DSI, sid, isk))
  return hmac(sha512, macKey, lvCat(Y, AD))
}

/** Constant-time byte comparison. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
