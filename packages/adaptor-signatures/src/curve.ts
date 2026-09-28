/**
 * Shared secp256k1 scalar/point helpers used by the DLEQ proof, the Schnorr proof-of-knowledge,
 * and the ECDSA adaptor signature scheme itself.
 *
 * Uses @noble/curves (audited, widely-used, minimal-dependency) rather than this monorepo's
 * existing `elliptic`-based `bitcore-lib-xpi` dependency: @noble/curves ships first-class
 * TypeScript types for the exact primitives this module needs (a scalar field object with
 * constant-time inversion, typed Weierstrass points), constant-time scalar operations, and no
 * separate BN.js-style big-number dependency to keep in sync. `elliptic` would work too (Frank
 * already trusts it, via bitcore-lib-xpi), but its API is untyped JS and its `BN` reduction
 * helpers are more awkward to use safely from TypeScript for the modular arithmetic this
 * construction leans on heavily.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import type { WeierstrassPoint } from '@noble/curves/abstract/weierstrass.js'
import { bytesToNumberBE, numberToBytesBE, concatBytes, randomBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'

/** A secp256k1 curve point (affine coordinates are plain bigints). */
export type Point = WeierstrassPoint<bigint>

/** The secp256k1 base point / generator. */
export const G: Point = secp256k1.Point.BASE

/** The secp256k1 group order (a 256-bit prime). */
export const CURVE_ORDER: bigint = secp256k1.Point.Fn.ORDER

const n = CURVE_ORDER

/** Reduce an arbitrary (possibly negative) bigint into the canonical [0, n) scalar range. */
export function mod(x: bigint): bigint {
  const r = x % n
  return r >= 0n ? r : r + n
}

export function modAdd(a: bigint, b: bigint): bigint {
  return mod(a + b)
}

export function modSub(a: bigint, b: bigint): bigint {
  return mod(a - b)
}

export function modMul(a: bigint, b: bigint): bigint {
  return mod(a * b)
}

/** Modular inverse of `x` mod the curve order. Delegates to @noble/curves' scalar field. */
export function modInv(x: bigint): bigint {
  const reduced = mod(x)
  if (reduced === 0n) {
    throw new Error('cannot invert zero scalar')
  }
  return secp256k1.Point.Fn.inv(reduced)
}

/** Negate a scalar mod n. */
export function modNeg(x: bigint): bigint {
  return modSub(0n, x)
}

/**
 * A cryptographically random scalar in [1, n-1], suitable for use as a private key, a tweak
 * secret, or (when combined with additional context via `sampleNonce`) a nonce.
 */
export function randomScalar(): bigint {
  return bytesToNumberBE(secp256k1.utils.randomSecretKey())
}

/** Encode a point as 33-byte compressed SEC1 bytes. */
export function pointBytes(p: Point): Uint8Array {
  return p.toBytes(true)
}

/** Encode a scalar as 32-byte big-endian bytes. */
export function scalarBytes(x: bigint): Uint8Array {
  return numberToBytesBE(mod(x), 32)
}

/** Reduce a 32-byte hash digest into a scalar mod n, per the usual ECDSA `bits2int` convention. */
export function hashToScalar(hash: Uint8Array): bigint {
  return mod(bytesToNumberBE(hash))
}

/**
 * Domain-separated tagged hash used to build Fiat-Shamir challenges and nonces, following the
 * "tag || tag || data" convention from BIP340 / the dlcspecs ECDSA-adaptor.md spec. Using a
 * distinct tag per protocol/purpose keeps the DLEQ proof's hash, the proof-of-knowledge's hash,
 * and nonce generation from colliding with each other even if used with identical inputs.
 */
export function taggedHash(tag: string, ...parts: Uint8Array[]): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag))
  return sha256(concatBytes(tagHash, tagHash, ...parts))
}

/**
 * Generate a nonce scalar for a signing/proving operation. Per the dlcspecs spec's "Secure Nonce
 * Generation" section, this is *not* purely deterministic (unlike RFC6979): it hashes the
 * supplied context together with fresh system randomness, so a broken or predictable RNG can
 * degrade nonce quality but cannot make nonces deterministic/replayable across calls, and a
 * transient RNG failure can't cause catastrophic nonce reuse the way a naive `Math.random()`-only
 * scheme could.
 */
export function sampleNonce(tag: string, ...parts: Uint8Array[]): bigint {
  const fresh = randomBytes(32)
  const digest = taggedHash(tag, fresh, ...parts)
  const k = hashToScalar(digest)
  // Negligible-probability (~1/2^256) guard against a zero nonce, which would be unusable.
  return k === 0n ? 1n : k
}
