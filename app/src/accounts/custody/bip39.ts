import { hdPrivateFromSeed, deriveHdPrivate } from '@frank/nakamoto/hd'
import { publicFromPrivate } from '@frank/nakamoto/keys'
import { BIP39_DERIVATION } from '@frank/account-vault'
import { CustodyError } from './types'

export const FRANK_BIP39_IDENTITY_PATH = "m/44'/60'/1'/0/0"

/** Public commitment to the established historical identity; no seed conversion. */
export function bip39Descriptor(seed: Uint8Array): {
  descriptor: string
  fingerprint: string
} {
  if (!(seed instanceof Uint8Array) || seed.length !== 64)
    throw new CustodyError('invalid-input')
  const master = hdPrivateFromSeed(seed)
  if (!master.ok) throw new CustodyError('invalid-input')
  let node = master.value
  try {
    for (const index of [0x8000002c, 0x8000003c, 0x80000001, 0, 0]) {
      const child = deriveHdPrivate(node, index)
      if (!child.ok) throw new CustodyError('invalid-input')
      node.privateKey.bytes.fill(0)
      node.chainCode.fill(0)
      node = child.value
    }
    const point = publicFromPrivate(node.privateKey)
    if (!point.ok) throw new CustodyError('invalid-input')
    const fingerprint = Array.from(point.value.compressed, byte =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    return {
      fingerprint,
      descriptor: JSON.stringify({
        derivation: BIP39_DERIVATION,
        identityPath: FRANK_BIP39_IDENTITY_PATH,
        identityPublicKey: fingerprint,
      }),
    }
  } finally {
    node.privateKey.bytes.fill(0)
    node.chainCode.fill(0)
  }
}
