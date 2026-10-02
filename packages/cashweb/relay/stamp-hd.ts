import {
  privateKeyFromSecretBytes,
  type HdPrivateNode,
} from '@frank/nakamoto'

import { stampParentSecret } from './stamp-parent'

/** Depth-0 node. `chainCode` is stored as given and is not reduced mod n.
 * `secret` must already be in (0, n). The caller's buffers are not wiped. */
export function stampDepthZeroNode(
  secret: Uint8Array,
  chainCode: Uint8Array,
): HdPrivateNode {
  const secretBytes = Uint8Array.from(secret)
  const code = Uint8Array.from(chainCode)
  try {
    if (code.length !== 32) throw new Error('stamp-hd:chain-code')
    const key = privateKeyFromSecretBytes(secretBytes, true)
    if (!key.ok) throw new Error(`stamp-hd:${key.error.code}`)
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

/** Stamp parent as a depth-0 node (decision #537). The secret is
 * `stampParentSecret`. A digest of 0, a digest >= n, a digest that is
 * not 32 bytes, or a zero sum is an error and is not reduced. The chain
 * code is that same raw digest, not the tweaked scalar. The caller's
 * secret is not wiped. */
export function stampParentHdNode(
  destinationSecret: Uint8Array,
  payloadDigest: Uint8Array,
): HdPrivateNode {
  const digest = Uint8Array.from(payloadDigest)
  const derived = stampParentSecret(destinationSecret, digest)
  try {
    return stampDepthZeroNode(derived, digest)
  } finally {
    derived.fill(0)
  }
}
