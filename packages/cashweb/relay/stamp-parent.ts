import {
  privateKeyFromSecretBytes,
  tweakAddPrivateKey,
} from '@frank/nakamoto'

/** Stamp parent secret `(payloadDigest + destination) mod n`.
 * The digest must be 32 bytes in (0, n). A zero sum is an error
 * (decision #537). tweakAddPrivateKey rejects 0, values >= n, and a
 * zero sum. The caller wraps the secret in a bitcore PrivateKey.
 * Stealth parent scalars use stealthParentSecret (decision #559). */
export function stampParentSecret(
  destinationSecret: Uint8Array,
  payloadDigest: Uint8Array,
): Uint8Array {
  const digest = Uint8Array.from(payloadDigest)
  if (digest.length !== 32) throw new Error('stamp-parent:digest')
  const secretBytes = Uint8Array.from(destinationSecret)
  const secret = privateKeyFromSecretBytes(secretBytes, true)
  secretBytes.fill(0)
  if (!secret.ok) throw new Error(`stamp-parent:${secret.error.code}`)
  const added = tweakAddPrivateKey(secret.value, digest)
  secret.value.bytes.fill(0)
  if (!added.ok) throw new Error(`stamp-parent:${added.error.code}`)
  const derived = Uint8Array.from(added.value.bytes)
  added.value.bytes.fill(0)
  return derived
}
