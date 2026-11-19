// Lotus v2 hash commitments (P02 "Hash registry", "Branch MAST",
// "Indexed binary Merkle tree"). Every hash is a tagged BLAKE3 whose tag
// prefix comes from the descriptor's `hash` capability.

import { blake3 } from '@noble/hashes/blake3.js'

import { concatBytes } from '../bytes.js'
import type { LotusV2ChainDescriptor } from '../chain/types.js'
import { encodeVarint } from '../varint.js'

/** Hash domains this package computes (P02 registry names). */
export type LotusV2HashName =
  | 'branch'
  | 'txid'
  | 'txhash'
  | 'sighash'
  | 'inputcore'
  | 'inputfull'
  | 'coinentry'
  | 'owninput'
  | 'output'
  | 'merkleidx'

const ZERO32 = new Uint8Array(32)

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code > 0x7f) throw new RangeError('Lotus v2 hash tags are ASCII')
    out[i] = code
  }
  return out
}

/** Unkeyed 32-byte BLAKE3. */
export function blake3Hash(bytes: Uint8Array): Uint8Array {
  return blake3(bytes)
}

/** `H_name(x) = BLAKE3(ASCII(tagPrefix + name) || 00 || x)`. */
export function lotusV2TaggedHash(
  chain: LotusV2ChainDescriptor,
  name: LotusV2HashName,
  payload: Uint8Array,
): Uint8Array {
  return blake3(
    concatBytes([
      ascii(`${chain.hash.tagPrefix}${name}`),
      Uint8Array.of(0),
      payload,
    ]),
  )
}

/** CompactSize length prefix, then the bytes (`Bytes(x)` in C04). */
export function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const length = encodeVarint(BigInt(bytes.length))
  if (!length.ok) throw new RangeError('length out of range')
  return concatBytes([length.value, bytes])
}

/** `Leaf(script) = H_branch(00 || Bytes(script))`. */
export function lotusV2BranchLeaf(
  chain: LotusV2ChainDescriptor,
  script: Uint8Array,
): Uint8Array {
  return lotusV2TaggedHash(
    chain,
    'branch',
    concatBytes([Uint8Array.of(0), lengthPrefixed(script)]),
  )
}

function lessLittleEndian(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 31; i >= 0; i -= 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

/** `BranchNode(a,b) = H_branch(01 || min(a,b) || max(a,b))`, hashes read as little-endian integers. */
export function lotusV2BranchNode(
  chain: LotusV2ChainDescriptor,
  a: Uint8Array,
  b: Uint8Array,
): Uint8Array {
  const [low, high] = lessLittleEndian(a, b) ? [a, b] : [b, a]
  return lotusV2TaggedHash(
    chain,
    'branch',
    concatBytes([Uint8Array.of(1), low, high]),
  )
}

/** Fold a membership proof bottom-up; no siblings means the root is the leaf. */
export function lotusV2BranchProofRoot(
  chain: LotusV2ChainDescriptor,
  leaf: Uint8Array,
  siblings: readonly Uint8Array[],
): Uint8Array {
  let root = leaf
  for (const sibling of siblings) root = lotusV2BranchNode(chain, root, sibling)
  return root
}

function u16(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >> 8) & 0xff)
}

/**
 * P02 `IndexedTreeRoot`: empty -> `H_merkleidx(02)`; one leaf -> the leaf;
 * otherwise bottom-up layers `s = 0, 1, …` of `H_merkleidx(01 || u16(s) || l || r)`,
 * an odd layer padded on the right with 32 zero bytes.
 */
export function lotusV2IndexedTreeRoot(
  chain: LotusV2ChainDescriptor,
  leaves: readonly Uint8Array[],
): Uint8Array {
  if (chain.merkle.oddRule !== 'pad-zero')
    throw new RangeError('unsupported Merkle rule')
  if (leaves.length === 0)
    return lotusV2TaggedHash(chain, 'merkleidx', Uint8Array.of(2))
  let layer = [...leaves]
  let s = 0
  while (layer.length > 1) {
    if (layer.length % 2 === 1) layer.push(ZERO32)
    const next: Uint8Array[] = []
    for (let i = 0; i < layer.length; i += 2) {
      next.push(
        lotusV2TaggedHash(
          chain,
          'merkleidx',
          concatBytes([
            Uint8Array.of(1),
            u16(s),
            layer[i] as Uint8Array,
            layer[i + 1] as Uint8Array,
          ]),
        ),
      )
    }
    layer = next
    s += 1
  }
  return layer[0] as Uint8Array
}
