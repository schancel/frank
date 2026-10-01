import {
  compressedPublicKeyFromBytes,
  type HdPublicNode,
} from '@frank/nakamoto'

import { stealthPointDigest } from './stealth-point-digest'
import { stealthParentPublicKey } from './stealth-public'
import { stealthSharedPoint } from './stealth-shared'

/** Depth-0 public node. `chainCode` is stored as given and is not reduced
 * mod n (decision #559). `publicKey` must be 33 bytes with a 02 or 03
 * prefix. The caller's buffers are not wiped. */
export function stealthDepthZeroPublicNode(
  publicKey: Uint8Array,
  chainCode: Uint8Array,
): HdPublicNode {
  const point = Uint8Array.from(publicKey)
  const code = Uint8Array.from(chainCode)
  if (code.length !== 32) throw new Error('stealth-hd-public:chain-code')
  const key = compressedPublicKeyFromBytes(point)
  if (!key.ok) throw new Error(`stealth-hd-public:${key.error.code}`)
  return {
    depth: 0,
    parentFingerprint: new Uint8Array(4),
    childIndex: 0,
    chainCode: code,
    publicKey: key.value,
  }
}

/** Stealth parent as a depth-0 public node (decision #559). The chain
 * code is the raw SHA-256 digest from `stealthPointDigest`, not the
 * reduced scalar. A secret outside (0, n), a public key that is not 33
 * or 65 SEC1 bytes, an invalid point, or a point at infinity is an
 * error. The caller's secret is not wiped. The returned public key is
 * a copy. */
export function stealthParentHdPublicNode(
  ephemeralSecret: Uint8Array,
  destinationPublicKey: Uint8Array,
): HdPublicNode {
  const shared = stealthSharedPoint(ephemeralSecret, destinationPublicKey)
  const digest = Uint8Array.from(stealthPointDigest(shared))
  const point = stealthParentPublicKey(destinationPublicKey, digest)
  return stealthDepthZeroPublicNode(point, digest)
}
