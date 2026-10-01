import {
  ecdh,
  privateKeyFromSecretBytes,
  tweakAddPrivateKey,
} from '@frank/nakamoto'

import { stealthPointDigest } from './stealth-point-digest'

/** secp256k1 n. A SHA-256 digest is below 2n, so one subtraction reduces it. */
const SECP256K1_N = Uint8Array.from([
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2,
  0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
])

function compareUnsigned(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function isZero(bytes: Uint8Array): boolean {
  let acc = 0
  for (const byte of bytes) acc |= byte
  return acc === 0
}

/** 32-byte big-endian digest mod n. Matches bitcore `BN.fromBuffer(d).mod(n)`. */
export function stealthDigestModN(digest: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(digest)
  if (bytes.length !== 32) throw new Error('stealth-parent:digest')
  if (compareUnsigned(bytes, SECP256K1_N) < 0) return bytes
  const reduced = new Uint8Array(32)
  let borrow = 0
  for (let index = 31; index >= 0; index -= 1) {
    const diff = (bytes[index] ?? 0) - (SECP256K1_N[index] ?? 0) - borrow
    if (diff < 0) {
      reduced[index] = diff + 256
      borrow = 1
    } else {
      reduced[index] = diff
      borrow = 0
    }
  }
  return reduced
}

/** `(digest + destination) mod n`. A digest >= n is reduced first
 * (decision #559). A reduced digest of 0 yields the destination. A zero
 * sum is an error. The caller wraps the secret in a bitcore PrivateKey. */
export function stealthParentScalar(
  destinationSecret: Uint8Array,
  digest: Uint8Array,
): Uint8Array {
  const secretBytes = Uint8Array.from(destinationSecret)
  let reduced: Uint8Array
  try {
    reduced = stealthDigestModN(digest)
  } catch (error) {
    secretBytes.fill(0)
    throw error
  }
  const key = privateKeyFromSecretBytes(secretBytes, true)
  secretBytes.fill(0)
  if (!key.ok) {
    reduced.fill(0)
    throw new Error(`stealth-parent:${key.error.code}`)
  }
  if (isZero(reduced)) {
    const derived = Uint8Array.from(key.value.bytes)
    key.value.bytes.fill(0)
    return derived
  }
  const added = tweakAddPrivateKey(key.value, reduced)
  key.value.bytes.fill(0)
  reduced.fill(0)
  if (!added.ok) throw new Error(`stealth-parent:${added.error.code}`)
  const derived = Uint8Array.from(added.value.bytes)
  added.value.bytes.fill(0)
  return derived
}

/** Stealth parent secret `(H(ebG) + destination) mod n` (decision #559).
 * ebG is `ecdh` of the destination secret and the ephemeral public point.
 * H is `stealthPointDigest`. The returned digest is
 * the raw hash, not the reduced scalar. A secret outside (0, n), a public
 * key that is not 33 or 65 SEC1 bytes, an invalid point, or a zero sum is
 * an error. The caller's secret is not wiped. Stealth public addition
 * stays on bitcore. */
export function stealthParentSecret(
  destinationSecret: Uint8Array,
  ephemeralPublicKey: Uint8Array,
): { secret: Uint8Array; digest: Uint8Array } {
  const secretBytes = Uint8Array.from(destinationSecret)
  const point = Uint8Array.from(ephemeralPublicKey)
  const key = privateKeyFromSecretBytes(secretBytes, true)
  secretBytes.fill(0)
  if (!key.ok) throw new Error(`stealth-parent:${key.error.code}`)
  try {
    if (point.length !== 33 && point.length !== 65) {
      throw new Error('stealth-parent:public-key')
    }
    const shared = ecdh(key.value, point)
    if (!shared.ok) throw new Error(`stealth-parent:${shared.error.code}`)
    const digest = Uint8Array.from(stealthPointDigest(shared.value.point))
    const secret = stealthParentScalar(destinationSecret, digest)
    return { secret, digest }
  } finally {
    key.value.bytes.fill(0)
  }
}
