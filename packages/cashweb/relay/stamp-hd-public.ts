import {
  compressedPublicKeyFromBytes,
  type HdPublicNode,
} from '@frank/nakamoto'

import { stampParentPublicKey } from './stamp-public'

/** Depth-0 public node. `chainCode` is stored as given and is not reduced
 * mod n (decision #537). `publicKey` must be 33 bytes with a 02 or 03
 * prefix. The caller's buffers are not wiped. */
export function stampDepthZeroPublicNode(
  publicKey: Uint8Array,
  chainCode: Uint8Array,
): HdPublicNode {
  const point = Uint8Array.from(publicKey)
  const code = Uint8Array.from(chainCode)
  if (code.length !== 32) throw new Error('stamp-hd-public:chain-code')
  const key = compressedPublicKeyFromBytes(point)
  if (!key.ok) throw new Error(`stamp-hd-public:${key.error.code}`)
  return {
    depth: 0,
    parentFingerprint: new Uint8Array(4),
    childIndex: 0,
    chainCode: code,
    publicKey: key.value,
  }
}

/** Stamp parent as a depth-0 public node (decision #537). The public key
 * is `stampParentPublicKey`. A digest of 0, a digest >= n, a digest that
 * is not 32 bytes, a destination that is not 33 or 65 SEC1 bytes, or a
 * point at infinity is an error and is not reduced. The chain code is
 * that same raw digest, not a reduced scalar. The caller's public key
 * is not wiped. The returned public key is a copy. */
export function stampParentHdPublicNode(
  destinationPublicKey: Uint8Array,
  payloadDigest: Uint8Array,
): HdPublicNode {
  const digest = Uint8Array.from(payloadDigest)
  const point = stampParentPublicKey(destinationPublicKey, digest)
  return stampDepthZeroPublicNode(point, digest)
}
