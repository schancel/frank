import { cborMap, decodeCanonical, encodeCanonical } from './cbor'
import type { FrankValue } from './cbor'
import { TYPE_STEALTH_MESSAGE_ITEM } from './constants'
import { FrankCodecError } from './errors'
import { encodeFrame } from './frame'
import { fromHex, toHex } from './hash'
import type {
  AccountRef,
  ParsedFrame,
  PaymentMember,
  StealthMessageItem,
  StealthMetadata,
} from './types'
import { parseFrame } from './validate'
import { paymentMember, stealthMetadata } from './schema'

export { paymentMember, stealthMetadata }

export interface CanonicalStealthMetadata {
  keyType: 1 | 2 | number
  ephemeralPubKey: string | Uint8Array
  viewTag?: number | string | Uint8Array
}

/** Writer input for one payment-member. Exactly one of `childIndex` or `stealthMetadata`. */
export interface PaymentMemberInput {
  network: string
  transactionId: string | Uint8Array
  value: number | bigint | string | Uint8Array
  address: string | Uint8Array
  commitment?: string | Uint8Array
  vout?: number
  rawTx?: string | Uint8Array
  childIndex?: number
  stealthMetadata?: CanonicalStealthMetadata | StealthMetadata
  token?: string | Uint8Array
}

export interface CanonicalStealthItem {
  type: 'stealth'
  networkTag: string
  keyType: 1 | 2
  ephemeralPubKey: string
  transactions: string[]
  amount: number | bigint
  memo?: string
}

const bad = (message: string) =>
  new FrankCodecError('schema', '8.2', message, 'stealth/writer')

export function encodeStealthMessageItem(
  item: CanonicalStealthItem,
): Uint8Array {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw bad('expected an item object')
  }
  if (typeof item.networkTag !== 'string' || item.networkTag.length === 0) {
    throw bad('networkTag must be a non-empty string')
  }
  if (item.keyType !== 1 && item.keyType !== 2) {
    throw bad('keyType must be 1 or 2')
  }
  if (
    typeof item.ephemeralPubKey !== 'string' ||
    item.ephemeralPubKey.length === 0
  ) {
    throw bad('ephemeralPubKey must be a hex string')
  }
  const pubHex = item.ephemeralPubKey.startsWith('0x')
    ? item.ephemeralPubKey.slice(2).toLowerCase()
    : item.ephemeralPubKey.toLowerCase()
  const pubKeyBytes = fromHex(pubHex)
  const expectedLen = item.keyType === 1 ? 33 : 32
  if (pubKeyBytes.length !== expectedLen) {
    throw bad(
      `ephemeralPubKey length mismatch: expected ${expectedLen} bytes for keyType ${item.keyType}, got ${pubKeyBytes.length}`,
    )
  }

  if (!Array.isArray(item.transactions) || item.transactions.length === 0) {
    throw bad('transactions must be a non-empty array')
  }
  if (item.transactions.length > 16) {
    throw bad('transactions array cannot exceed 16 items')
  }
  const txBytesList: Uint8Array[] = item.transactions.map((txStr, i) => {
    if (typeof txStr !== 'string' || txStr.length === 0) {
      throw bad(`transaction ${i} must be a non-empty hex string`)
    }
    const hex = txStr.startsWith('0x')
      ? txStr.slice(2).toLowerCase()
      : txStr.toLowerCase()
    return fromHex(hex)
  })

  const amt = BigInt(item.amount)
  if (amt < 0n) {
    throw bad('amount cannot be negative')
  }

  const entries: Array<[number, any]> = [
    [0, item.networkTag],
    [
      1,
      cborMap([
        [0, item.keyType],
        [1, pubKeyBytes],
      ]),
    ],
    [2, txBytesList],
    [3, amt],
  ]
  if (item.memo !== undefined && item.memo.length > 0) {
    entries.push([4, item.memo])
  }

  const bytes = encodeFrame(
    {
      typeId: TYPE_STEALTH_MESSAGE_ITEM,
      schemaVersion: 1,
      minReaderVersion: 1,
    },
    cborMap(entries),
  )
  parseFrame(bytes)
  return bytes
}

export function isStealthMessageItemFrame(
  frame: ParsedFrame,
): frame is ParsedFrame & { typed: StealthMessageItem } {
  return (
    frame.typeId === TYPE_STEALTH_MESSAGE_ITEM &&
    frame.typed?.type === 24 &&
    !('transfers' in frame.typed)
  )
}

export function projectStealthMessageItem(
  frame: ParsedFrame,
): CanonicalStealthItem {
  if (!isStealthMessageItemFrame(frame)) {
    throw bad('frame is not a valid stealth message item')
  }
  const typed = frame.typed
  return {
    type: 'stealth',
    networkTag: typed.networkTag,
    keyType: typed.ephemeralPubKey.keyType as 1 | 2,
    ephemeralPubKey: toHex(typed.ephemeralPubKey.keyBytes),
    transactions: typed.transactions.map(toHex),
    amount: Number(typed.amount),
    ...(typed.memo !== undefined ? { memo: typed.memo } : {}),
  }
}

function parseBytes(
  val: string | Uint8Array,
  min: number,
  max: number,
  name: string,
): Uint8Array {
  let b: Uint8Array
  if (typeof val === 'string') {
    const clean = val.startsWith('0x')
      ? val.slice(2).toLowerCase()
      : val.toLowerCase()
    b = fromHex(clean)
  } else if (val instanceof Uint8Array) {
    b = val
  } else {
    throw bad(`${name} must be a hex string or Uint8Array`)
  }
  if (b.length < min || b.length > max) {
    throw bad(
      `${name} length must be between ${min} and ${max} bytes, got ${b.length}`,
    )
  }
  return b
}

function parseValue(
  val: number | bigint | string | Uint8Array,
): bigint | Uint8Array {
  if (typeof val === 'number') {
    if (!Number.isSafeInteger(val) || val < 0) {
      throw bad('value number must be a non-negative safe integer')
    }
    return BigInt(val)
  }
  if (typeof val === 'bigint') {
    if (val < 0n) throw bad('value cannot be negative')
    if (val <= 0xffffffffffffffffn) return val
    const hex = val.toString(16).padStart(64, '0')
    if (hex.length > 64) throw bad('value exceeds 256 bits')
    return fromHex(hex)
  }
  if (typeof val === 'string') {
    const clean = val.startsWith('0x')
      ? val.slice(2).toLowerCase()
      : val.toLowerCase()
    if (clean.length === 64) {
      return fromHex(clean)
    }
    const bi = BigInt(val)
    if (bi < 0n) throw bad('value cannot be negative')
    if (bi <= 0xffffffffffffffffn) return bi
    const hex = bi.toString(16).padStart(64, '0')
    if (hex.length > 64) throw bad('value exceeds 256 bits')
    return fromHex(hex)
  }
  if (val instanceof Uint8Array) {
    if (val.length !== 32) {
      throw bad(`value byte string must be exactly 32 bytes, got ${val.length}`)
    }
    return val
  }
  throw bad(
    'expected value to be a number, bigint, hex string, or 32-byte Uint8Array',
  )
}

function parseStealthMetadata(
  meta: CanonicalStealthMetadata | StealthMetadata,
): Map<number | bigint, any> {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw bad('stealthMetadata must be an object')
  }
  let keyType: number
  let keyBytes: Uint8Array
  if (
    'ephemeralPubKey' in meta &&
    typeof meta.ephemeralPubKey === 'object' &&
    'keyType' in meta.ephemeralPubKey &&
    meta.ephemeralPubKey.keyBytes instanceof Uint8Array
  ) {
    keyType = meta.ephemeralPubKey.keyType
    keyBytes = meta.ephemeralPubKey.keyBytes
  } else if ('keyType' in meta) {
    keyType = meta.keyType
    const rawKey = meta.ephemeralPubKey as string | Uint8Array
    keyBytes = parseBytes(rawKey, 1, 128, 'ephemeralPubKey')
  } else {
    throw bad('stealthMetadata missing keyType or ephemeralPubKey')
  }
  if (!Number.isSafeInteger(keyType) || keyType < 0 || keyType > 65535) {
    throw bad('stealthMetadata keyType must be in 0..65535')
  }
  if (keyType === 1 && keyBytes.length !== 33) {
    throw bad(`keyType 1 requires 33 key bytes, got ${keyBytes.length}`)
  }
  if (keyType === 2 && keyBytes.length !== 32) {
    throw bad(`keyType 2 requires 32 key bytes, got ${keyBytes.length}`)
  }

  const entries: Array<[number, any]> = [
    [
      0,
      cborMap([
        [0, keyType],
        [1, keyBytes],
      ]),
    ],
  ]

  if (meta.viewTag !== undefined) {
    let tagVal: bigint | Uint8Array
    if (typeof meta.viewTag === 'number') {
      if (
        !Number.isSafeInteger(meta.viewTag) ||
        meta.viewTag < 0 ||
        meta.viewTag > 65535
      ) {
        throw bad('viewTag integer must be in 0..65535')
      }
      tagVal = BigInt(meta.viewTag)
    } else if (typeof meta.viewTag === 'string') {
      tagVal = parseBytes(meta.viewTag, 1, 32, 'viewTag')
    } else if (meta.viewTag instanceof Uint8Array) {
      if (meta.viewTag.length < 1 || meta.viewTag.length > 32) {
        throw bad(
          `viewTag bytes length must be 1..32, got ${meta.viewTag.length}`,
        )
      }
      tagVal = meta.viewTag
    } else {
      throw bad('viewTag must be a number, hex string, or Uint8Array')
    }
    entries.push([1, tagVal])
  }

  return cborMap(entries)
}

const NETWORK_TAG = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function encodePaymentMember(member: PaymentMemberInput): Uint8Array {
  if (member === null || typeof member !== 'object' || Array.isArray(member)) {
    throw bad('expected a payment member object')
  }
  if (typeof member.network !== 'string' || !NETWORK_TAG.test(member.network)) {
    throw bad('network tag does not match S1')
  }
  const transactionId = parseBytes(
    member.transactionId,
    1,
    128,
    'transactionId',
  )
  if (member.vout !== undefined) {
    if (
      !Number.isSafeInteger(member.vout) ||
      member.vout < 0 ||
      member.vout > 4294967295
    ) {
      throw bad('vout must be an unsigned integer <= 4294967295')
    }
  }
  if (member.childIndex !== undefined) {
    if (
      !Number.isSafeInteger(member.childIndex) ||
      member.childIndex < 0 ||
      member.childIndex > 2147483647
    ) {
      throw bad('childIndex must be in 0..2147483647')
    }
  }
  const address = parseBytes(member.address, 1, 128, 'address')
  const value = parseValue(member.value)
  const token =
    member.token !== undefined
      ? parseBytes(member.token, 1, 128, 'token')
      : undefined
  const stealth =
    member.stealthMetadata !== undefined
      ? parseStealthMetadata(member.stealthMetadata)
      : undefined
  const commitment =
    member.commitment !== undefined
      ? parseBytes(member.commitment, 32, 32, 'commitment')
      : undefined
  const rawTx =
    member.rawTx !== undefined
      ? parseBytes(member.rawTx, 1, 16384, 'rawTx')
      : undefined
  const stamp = member.childIndex !== undefined
  if (stamp === (stealth !== undefined)) {
    throw bad('payment member requires exactly one of field 7 or field 8')
  }
  if (stamp && commitment === undefined) {
    throw bad('stamp payment requires a T4 commitment')
  }
  if (token !== undefined && stealth === undefined) {
    throw bad('token identifier is allowed only on a stealth payment')
  }

  const entries: Array<[number, any]> = [
    [0, member.network],
    [1, transactionId],
    [2, value],
    [3, address],
  ]
  if (commitment !== undefined) entries.push([4, commitment])
  if (member.vout !== undefined) entries.push([5, member.vout])
  if (rawTx !== undefined) entries.push([6, rawTx])
  if (stamp) entries.push([7, member.childIndex])
  if (stealth !== undefined) entries.push([8, stealth])
  if (token !== undefined) entries.push([9, token])

  const bytes = encodeCanonical(cborMap(entries))
  paymentMember(decodeCanonical(bytes), 'payment-member')
  return bytes
}

export function decodePaymentMember(bytes: Uint8Array): PaymentMember {
  return paymentMember(decodeCanonical(bytes), 'payment-member')
}

export function paymentMemberToCborMap(
  member: PaymentMemberInput,
): ReadonlyMap<bigint, FrankValue> {
  return decodeCanonical(encodePaymentMember(member)) as ReadonlyMap<
    bigint,
    FrankValue
  >
}
