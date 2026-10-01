// Jacobian point math for script verification and BIP32 child points.
// The selectable hash and secp backend lives in src/backend.
// This file does not sign. ECDSA, Schnorr, ECDH, and BIP-374 live in curve.ts.
// Not a package dependency. p = 2^256 - 2^32 - 977. a = 0, b = 7.

import { bigintToBytes, bytesToBigint } from './integer.js'

export const SECP256K1_P =
  0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn

export const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

const B = 7n
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n

export interface AffinePoint {
  readonly x: bigint
  readonly y: bigint
}

interface Jacobian {
  readonly x: bigint
  readonly y: bigint
  readonly z: bigint
}

export function isValidScalar(value: bigint): boolean {
  return value > 0n && value < SECP256K1_N
}

function modP(value: bigint): bigint {
  const remainder = value % SECP256K1_P
  return remainder >= 0n ? remainder : remainder + SECP256K1_P
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let factor = base % modulus
  if (factor < 0n) factor += modulus
  let bits = exponent
  while (bits > 0n) {
    if ((bits & 1n) === 1n) result = (result * factor) % modulus
    factor = (factor * factor) % modulus
    bits >>= 1n
  }
  return result
}

function onCurve(x: bigint, y: bigint): boolean {
  return modP(y * y) === modP(modP(x * x) * x + B)
}

function doubleJac(point: Jacobian): Jacobian {
  const a = modP(point.x * point.x)
  const b = modP(point.y * point.y)
  const c = modP(b * b)
  const xPlusB = modP(point.x + b)
  const d = modP(2n * (modP(xPlusB * xPlusB) - a - c))
  const e = modP(3n * a)
  const f = modP(e * e)
  const x3 = modP(f - 2n * d)
  const y3 = modP(e * (d - x3) - 8n * c)
  const z3 = modP(2n * point.y * point.z)
  return { x: x3, y: y3, z: z3 }
}

/** Returns null when the sum is the point at infinity. */
function addJac(left: Jacobian, right: Jacobian): Jacobian | null {
  if (left.z === 0n) return right
  if (right.z === 0n) return left
  const z1z1 = modP(left.z * left.z)
  const z2z2 = modP(right.z * right.z)
  const u1 = modP(left.x * z2z2)
  const u2 = modP(right.x * z1z1)
  const s1 = modP(left.y * right.z * z2z2)
  const s2 = modP(right.y * left.z * z1z1)
  const h = modP(u2 - u1)
  const r = modP(2n * (s2 - s1))
  if (h === 0n) {
    if (r === 0n) return doubleJac(left)
    return null
  }
  const hh = modP(h * h)
  const i = modP(4n * hh)
  const j = modP(h * i)
  const v = modP(u1 * i)
  const x3 = modP(r * r - j - 2n * v)
  const y3 = modP(r * (v - x3) - 2n * s1 * j)
  const zSum = modP(left.z + right.z)
  const z3 = modP((modP(zSum * zSum) - z1z1 - z2z2) * h)
  return { x: x3, y: y3, z: z3 }
}

function toAffine(point: Jacobian): AffinePoint | null {
  if (point.z === 0n) return null
  const inverse = modPow(point.z, SECP256K1_P - 2n, SECP256K1_P)
  const inverse2 = modP(inverse * inverse)
  const x = modP(point.x * inverse2)
  const y = modP(point.y * inverse2 * inverse)
  if (!onCurve(x, y)) return null
  return { x, y }
}

/** Scalar must be in [1, n). Returns null otherwise, or if the point is infinity. */
export function multiplyGenerator(scalar: bigint): AffinePoint | null {
  if (!isValidScalar(scalar)) return null
  let acc: Jacobian | null = null
  let base: Jacobian = { x: GX, y: GY, z: 1n }
  let bits = scalar
  while (bits > 0n) {
    if ((bits & 1n) === 1n) {
      acc = acc === null ? base : addJac(acc, base)
      if (acc === null) return null
    }
    base = doubleJac(base)
    bits >>= 1n
  }
  if (acc === null) return null
  return toAffine(acc)
}

function coordinate(value: bigint, length: number): Uint8Array | null {
  const encoded = bigintToBytes(value, length)
  return encoded.ok ? encoded.value : null
}

export function compressPoint(point: AffinePoint): Uint8Array | null {
  const x = coordinate(point.x, 32)
  if (x === null) return null
  const out = new Uint8Array(33)
  out[0] = point.y % 2n === 0n ? 0x02 : 0x03
  out.set(x, 1)
  return out
}

export function uncompressPoint(point: AffinePoint): Uint8Array | null {
  const x = coordinate(point.x, 32)
  const y = coordinate(point.y, 32)
  if (x === null || y === null) return null
  const out = new Uint8Array(65)
  out[0] = 0x04
  out.set(x, 1)
  out.set(y, 33)
  return out
}

export function xOnlyPoint(point: AffinePoint): Uint8Array | null {
  return coordinate(point.x, 32)
}

function sqrtMod(value: bigint): bigint | null {
  const reduced = modP(value)
  if (reduced === 0n) return 0n
  const root = modPow(reduced, (SECP256K1_P + 1n) / 4n, SECP256K1_P)
  if (modP(root * root) !== reduced) return null
  return root
}

/** Compressed SEC1 point, or null when the bytes are not on the curve. */
export function compressedPointFromBytes(
  bytes: Uint8Array,
): AffinePoint | null {
  if (bytes.length !== 33) return null
  const prefix = bytes[0]
  if (prefix !== 0x02 && prefix !== 0x03) return null
  const x = bytesToBigint(bytes.subarray(1))
  if (x >= SECP256K1_P) return null
  const root = sqrtMod(modP(modP(x * x) * x + B))
  if (root === null) return null
  const even = root % 2n === 0n
  const y = (prefix === 0x02) === even ? root : modP(SECP256K1_P - root)
  if (!onCurve(x, y)) return null
  return { x, y }
}

/** Scalar must be in [1, n). Null at 0, out of range, or infinity. */
export function multiplyPoint(
  point: AffinePoint,
  scalar: bigint,
): AffinePoint | null {
  if (scalar <= 0n || scalar >= SECP256K1_N) return null
  if (!onCurve(point.x, point.y)) return null
  let acc: Jacobian | null = null
  let base: Jacobian = { x: point.x, y: point.y, z: 1n }
  let bits = scalar
  while (bits > 0n) {
    if ((bits & 1n) === 1n) {
      acc = acc === null ? base : addJac(acc, base)
      if (acc === null) return null
    }
    base = doubleJac(base)
    bits >>= 1n
  }
  if (acc === null) return null
  return toAffine(acc)
}

/** Null when either point is off-curve or the sum is infinity. */
export function addPoints(
  left: AffinePoint,
  right: AffinePoint,
): AffinePoint | null {
  if (!onCurve(left.x, left.y) || !onCurve(right.x, right.y)) return null
  const sum = addJac(
    { x: left.x, y: left.y, z: 1n },
    { x: right.x, y: right.y, z: 1n },
  )
  if (sum === null) return null
  return toAffine(sum)
}

/** Compressed 33-byte or uncompressed 65-byte SEC1 point. Hybrid is rejected. */
export function pointFromPublicKey(bytes: Uint8Array): AffinePoint | null {
  if (bytes.length === 33) return compressedPointFromBytes(bytes)
  if (bytes.length !== 65 || bytes[0] !== 0x04) return null
  const x = bytesToBigint(bytes.subarray(1, 33))
  const y = bytesToBigint(bytes.subarray(33))
  if (x >= SECP256K1_P || y >= SECP256K1_P) return null
  if (!onCurve(x, y)) return null
  return { x, y }
}

/**
 * BIP32 public child point: scalar*G + parent. Null when the scalar is
 * outside [1, n), the parent is not a compressed curve point, or the sum
 * is infinity. The taproot tweak is not applied here.
 */
export function addScalarToPublicKey(
  parent: Uint8Array,
  scalar: bigint,
): Uint8Array | null {
  if (!isValidScalar(scalar)) return null
  const point = compressedPointFromBytes(parent)
  const added = multiplyGenerator(scalar)
  if (point === null || added === null) return null
  const sum = addJac(
    { x: point.x, y: point.y, z: 1n },
    { x: added.x, y: added.y, z: 1n },
  )
  if (sum === null) return null
  const affine = toAffine(sum)
  if (affine === null) return null
  return compressPoint(affine)
}
