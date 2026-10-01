// Destination versus encoding. A destination is chain-neutral and maps to one
// locking script. The chain argument is required. XPI strings are not pinned
// (issue 242): encode and decode return address-format-not-pinned and do not
// build a string. Taproot output keys are encoded as given. This module does
// not add the tweak on the curve; issue 249 owns that check.

import { cryptoBackend } from './backend.js'
import { decodeBech32, encodeBech32, type Bech32Spec } from './bech32.js'
import { CASHADDR_CHARSET } from './base32.js'
import { decodeBase58Check, encodeBase58Check } from './base58check.js'
import { copyBytes } from './bytes.js'
import { decodeCashaddr, encodeCashaddr } from './cashaddr.js'
import { CHAINS } from './chain/index.js'
import type {
  ChainDescriptor,
  ChainFamily,
  NetworkKind,
} from './chain/types.js'
import { convertBits } from './convert-bits.js'
import {
  compressedPublicKeyFromBytes,
  pubkeyHashFromBytes,
  xOnlyPublicKeyFromBytes,
  type CompressedPublicKey,
  type PubkeyHash,
  type XOnlyPublicKey,
} from './constructors.js'
import {
  EncodingException,
  isEncodingError,
  type EncodingError,
} from './encoding-error.js'

type Brand<T, Name extends string> = T & { readonly __nakamoto: Name }

export type ScriptHash = Brand<Uint8Array, 'script-hash'>
export type WitnessScriptHash = Brand<Uint8Array, 'witness-script-hash'>

export type Destination =
  | { readonly kind: 'p2pkh'; readonly hash: PubkeyHash }
  | { readonly kind: 'p2sh'; readonly hash: ScriptHash }
  | { readonly kind: 'p2wpkh'; readonly hash: PubkeyHash }
  | { readonly kind: 'p2wsh'; readonly hash: WitnessScriptHash }
  | {
      readonly kind: 'p2sh-p2wpkh'
      readonly pubkeyHash: PubkeyHash
      readonly scriptHash: ScriptHash
    }
  | {
      readonly kind: 'p2tr'
      readonly outputKey: XOnlyPublicKey
      readonly tweak: Uint8Array | null
    }

export type AddressEncoding = 'base58check' | 'cashaddr' | 'bech32' | 'bech32m'

export interface AddressForm {
  readonly encoding: AddressEncoding
  readonly text: string
}

export interface AddressListing {
  readonly destination: Destination
  readonly chain: ChainDescriptor
  readonly forms: readonly AddressForm[]
  readonly stringEncoding:
    | { readonly status: 'pinned' }
    | {
        readonly status: 'unpinned'
        readonly code: 'address-format-not-pinned'
      }
}

export interface DecodedAddress {
  readonly destination: Destination
  readonly chain: ChainDescriptor
  readonly encoding: AddressEncoding
  readonly text: string
}

export interface TaprootCommitment {
  /** Witness program. Already the output key; this module does not tweak it. */
  readonly outputKey: XOnlyPublicKey
  /** Required so a zero tweak cannot be implied. Not mixed into the address. */
  readonly tweak: Uint8Array
}

export interface AddressFormatNotPinned {
  readonly code: 'address-format-not-pinned'
}

export interface NotRepresentable {
  readonly code: 'not-representable'
  readonly kind: Destination['kind']
  readonly family: ChainFamily
}

export interface ChainMismatch {
  readonly code: 'chain-mismatch'
  readonly detected: {
    readonly family: ChainFamily
    readonly network: NetworkKind
  }
  readonly supplied: {
    readonly family: ChainFamily
    readonly network: NetworkKind
  }
}

export interface ChainRequired {
  readonly code: 'chain-required'
}

export interface TaprootTweakRequired {
  readonly code: 'taproot-tweak-required'
}

export interface UnknownEncoding {
  readonly code: 'unknown-encoding'
  readonly encoding: AddressEncoding
}

export interface UnknownAddressType {
  readonly code: 'unknown-address-type'
  readonly version: number
}

export interface UnsupportedWitness {
  readonly code: 'unsupported-witness'
  readonly version: number
  readonly length: number
}

export interface WitnessProgramLength {
  readonly code: 'witness-program-length'
  readonly version: number
  readonly actual: number
}

export interface AddressMixedCase {
  readonly code: 'mixed-case'
}

export interface AddressChecksum {
  readonly code: 'bad-checksum'
}

export interface AddressWrongPrefix {
  readonly code: 'wrong-prefix'
  readonly prefix: string
}

/** Bech32 or cashaddr and base58check both checksum. Neither encoding is chosen. */
export interface AddressAmbiguous {
  readonly code: 'ambiguous-encoding'
}

export interface AddressTooLong {
  readonly code: 'address-too-long'
  readonly actual: number
}

export interface AddressSeparatorMissing {
  readonly code: 'separator-missing'
}

export interface AddressEmptyHrp {
  readonly code: 'empty-hrp'
}

export interface AddressHrpChar {
  readonly code: 'hrp-char'
  readonly index: number
}

/** Not lotusd MatchPayToPubkeyHash. Includes non-minimal pushes. */
export interface OutputScriptUnmatched {
  readonly code: 'output-script-unmatched'
}

export type AddressError =
  | EncodingError
  | AddressFormatNotPinned
  | NotRepresentable
  | ChainMismatch
  | ChainRequired
  | TaprootTweakRequired
  | UnknownEncoding
  | UnknownAddressType
  | UnsupportedWitness
  | WitnessProgramLength
  | AddressMixedCase
  | AddressChecksum
  | AddressWrongPrefix
  | AddressAmbiguous
  | AddressTooLong
  | AddressSeparatorMissing
  | AddressEmptyHrp
  | AddressHrpChar
  | OutputScriptUnmatched

export type AddressResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AddressError }

const ADDRESS_CODES: ReadonlySet<string> = new Set([
  'address-format-not-pinned',
  'not-representable',
  'chain-mismatch',
  'chain-required',
  'taproot-tweak-required',
  'unknown-encoding',
  'unknown-address-type',
  'unsupported-witness',
  'witness-program-length',
  'mixed-case',
  'bad-checksum',
  'wrong-prefix',
  'ambiguous-encoding',
  'address-too-long',
  'separator-missing',
  'empty-hrp',
  'hrp-char',
  'output-script-unmatched',
])

const OP_0 = 0x00
const OP_1 = 0x51
const OP_DUP = 0x76
const OP_HASH160 = 0xa9
const OP_EQUALVERIFY = 0x88
const OP_CHECKSIG = 0xac
const OP_EQUAL = 0x87
const PUSH_20 = 0x14
const PUSH_32 = 0x20
const HASH160_LENGTH = 20
const HASH256_LENGTH = 32

const SIZE_BYTES = [20, 24, 28, 32, 40, 48, 56, 64] as const

const CASH_CHAR = new Set(CASHADDR_CHARSET.split(''))

export function isAddressError(value: unknown): value is AddressError {
  if (isEncodingError(value)) return true
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && ADDRESS_CODES.has(code)
}

function fail(error: AddressError): AddressResult<never> {
  return { ok: false, error }
}

function relay(error: { readonly code: string }): AddressResult<never> {
  if (isAddressError(error)) return { ok: false, error }
  return fail({ code: 'bad-checksum' })
}

function hash160(bytes: Uint8Array) {
  return new Uint8Array(cryptoBackend.hash160(bytes))
}

function take(bytes: Uint8Array, length: number): AddressResult<Uint8Array> {
  const copied = copyBytes(bytes)
  if (copied.length !== length) {
    return fail({
      code: 'wrong-length',
      min: length,
      max: length,
      actual: copied.length,
    })
  }
  return { ok: true, value: copied }
}

function asPubkeyHash(bytes: Uint8Array): AddressResult<PubkeyHash> {
  return pubkeyHashFromBytes(bytes)
}

function asScriptHash(bytes: Uint8Array): AddressResult<ScriptHash> {
  const fixed = take(bytes, HASH160_LENGTH)
  if (!fixed.ok) return fixed
  return { ok: true, value: fixed.value as ScriptHash }
}

function asWitnessScript(bytes: Uint8Array): AddressResult<WitnessScriptHash> {
  const fixed = take(bytes, HASH256_LENGTH)
  if (!fixed.ok) return fixed
  return { ok: true, value: fixed.value as WitnessScriptHash }
}

function chainByCashaddr(prefix: string): ChainDescriptor | undefined {
  const matches = CHAINS.filter(item => item.cashaddrPrefix === prefix)
  if (matches.length !== 1) return undefined
  return matches[0]
}

function chainByBech32(hrp: string): ChainDescriptor | undefined {
  const matches = CHAINS.filter(item => item.bech32Hrp === hrp)
  if (matches.length !== 1) return undefined
  return matches[0]
}

function representable(
  chain: ChainDescriptor,
  kind: Destination['kind'],
): boolean {
  if (kind === 'p2pkh' || kind === 'p2sh') return true
  if (chain.bech32Hrp === null) return false
  return (
    kind === 'p2wpkh' ||
    kind === 'p2wsh' ||
    kind === 'p2tr' ||
    kind === 'p2sh-p2wpkh'
  )
}

function encodingsFor(
  chain: ChainDescriptor,
  kind: Destination['kind'],
): AddressEncoding[] {
  if (chain.family === 'xpi') return []
  if (kind === 'p2pkh' || kind === 'p2sh') {
    if (chain.cashaddrPrefix !== null) return ['cashaddr', 'base58check']
    return ['base58check']
  }
  if (chain.bech32Hrp === null) return []
  if (kind === 'p2wpkh' || kind === 'p2wsh') return ['bech32']
  if (kind === 'p2tr') return ['bech32m']
  if (kind === 'p2sh-p2wpkh') return ['base58check']
  return []
}

function cashVersion(type: 0 | 1, hashLength: number): AddressResult<number> {
  const size = SIZE_BYTES.indexOf(hashLength as (typeof SIZE_BYTES)[number])
  if (size < 0) {
    return fail({
      code: 'wrong-length',
      min: HASH160_LENGTH,
      max: HASH160_LENGTH,
      actual: hashLength,
    })
  }
  return { ok: true, value: (type << 3) | size }
}

function encodeCash(
  chain: ChainDescriptor,
  type: 0 | 1,
  hash: Uint8Array,
): AddressResult<string> {
  if (chain.family === 'xpi') return fail({ code: 'address-format-not-pinned' })
  const prefix = chain.cashaddrPrefix
  if (prefix === null) {
    return fail({
      code: 'not-representable',
      kind: type === 0 ? 'p2pkh' : 'p2sh',
      family: chain.family,
    })
  }
  const version = cashVersion(type, hash.length)
  if (!version.ok) return version
  const payload = new Uint8Array(hash.length + 1)
  payload[0] = version.value
  payload.set(hash, 1)
  const encoded = encodeCashaddr(prefix, payload)
  if (!encoded.ok) return relay(encoded.error)
  return encoded
}

function encodeLegacy(
  chain: ChainDescriptor,
  version: number,
  hash: Uint8Array,
): AddressResult<string> {
  if (chain.family === 'xpi') return fail({ code: 'address-format-not-pinned' })
  const payload = new Uint8Array(hash.length + 1)
  payload[0] = version
  payload.set(hash, 1)
  return { ok: true, value: encodeBase58Check(payload) }
}

function encodeWitness(
  chain: ChainDescriptor,
  version: number,
  program: Uint8Array,
  spec: Bech32Spec,
): AddressResult<string> {
  const hrp = chain.bech32Hrp
  if (hrp === null) {
    return fail({
      code: 'not-representable',
      kind: version === 1 ? 'p2tr' : 'p2wpkh',
      family: chain.family,
    })
  }
  const grouped = convertBits(Array.from(program), 8, 5)
  if (!grouped.ok) return grouped
  const encoded = encodeBech32(hrp, [version, ...grouped.value], spec)
  if (!encoded.ok) return relay(encoded.error)
  return encoded
}

export function encodeAddress(
  destination: Destination,
  chain: ChainDescriptor,
  encoding: AddressEncoding,
): AddressResult<string> {
  if (!representable(chain, destination.kind)) {
    return fail({
      code: 'not-representable',
      kind: destination.kind,
      family: chain.family,
    })
  }
  if (chain.family === 'xpi') return fail({ code: 'address-format-not-pinned' })
  if (!encodingsFor(chain, destination.kind).includes(encoding)) {
    return fail({ code: 'unknown-encoding', encoding })
  }
  const sized = scriptOf(destination)
  if (!sized.ok) return sized
  switch (destination.kind) {
    case 'p2pkh':
      if (encoding === 'cashaddr') return encodeCash(chain, 0, destination.hash)
      return encodeLegacy(chain, chain.pubkeyHashVersion, destination.hash)
    case 'p2sh':
      if (encoding === 'cashaddr') return encodeCash(chain, 1, destination.hash)
      return encodeLegacy(chain, chain.scriptHashVersion, destination.hash)
    case 'p2sh-p2wpkh':
      return encodeLegacy(
        chain,
        chain.scriptHashVersion,
        destination.scriptHash,
      )
    case 'p2wpkh':
      return encodeWitness(chain, 0, destination.hash, 'bech32')
    case 'p2wsh':
      return encodeWitness(chain, 0, destination.hash, 'bech32')
    case 'p2tr':
      return encodeWitness(chain, 1, destination.outputKey, 'bech32m')
  }
}

function listingFor(
  destination: Destination,
  chain: ChainDescriptor,
): AddressResult<AddressListing> {
  if (!representable(chain, destination.kind)) {
    return fail({
      code: 'not-representable',
      kind: destination.kind,
      family: chain.family,
    })
  }
  if (chain.family === 'xpi') {
    return {
      ok: true,
      value: Object.freeze({
        destination,
        chain,
        forms: Object.freeze([]),
        stringEncoding: Object.freeze({
          status: 'unpinned' as const,
          code: 'address-format-not-pinned' as const,
        }),
      }),
    }
  }
  const forms: AddressForm[] = []
  for (const encoding of encodingsFor(chain, destination.kind)) {
    const encoded = encodeAddress(destination, chain, encoding)
    if (!encoded.ok) return encoded
    forms.push(Object.freeze({ encoding, text: encoded.value }))
  }
  return {
    ok: true,
    value: Object.freeze({
      destination,
      chain,
      forms: Object.freeze(forms),
      stringEncoding: Object.freeze({ status: 'pinned' as const }),
    }),
  }
}

export function convertAddress(
  destination: Destination,
  chain: ChainDescriptor,
): AddressResult<AddressListing> {
  return listingFor(destination, chain)
}

export function addressesFor(
  pubkey: CompressedPublicKey,
  chain: ChainDescriptor,
  taproot?: TaprootCommitment,
): AddressResult<readonly AddressListing[]> {
  const key = compressedPublicKeyFromBytes(pubkey)
  if (!key.ok) return key
  let commitment: { outputKey: XOnlyPublicKey; tweak: Uint8Array } | undefined
  if (chain.bech32Hrp !== null) {
    if (taproot === undefined) return fail({ code: 'taproot-tweak-required' })
    const outputKey = xOnlyPublicKeyFromBytes(taproot.outputKey)
    if (!outputKey.ok) return outputKey
    const tweak = take(taproot.tweak, HASH256_LENGTH)
    if (!tweak.ok) return tweak
    commitment = { outputKey: outputKey.value, tweak: tweak.value }
  }
  const hashed = asPubkeyHash(hash160(key.value))
  if (!hashed.ok) return hashed
  const listings: AddressListing[] = []
  const p2pkh = listingFor(
    Object.freeze({ kind: 'p2pkh', hash: hashed.value }),
    chain,
  )
  if (!p2pkh.ok) return p2pkh
  listings.push(p2pkh.value)
  if (commitment !== undefined) {
    const redeem = new Uint8Array(22)
    redeem[0] = OP_0
    redeem[1] = PUSH_20
    redeem.set(hashed.value, 2)
    const scriptHash = asScriptHash(hash160(redeem))
    if (!scriptHash.ok) return scriptHash
    const nested = listingFor(
      Object.freeze({
        kind: 'p2sh-p2wpkh',
        pubkeyHash: hashed.value,
        scriptHash: scriptHash.value,
      }),
      chain,
    )
    if (!nested.ok) return nested
    const witness = listingFor(
      Object.freeze({ kind: 'p2wpkh', hash: hashed.value }),
      chain,
    )
    if (!witness.ok) return witness
    const taprootOut = listingFor(
      Object.freeze({
        kind: 'p2tr',
        outputKey: commitment.outputKey,
        tweak: commitment.tweak,
      }),
      chain,
    )
    if (!taprootOut.ok) return taprootOut
    listings.push(nested.value, witness.value, taprootOut.value)
  }
  return { ok: true, value: Object.freeze(listings) }
}

function scriptOf(destination: Destination): AddressResult<Uint8Array> {
  switch (destination.kind) {
    case 'p2pkh': {
      const hash = take(destination.hash, HASH160_LENGTH)
      if (!hash.ok) return hash
      const out = new Uint8Array(25)
      out[0] = OP_DUP
      out[1] = OP_HASH160
      out[2] = PUSH_20
      out.set(hash.value, 3)
      out[23] = OP_EQUALVERIFY
      out[24] = OP_CHECKSIG
      return { ok: true, value: out }
    }
    case 'p2sh':
    case 'p2sh-p2wpkh': {
      const hashBytes =
        destination.kind === 'p2sh' ? destination.hash : destination.scriptHash
      const hash = take(hashBytes, HASH160_LENGTH)
      if (!hash.ok) return hash
      const out = new Uint8Array(23)
      out[0] = OP_HASH160
      out[1] = PUSH_20
      out.set(hash.value, 2)
      out[22] = OP_EQUAL
      return { ok: true, value: out }
    }
    case 'p2wpkh': {
      const hash = take(destination.hash, HASH160_LENGTH)
      if (!hash.ok) return hash
      const out = new Uint8Array(22)
      out[0] = OP_0
      out[1] = PUSH_20
      out.set(hash.value, 2)
      return { ok: true, value: out }
    }
    case 'p2wsh': {
      const hash = take(destination.hash, HASH256_LENGTH)
      if (!hash.ok) return hash
      const out = new Uint8Array(34)
      out[0] = OP_0
      out[1] = PUSH_32
      out.set(hash.value, 2)
      return { ok: true, value: out }
    }
    case 'p2tr': {
      const key = take(destination.outputKey, HASH256_LENGTH)
      if (!key.ok) return key
      const out = new Uint8Array(34)
      out[0] = OP_1
      out[1] = PUSH_32
      out.set(key.value, 2)
      return { ok: true, value: out }
    }
  }
}

export function lockingScript(destination: Destination): Uint8Array {
  const built = scriptOf(destination)
  if (!built.ok) {
    if (isEncodingError(built.error)) throw new EncodingException(built.error)
    throw new EncodingException({
      code: 'wrong-length',
      min: 0,
      max: 0,
      actual: 0,
    })
  }
  return built.value
}

/**
 * lotusd `MatchPayToPubkeyHash` (`src/script/standard.cpp`): exactly 25 bytes,
 * OP_DUP OP_HASH160 20 <hash> OP_EQUALVERIFY OP_CHECKSIG.
 * A non-minimal push is not this template (decision #493).
 */
export function pubkeyHashFromOutputScript(
  script: Uint8Array,
): AddressResult<PubkeyHash> {
  if (
    script.length !== 25 ||
    script[0] !== OP_DUP ||
    script[1] !== OP_HASH160 ||
    script[2] !== PUSH_20 ||
    script[23] !== OP_EQUALVERIFY ||
    script[24] !== OP_CHECKSIG
  ) {
    return fail({ code: 'output-script-unmatched' })
  }
  return asPubkeyHash(script.subarray(3, 23))
}

export function sameDestination(
  left: Destination,
  right: Destination,
): boolean {
  let a: Uint8Array
  let b: Uint8Array
  try {
    a = lockingScript(left)
    b = lockingScript(right)
  } catch (error) {
    if (error instanceof EncodingException) return false
    throw error
  }
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

function agree(
  detected: ChainDescriptor,
  supplied: ChainDescriptor | undefined,
): AddressResult<ChainDescriptor> {
  if (supplied === undefined) return { ok: true, value: detected }
  if (
    supplied.family === detected.family &&
    supplied.network === detected.network
  ) {
    return { ok: true, value: detected }
  }
  return fail({
    code: 'chain-mismatch',
    detected: { family: detected.family, network: detected.network },
    supplied: { family: supplied.family, network: supplied.network },
  })
}

function destinationFromCashaddr(
  payload: Uint8Array,
): AddressResult<Destination> {
  if (payload.length < 1) {
    return fail({ code: 'wrong-length', min: 1, max: 65, actual: 0 })
  }
  const version = payload[0] ?? 0
  if ((version & 0x80) !== 0) {
    return fail({ code: 'unknown-address-type', version })
  }
  const sizeBits = version & 7
  const typeBits = version >> 3
  const expected = SIZE_BYTES[sizeBits] ?? 0
  const hash = payload.subarray(1)
  if (hash.length !== expected) {
    return fail({
      code: 'wrong-length',
      min: expected,
      max: expected,
      actual: hash.length,
    })
  }
  if (typeBits === 0 && hash.length === HASH160_LENGTH) {
    const branded = asPubkeyHash(hash)
    if (!branded.ok) return branded
    return {
      ok: true,
      value: Object.freeze({ kind: 'p2pkh', hash: branded.value }),
    }
  }
  if (typeBits === 1 && hash.length === HASH160_LENGTH) {
    const branded = asScriptHash(hash)
    if (!branded.ok) return branded
    return {
      ok: true,
      value: Object.freeze({ kind: 'p2sh', hash: branded.value }),
    }
  }
  return fail({ code: 'unknown-address-type', version })
}

function destinationFromWitness(
  version: number,
  program: Uint8Array,
  spec: Bech32Spec,
): AddressResult<Destination> {
  if (version < 0 || version > 16) {
    return fail({
      code: 'unsupported-witness',
      version,
      length: program.length,
    })
  }
  if (program.length < 2 || program.length > 40) {
    return fail({
      code: 'witness-program-length',
      version,
      actual: program.length,
    })
  }
  if (version === 0) {
    if (spec !== 'bech32') return fail({ code: 'bad-checksum' })
    if (program.length === HASH160_LENGTH) {
      const hash = asPubkeyHash(program)
      if (!hash.ok) return hash
      return {
        ok: true,
        value: Object.freeze({ kind: 'p2wpkh', hash: hash.value }),
      }
    }
    if (program.length === HASH256_LENGTH) {
      const hash = asWitnessScript(program)
      if (!hash.ok) return hash
      return {
        ok: true,
        value: Object.freeze({ kind: 'p2wsh', hash: hash.value }),
      }
    }
    return fail({
      code: 'witness-program-length',
      version,
      actual: program.length,
    })
  }
  if (spec !== 'bech32m') return fail({ code: 'bad-checksum' })
  if (version === 1) {
    if (program.length !== HASH256_LENGTH) {
      return fail({
        code: 'witness-program-length',
        version,
        actual: program.length,
      })
    }
    const outputKey = xOnlyPublicKeyFromBytes(program)
    if (!outputKey.ok) return outputKey
    return {
      ok: true,
      value: Object.freeze({
        kind: 'p2tr',
        outputKey: outputKey.value,
        tweak: null,
      }),
    }
  }
  return fail({ code: 'unsupported-witness', version, length: program.length })
}

function looksLikePrefixlessCashaddr(text: string): boolean {
  if (text.length === 0 || text.includes(':') || text.includes('1'))
    return false
  const lower = text.toLowerCase()
  for (let index = 0; index < lower.length; index += 1) {
    if (!CASH_CHAR.has(lower.charAt(index))) return false
  }
  return true
}

function decodeCash(
  text: string,
  chain: ChainDescriptor | undefined,
  defaultPrefix: string | undefined,
): AddressResult<DecodedAddress> {
  const decoded = decodeCashaddr(text, defaultPrefix)
  if (!decoded.ok) return relay(decoded.error)
  const detected = chainByCashaddr(decoded.value.prefix)
  if (detected === undefined) {
    return fail({ code: 'wrong-prefix', prefix: decoded.value.prefix })
  }
  const agreed = agree(detected, chain)
  if (!agreed.ok) return agreed
  const destination = destinationFromCashaddr(decoded.value.payload)
  if (!destination.ok) return destination
  const canonical = text.toLowerCase()
  const textOut = canonical.includes(':')
    ? canonical
    : `${decoded.value.prefix}:${canonical}`
  return {
    ok: true,
    value: Object.freeze({
      destination: destination.value,
      chain: detected,
      encoding: 'cashaddr' as const,
      text: textOut,
    }),
  }
}

function decodeWitness(
  text: string,
  chain: ChainDescriptor | undefined,
): AddressResult<DecodedAddress> {
  const decoded = decodeBech32(text)
  if (!decoded.ok) return relay(decoded.error)
  const detected = chainByBech32(decoded.value.hrp)
  if (detected === undefined) {
    return fail({ code: 'wrong-prefix', prefix: decoded.value.hrp })
  }
  const agreed = agree(detected, chain)
  if (!agreed.ok) return agreed
  if (decoded.value.data.length < 1) {
    return fail({ code: 'witness-program-length', version: -1, actual: 0 })
  }
  const version = decoded.value.data[0] ?? 0
  const programBits = decoded.value.data.slice(1)
  const program = convertBits(programBits, 5, 8, true)
  if (!program.ok) return program
  const destination = destinationFromWitness(
    version,
    Uint8Array.from(program.value),
    decoded.value.spec,
  )
  if (!destination.ok) return destination
  const encoding: AddressEncoding =
    decoded.value.spec === 'bech32' ? 'bech32' : 'bech32m'
  return {
    ok: true,
    value: Object.freeze({
      destination: destination.value,
      chain: detected,
      encoding,
      text: text.toLowerCase(),
    }),
  }
}

function decodeLegacy(
  text: string,
  chain: ChainDescriptor | undefined,
): AddressResult<DecodedAddress> {
  if (chain === undefined) return fail({ code: 'chain-required' })
  if (chain.family === 'xpi') return fail({ code: 'address-format-not-pinned' })
  const decoded = decodeBase58Check(text)
  if (!decoded.ok) return decoded
  if (decoded.value.length !== HASH160_LENGTH + 1) {
    return fail({
      code: 'wrong-length',
      min: HASH160_LENGTH + 1,
      max: HASH160_LENGTH + 1,
      actual: decoded.value.length,
    })
  }
  const version = decoded.value[0] ?? 0
  const hash = decoded.value.subarray(1)
  let destination: Destination
  if (version === chain.pubkeyHashVersion) {
    const branded = asPubkeyHash(hash)
    if (!branded.ok) return branded
    destination = Object.freeze({ kind: 'p2pkh', hash: branded.value })
  } else if (version === chain.scriptHashVersion) {
    const branded = asScriptHash(hash)
    if (!branded.ok) return branded
    destination = Object.freeze({ kind: 'p2sh', hash: branded.value })
  } else {
    return fail({ code: 'wrong-prefix', prefix: String(version) })
  }
  return {
    ok: true,
    value: Object.freeze({
      destination,
      chain,
      encoding: 'base58check' as const,
      text,
    }),
  }
}

function decodePrefixless(
  text: string,
  chain: ChainDescriptor | undefined,
): AddressResult<DecodedAddress> {
  if (
    chain === undefined ||
    chain.family === 'xpi' ||
    chain.cashaddrPrefix === null
  ) {
    return decodeLegacy(text, chain)
  }
  const cash = decodeCashaddr(text, chain.cashaddrPrefix)
  if (cash.ok && decodeBase58Check(text).ok) {
    return fail({ code: 'ambiguous-encoding' })
  }
  if (cash.ok) return decodeCash(text, chain, chain.cashaddrPrefix)
  return decodeLegacy(text, chain)
}

export function decodeAddress(
  text: string,
  chain?: ChainDescriptor,
): AddressResult<DecodedAddress> {
  if (typeof text !== 'string') return fail({ code: 'base32-invalid-type' })
  if (text.includes(':')) return decodeCash(text, chain, undefined)
  const split = text.lastIndexOf('1')
  if (split > 0) {
    const hrp = text.slice(0, split).toLowerCase()
    if (chainByBech32(hrp) !== undefined) return decodeWitness(text, chain)
    const witness = decodeBech32(text)
    if (witness.ok) {
      if (decodeBase58Check(text).ok) {
        return fail({ code: 'ambiguous-encoding' })
      }
      return fail({ code: 'wrong-prefix', prefix: witness.value.hrp })
    }
  }
  if (looksLikePrefixlessCashaddr(text)) return decodePrefixless(text, chain)
  return decodeLegacy(text, chain)
}
