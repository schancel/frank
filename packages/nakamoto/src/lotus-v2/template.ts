// Spending-program templates whose exact bytes the spec fixes.
//
// Opcodes (Lotus repository docs/lotus-v2/tools/opcodes.json, P03): 0x20 is a
// 32-byte push, 0x7a DUP, 0xba BLAKE3, 0x92 EQUALVERIFY, 0xbb CHECKSIG.

import { blake3 } from '@noble/hashes/blake3.js'

import { concatBytes } from '../bytes.js'

function require32(bytes: Uint8Array, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32)
    throw new RangeError(`${what} must be 32 bytes`)
}

/** Type-1 payload: unkeyed BLAKE3 of the 32-byte x-only key (addresses.md "Type 1"). */
export function lotusV2Keyhash(xOnlyPublicKey: Uint8Array): Uint8Array {
  require32(xOnlyPublicKey, 'x-only public key')
  return blake3(xOnlyPublicKey)
}

/** The 37-byte type-1 program `DUP BLAKE3 PUSH32(keyhash) EQUALVERIFY CHECKSIG`. */
export function lotusV2KeyhashProgram(keyhash: Uint8Array): Uint8Array {
  require32(keyhash, 'keyhash')
  return concatBytes([
    Uint8Array.of(0x7a, 0xba, 0x20),
    keyhash,
    Uint8Array.of(0x92, 0xbb),
  ])
}

/**
 * The 34-byte program `PUSH32(key) CHECKSIG`: the Lotus v2 compiler's
 * `Payment` contract (tools/lotus-v2-compiler/fixtures/key3-one-output.json)
 * and the shape the reference signed-payment vector spends. Not an address
 * template: it is paid as an explicit (type-0) branch root.
 */
export function lotusV2PublicKeyProgram(
  xOnlyPublicKey: Uint8Array,
): Uint8Array {
  require32(xOnlyPublicKey, 'x-only public key')
  return concatBytes([Uint8Array.of(0x20), xOnlyPublicKey, Uint8Array.of(0xbb)])
}

/**
 * A single-signature spend: its program and how its argument stack is made
 * from the signature. The stack is listed bottom first.
 */
export interface LotusV2SignatureTemplate {
  readonly script: Uint8Array
  arguments(signature: Uint8Array): readonly Uint8Array[]
}

/** `[signature, xonly_public_key]`, the key on top (addresses.md "Type 1"). */
export function lotusV2KeyhashTemplate(
  xOnlyPublicKey: Uint8Array,
): LotusV2SignatureTemplate {
  const key = Uint8Array.from(xOnlyPublicKey)
  const script = lotusV2KeyhashProgram(lotusV2Keyhash(key))
  return Object.freeze({
    script,
    arguments: (signature: Uint8Array) => [Uint8Array.from(signature), key],
  })
}

/** `[signature]` for `PUSH32(key) CHECKSIG`. */
export function lotusV2PublicKeyTemplate(
  xOnlyPublicKey: Uint8Array,
): LotusV2SignatureTemplate {
  const script = lotusV2PublicKeyProgram(xOnlyPublicKey)
  return Object.freeze({
    script,
    arguments: (signature: Uint8Array) => [Uint8Array.from(signature)],
  })
}
