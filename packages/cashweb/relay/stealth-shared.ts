import { ecdh, privateKeyFromSecretBytes } from '@frank/nakamoto'

/** Compressed ebG: ephemeral secret times the destination point.
 * The scalar is a secret, so this calls `ecdh` (decision #559). A
 * secret outside (0, n), a public key that is not 33 or 65 SEC1 bytes,
 * or an invalid point is an error. The caller's secret is not wiped.
 * Bytes match bitcore's compressed encoding of that product, including
 * an x coordinate whose first byte is zero. */
export function stealthSharedPoint(
  ephemeralSecret: Uint8Array,
  destinationPublicKey: Uint8Array,
): Uint8Array {
  const secretBytes = Uint8Array.from(ephemeralSecret)
  const point = Uint8Array.from(destinationPublicKey)
  const key = privateKeyFromSecretBytes(secretBytes, true)
  secretBytes.fill(0)
  if (!key.ok) throw new Error(`stealth-shared:${key.error.code}`)
  try {
    if (point.length !== 33 && point.length !== 65) {
      throw new Error('stealth-shared:public-key')
    }
    const shared = ecdh(key.value, point)
    if (!shared.ok) throw new Error(`stealth-shared:${shared.error.code}`)
    return Uint8Array.from(shared.value.point)
  } finally {
    key.value.bytes.fill(0)
  }
}
