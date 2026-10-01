// Pure-JS backend. @noble/hashes 1.8.0 and @noble/curves 1.9.1.
// hash-wasm and tiny-secp256k1 are not imported. WebCrypto is not used.

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { hmac } from '@noble/hashes/hmac.js'
import { ripemd160 as nobleRipemd160 } from '@noble/hashes/ripemd160.js'
import { sha256 as nobleSha256 } from '@noble/hashes/sha256.js'

import { isPlainBytes } from '../bytes.js'
import { bytesToBigint } from '../integer.js'
import { isValidScalar } from '../secp256k1.js'
import { CryptoBackendError, type CryptoBackend } from './types.js'

export { CryptoBackendError }

const Point = secp256k1.ProjectivePoint
type Projective = typeof Point.BASE

function plain(value: Uint8Array): Uint8Array {
  if (!isPlainBytes(value)) throw new CryptoBackendError('bad-length', 0)
  return value
}

function hashBytes(input: Uint8Array): Uint8Array {
  return new Uint8Array(nobleSha256(plain(input)))
}

function parsePoint(bytes: Uint8Array): Projective {
  const encoded = plain(bytes)
  if (encoded.length !== 32 && encoded.length !== 33 && encoded.length !== 65) {
    throw new CryptoBackendError('bad-length', encoded.length)
  }
  const prefix = encoded[0]
  if (encoded.length === 33 && prefix !== 0x02 && prefix !== 0x03) {
    throw new CryptoBackendError('point-invalid')
  }
  if (encoded.length === 65 && prefix !== 0x04) {
    throw new CryptoBackendError('point-invalid')
  }
  try {
    if (encoded.length === 32) {
      const lifted = schnorr.utils.lift_x(bytesToBigint(encoded))
      lifted.assertValidity()
      return lifted
    }
    return Point.fromHex(encoded)
  } catch (error) {
    if (error instanceof CryptoBackendError) throw error
    throw new CryptoBackendError('point-invalid')
  }
}

function compressed(point: Projective): Uint8Array {
  if (point.equals(Point.ZERO)) {
    throw new CryptoBackendError('point-at-infinity')
  }
  const bytes = point.toRawBytes(true)
  if (bytes.length !== 33) throw new CryptoBackendError('point-invalid')
  return new Uint8Array(bytes)
}

function secret32(secret: Uint8Array): Uint8Array {
  const bytes = plain(secret)
  if (bytes.length !== 32) {
    throw new CryptoBackendError('bad-length', bytes.length)
  }
  if (!isValidScalar(bytesToBigint(bytes))) {
    throw new CryptoBackendError('scalar-out-of-range')
  }
  return bytes
}

function scalar32(scalar: Uint8Array): bigint {
  const bytes = plain(scalar)
  if (bytes.length !== 32) {
    throw new CryptoBackendError('bad-length', bytes.length)
  }
  const value = bytesToBigint(bytes)
  if (!isValidScalar(value)) {
    throw new CryptoBackendError('scalar-out-of-range')
  }
  return value
}

export const nobleBackend: CryptoBackend = {
  name: 'noble',

  sha256(input) {
    return hashBytes(input)
  },

  sha256d(input) {
    return new Uint8Array(nobleSha256(hashBytes(input)))
  },

  ripemd160(input) {
    return new Uint8Array(nobleRipemd160(plain(input)))
  },

  hash160(input) {
    return new Uint8Array(nobleRipemd160(hashBytes(input)))
  },

  hmacSha256(key, message) {
    return new Uint8Array(hmac(nobleSha256, plain(key), plain(message)))
  },

  signEcdsa(secret, digest) {
    const key = secret32(secret)
    const hash = plain(digest)
    if (hash.length !== 32) {
      throw new CryptoBackendError('bad-length', hash.length)
    }
    const signature = secp256k1.sign(hash, key, { lowS: true })
    if (signature.hasHighS()) throw new CryptoBackendError('high-s')
    return new Uint8Array(signature.toDERRawBytes())
  },

  verifyEcdsa(signature, digest, publicKey) {
    if (!isPlainBytes(signature)) throw new CryptoBackendError('bad-length', 0)
    if (!isPlainBytes(digest)) throw new CryptoBackendError('bad-length', 0)
    if (digest.length !== 32) {
      throw new CryptoBackendError('bad-length', digest.length)
    }
    const encoded = compressed(parsePoint(publicKey))
    let parsed: ReturnType<typeof secp256k1.Signature.fromDER>
    try {
      parsed =
        signature.length === 64
          ? secp256k1.Signature.fromCompact(signature)
          : secp256k1.Signature.fromDER(signature)
      parsed.assertValidity()
    } catch (error) {
      if (error instanceof CryptoBackendError) throw error
      throw new CryptoBackendError('signature-invalid')
    }
    if (parsed.hasHighS()) throw new CryptoBackendError('high-s')
    return secp256k1.verify(parsed, digest, encoded, { lowS: true })
  },

  signSchnorr(secret, message, aux) {
    const key = secret32(secret)
    const msg = plain(message)
    const randomness = plain(aux)
    if (randomness.length !== 32) {
      throw new CryptoBackendError('bad-length', randomness.length)
    }
    try {
      const signature = schnorr.sign(msg, key, randomness)
      if (signature.length !== 64) {
        throw new CryptoBackendError('signature-invalid')
      }
      return new Uint8Array(signature)
    } catch (error) {
      if (error instanceof CryptoBackendError) throw error
      throw new CryptoBackendError('signature-invalid')
    }
  },

  verifySchnorr(signature, message, publicKey) {
    const sig = plain(signature)
    if (sig.length !== 64)
      throw new CryptoBackendError('bad-length', sig.length)
    const msg = plain(message)
    const key = plain(publicKey)
    if (key.length !== 32)
      throw new CryptoBackendError('bad-length', key.length)
    try {
      return schnorr.verify(sig, msg, key)
    } catch (error) {
      if (error instanceof CryptoBackendError) throw error
      throw new CryptoBackendError('signature-invalid')
    }
  },

  ecdh(secret, publicKey) {
    const key = secret32(secret)
    const point = compressed(parsePoint(publicKey))
    try {
      const shared = secp256k1.getSharedSecret(key, point, true)
      if (shared.length !== 33) throw new CryptoBackendError('point-invalid')
      return new Uint8Array(shared)
    } catch (error) {
      if (error instanceof CryptoBackendError) throw error
      throw new CryptoBackendError('point-invalid')
    }
  },

  pointAdd(left, right) {
    return compressed(parsePoint(left).add(parsePoint(right)))
  },

  pointMultiply(publicPoint, scalar) {
    return compressed(parsePoint(publicPoint).multiply(scalar32(scalar)))
  },
}
