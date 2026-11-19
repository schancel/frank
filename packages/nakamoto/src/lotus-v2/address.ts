// Lotus v2 typed addresses (Lotus repository docs/lotus-v2/addresses.md).
//
// `<hrp> "1" <type> <payload: 52 symbols> <checksum: 8 symbols>`: the cashaddr
// alphabet and 40-bit BCH generator, no prefix expansion, no final xor, and a
// per-network checksum constant. Type 0 carries an explicit branch root; type 1
// carries the BLAKE3 keyhash of an x-only key and expands to the keyhash
// program. Types 2-31 are rejected.

import { polymod40 } from '../cashaddr.js'
import type { LotusV2ChainDescriptor, NetworkKind } from '../chain/types.js'
import { lotusV2BranchLeaf } from './hash.js'
import { lotusV2KeyhashProgram } from './template.js'

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BODY_SYMBOLS = 61
const PAYLOAD_SYMBOLS = 52

/**
 * Every prefix addresses.md assigns, with its checksum constant. Used only to
 * classify a string: a well-formed address of a network nakamoto has no
 * descriptor for is `network-not-defined`, not malformed.
 */
export const LOTUS_V2_ADDRESS_PREFIXES: Readonly<
  Record<
    string,
    { readonly network: NetworkKind; readonly checksumConstant: bigint }
  >
> = Object.freeze({
  xpi: Object.freeze({
    network: 'mainnet' as const,
    checksumConstant: 0xb70061479en,
  }),
  txpi: Object.freeze({
    network: 'testnet' as const,
    checksumConstant: 0xadda0f1635n,
  }),
  rxpi: Object.freeze({
    network: 'regtest' as const,
    checksumConstant: 0x8172b45d63n,
  }),
})

/** The spec's rejection reasons (addresses.md "Decoding, in order"), kebab-cased. */
export type LotusV2AddressErrorCode =
  | 'mixed-case'
  | 'unknown-prefix'
  | 'bad-length'
  | 'bad-character'
  | 'bad-checksum'
  | 'unknown-version'
  | 'nonzero-padding'
  | 'wrong-network'
  | 'network-not-defined'

export interface LotusV2AddressError {
  readonly code: LotusV2AddressErrorCode
  /** For `wrong-network` and `network-not-defined`: the network the prefix names. */
  readonly network?: NetworkKind
}

export type LotusV2AddressResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LotusV2AddressError }

/** What a payer locks coins to: always a single branch root, path `[[0]]`. */
export type LotusV2Destination =
  | { readonly type: 0; readonly root: Uint8Array }
  | {
      readonly type: 1
      readonly keyhash: Uint8Array
      readonly program: Uint8Array
      readonly root: Uint8Array
    }

function fail<T>(
  code: LotusV2AddressErrorCode,
  network?: NetworkKind,
): LotusV2AddressResult<T> {
  return { ok: false, error: network ? { code, network } : { code } }
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

/** Encode a type-0 (branch root) or type-1 (keyhash) address on `chain`. */
export function encodeLotusV2Address(
  chain: LotusV2ChainDescriptor,
  type: 0 | 1,
  payload: Uint8Array,
): string {
  if (!chain.address.types.includes(type))
    throw new RangeError(`address type ${type} is not supported`)
  if (!(payload instanceof Uint8Array) || payload.length !== 32)
    throw new RangeError('Lotus v2 address payloads are 32 bytes')
  let p = bytesToBigint(payload) << 4n
  const groups: number[] = []
  for (let i = 0; i < PAYLOAD_SYMBOLS; i += 1) {
    groups.unshift(Number(p & 31n))
    p >>= 5n
  }
  const data = [type, ...groups]
  const mod =
    polymod40([...data, 0, 0, 0, 0, 0, 0, 0, 0]) ^
    chain.address.checksumConstant
  for (let i = 0; i < 8; i += 1)
    data.push(Number((mod >> BigInt(5 * (7 - i))) & 31n))
  return `${chain.address.hrp}1${data.map(d => CHARSET[d]).join('')}`
}

/** Type-1 address of a 32-byte keyhash. */
export function encodeLotusV2KeyhashAddress(
  chain: LotusV2ChainDescriptor,
  keyhash: Uint8Array,
): string {
  return encodeLotusV2Address(chain, 1, keyhash)
}

/**
 * Decode an address for `chain`, in the spec's order. A string whose prefix
 * belongs to another known network, with a valid checksum under that
 * network's constant, is `network-not-defined` (nakamoto has no descriptor
 * for it) or `wrong-network`.
 */
export function decodeLotusV2Address(
  chain: LotusV2ChainDescriptor,
  input: string,
  known: readonly LotusV2ChainDescriptor[] = [chain],
): LotusV2AddressResult<LotusV2Destination> {
  if (typeof input !== 'string') return fail('unknown-prefix')
  if (input !== input.toLowerCase() && input !== input.toUpperCase())
    return fail('mixed-case')
  const text = input.toLowerCase()
  const split = text.lastIndexOf('1')
  if (split < 0) return fail('unknown-prefix')
  const hrp = text.slice(0, split)
  const prefix = Object.prototype.hasOwnProperty.call(
    LOTUS_V2_ADDRESS_PREFIXES,
    hrp,
  )
    ? LOTUS_V2_ADDRESS_PREFIXES[hrp]
    : undefined
  if (prefix === undefined) return fail('unknown-prefix')
  const body = text.slice(split + 1)
  if (body.length !== BODY_SYMBOLS) return fail('bad-length')
  const symbols = [...body].map(ch => CHARSET.indexOf(ch))
  if (symbols.some(s => s < 0)) return fail('bad-character')
  if (polymod40(symbols) !== prefix.checksumConstant)
    return fail('bad-checksum')
  if (hrp !== chain.address.hrp) {
    const defined = known.some(c => c.address.hrp === hrp)
    return fail(
      defined ? 'wrong-network' : 'network-not-defined',
      prefix.network,
    )
  }
  const type = symbols[0]
  if (type !== 0 && type !== 1) return fail('unknown-version')
  if (!chain.address.types.includes(type)) return fail('unknown-version')
  let p = 0n
  for (const s of symbols.slice(1, 1 + PAYLOAD_SYMBOLS)) p = p * 32n + BigInt(s)
  if ((p & 15n) !== 0n) return fail('nonzero-padding')
  p >>= 4n
  const payload = new Uint8Array(32)
  for (let i = 31; i >= 0; i -= 1) {
    payload[i] = Number(p & 255n)
    p >>= 8n
  }
  if (type === 0) return { ok: true, value: { type: 0, root: payload } }
  const program = lotusV2KeyhashProgram(payload)
  return {
    ok: true,
    value: {
      type: 1,
      keyhash: payload,
      program,
      root: lotusV2BranchLeaf(chain, program),
    },
  }
}
