import { sha256 } from '@frank/crypto-box'
import {
  bigintToBytes,
  bytesToBigint,
  ecdh,
  mod,
  privateKeyFromHex,
  privateKeyFromSecretBytes,
  publicFromPrivate,
  tweakAddPrivateKey,
  tweakAddPublicKey,
} from '@frank/nakamoto'

/** secp256k1 group order. */
export const SECP_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
)

type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string } }

export function must<T>(result: Checked<T>): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

/** 32-byte big-endian `bytes mod n`. */
export function reduced32(bytes: Uint8Array): Buffer {
  const reduced = must(mod(bytesToBigint(Uint8Array.from(bytes)), SECP_N))
  return Buffer.from(must(bigintToBytes(reduced, 32)))
}

/** `(secret + tweak) mod n` with `tweak` already in (0, n). A zero sum throws. */
export function addedSecret(secret: Uint8Array, tweak: Uint8Array): Buffer {
  const key = must(privateKeyFromSecretBytes(Uint8Array.from(secret), true))
  try {
    const added = must(tweakAddPrivateKey(key, Uint8Array.from(tweak)))
    const out = Buffer.from(added.bytes)
    added.bytes.fill(0)
    return out
  } finally {
    key.bytes.fill(0)
  }
}

/** Reduce `tweak` mod n first. A zero tweak returns `secret`. A zero sum throws. */
export function addedSecretMod(secret: Uint8Array, tweak: Uint8Array): Buffer {
  const reduced = reduced32(tweak)
  if (reduced.equals(Buffer.alloc(32))) return Buffer.from(secret)
  return addedSecret(secret, reduced)
}

/** `point + tweak·G`, compressed. */
export function addedPoint(point: Uint8Array, tweak: Uint8Array): Buffer {
  return Buffer.from(
    must(tweakAddPublicKey(Uint8Array.from(point), Uint8Array.from(tweak))),
  )
}

/** Compressed ECDH point of `secretHex` times `point`. */
export function sharedPoint(secretHex: string, point: Uint8Array): Buffer {
  const key = must(privateKeyFromHex(secretHex, true))
  try {
    return Buffer.from(must(ecdh(key, Uint8Array.from(point))).point)
  } finally {
    key.bytes.fill(0)
  }
}

/** SEC1 point of a 32-byte secret. */
export function pointOf(secret: Uint8Array, compressed = true): Buffer {
  const key = must(
    privateKeyFromSecretBytes(Uint8Array.from(secret), compressed),
  )
  try {
    const derived = must(publicFromPrivate(key))
    const bytes = compressed ? derived.compressed : derived.uncompressed
    return Buffer.from(bytes)
  } finally {
    key.bytes.fill(0)
  }
}

export function digestSha256(data: Uint8Array): Buffer {
  return Buffer.from(sha256(Uint8Array.from(data)))
}

/** SEC1 point wrapper. `toBuffer()` returns a copy. */
export function pointKey(bytes: Uint8Array) {
  const point = Buffer.from(bytes)
  return {
    toBuffer(): Uint8Array {
      return Buffer.from(point)
    },
  }
}

/** `{ toBuffer, toPublicKey, compressed }` for a hex scalar. */
export function secretKey(hex: string, compressed = true) {
  const secret = Buffer.from(hex.toLowerCase(), 'hex')
  const point = pointOf(secret, compressed)
  return {
    compressed,
    toBuffer(): Uint8Array {
      return Buffer.from(secret)
    },
    toPublicKey() {
      return {
        toBuffer(): Uint8Array {
          return Buffer.from(point)
        },
      }
    },
  }
}
