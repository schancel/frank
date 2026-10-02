// One signing interface. ECDSA and Schnorr private keys, and a 32-byte
// secret that can present its own point, all map onto SigningKey.
// sign(digest) is the only operation. The caller computed the digest.

import { isPlainBytes } from './bytes.js'
import type { PrivateKey } from './constructors.js'
import { signEcdsa, signSchnorr } from './curve.js'
import {
  privateKeyFromSecretBytes,
  publicFromPrivate,
  type KeyFailure,
  type KeyResult,
} from './keys.js'

/** Signs a 32-byte digest. ECDSA returns strict-DER low-S. Schnorr returns
 * 64-byte BIP340. `publicKey` is the SEC1 point for ECDSA and the 32-byte
 * x-only point for Schnorr. */
export interface SigningKey {
  readonly publicKey: Uint8Array
  sign(digest: Uint8Array): Uint8Array
}

/** Keys this package can sign with. */
export interface SigningKeyMap {
  readonly ecdsa: PrivateKey
  readonly schnorr: {
    readonly key: PrivateKey
    readonly aux: Uint8Array
  }
  readonly secret: {
    toBuffer(): Uint8Array
    toPublicKey?: () => { toBuffer(): Uint8Array }
    readonly compressed?: boolean
  }
}

function fail<T>(error: KeyFailure): KeyResult<T> {
  return { ok: false, error }
}

function ecdsaPoint(key: PrivateKey): KeyResult<Uint8Array> {
  const point = publicFromPrivate(key)
  if (!point.ok) return point
  const bytes = key.compressed
    ? point.value.compressed
    : point.value.uncompressed
  return { ok: true, value: Uint8Array.from(bytes) }
}

function ownedKey(key: PrivateKey): KeyResult<PrivateKey> {
  return privateKeyFromSecretBytes(key.bytes, key.compressed)
}

function ecdsaSigner(key: PrivateKey, publicKey: Uint8Array): SigningKey {
  return Object.freeze({
    publicKey,
    sign(digest: Uint8Array): Uint8Array {
      const signed = signEcdsa(key, digest)
      if (!signed.ok) throw new Error(signed.error.code)
      return Uint8Array.from(signed.value)
    },
  })
}

function fromPrivate(
  key: PrivateKey,
  publicKey: KeyResult<Uint8Array>,
): KeyResult<SigningKey> {
  if (!publicKey.ok) {
    key.bytes.fill(0)
    return publicKey
  }
  return { ok: true, value: ecdsaSigner(key, publicKey.value) }
}

function ecdsaKey(source: PrivateKey): KeyResult<SigningKey> {
  const key = ownedKey(source)
  if (!key.ok) return key
  return fromPrivate(key.value, ecdsaPoint(key.value))
}

function schnorrKey(source: SigningKeyMap['schnorr']): KeyResult<SigningKey> {
  if (!isPlainBytes(source.aux)) return fail({ code: 'bytes-expected' })
  if (source.aux.length !== 32) {
    return fail({
      code: 'wrong-length',
      min: 32,
      max: 32,
      actual: source.aux.length,
    })
  }
  const aux = Uint8Array.from(source.aux)
  const key = ownedKey(source.key)
  if (!key.ok) {
    aux.fill(0)
    return key
  }
  const point = publicFromPrivate(key.value)
  if (!point.ok) {
    key.value.bytes.fill(0)
    aux.fill(0)
    return point
  }
  const publicKey = Uint8Array.from(point.value.xOnly)
  return {
    ok: true,
    value: Object.freeze({
      publicKey,
      sign(digest: Uint8Array): Uint8Array {
        const signed = signSchnorr(key.value, digest, aux)
        if (!signed.ok) throw new Error(signed.error.code)
        return Uint8Array.from(signed.value)
      },
    }),
  }
}

function secretKey(source: SigningKeyMap['secret']): KeyResult<SigningKey> {
  const raw = Uint8Array.from(source.toBuffer())
  try {
    const provided = source.toPublicKey?.().toBuffer()
    const compressed =
      provided !== undefined
        ? provided.length === 33
        : source.compressed !== false
    const key = privateKeyFromSecretBytes(raw, compressed)
    if (!key.ok) return key
    if (provided !== undefined) {
      return {
        ok: true,
        value: ecdsaSigner(key.value, Uint8Array.from(provided)),
      }
    }
    return fromPrivate(key.value, ecdsaPoint(key.value))
  } finally {
    raw.fill(0)
  }
}

/** Map a concrete key onto {@link SigningKey}. The source secret is copied. */
export function signingKey<K extends keyof SigningKeyMap>(
  kind: K,
  source: SigningKeyMap[K],
): KeyResult<SigningKey> {
  switch (kind) {
    case 'ecdsa':
      return ecdsaKey(source as SigningKeyMap['ecdsa'])
    case 'schnorr':
      return schnorrKey(source as SigningKeyMap['schnorr'])
    case 'secret':
      return secretKey(source as SigningKeyMap['secret'])
    default: {
      const unexpected: never = kind
      return unexpected
    }
  }
}
