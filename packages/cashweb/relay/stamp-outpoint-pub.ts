import {
  privateKeyFromSecretBytes,
  publicFromPrivate,
} from '@frank/nakamoto'

/** Compressed public key of a stamp outpoint secret.
 * The secret must be 32 bytes in (0, n) (decision #541).
 * publicFromPrivate rejects 0 and values >= n. The caller wraps the
 * bytes in a bitcore PublicKey and still compares addresses with
 * toAddress (issue #242). Stealth receive uses stealthOutpointPublicKey
 * (decision #555). */
export function stampOutpointPublicKey(secret: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(secret)
  if (bytes.length !== 32) {
    bytes.fill(0)
    throw new Error('stamp-outpoint-pub:secret')
  }
  const key = privateKeyFromSecretBytes(bytes, true)
  bytes.fill(0)
  if (!key.ok) throw new Error(`stamp-outpoint-pub:${key.error.code}`)
  const derived = publicFromPrivate(key.value)
  key.value.bytes.fill(0)
  if (!derived.ok) throw new Error(`stamp-outpoint-pub:${derived.error.code}`)
  return Uint8Array.from(derived.value.compressed)
}
