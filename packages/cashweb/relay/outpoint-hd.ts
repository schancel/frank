import {
  compressedPublicKeyFromBytes,
  deriveHdPath,
  deriveHdPublicPath,
  privateKeyFromSecretBytes,
} from '@frank/nakamoto'

/** Non-hardened BIP32 public child `m/44/145/<transaction>/<output>`.
 * Those indexes are the stamp and stealth outpoint path (decision #513).
 * An invalid child is an error (decision #303).
 * cryptoBackend rejects Buffer. */
export function outpointPublicKey(
  parentPublicKey: Uint8Array,
  chainCode: Uint8Array,
  transactionNumber: number,
  outputNumber: number,
): Uint8Array {
  const parent = compressedPublicKeyFromBytes(Uint8Array.from(parentPublicKey))
  if (!parent.ok) throw new Error(`outpoint-hd:${parent.error.code}`)
  const code = Uint8Array.from(chainCode)
  if (code.length !== 32) throw new Error('outpoint-hd:chain-code')
  const child = deriveHdPublicPath(
    {
      depth: 0,
      parentFingerprint: new Uint8Array(4),
      childIndex: 0,
      chainCode: code,
      publicKey: parent.value,
    },
    `m/44/145/${transactionNumber}/${outputNumber}`,
  )
  if (!child.ok) throw new Error(`outpoint-hd:${child.error.code}`)
  return child.value.publicKey
}

/** Non-hardened BIP32 private child of the same `m/44/145/<transaction>/<output>`
 * path (decision #531). An invalid child is an error and the index is not
 * incremented (decision #303). The caller wraps the secret in a bitcore
 * PrivateKey so address strings stay on bitcore (issue #242). */
export function outpointPrivateKey(
  parentPrivateKey: Uint8Array,
  chainCode: Uint8Array,
  transactionNumber: number,
  outputNumber: number,
): Uint8Array {
  const secretBytes = Uint8Array.from(parentPrivateKey)
  const secret = privateKeyFromSecretBytes(secretBytes, true)
  secretBytes.fill(0)
  if (!secret.ok) throw new Error(`outpoint-hd:${secret.error.code}`)
  const code = Uint8Array.from(chainCode)
  if (code.length !== 32) {
    secret.value.bytes.fill(0)
    throw new Error('outpoint-hd:chain-code')
  }
  const child = deriveHdPath(
    {
      depth: 0,
      parentFingerprint: new Uint8Array(4),
      childIndex: 0,
      chainCode: code,
      privateKey: secret.value,
    },
    `m/44/145/${transactionNumber}/${outputNumber}`,
  )
  secret.value.bytes.fill(0)
  if (!child.ok) throw new Error(`outpoint-hd:${child.error.code}`)
  const derived = Uint8Array.from(child.value.privateKey.bytes)
  child.value.privateKey.bytes.fill(0)
  return derived
}
