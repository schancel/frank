/** Frank-CBOR T3b stamp proof (docs/protocol/cbor/README.md). */
import { sha256 } from '@noble/hashes/sha256.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'

import {
  G,
  modAdd,
  modMul,
  pointBytes,
  pointFromBytes,
  randomScalar,
  scalarBytes,
  scalarFromBytesCanonical,
} from './curve.js'

const CHALLENGE_DOMAIN = 'frank/stamp-dleq/v1'
const NONCE_DOMAIN = 'frank/stamp-dleq-nonce/v1'

function ascii(value: string): Uint8Array {
  const out = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code > 0x7f) throw new Error('domain must be ASCII')
    out[i] = code
  }
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function u16(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError('length does not fit u16')
  }
  return Uint8Array.of(value >>> 8, value & 0xff)
}

function transcriptPrefix(domain: string, network: string): Uint8Array {
  const domainBytes = ascii(domain)
  const networkBytes = utf8ToBytes(network)
  return concat(
    u16(domainBytes.length),
    domainBytes,
    u16(networkBytes.length),
    networkBytes,
  )
}

function challenge(
  network: string,
  stampKey: Uint8Array,
  ephemeralPoint: Uint8Array,
  sharedPoint: Uint8Array,
  r1: Uint8Array,
  r2: Uint8Array,
): bigint {
  return scalarFromBytesCanonical(
    sha256(
      concat(
        transcriptPrefix(CHALLENGE_DOMAIN, network),
        pointBytes(G),
        stampKey,
        ephemeralPoint,
        sharedPoint,
        r1,
        r2,
      ),
    ),
    false,
  )
}

export interface FrankStampProofMaterial {
  readonly ephemeralSecret: Uint8Array
  readonly ephemeralPoint: Uint8Array
  readonly sharedPoint: Uint8Array
  readonly proof: Uint8Array
}

/** Creates E=eG, X=eP' and the exact 64-byte `c || s` T3b proof. */
export function createFrankStampProof(params: {
  readonly network: string
  readonly stampKey: Uint8Array
  readonly ephemeralSecret?: Uint8Array
  readonly proofNonce?: Uint8Array
}): FrankStampProofMaterial {
  if (params.network.length === 0) throw new Error('network must not be empty')
  if (utf8ToBytes(params.network).length > 0xffff) {
    throw new RangeError('network UTF-8 encoding does not fit u16')
  }
  const stampPoint = pointFromBytes(params.stampKey)
  const e =
    params.ephemeralSecret === undefined
      ? randomScalar()
      : scalarFromBytesCanonical(params.ephemeralSecret, false)
  const ephemeralPoint = pointBytes(G.multiply(e))
  const sharedPoint = pointBytes(stampPoint.multiply(e))

  for (;;) {
    const k =
      params.proofNonce === undefined
        ? randomScalar()
        : scalarFromBytesCanonical(params.proofNonce, false)
    let c: bigint
    try {
      c = challenge(
        params.network,
        params.stampKey,
        ephemeralPoint,
        sharedPoint,
        pointBytes(G.multiply(k)),
        pointBytes(stampPoint.multiply(k)),
      )
    } catch {
      if (params.proofNonce !== undefined) {
        throw new Error('provided proof nonce produced an out-of-range challenge')
      }
      continue
    }
    const s = modAdd(k, modMul(c, e))
    if (c !== 0n && s !== 0n) {
      return {
        ephemeralSecret: scalarBytes(e),
        ephemeralPoint,
        sharedPoint,
        proof: concat(scalarBytes(c), scalarBytes(s)),
      }
    }
    if (params.proofNonce !== undefined) {
      throw new Error('provided proof nonce produced a zero proof scalar')
    }
  }
}

/** Verifies a Frank-CBOR T3b proof. All inputs are public wire values. */
export function verifyFrankStampProof(params: {
  readonly network: string
  readonly stampKey: Uint8Array
  readonly ephemeralPoint: Uint8Array
  readonly sharedPoint: Uint8Array
  readonly proof: Uint8Array
}): boolean {
  try {
    if (params.proof.length !== 64) return false
    const c = scalarFromBytesCanonical(params.proof.subarray(0, 32), false)
    const s = scalarFromBytesCanonical(params.proof.subarray(32), false)
    const stampPoint = pointFromBytes(params.stampKey)
    const ephemeral = pointFromBytes(params.ephemeralPoint)
    const shared = pointFromBytes(params.sharedPoint)
    const r1 = G.multiply(s).subtract(ephemeral.multiply(c))
    const r2 = stampPoint.multiply(s).subtract(shared.multiply(c))
    return (
      challenge(
        params.network,
        params.stampKey,
        params.ephemeralPoint,
        params.sharedPoint,
        pointBytes(r1),
        pointBytes(r2),
      ) === c
    )
  } catch {
    return false
  }
}

/** Exact deterministic nonce from T3b; exported for vectors, not production reuse. */
export function frankStampDeterministicNonce(params: {
  readonly network: string
  readonly ephemeralSecret: Uint8Array
  readonly stampKey: Uint8Array
  readonly ephemeralPoint: Uint8Array
  readonly sharedPoint: Uint8Array
}): Uint8Array {
  const digest = sha256(
    concat(
      transcriptPrefix(NONCE_DOMAIN, params.network),
      params.ephemeralSecret,
      params.stampKey,
      params.ephemeralPoint,
      params.sharedPoint,
    ),
  )
  const scalar = scalarFromBytesCanonical(digest, false)
  return scalarBytes(scalar)
}
