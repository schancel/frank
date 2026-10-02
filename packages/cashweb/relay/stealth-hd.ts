import {
  privateKeyFromSecretBytes,
  type HdPrivateNode,
} from '@frank/nakamoto'

import { stealthParentSecret } from './stealth-parent'

/** Depth-0 node. `chainCode` is stored as given and is not reduced mod n
 * (decision #559). `secret` must already be in (0, n). The caller's
 * buffers are not wiped. */
export function stealthDepthZeroNode(
  secret: Uint8Array,
  chainCode: Uint8Array,
): HdPrivateNode {
  const secretBytes = Uint8Array.from(secret)
  const code = Uint8Array.from(chainCode)
  try {
    if (code.length !== 32) throw new Error('stealth-hd:chain-code')
    const key = privateKeyFromSecretBytes(secretBytes, true)
    if (!key.ok) throw new Error(`stealth-hd:${key.error.code}`)
    return {
      depth: 0,
      parentFingerprint: new Uint8Array(4),
      childIndex: 0,
      chainCode: code,
      privateKey: key.value,
    }
  } finally {
    secretBytes.fill(0)
  }
}

/** Stealth parent as a depth-0 node (decision #559). The chain code is
 * the raw SHA-256 digest from `stealthParentSecret`, not the reduced
 * scalar. A secret outside (0, n), a public key that is not 33 or 65
 * SEC1 bytes, an invalid point, or a zero sum is an error. The caller's
 * secret is not wiped. */
export function stealthParentHdNode(
  destinationSecret: Uint8Array,
  ephemeralPublicKey: Uint8Array,
): HdPrivateNode {
  const derived = stealthParentSecret(destinationSecret, ephemeralPublicKey)
  try {
    return stealthDepthZeroNode(derived.secret, derived.digest)
  } finally {
    derived.secret.fill(0)
  }
}
