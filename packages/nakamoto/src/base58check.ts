import { sha256 } from '@noble/hashes/sha256.js'
import { decodeBase58, encodeBase58 } from './base58.js'
import { concatBytes, copyBytes } from './bytes.js'
import type { EncodingResult } from './encoding-error.js'

// Bitcoin base58check: payload || SHA-256d(payload)[0..4], then base58.
// The hash function stays private. The hash-backend ticket owns the public API.

function hash256(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes))
}

export function encodeBase58Check(payload: Uint8Array): string {
  const body = copyBytes(payload)
  const checksum = hash256(body).subarray(0, 4)
  return encodeBase58(concatBytes([body, checksum]))
}

export function decodeBase58Check(text: string): EncodingResult<Uint8Array> {
  const decoded = decodeBase58(text)
  if (!decoded.ok) return decoded
  if (decoded.value.length < 4) {
    return {
      ok: false,
      error: {
        code: 'base58check-too-short',
        length: decoded.value.length,
      },
    }
  }
  const payload = decoded.value.subarray(0, -4)
  const checksum = decoded.value.subarray(-4)
  const expected = hash256(payload).subarray(0, 4)
  for (let index = 0; index < 4; index += 1) {
    if (checksum[index] !== expected[index]) {
      return { ok: false, error: { code: 'base58check-checksum' } }
    }
  }
  return { ok: true, value: new Uint8Array(payload) }
}
