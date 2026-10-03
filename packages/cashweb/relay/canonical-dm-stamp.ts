/** Frozen T3a/T3b/T4 operations. No directory admission or economic authority. */
import { randomBytes, sha256 } from '@frank/crypto-box'
import {
  bigintToBytes,
  bytesToBigint,
  pointAdd,
  pointMultiply,
} from '@frank/nakamoto'
import {
  addressFromCompressedPubkey,
  paymentCommitment,
  recipientPayloadDigest,
  type AccountRef,
} from '@frank/codec'

const ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
)
const GENERATOR = Uint8Array.from([
  2, 121, 190, 102, 126, 249, 220, 187, 172, 85, 160, 98, 149, 206, 135, 11, 7,
  2, 155, 252, 219, 45, 206, 40, 217, 89, 242, 129, 91, 22, 248, 23, 152,
])

export interface CanonicalStampProof {
  readonly ephemeralPoint: Uint8Array
  readonly sharedPoint: Uint8Array
  readonly dleqProof: Uint8Array
}

export interface CanonicalStampInput extends CanonicalStampProof {
  readonly network: string
  readonly stampKey: AccountRef
}

export class CanonicalStampError extends Error {
  constructor(
    readonly code:
      | 'network'
      | 'point'
      | 'scalar'
      | 'proof'
      | 'index'
      | 'random',
  ) {
    super(`canonical-stamp:${code}`)
    this.name = 'CanonicalStampError'
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function scalarBytes(n: bigint): Uint8Array {
  const result = bigintToBytes(n, 32)
  if (!result.ok) throw new CanonicalStampError('scalar')
  return result.value
}

function scalar(bytes: Uint8Array): bigint {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32)
    throw new CanonicalStampError('scalar')
  const n = bytesToBigint(bytes)
  if (n <= 0n || n >= ORDER) throw new CanonicalStampError('scalar')
  return n
}

function multiply(point: Uint8Array, factor: Uint8Array): Uint8Array {
  const result = pointMultiply(point, factor)
  if (!result.ok) throw new CanonicalStampError('point')
  return result.value
}

function point(bytes: Uint8Array): Uint8Array {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length !== 33 ||
    (bytes[0] !== 2 && bytes[0] !== 3)
  )
    throw new CanonicalStampError('point')
  return multiply(new Uint8Array(bytes), scalarBytes(1n))
}

function stamp(key: AccountRef): Uint8Array {
  if (key.keyType !== 1) throw new CanonicalStampError('point')
  return point(key.keyBytes)
}

function prefix(domain: string, network: string): Uint8Array {
  if (
    typeof network !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(network)
  )
    throw new CanonicalStampError('network')
  // Both strings are bounded ASCII; these are the frozen length-prefixed domains.
  return concat([
    Uint8Array.of(0, domain.length),
    Uint8Array.from(domain, c => c.charCodeAt(0)),
    Uint8Array.of(0, network.length),
    Uint8Array.from(network, c => c.charCodeAt(0)),
  ])
}

function freshScalar(): Uint8Array {
  for (let i = 0; i < 128; i++) {
    const bytes = randomBytes(32)
    const n = bytesToBigint(bytes)
    if (n > 0n && n < ORDER) return bytes
    bytes.fill(0)
  }
  throw new CanonicalStampError('random')
}

function challenge(
  domain: Uint8Array,
  p: Uint8Array,
  e: Uint8Array,
  x: Uint8Array,
  r1: Uint8Array,
  r2: Uint8Array,
): Uint8Array {
  return sha256(concat([domain, GENERATOR, p, e, x, r1, r2]))
}

/** Runtime entropy only. The stamp ephemeral is never handed to encryption. */
export function createCanonicalStampProof(input: {
  readonly network: string
  readonly stampKey: AccountRef
}): CanonicalStampProof {
  const domain = prefix('frank/stamp-dleq/v1', input.network)
  const p = stamp(input.stampKey)
  const e = freshScalar()
  try {
    const ephemeralPoint = multiply(GENERATOR, e)
    const sharedPoint = multiply(p, e)
    for (let attempt = 0; attempt < 128; attempt++) {
      const k = freshScalar()
      try {
        const c = challenge(
          domain,
          p,
          ephemeralPoint,
          sharedPoint,
          multiply(GENERATOR, k),
          multiply(p, k),
        )
        const cn = bytesToBigint(c)
        if (cn === 0n || cn >= ORDER) continue
        const response = (bytesToBigint(k) + cn * bytesToBigint(e)) % ORDER
        if (response === 0n) continue
        return Object.freeze({
          ephemeralPoint,
          sharedPoint,
          dleqProof: concat([c, scalarBytes(response)]),
        })
      } finally {
        k.fill(0)
      }
    }
    throw new CanonicalStampError('random')
  } finally {
    e.fill(0)
  }
}

/** Throws on invalid encoding or relation; success grants no freshness authority. */
export function verifyCanonicalStampProof(input: CanonicalStampInput): void {
  const domain = prefix('frank/stamp-dleq/v1', input.network)
  const p = stamp(input.stampKey)
  const e = point(input.ephemeralPoint)
  const x = point(input.sharedPoint)
  if (!(input.dleqProof instanceof Uint8Array) || input.dleqProof.length !== 64)
    throw new CanonicalStampError('proof')
  const proof = new Uint8Array(input.dleqProof)
  const c = scalar(proof.subarray(0, 32))
  const s = scalarBytes(scalar(proof.subarray(32)))
  const minusC = scalarBytes(ORDER - c)
  const subtract = (base: Uint8Array, other: Uint8Array): Uint8Array => {
    const sum = pointAdd(multiply(base, s), multiply(other, minusC))
    if (!sum.ok) throw new CanonicalStampError('proof')
    return sum.value
  }
  const again = challenge(
    domain,
    p,
    e,
    x,
    subtract(GENERATOR, e),
    subtract(p, x),
  )
  if (!again.every((b, i) => b === proof[i]))
    throw new CanonicalStampError('proof')
}

/** Public T3a derivation. A valid result is not proof of a payment or DLEQ relation. */
export function canonicalStampDestination(input: {
  readonly network: string
  readonly stampKey: AccountRef
  readonly sharedPoint: Uint8Array
  readonly childIndex: number
}): { readonly publicKey: Uint8Array; readonly address: Uint8Array } {
  const domain = prefix('frank/stamp-child/v1', input.network)
  const p = stamp(input.stampKey)
  const x = point(input.sharedPoint)
  const i = input.childIndex
  if (!Number.isSafeInteger(i) || i < 0 || i > 0x7fffffff)
    throw new CanonicalStampError('index')
  const tweak = sha256(
    concat([domain, x, Uint8Array.of(i >>> 24, i >>> 16, i >>> 8, i)]),
  )
  scalar(tweak) // Never reduce or skip an invalid hash.
  const publicKey = multiply(p, tweak)
  return Object.freeze({
    publicKey,
    address: addressFromCompressedPubkey(publicKey),
  })
}

/** Existing codec transcript owners, re-exported for the immediate DM consumer. */
export { paymentCommitment, recipientPayloadDigest }
