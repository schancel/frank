import { decodeCanonical, encodeCanonical, type Encodable } from './cbor'
import {
  ACCOUNT_REF,
  DM_CRYPTO_CONTEXT_V1,
  DM_CRYPTO_CONTEXT_V1_SHAPE,
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
  readonly sender?: AccountRef
  readonly recipient: AccountRef
  readonly senderDirectoryHash?: Uint8Array
  readonly recipientDirectoryHash: Uint8Array
  readonly senderMessageKey?: AccountRef
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
  const K = DM_CRYPTO_CONTEXT_V1
  const hasSender = input.sender !== undefined
  const hasSenderDirHash = input.senderDirectoryHash !== undefined
  const hasSenderMsgKey = input.senderMessageKey !== undefined
  if (hasSender !== hasSenderDirHash || hasSender !== hasSenderMsgKey) {
    throw new RangeError(
      'sender, senderDirectoryHash, and senderMessageKey must either all be present or all be absent',
    )
  }
  // A sealed-sender context omits the three sender fields.
  const entries: Array<[number, Encodable]> = [
    [K.domain, DM_CRYPTO_CONTEXT_DOMAIN],
    [K.network, input.network],
  ]
  if (input.sender !== undefined) {
    entries.push([K.sender, account(input.sender, 'sender')])
  }
  entries.push([K.recipient, account(input.recipient, 'recipient')])
  if (input.senderDirectoryHash !== undefined) {
    entries.push([
      K.senderStatementHash,
      exact(input.senderDirectoryHash, 32, 'senderDirectoryHash'),
    ])
  }
  entries.push([
    K.recipientStatementHash,
    exact(input.recipientDirectoryHash, 32, 'recipientDirectoryHash'),
  ])
  if (input.senderMessageKey !== undefined) {
    entries.push([
      K.senderMessageKey,
      account(input.senderMessageKey, 'senderMessageKey', true),
    ])
  }
  entries.push(
    [
      K.recipientMessageKey,
      account(input.recipientMessageKey, 'recipientMessageKey', true),
    ],
    [K.recipientStampKey, account(input.stampKey, 'stampKey', true)],
    [K.ephemeralPoint, point(input.ephemeralPoint, 'ephemeralPoint')],
    [K.sharedPoint, point(input.sharedPoint, 'sharedPoint')],
    [K.dleqProof, proof(input.dleqProof)],
    [K.suite, ENCRYPTION_SUITE_DM_AUTH_XCHACHA],
    [K.objectType, TYPE_RECIPIENT_ENCRYPTED_PAYLOAD],
    [K.schemaVersion, DM_CRYPTO_SCHEMA_VERSION],
    [K.minReaderVersion, DM_CRYPTO_MIN_READER_VERSION],
  )
  return encodeCanonical(new Map<number, Encodable>(entries))
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
  const has = (key: number): boolean => value.has(BigInt(key))
  const hasSender = has(K.sender)
  const hasSenderDirHash = has(K.senderStatementHash)
  const hasSenderMsgKey = has(K.senderMessageKey)
  if (hasSender !== hasSenderDirHash || hasSender !== hasSenderMsgKey) {
    throw new RangeError(
      'sender, senderDirectoryHash, and senderMessageKey must either all be present or all be absent',
    )
  }
  const expectedSize =
    DM_CRYPTO_CONTEXT_V1_SHAPE.required.length +
    (hasSender ? DM_CRYPTO_CONTEXT_V1_SHAPE.optional.length : 0)
  if (value.size !== expectedSize) {
    throw new RangeError('unexpected context map size')
  }
  const sender = hasSender ? parseAccount(get(K.sender), 'sender') : undefined
  const recipient = parseAccount(get(K.recipient), 'recipient')
  const senderDirectoryHash = hasSenderDirHash
    ? exact(get(K.senderStatementHash) as Uint8Array, 32, 'senderDirectoryHash')
    : undefined
  const recipientDirectoryHash = exact(
    get(K.recipientStatementHash) as Uint8Array,
    32,
    'recipientDirectoryHash',
  )
  const senderMessageKey = hasSenderMsgKey
    ? parseAccount(get(K.senderMessageKey), 'senderMessageKey', true)
    : undefined
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
    ...(sender !== undefined ? { sender } : {}),
    recipient,
    ...(senderDirectoryHash !== undefined ? { senderDirectoryHash } : {}),
    recipientDirectoryHash,
    ...(senderMessageKey !== undefined ? { senderMessageKey } : {}),
    recipientMessageKey,
    stampKey,
    ephemeralPoint,
    sharedPoint,
    dleqProof,
  }
}
