import { pointMultiply, tweakAddPublicKey } from '@frank/nakamoto'

import { stealthDigestModN } from './stealth-parent'

/** Scalar 1. Multiplying by it re-encodes the destination when H mod n is 0. */
const SCALAR_ONE = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 1,
])

function isZero(bytes: Uint8Array): boolean {
  let acc = 0
  for (const byte of bytes) acc |= byte
  return acc === 0
}

/** Stealth parent public key `destination + (H mod n)·G`.
 * A digest >= n is reduced once (decision #559). A reduced digest of
 * 0 yields the destination point. tweakAddPublicKey rejects a zero
 * tweak, so that case is pointMultiply by 1: the same point, compressed.
 * A point at infinity is an error and no key is returned. A 32-byte
 * x-only point is rejected so it is not lifted with even Y. The caller
 * wraps the bytes in a bitcore PublicKey. ebG point multiplication
 * stays on bitcore. A digest >= n is not rejected (#537 is the stamp
 * path). */
export function stealthParentPublicKey(
  destinationPublicKey: Uint8Array,
  digest: Uint8Array,
): Uint8Array {
  const point = Uint8Array.from(destinationPublicKey)
  if (point.length !== 33 && point.length !== 65) {
    throw new Error('stealth-public:point')
  }
  let reduced: Uint8Array
  try {
    reduced = stealthDigestModN(digest)
  } catch {
    throw new Error('stealth-public:digest')
  }
  try {
    if (isZero(reduced)) {
      const encoded = pointMultiply(point, SCALAR_ONE)
      if (!encoded.ok) throw new Error(`stealth-public:${encoded.error.code}`)
      return Uint8Array.from(encoded.value)
    }
    const added = tweakAddPublicKey(point, reduced)
    if (!added.ok) throw new Error(`stealth-public:${added.error.code}`)
    return Uint8Array.from(added.value)
  } finally {
    reduced.fill(0)
  }
}
