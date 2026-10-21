import { decodeCanonical, encodeCanonical, type Encodable } from './cbor'
import {
  ACCOUNT_REF,
  DM_CRYPTO_CONTEXT_V1,
  ENCRYPTION_SUITE_DM_AUTH_XCHACHA,
  KEY_TYPE,
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
  if (
    secpOnly &&
    (value.keyType !== KEY_TYPE.secp256k1 || !isCompressedPoint(value.keyBytes))
  ) {
    throw new RangeError(`${name} must be a compressed secp256k1 account`)
  }
  return new Map<number, Encodable>([
    [ACCOUNT_REF.keyType, value.keyType],
    [ACCOUNT_REF.keyBytes, Uint8Array.from(value.keyBytes)],
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
      [DM_CRYPTO_CONTEXT_V1.domain, DM_CRYPTO_CONTEXT_DOMAIN],
      [DM_CRYPTO_CONTEXT_V1.network, input.network],
      [DM_CRYPTO_CONTEXT_V1.sender, account(input.sender, 'sender')],
      [DM_CRYPTO_CONTEXT_V1.recipient, account(input.recipient, 'recipient')],
      [
        DM_CRYPTO_CONTEXT_V1.senderStatementHash,
        exact(input.senderDirectoryHash, 32, 'senderDirectoryHash'),
      ],
      [
        DM_CRYPTO_CONTEXT_V1.recipientStatementHash,
        exact(input.recipientDirectoryHash, 32, 'recipientDirectoryHash'),
      ],
      [
        DM_CRYPTO_CONTEXT_V1.senderMessageKey,
        account(input.senderMessageKey, 'senderMessageKey', true),
      ],
      [
        DM_CRYPTO_CONTEXT_V1.recipientMessageKey,
        account(input.recipientMessageKey, 'recipientMessageKey', true),
      ],
      [
        DM_CRYPTO_CONTEXT_V1.recipientStampKey,
        account(input.stampKey, 'stampKey', true),
      ],
      [
        DM_CRYPTO_CONTEXT_V1.ephemeralPoint,
        point(input.ephemeralPoint, 'ephemeralPoint'),
      ],
      [
        DM_CRYPTO_CONTEXT_V1.sharedPoint,
        point(input.sharedPoint, 'sharedPoint'),
      ],
      [DM_CRYPTO_CONTEXT_V1.dleqProof, proof(input.dleqProof)],
      [DM_CRYPTO_CONTEXT_V1.suite, ENCRYPTION_SUITE_DM_AUTH_XCHACHA],
      [DM_CRYPTO_CONTEXT_V1.objectType, TYPE_RECIPIENT_ENCRYPTED_PAYLOAD],
      [DM_CRYPTO_CONTEXT_V1.schemaVersion, DM_CRYPTO_SCHEMA_VERSION],
      [DM_CRYPTO_CONTEXT_V1.minReaderVersion, DM_CRYPTO_MIN_READER_VERSION],
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
  const K = DM_CRYPTO_CONTEXT_V1
  const get = (key: number): unknown => value.get(BigInt(key))
  const domain = get(K.domain)
  if (domain !== DM_CRYPTO_CONTEXT_DOMAIN) {
    throw new RangeError('unexpected crypto context domain')
  }
  const network = get(K.network)
  if (typeof network !== 'string' || network.length === 0) {
    throw new TypeError('network must be a non-empty string')
  }
  const parseAccount = (
    v: unknown,
    name: string,
    secpOnly = false,
  ): AccountRef => {
    if (!(v instanceof Map))
      throw new TypeError(`${name} must be an account map`)
    const rawKeyType = v.get(BigInt(ACCOUNT_REF.keyType))
    const rawKeyBytes = v.get(BigInt(ACCOUNT_REF.keyBytes))
    if (
      typeof rawKeyType !== 'bigint' ||
      !(rawKeyBytes instanceof Uint8Array)
    ) {
      throw new TypeError(`${name} account invalid`)
    }
    const keyType = Number(rawKeyType)
    const keyBytes = Uint8Array.from(rawKeyBytes)
    if (
      secpOnly &&
      (keyType !== KEY_TYPE.secp256k1 || !isCompressedPoint(keyBytes))
    ) {
      throw new RangeError(`${name} must be a compressed secp256k1 account`)
    }
    return { keyType, keyBytes }
  }
  const sender = parseAccount(get(K.sender), 'sender')
  const recipient = parseAccount(get(K.recipient), 'recipient')
  const senderDirectoryHash = exact(
    get(K.senderStatementHash) as Uint8Array,
    32,
    'senderDirectoryHash',
  )
  const recipientDirectoryHash = exact(
    get(K.recipientStatementHash) as Uint8Array,
    32,
    'recipientDirectoryHash',
  )
  const senderMessageKey = parseAccount(
    get(K.senderMessageKey),
    'senderMessageKey',
    true,
  )
  const recipientMessageKey = parseAccount(
    get(K.recipientMessageKey),
    'recipientMessageKey',
    true,
  )
  const stampKey = parseAccount(get(K.recipientStampKey), 'stampKey', true)
  const ephemeralPoint = point(
    get(K.ephemeralPoint) as Uint8Array,
    'ephemeralPoint',
  )
  const sharedPoint = point(get(K.sharedPoint) as Uint8Array, 'sharedPoint')
  const dleqProof = proof(get(K.dleqProof) as Uint8Array)

  const suite = get(K.suite)
  const typePayload = get(K.objectType)
  const schemaVer = get(K.schemaVersion)
  const minReaderVer = get(K.minReaderVersion)

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
