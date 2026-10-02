// Stage 10.6 (README section 9): every type-2 signature entry and every key-transition
// authorization verifies over its frozen transcript digest. This slice verifies algorithm 1
// only (strict-DER low-S secp256k1 ECDSA over the SHA-256 digest, key type 1); an entry whose
// algorithm is allocated but not verifiable here (2, 3, 16) is `unsupported` at 10.6 before any
// verification runs (M7), never `cryptographic` (V3: unverified semantics are not verified).
import { secp256k1 } from '@noble/curves/secp256k1.js'

import { FrankCodecError } from './errors'
import { directorySignatureDigest, keyTransitionSignatureDigest } from './hash'
import type {
  DirectoryAttestation,
  DirectoryStatement,
  KeyTransitionStatement,
  ParsedFrame,
} from './types'

/** Group order `n` of secp256k1. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** Allocated signature algorithms this slice cannot verify (M7). */
const UNVERIFIABLE_ALGORITHMS: ReadonlySet<number> = new Set([2, 3, 16])

const fail = (
  category: 'unsupported' | 'cryptographic',
  message: string,
  location: string,
): FrankCodecError => new FrankCodecError(category, '10.6', message, location)

function bytesToBigInt(b: Uint8Array): bigint {
  let x = 0n
  for (const v of b) x = (x << 8n) | BigInt(v)
  return x
}

/**
 * Strict DER (S2a): `SEQUENCE {r INTEGER, s INTEGER}`, fully consumed, minimal contents, no
 * sign-extension beyond a leading zero, and both scalars in `1..n-1`. Anything else throws.
 */
export function parseStrictDer(der: Uint8Array): { r: bigint; s: bigint } {
  const bad = (m: string) =>
    fail('cryptographic', `malformed DER: ${m}`, 'root')
  const u8 = (i: number) => der[i]
  const len = (i: number): [number, number] => {
    const first = u8(i)
    if (first < 0x80) return [first, i + 1]
    if (first === 0x80 || first > 0x82) throw bad('unsupported length encoding')
    const n = first - 0x80
    let v = 0
    for (let k = 0; k < n; k++) v = v * 256 + u8(i + 1 + k)
    if (v < 0x80) throw bad('non-minimal length')
    return [v, i + 1 + n]
  }
  if (der.length < 8 || der.length > 72) throw bad('length outside 8..72')
  if (u8(0) !== 0x30) throw bad('missing SEQUENCE')
  const [seqLen, afterSeqLen] = len(1)
  if (afterSeqLen + seqLen !== der.length) throw bad('SEQUENCE length mismatch')
  let i = afterSeqLen
  if (u8(i) !== 0x02) throw bad('r is not an INTEGER')
  const [rLen, afterRLen] = len(i + 1)
  const rBytes = der.subarray(afterRLen, afterRLen + rLen)
  i = afterRLen + rLen
  if (u8(i) !== 0x02) throw bad('s is not an INTEGER')
  const [sLen, afterSLen] = len(i + 1)
  const sBytes = der.subarray(afterSLen, afterSLen + sLen)
  if (afterSLen + sLen !== der.length) throw bad('trailing bytes after s')
  const scalar = (b: Uint8Array, what: string): bigint => {
    if (b.length === 0) throw bad(`empty ${what}`)
    if (b[0] & 0x80) throw bad(`negative ${what}`)
    if (b.length > 1 && b[0] === 0 && !(b[1] & 0x80))
      throw bad(`non-minimal ${what}`)
    const v = bytesToBigInt(b)
    if (v < 1n || v >= N) throw bad(`${what} outside 1..n-1`)
    return v
  }
  return { r: scalar(rBytes, 'r'), s: scalar(sBytes, 's') }
}

/** Low-S (S2a): reject `s > n/2` so every signature has exactly one S-value. */
export function hasLowS(s: bigint): boolean {
  return s <= N >> 1n
}

/**
 * Verifies one algorithm-1 entry: strict-DER parse, low-S, then ECDSA over the 32-byte digest
 * with the 33-byte compressed SEC1 signer key. Returns `false` for a well-formed entry whose
 * signature does not verify; throws nothing.
 */
export function verifyAlgorithm1(
  digest: Uint8Array,
  der: Uint8Array,
  signerKey: Uint8Array,
): boolean {
  let r: bigint
  let s: bigint
  try {
    const parsed = parseStrictDer(der)
    r = parsed.r
    s = parsed.s
  } catch (e) {
    if (e instanceof FrankCodecError && e.category === 'cryptographic')
      return false
    throw e
  }
  if (!hasLowS(s)) return false
  const compact = new Uint8Array(64)
  for (let i = 0; i < 32; i++) {
    compact[i] = Number((r >> BigInt(8 * (31 - i))) & 0xffn)
    compact[32 + i] = Number((s >> BigInt(8 * (31 - i))) & 0xffn)
  }
  try {
    return secp256k1.verify(compact, digest, signerKey, { lowS: false })
  } catch {
    return false
  }
}

type VerifiableEntry = {
  algorithm: number
  signer: { keyType: number; keyBytes: Uint8Array }
  signature: Uint8Array
}

function preflightAlgorithm(entry: VerifiableEntry, location: string): void {
  if (UNVERIFIABLE_ALGORITHMS.has(entry.algorithm)) {
    throw fail(
      'unsupported',
      `algorithm ${entry.algorithm} is allocated but not verifiable in this slice (M7)`,
      location,
    )
  }
}

function verifyEntry(
  entry: VerifiableEntry,
  digest: Uint8Array,
  location: string,
): void {
  preflightAlgorithm(entry, location)
  if (entry.algorithm === 1) {
    if (entry.signer.keyType !== 1) {
      throw fail(
        'cryptographic',
        'algorithm 1 needs a key-type-1 signer',
        location,
      )
    }
    if (!verifyAlgorithm1(digest, entry.signature, entry.signer.keyBytes)) {
      throw fail(
        'cryptographic',
        'the algorithm-1 signature does not verify over the transcript digest',
        location,
      )
    }
    return
  }
  throw fail(
    'unsupported',
    `algorithm ${entry.algorithm} is not allocated to this reader (S2a)`,
    location,
  )
}

function statementOf(f: ParsedFrame): DirectoryStatement<ParsedFrame> {
  const t = f.typed
  if (!t || t.type !== 4)
    throw new Error('internal: expected an opened type-4 frame')
  return t
}

function transitionOf(f: ParsedFrame): KeyTransitionStatement {
  const t = f.typed
  if (!t || t.type !== 7)
    throw new Error('internal: expected an opened type-7 frame')
  return t
}

/**
 * Stage 10.6 for a type-2 root: first preflight all entries for allocated-but-unverifiable
 * algorithms (M7), then verify signature entries followed by key-transition authorizations in
 * document order.
 */
export function verifyDirectoryAttestation(
  attestation: DirectoryAttestation<ParsedFrame>,
): void {
  const statement = statementOf(attestation.statementFrame)
  const transitions = statement.keyTransitions ?? []
  // M7 applies to the whole attestation: discover every allocated-but-unverifiable algorithm
  // before running any algorithm-1 verification.
  attestation.signatures.forEach((entry, i) =>
    preflightAlgorithm(entry, `root/payload.1[${i}]`),
  )
  transitions.forEach((entry, i) =>
    preflightAlgorithm(entry, `root/payload.0/5[${i}]`),
  )
  const frameBytes = attestation.statementFrame.frame
  const digest = directorySignatureDigest(statement.network, frameBytes)
  attestation.signatures.forEach((entry, i) =>
    verifyEntry(entry, digest, `root/payload.1[${i}]`),
  )
  transitions.forEach((t, i) => {
    const ts = transitionOf(t.statementFrame)
    const tDigest = keyTransitionSignatureDigest(
      ts.network,
      t.statementFrame.frame,
    )
    verifyEntry(t, tDigest, `root/payload.0/5[${i}]`)
  })
}
