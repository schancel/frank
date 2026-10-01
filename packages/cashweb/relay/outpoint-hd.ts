import {
  compressedPublicKeyFromBytes,
  deriveHdPublicPath,
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
