import { privateKeyFromSecretBytes, publicFromPrivate } from '@frank/nakamoto'

/** FrankIdentity public key bytes (decision #556).
 * The secret must be 32 bytes in (0, n). Compressed matches bitcore
 * `toPublicKey().toBuffer()` at 33 bytes. Uncompressed is 65 bytes,
 * `04 || x || y`. The caller's secret buffer and PrivateKey are not wiped. */
export function lotusIdentityPublicKey(
  secret: Uint8Array,
  compressed: boolean,
): Uint8Array {
  const bytes = Uint8Array.from(secret)
  if (bytes.length !== 32) {
    bytes.fill(0)
    throw new Error('lotus-identity-pubkey:secret')
  }
  if (compressed !== true && compressed !== false) {
    bytes.fill(0)
    throw new Error('lotus-identity-pubkey:compressed')
  }
  const key = privateKeyFromSecretBytes(bytes, compressed)
  bytes.fill(0)
  if (!key.ok) throw new Error(`lotus-identity-pubkey:${key.error.code}`)
  const derived = publicFromPrivate(key.value)
  key.value.bytes.fill(0)
  if (!derived.ok)
    throw new Error(`lotus-identity-pubkey:${derived.error.code}`)
  const point = compressed
    ? derived.value.compressed
    : derived.value.uncompressed
  return Uint8Array.from(point)
}
