import { decodeCanonical, encodeCanonical, type Encodable } from './cbor'
import {
  ENCRYPTION_SUITE_DM_AUTH_XCHACHA,
  TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
} from './constants'
import type { AccountRef } from './types'
import { isCompressedPoint, isProofEncoding } from './point'

export const DM_CRYPTO_CONTEXT_DOMAIN = 'frank/dm-crypto-context/v1'
export const DM_CRYPTO_SCHEMA_VERSION = 2
export const DM_CRYPTO_MIN_READER_VERSION = 2

export interface DirectMessageCryptoContext {
  readonly network: string
  readonly sender: AccountRef
  readonly recipient: AccountRef
  readonly senderDirectoryHash: Uint8Array
  readonly recipientDirectoryHash: Uint8Array
  readonly senderMessageKey: AccountRef
  readonly recipientMessageKey: AccountRef
  readonly stampKey: AccountRef
  readonly ephemeralPoint: Uint8Array
  readonly sharedPoint: Uint8Array
  readonly dleqProof: Uint8Array
}

function exact(bytes: Uint8Array, length: number, name: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new RangeError(`${name} must contain exactly ${length} bytes`)
  }
  return Uint8Array.from(bytes)
}

function account(value: AccountRef, name: string, secpOnly = false): Encodable {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Number.isSafeInteger(value.keyType) ||
    value.keyType < 0 ||
    value.keyType > 65535 ||
    !(value.keyBytes instanceof Uint8Array)
  ) {
    throw new TypeError(`${name} must be an account reference`)
  }
  if (secpOnly && (value.keyType !== 1 || !isCompressedPoint(value.keyBytes))) {
    throw new RangeError(`${name} must be a compressed secp256k1 account`)
  }
  return new Map<number, Encodable>([
    [0, value.keyType],
    [1, Uint8Array.from(value.keyBytes)],
  ])
}

function point(bytes: Uint8Array, name: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || !isCompressedPoint(bytes)) {
    throw new RangeError(`${name} must be a compressed secp256k1 point`)
  }
  return Uint8Array.from(bytes)
}

function proof(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array) || !isProofEncoding(bytes)) {
    throw new RangeError('dleqProof must contain two scalars in 1..n-1')
  }
  return Uint8Array.from(bytes)
}

/** Byte-exact suite-1 context passed to both crypto-box seal and open. */
export function encodeDirectMessageCryptoContext(
  input: DirectMessageCryptoContext,
): Uint8Array {
  if (typeof input.network !== 'string' || input.network.length === 0) {
    throw new TypeError('network must be a non-empty string')
  }
  return encodeCanonical(
    new Map<number, Encodable>([
      [0, DM_CRYPTO_CONTEXT_DOMAIN],
      [1, input.network],
      [2, account(input.sender, 'sender')],
      [3, account(input.recipient, 'recipient')],
      [4, exact(input.senderDirectoryHash, 32, 'senderDirectoryHash')],
      [5, exact(input.recipientDirectoryHash, 32, 'recipientDirectoryHash')],
      [6, account(input.senderMessageKey, 'senderMessageKey', true)],
      [7, account(input.recipientMessageKey, 'recipientMessageKey', true)],
      [8, account(input.stampKey, 'stampKey', true)],
      [9, point(input.ephemeralPoint, 'ephemeralPoint')],
      [10, point(input.sharedPoint, 'sharedPoint')],
      [11, proof(input.dleqProof)],
      [12, ENCRYPTION_SUITE_DM_AUTH_XCHACHA],
      [13, TYPE_RECIPIENT_ENCRYPTED_PAYLOAD],
      [14, DM_CRYPTO_SCHEMA_VERSION],
      [15, DM_CRYPTO_MIN_READER_VERSION],
    ]),
  )
}

/** Decodes a canonical CBOR suite-1 context. Strict. */
export function decodeDirectMessageCryptoContext(
  bytes: Uint8Array,
): DirectMessageCryptoContext {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('context must be a Uint8Array')
  }
  const value = decodeCanonical(bytes)
  if (!(value instanceof Map)) {
    throw new TypeError('context must be a canonical CBOR map')
  }
  const domain = value.get(0n)
  if (domain !== DM_CRYPTO_CONTEXT_DOMAIN) {
    throw new RangeError('unexpected crypto context domain')
  }
  const network = value.get(1n)
  if (typeof network !== 'string' || network.length === 0) {
    throw new TypeError('network must be a non-empty string')
  }
  const parseAccount = (v: unknown, name: string, secpOnly = false): AccountRef => {
    if (!(v instanceof Map)) throw new TypeError(`${name} must be an account map`)
    const rawKeyType = v.get(0n)
    const rawKeyBytes = v.get(1n)
    if (typeof rawKeyType !== 'bigint' || !(rawKeyBytes instanceof Uint8Array)) {
      throw new TypeError(`${name} account invalid`)
    }
    const keyType = Number(rawKeyType)
    const keyBytes = Uint8Array.from(rawKeyBytes)
    if (secpOnly && (keyType !== 1 || !isCompressedPoint(keyBytes))) {
      throw new RangeError(`${name} must be a compressed secp256k1 account`)
    }
    return { keyType, keyBytes }
  }
  const sender = parseAccount(value.get(2n), 'sender')
  const recipient = parseAccount(value.get(3n), 'recipient')
  const senderDirectoryHash = exact(value.get(4n) as Uint8Array, 32, 'senderDirectoryHash')
  const recipientDirectoryHash = exact(value.get(5n) as Uint8Array, 32, 'recipientDirectoryHash')
  const senderMessageKey = parseAccount(value.get(6n), 'senderMessageKey', true)
  const recipientMessageKey = parseAccount(value.get(7n), 'recipientMessageKey', true)
  const stampKey = parseAccount(value.get(8n), 'stampKey', true)
  const ephemeralPoint = point(value.get(9n) as Uint8Array, 'ephemeralPoint')
  const sharedPoint = point(value.get(10n) as Uint8Array, 'sharedPoint')
  const dleqProof = proof(value.get(11n) as Uint8Array)

  const suite = value.get(12n)
  const typePayload = value.get(13n)
  const schemaVer = value.get(14n)
  const minReaderVer = value.get(15n)

  if (
    suite !== BigInt(ENCRYPTION_SUITE_DM_AUTH_XCHACHA) ||
    typePayload !== BigInt(TYPE_RECIPIENT_ENCRYPTED_PAYLOAD) ||
    schemaVer !== BigInt(DM_CRYPTO_SCHEMA_VERSION) ||
    minReaderVer !== BigInt(DM_CRYPTO_MIN_READER_VERSION)
  ) {
    throw new RangeError('invalid context suite or version')
  }

  return {
    network,
    sender,
    recipient,
    senderDirectoryHash,
    recipientDirectoryHash,
    senderMessageKey,
    recipientMessageKey,
    stampKey,
    ephemeralPoint,
    sharedPoint,
    dleqProof,
  }
}
