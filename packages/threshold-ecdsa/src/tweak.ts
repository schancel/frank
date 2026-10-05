/**
 * State-committed key tweak.
 *
 *   h  = SHA256(SHA256(tag) || SHA256(tag) || P || commitment) mod n
 *   P' = P + h * G
 *
 * with `tag = "FRANK-TECDSA-V1/tweak"`, `P` the 33-byte compressed joint key
 * and `commitment` 32 bytes. The tweak `h` is public: anyone who knows `P`
 * and the commitment can compute `P'`.
 *
 * The private key behind `P'` is `x_A * x_B + h`. With multiplicative shares
 * neither party can fold `h` into its own share (that would need `h / x_B`),
 * so no share changes. Instead the signing protocol adds `r * h` to the
 * message term inside the Paillier computation; see `sign.ts`.
 */
import {
  hashToScalar,
  taggedHash,
} from '@frank/adaptor-signatures/src/curve.js'

import { snapshot } from './bytes.js'
import {
  G,
  multiply,
  parsePoint,
  pointBytes,
  scalarBytes,
  TAG_PREFIX,
  type Point,
} from './group.js'
import { addressOfPoint } from './key-share.js'
import {
  fail,
  failure,
  failureCode,
  success,
  type ThresholdResult,
} from './result.js'

export interface TweakedKey {
  /** 33-byte compressed tweaked public key `P'`. */
  readonly publicKey: Uint8Array
  /** 20-byte EVM address of `P'`. */
  readonly address: Uint8Array
  /** The public tweak scalar `h`, 32 bytes big-endian. */
  readonly tweak: Uint8Array
}

export function computeTweak(
  publicKey: Uint8Array,
  commitment: Uint8Array,
): { readonly tweak: bigint; readonly point: Point } {
  const base = parsePoint(publicKey)
  const tweak = hashToScalar(
    taggedHash(`${TAG_PREFIX}tweak`, publicKey, commitment),
  )
  // Probability 2^-256 each; refusing keeps every later scalar nonzero.
  if (tweak === 0n) fail('invalid-input')
  const point = base.add(multiply(G, tweak))
  try {
    point.assertValidity()
  } catch {
    return fail('invalid-input')
  }
  return { tweak, point }
}

/**
 * Derives the tweaked key and its EVM address from a joint public key and a
 * 32-byte commitment. Pass the same commitment to `startSign` to sign for it.
 */
export function tweakPublicKey(
  publicKey: Uint8Array,
  commitment: Uint8Array,
): ThresholdResult<TweakedKey> {
  const key = snapshot(publicKey, 33)
  const committed = snapshot(commitment, 32)
  if (key === null || committed === null) return failure('invalid-input')
  try {
    const { tweak, point } = computeTweak(key, committed)
    const tweaked = pointBytes(point)
    return success({
      publicKey: tweaked,
      address: addressOfPoint(tweaked),
      tweak: scalarBytes(tweak),
    })
  } catch (error) {
    return failure(failureCode(error))
  }
}
