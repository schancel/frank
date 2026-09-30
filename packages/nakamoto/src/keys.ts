// Private keys, WIF, and the public points derived from them.
// A raw 32-byte secret does not imply a compression flag or a network.
// WIF version bytes come from the chain descriptor the caller passes.
// Range is [1, n). The brand constructor privateKeyFromBytes does not
// check the curve order; that stayed the issue 237 contract.

import { decodeBase58Check, encodeBase58Check } from './base58check.js'
import type { ChainDescriptor } from './chain/types.js'
import {
  compressedPublicKeyFromBytes,
  privateKeyFromBytes,
  xOnlyPublicKeyFromBytes,
  type CompressedPublicKey,
  type PrivateKey,
  type XOnlyPublicKey,
} from './constructors.js'
import { type EncodingError } from './encoding-error.js'
import { bytesToBigint } from './integer.js'
import {
  compressPoint,
  isValidScalar,
  multiplyGenerator,
  uncompressPoint,
  xOnlyPoint,
} from './secp256k1.js'

type Brand<T, Name extends string> = T & { readonly __nakamoto: Name }

/** 65-byte SEC1 point, prefix 0x04. Not a compressed key. */
export type UncompressedPublicKey = Brand<Uint8Array, 'uncompressed-pubkey'>

export interface DerivedPublicKey {
  readonly compressed: CompressedPublicKey
  readonly uncompressed: UncompressedPublicKey
  readonly xOnly: XOnlyPublicKey
}

export interface ScalarOutOfRange {
  readonly code: 'scalar-out-of-range'
}

export interface CompressionRequired {
  readonly code: 'compression-required'
}

export interface ChainRequired {
  readonly code: 'chain-required'
}

export interface WifVersion {
  readonly code: 'wif-version'
  readonly expected: number
  readonly actual: number
}

export interface WifPayloadLength {
  readonly code: 'wif-payload-length'
  readonly actual: number
}

export interface WifCompressionFlag {
  readonly code: 'wif-compression-flag'
}

export interface HexInvalid {
  readonly code: 'hex-invalid'
}

export interface PublicKeyInvalid {
  readonly code: 'public-key-invalid'
}

export type KeyError =
  | ScalarOutOfRange
  | CompressionRequired
  | ChainRequired
  | WifVersion
  | WifPayloadLength
  | WifCompressionFlag
  | HexInvalid
  | PublicKeyInvalid

export type KeyFailure = KeyError | EncodingError

export type KeyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KeyFailure }

const KEY_CODES: ReadonlySet<string> = new Set([
  'scalar-out-of-range',
  'compression-required',
  'chain-required',
  'wif-version',
  'wif-payload-length',
  'wif-compression-flag',
  'hex-invalid',
  'public-key-invalid',
])

export function isKeyError(value: unknown): value is KeyError {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && KEY_CODES.has(code)
}

function fail<T>(error: KeyFailure): KeyResult<T> {
  return { ok: false, error }
}

function wipe(bytes: Uint8Array): void {
  bytes.fill(0)
}

function requireCompression(compressed: boolean): KeyResult<boolean> {
  if (typeof compressed !== 'boolean')
    return fail({ code: 'compression-required' })
  return { ok: true, value: compressed }
}

function requireChain(chain: ChainDescriptor): KeyResult<ChainDescriptor> {
  if (
    typeof chain !== 'object' ||
    chain === null ||
    !Number.isInteger(chain.wifVersion) ||
    chain.wifVersion < 0 ||
    chain.wifVersion > 0xff
  ) {
    return fail({ code: 'chain-required' })
  }
  return { ok: true, value: chain }
}

/**
 * Copies `bytes` and requires `compressed`. Rejects 0 and scalars outside
 * [1, n). There is no default network.
 */
export function privateKeyFromSecretBytes(
  bytes: Uint8Array,
  compressed: boolean,
): KeyResult<PrivateKey> {
  const flag = requireCompression(compressed)
  if (!flag.ok) return flag
  const branded = privateKeyFromBytes(bytes, flag.value)
  if (!branded.ok) return branded
  if (!isValidScalar(bytesToBigint(branded.value.bytes))) {
    wipe(branded.value.bytes)
    return fail({ code: 'scalar-out-of-range' })
  }
  return branded
}

/** 64 hex characters. `compressed` is still required; the text has no flag. */
export function privateKeyFromHex(
  hex: string,
  compressed: boolean,
): KeyResult<PrivateKey> {
  const flag = requireCompression(compressed)
  if (!flag.ok) return flag
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    return fail({ code: 'hex-invalid' })
  }
  const bytes = new Uint8Array(32)
  for (let index = 0; index < 32; index += 1) {
    const pair = hex.slice(index * 2, index * 2 + 2)
    bytes[index] = Number.parseInt(pair, 16)
  }
  const key = privateKeyFromSecretBytes(bytes, flag.value)
  wipe(bytes)
  return key
}

function brandUncompressed(bytes: Uint8Array): UncompressedPublicKey {
  return bytes as UncompressedPublicKey
}

/** Compressed, uncompressed, and x-only forms. The x-only form is not tweaked. */
export function publicFromPrivate(
  key: PrivateKey,
): KeyResult<DerivedPublicKey> {
  const scalar = bytesToBigint(key.bytes)
  if (!isValidScalar(scalar)) return fail({ code: 'scalar-out-of-range' })
  const point = multiplyGenerator(scalar)
  if (point === null) return fail({ code: 'public-key-invalid' })
  const compressedBytes = compressPoint(point)
  const uncompressedBytes = uncompressPoint(point)
  const xOnlyBytes = xOnlyPoint(point)
  if (
    compressedBytes === null ||
    uncompressedBytes === null ||
    xOnlyBytes === null
  ) {
    return fail({ code: 'public-key-invalid' })
  }
  const compressed = compressedPublicKeyFromBytes(compressedBytes)
  const xOnly = xOnlyPublicKeyFromBytes(xOnlyBytes)
  if (!compressed.ok || !xOnly.ok) return fail({ code: 'public-key-invalid' })
  if (uncompressedBytes.length !== 65 || uncompressedBytes[0] !== 0x04) {
    return fail({ code: 'public-key-invalid' })
  }
  return {
    ok: true,
    value: Object.freeze({
      compressed: compressed.value,
      uncompressed: brandUncompressed(uncompressedBytes),
      xOnly: xOnly.value,
    }),
  }
}

/** WIF using `chain.wifVersion` and `key.compressed`. No default network. */
export function privateKeyToWif(
  key: PrivateKey,
  chain: ChainDescriptor,
): KeyResult<string> {
  const descriptor = requireChain(chain)
  if (!descriptor.ok) return descriptor
  if (typeof key.compressed !== 'boolean') {
    return fail({ code: 'compression-required' })
  }
  if (!isValidScalar(bytesToBigint(key.bytes))) {
    return fail({ code: 'scalar-out-of-range' })
  }
  const payload = new Uint8Array(key.compressed ? 34 : 33)
  payload[0] = descriptor.value.wifVersion
  payload.set(key.bytes, 1)
  if (key.compressed) payload[33] = 0x01
  const text = encodeBase58Check(payload)
  wipe(payload)
  return { ok: true, value: text }
}

/**
 * Decodes WIF. The leading byte must equal `chain.wifVersion`.
 * 34-byte payloads must end in 0x01. A bare 32-byte secret is not WIF.
 */
export function privateKeyFromWif(
  text: string,
  chain: ChainDescriptor,
): KeyResult<PrivateKey> {
  const descriptor = requireChain(chain)
  if (!descriptor.ok) return descriptor
  const decoded = decodeBase58Check(text)
  if (!decoded.ok) return decoded
  const payload = decoded.value
  const length = payload.length
  if (length !== 33 && length !== 34) {
    wipe(payload)
    return fail({ code: 'wif-payload-length', actual: length })
  }
  const actual = payload[0] ?? 0
  if (actual !== descriptor.value.wifVersion) {
    wipe(payload)
    return fail({
      code: 'wif-version',
      expected: descriptor.value.wifVersion,
      actual,
    })
  }
  if (length === 34 && payload[33] !== 0x01) {
    wipe(payload)
    return fail({ code: 'wif-compression-flag' })
  }
  const secret = new Uint8Array(payload.subarray(1, 33))
  const compressed = length === 34
  wipe(payload)
  const key = privateKeyFromSecretBytes(secret, compressed)
  wipe(secret)
  return key
}
