import { privateKeyFromSecretBytes, publicFromPrivate } from '@frank/nakamoto'

/** Public key bytes on a stealth payment `ephemeral_pub_key` (decision #576).
 * The secret must be 32 bytes in (0, n). Compressed is 33 bytes and
 * matches bitcore `publicKey.toBuffer()`. Uncompressed is 65 bytes,
 * `04 || x || y`. The caller's secret buffer is not wiped. Same point
 * encoding as relay message source keys (decision #574). This is the
 * ephemeral key's own point, not a stealth parent scalar. HMAC, salt,
 * the plaintext digest, and envelope ECDH stay on bitcore. */
export function stealthEphemeralPublicKey(
  secret: Uint8Array,
  compressed: boolean,
): Uint8Array {
  const bytes = Uint8Array.from(secret)
  if (bytes.length !== 32) {
    bytes.fill(0)
    throw new Error('stealth-ephemeral-pubkey:secret')
  }
  if (compressed !== true && compressed !== false) {
    bytes.fill(0)
    throw new Error('stealth-ephemeral-pubkey:compressed')
  }
  const key = privateKeyFromSecretBytes(bytes, compressed)
  bytes.fill(0)
  if (!key.ok) throw new Error(`stealth-ephemeral-pubkey:${key.error.code}`)
  const derived = publicFromPrivate(key.value)
  key.value.bytes.fill(0)
  if (!derived.ok) {
    throw new Error(`stealth-ephemeral-pubkey:${derived.error.code}`)
  }
  const point = compressed
    ? derived.value.compressed
    : derived.value.uncompressed
  return Uint8Array.from(point)
}
