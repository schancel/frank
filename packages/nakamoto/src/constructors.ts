// Structural brands. The phantom field is a string literal type, not a symbol
// identity, and it is not present at runtime. Each constructor copies a plain
// Uint8Array and returns one brand. None accepts a string, a subclass, or an object.

import { copyBytes, reverseBytes } from './bytes.js'
import {
  type BadPrefix,
  type EncodingResult,
  type WrongLength,
} from './encoding-error.js'

type Brand<T, Name extends string> = T & { readonly __nakamoto: Name }

const HASH_LENGTH = 32
const PRIVATE_KEY_LENGTH = 32
const COMPRESSED_PUBLIC_KEY_LENGTH = 33
const X_ONLY_LENGTH = 32
const SCHNORR_LENGTH = 64
const ECDSA_DER_MIN = 8
const ECDSA_DER_MAX = 73
const ECDSA_DER_TAG = 0x30

export type InternalHash = Brand<Uint8Array, 'internal-hash'>
export type DisplayTxid = Brand<Uint8Array, 'display-txid'>
export type PrivateKeyBytes = Brand<Uint8Array, 'private-key'>
export type CompressedPublicKey = Brand<Uint8Array, 'compressed-pubkey'>
export type XOnlyPublicKey = Brand<Uint8Array, 'x-only-pubkey'>
export type EcdsaSignature = Brand<Uint8Array, 'ecdsa-signature'>
export type SchnorrSignature = Brand<Uint8Array, 'schnorr-signature'>
/** Payload only. Issue 242 has not chosen an XPI string prefix, so this does not encode one. */
export type XAddressPayload = Brand<Uint8Array, 'x-address-payload'>
export type PubkeyHash = Brand<Uint8Array, 'pubkey-hash'>
export type SighashByte = Brand<number, 'sighash-byte'>

export interface PrivateKey {
  readonly bytes: PrivateKeyBytes
  readonly compressed: boolean
}

export type SigningMethod = 'ecdsa' | 'schnorr'

/**
 * Sighash and the signing method are required. This is a type, not an
 * implementation. Issue 245 owns the signer.
 */
export type ExplicitSign = (args: {
  readonly key: PrivateKey
  readonly digest: InternalHash
  readonly sighash: SighashByte
  readonly method: SigningMethod
}) => EcdsaSignature | SchnorrSignature

function fixedLength(
  value: Uint8Array,
  length: number,
): EncodingResult<Uint8Array> {
  const bytes = copyBytes(value)
  if (bytes.length !== length) {
    const error: WrongLength = {
      code: 'wrong-length',
      min: length,
      max: length,
      actual: bytes.length,
    }
    return { ok: false, error }
  }
  return { ok: true, value: bytes }
}

function brandBytes<Name extends string>(
  bytes: Uint8Array,
): Brand<Uint8Array, Name> {
  return bytes as Brand<Uint8Array, Name>
}

export function internalHashFromBytes(
  bytes: Uint8Array,
): EncodingResult<InternalHash> {
  const fixed = fixedLength(bytes, HASH_LENGTH)
  if (!fixed.ok) return fixed
  return { ok: true, value: brandBytes<'internal-hash'>(fixed.value) }
}

export function displayTxidFromBytes(
  bytes: Uint8Array,
): EncodingResult<DisplayTxid> {
  const fixed = fixedLength(bytes, HASH_LENGTH)
  if (!fixed.ok) return fixed
  return { ok: true, value: brandBytes<'display-txid'>(fixed.value) }
}

/** Display order is the reversal of the internal hash. Not a hex string. */
export function displayTxidFromInternal(hash: InternalHash): DisplayTxid {
  return brandBytes<'display-txid'>(reverseBytes(hash))
}

export function internalHashFromDisplay(txid: DisplayTxid): InternalHash {
  return brandBytes<'internal-hash'>(reverseBytes(txid))
}

/**
 * `compressed` is required. There is no uncompressed default and no network
 * argument. The 32 bytes are not checked against the curve order.
 */
export function privateKeyFromBytes(
  bytes: Uint8Array,
  compressed: boolean,
): EncodingResult<PrivateKey> {
  const fixed = fixedLength(bytes, PRIVATE_KEY_LENGTH)
  if (!fixed.ok) return fixed
  return {
    ok: true,
    value: Object.freeze({
      bytes: brandBytes<'private-key'>(fixed.value),
      compressed,
    }),
  }
}

export function compressedPublicKeyFromBytes(
  bytes: Uint8Array,
): EncodingResult<CompressedPublicKey> {
  const fixed = fixedLength(bytes, COMPRESSED_PUBLIC_KEY_LENGTH)
  if (!fixed.ok) return fixed
  const prefix = fixed.value[0] ?? 0
  if (prefix !== 0x02 && prefix !== 0x03) {
    const error: BadPrefix = { code: 'bad-prefix', actual: prefix }
    return { ok: false, error }
  }
  return { ok: true, value: brandBytes<'compressed-pubkey'>(fixed.value) }
}

export function xOnlyPublicKeyFromBytes(
  bytes: Uint8Array,
): EncodingResult<XOnlyPublicKey> {
  const fixed = fixedLength(bytes, X_ONLY_LENGTH)
  if (!fixed.ok) return fixed
  return { ok: true, value: brandBytes<'x-only-pubkey'>(fixed.value) }
}

/** DER tag and length bounds only. Not a parse, and not a 64-byte Schnorr blob. */
export function ecdsaSignatureFromBytes(
  bytes: Uint8Array,
): EncodingResult<EcdsaSignature> {
  const copiedBytes = copyBytes(bytes)
  const actual = copiedBytes.length
  if (actual < ECDSA_DER_MIN || actual > ECDSA_DER_MAX) {
    const error: WrongLength = {
      code: 'wrong-length',
      min: ECDSA_DER_MIN,
      max: ECDSA_DER_MAX,
      actual,
    }
    return { ok: false, error }
  }
  const prefix = copiedBytes[0] ?? 0
  if (prefix !== ECDSA_DER_TAG) {
    const error: BadPrefix = { code: 'bad-prefix', actual: prefix }
    return { ok: false, error }
  }
  return { ok: true, value: brandBytes<'ecdsa-signature'>(copiedBytes) }
}

/** Exactly 64 bytes. A trailing sighash byte belongs on ExplicitSign, not here. */
export function schnorrSignatureFromBytes(
  bytes: Uint8Array,
): EncodingResult<SchnorrSignature> {
  const fixed = fixedLength(bytes, SCHNORR_LENGTH)
  if (!fixed.ok) return fixed
  return { ok: true, value: brandBytes<'schnorr-signature'>(fixed.value) }
}

/** Non-empty payload. Does not build or emit an address string. */
export function xAddressPayloadFromBytes(
  bytes: Uint8Array,
): EncodingResult<XAddressPayload> {
  const copiedBytes = copyBytes(bytes)
  if (copiedBytes.length < 1) {
    const error: WrongLength = {
      code: 'wrong-length',
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      actual: 0,
    }
    return { ok: false, error }
  }
  return { ok: true, value: brandBytes<'x-address-payload'>(copiedBytes) }
}

export function pubkeyHashFromBytes(
  bytes: Uint8Array,
): EncodingResult<PubkeyHash> {
  const fixed = fixedLength(bytes, 20)
  if (!fixed.ok) return fixed
  return { ok: true, value: brandBytes<'pubkey-hash'>(fixed.value) }
}

export function sighashByte(value: number): EncodingResult<SighashByte> {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    return { ok: false, error: { code: 'integer-out-of-range' } }
  }
  return { ok: true, value: value as SighashByte }
}
