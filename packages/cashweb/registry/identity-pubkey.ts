import {
  privateKeyFromSecretBytes,
  publicFromPrivate,
} from '@frank/nakamoto'

/** Public key bytes on a registry identity SignedPayload (decision #578).
 * The secret must be 32 bytes in (0, n). Compressed is 33 bytes and
 * matches bitcore `toPublicKey().toBuffer()`. Uncompressed is 65 bytes,
 * `04 || x || y`. The caller's secret buffer is not wiped. Same point
 * encoding as relay profile keys (decision #543). Broadcast digests and
 * the burn Output wrap stay on bitcore. */
export function registryIdentityPublicKey(
  secret: Uint8Array,
  compressed: boolean,
): Uint8Array {
  const bytes = Uint8Array.from(secret)
  if (bytes.length !== 32) {
    bytes.fill(0)
    throw new Error('registry-identity-pubkey:secret')
  }
  if (compressed !== true && compressed !== false) {
    bytes.fill(0)
    throw new Error('registry-identity-pubkey:compressed')
  }
  const key = privateKeyFromSecretBytes(bytes, compressed)
  bytes.fill(0)
  if (!key.ok) throw new Error(`registry-identity-pubkey:${key.error.code}`)
  const derived = publicFromPrivate(key.value)
  key.value.bytes.fill(0)
  if (!derived.ok) {
    throw new Error(`registry-identity-pubkey:${derived.error.code}`)
  }
  const point = compressed
    ? derived.value.compressed
    : derived.value.uncompressed
  return Uint8Array.from(point)
}
