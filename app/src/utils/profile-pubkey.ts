// Contact and message profile keys (decision #586). SEC1 bytes only.
// Compressed is 33 bytes, prefix 02 or 03. Uncompressed is 65 bytes, prefix 04.
// pointFromPublicKey rejects other lengths, other prefixes, and non-points.
// toBuffer returns a copy. The caller's buffer is not wiped. No address string.
import { pointFromPublicKey } from '../../../packages/nakamoto/src/secp256k1'

export class ProfilePubKeyError extends Error {
  readonly code = 'profile-public-key-invalid' as const

  constructor() {
    super('profile-public-key-invalid')
    this.name = 'ProfilePubKeyError'
  }
}

/** Accepted profile key. Chat views call `toBuffer()` and nothing else. */
export interface ProfilePubKey {
  toBuffer(): Uint8Array
}

export function isProfilePubKey(value: unknown): value is ProfilePubKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toBuffer?: unknown }).toBuffer === 'function'
  )
}

/** Throws `ProfilePubKeyError` when the bytes are not a curve point. No key object. */
export function profilePubKeyFromBytes(bytes: Uint8Array): ProfilePubKey {
  if (!(bytes instanceof Uint8Array)) {
    throw new ProfilePubKeyError()
  }
  const stored = new Uint8Array(bytes)
  if (pointFromPublicKey(stored) === null) {
    throw new ProfilePubKeyError()
  }
  return {
    toBuffer() {
      return new Uint8Array(stored)
    },
  }
}
