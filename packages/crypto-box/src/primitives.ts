// Hash and HMAC primitives for callers that are not building a seal frame.
// hmacSha256(data, key) takes the message first and the key second.
// @noble/hashes hmac takes the key first. Inputs are copied. crypto.getRandomValues
// is the browser, Capacitor, and Electron source for randomBytes.
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 as nobleSha256 } from '@noble/hashes/sha256.js'

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(Uint8Array.from(data))
}

export function hmacSha256(data: Uint8Array, key: Uint8Array): Uint8Array {
  return hmac(nobleSha256, Uint8Array.from(key), Uint8Array.from(data))
}

export function randomBytes(length: number): Uint8Array {
  const host = (
    globalThis as {
      crypto?: { getRandomValues?: (bytes: Uint8Array) => Uint8Array }
    }
  ).crypto
  if (!host || typeof host.getRandomValues !== 'function') {
    throw new Error('crypto-box:no-csprng')
  }
  const out = new Uint8Array(length)
  host.getRandomValues(out)
  return out
}
