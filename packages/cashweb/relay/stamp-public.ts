import { tweakAddPublicKey } from '@frank/nakamoto'

/** Stamp parent public key `destination + payloadDigest·G`.
 * The digest must be 32 bytes in (0, n). The destination must be a
 * 33-byte compressed or 65-byte uncompressed SEC1 point. A point at
 * infinity is an error (decision #539). tweakAddPublicKey rejects 0,
 * values >= n, and infinity. A 32-byte x-only point is rejected here
 * so it is not lifted with even Y. The caller wraps the bytes in a
 * bitcore PublicKey. Stealth public point.add stays on bitcore. */
export function stampParentPublicKey(
  destinationPublicKey: Uint8Array,
  payloadDigest: Uint8Array,
): Uint8Array {
  const digest = Uint8Array.from(payloadDigest)
  if (digest.length !== 32) throw new Error('stamp-public:digest')
  const point = Uint8Array.from(destinationPublicKey)
  if (point.length !== 33 && point.length !== 65) {
    throw new Error('stamp-public:point')
  }
  const added = tweakAddPublicKey(point, digest)
  if (!added.ok) throw new Error(`stamp-public:${added.error.code}`)
  return Uint8Array.from(added.value)
}
