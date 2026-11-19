// Lotus v2 legacy coins (P01 "Spending a legacy coin").
//
//   LegacyCoinOutput = 80 || value:u64 || Bytes(scriptPubKey)
//   LegacyBridgeLeaf = H_branch(03 || Bytes(scriptPubKey) || Bytes(witness_script))
//
// A legacy coin is native value imported from a v1 output under a migration
// profile. It stands where a V2 coin's `Output` wire stands (CoinEntry,
// CoinsRoot, OwnInputHash). Only P2PKH and P2SH scriptPubKeys can be spent,
// through a version-7 spend input with path 0 and one sibling-free witness.
//
// nakamoto computes the signing message for both templates (the message does
// not depend on the template beyond the bridge leaf) and builds and verifies
// P2PKH spends, whose signature is a BIP340 CHECKSIG operand. A P2SH spend runs
// the legacy script interpreter with legacy ECDSA/Schnorr signatures; nakamoto
// does not, and reports it as unsupported.

import { cryptoBackend } from '../backend.js'
import { concatBytes } from '../bytes.js'
import type { LotusV2ChainDescriptor } from '../chain/types.js'
import { ByteReader, ByteWriter } from '../reader.js'
import { lengthPrefixed, lotusV2TaggedHash } from './hash.js'
import {
  decodeLotusV2Output,
  encodeLotusV2Output,
  type LotusV2BranchWitness,
  LotusV2FormatError,
  type LotusV2Input,
  type LotusV2Output,
} from './transaction.js'

/** C16a `MAX_MONEY` (recommended, awaiting owner sign-off): `MoneyRange(v)` is `0 <= v <= 2^62`. */
export const LOTUS_V2_MAX_MONEY = 1n << 62n
/** P01: a legacy scriptPubKey is at most 10,000 bytes. */
export const LOTUS_V2_MAX_LEGACY_SCRIPT_BYTES = 10_000

export interface LotusV2LegacyCoin {
  readonly legacy: true
  readonly value: bigint
  readonly scriptPubKey: Uint8Array
}

/** What a spend input resolves: a V2 output or a legacy coin. */
export type LotusV2Coin = LotusV2Output | LotusV2LegacyCoin

export function isLotusV2LegacyCoin(
  coin: LotusV2Coin,
): coin is LotusV2LegacyCoin {
  return (coin as LotusV2LegacyCoin).legacy === true
}

function check(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new LotusV2FormatError(reason)
}

function validateLegacyCoin(coin: LotusV2LegacyCoin): void {
  check(
    coin.scriptPubKey instanceof Uint8Array &&
      coin.scriptPubKey.length <= LOTUS_V2_MAX_LEGACY_SCRIPT_BYTES,
    'legacy coin',
  )
  check(
    typeof coin.value === 'bigint' &&
      coin.value >= 0n &&
      coin.value <= LOTUS_V2_MAX_MONEY,
    'legacy coin value',
  )
}

/** `CoinOutput(coin)`: the coin's `Output` wire, or `LegacyCoinOutput`. */
export function encodeLotusV2CoinOutput(coin: LotusV2Coin): Uint8Array {
  if (!isLotusV2LegacyCoin(coin)) return encodeLotusV2Output(coin)
  validateLegacyCoin(coin)
  return concatBytes([
    new ByteWriter().writeUInt8(0x80).writeUInt64LE(coin.value).finish(),
    lengthPrefixed(coin.scriptPubKey),
  ])
}

/**
 * Parse `CoinOutput` exactly: a leading `80` is a legacy coin (shortest
 * CompactSize length, no trailing bytes, value in MoneyRange), anything else an
 * `Output`.
 */
export function decodeLotusV2CoinOutput(bytes: Uint8Array): LotusV2Coin {
  if (bytes[0] !== 0x80) return decodeLotusV2Output(bytes)
  const r = new ByteReader(bytes, 1)
  const value = r.readUInt64LE()
  check(value.ok, 'legacy coin bytes')
  const script = r.readBytesPrefixed()
  check(script.ok, 'legacy coin bytes')
  check(r.finished(), 'legacy coin bytes')
  const coin: LotusV2LegacyCoin = {
    legacy: true,
    value: value.value,
    scriptPubKey: script.value,
  }
  validateLegacyCoin(coin)
  return coin
}

export type LotusV2LegacyTemplate =
  | { readonly kind: 'p2pkh'; readonly hash: Uint8Array }
  | { readonly kind: 'p2sh'; readonly hash: Uint8Array }

/** P01 spend rule 1: `76 a9 14 <20> 88 ac` or `a9 14 <20> 87`; anything else is unspendable. */
export function lotusV2LegacyTemplate(
  scriptPubKey: Uint8Array,
): LotusV2LegacyTemplate | undefined {
  const s = scriptPubKey
  if (
    s.length === 25 &&
    s[0] === 0x76 &&
    s[1] === 0xa9 &&
    s[2] === 0x14 &&
    s[23] === 0x88 &&
    s[24] === 0xac
  )
    return { kind: 'p2pkh', hash: s.slice(3, 23) }
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87)
    return { kind: 'p2sh', hash: s.slice(2, 22) }
  return undefined
}

/** `LegacyBridgeLeaf = H_branch(03 || Bytes(scriptPubKey) || Bytes(witness_script))`. */
export function lotusV2LegacyBridgeLeaf(
  chain: LotusV2ChainDescriptor,
  scriptPubKey: Uint8Array,
  witnessScript: Uint8Array,
): Uint8Array {
  return lotusV2TaggedHash(
    chain,
    'branch',
    concatBytes([
      Uint8Array.of(3),
      lengthPrefixed(scriptPubKey),
      lengthPrefixed(witnessScript),
    ]),
  )
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function hash160(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(cryptoBackend.hash160(bytes))
}

/**
 * P01 spend rules 1-3 and the P2PKH empty-script rule for a legacy-bridge
 * input: what the signing message depends on. Returns the input's only
 * witness. The P2PKH argument rule (exactly `[signature, compressed key]`) is
 * checked where the arguments exist, in {@link verifyLotusV2LegacyP2pkh}.
 */
export function lotusV2LegacyBridgeWitness(
  input: Extract<LotusV2Input, { kind: 'spend' }>,
  coin: LotusV2LegacyCoin,
): {
  readonly template: LotusV2LegacyTemplate
  readonly witness: LotusV2BranchWitness
} {
  const template = lotusV2LegacyTemplate(coin.scriptPubKey)
  check(template !== undefined, 'legacy coin script')
  const witness = input.witnesses[0]
  check(
    input.pathIndex === 0 &&
      input.witnesses.length === 1 &&
      witness !== undefined &&
      witness.siblings.length === 0,
    'legacy coin witness',
  )
  if (template.kind === 'p2sh')
    check(equal(hash160(witness.script), template.hash), 'legacy redeem script')
  else check(witness.script.length === 0, 'legacy coin witness')
  return { template, witness }
}

/**
 * P01 P2PKH rule 4: the key is a 33-byte compressed SEC key whose HASH160 is
 * the coin's hash. Returns its x-only form (`public_key[1..33]`).
 */
export function lotusV2LegacyP2pkhKey(
  coin: LotusV2LegacyCoin,
  compressedPublicKey: Uint8Array,
): Uint8Array {
  const template = lotusV2LegacyTemplate(coin.scriptPubKey)
  check(template?.kind === 'p2pkh', 'legacy coin script')
  check(
    compressedPublicKey.length === 33 &&
      (compressedPublicKey[0] === 2 || compressedPublicKey[0] === 3) &&
      equal(hash160(compressedPublicKey), template.hash),
    'legacy p2pkh key',
  )
  return compressedPublicKey.slice(1)
}
