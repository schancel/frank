// AEAD wrappers. The tag check is the backend compare, not a branch in this file.
// The chaining mode that lives beside GCM in the cipher package is not called.

import { gcm } from '@noble/ciphers/aes.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'

import type { AeadName } from './ids.js'

export function aeadEncrypt(
  aead: AeadName,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  if (aead === 'aes-256-gcm') return gcm(key, nonce, aad).encrypt(plaintext)
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext)
}

/** Null on any failure, including a bad tag. The reason is not returned. */
export function aeadDecrypt(
  aead: AeadName,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array | null {
  try {
    if (aead === 'aes-256-gcm') return gcm(key, nonce, aad).decrypt(ciphertext)
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext)
  } catch {
    return null
  }
}
