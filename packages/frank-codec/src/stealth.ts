/** Pure typed-item writing and projection for stealth payment items (type 19). */
import { cborMap } from './cbor'
import { TYPE_STEALTH_MESSAGE_ITEM } from './constants'
import { FrankCodecError } from './errors'
import { encodeFrame } from './frame'
import { fromHex, toHex } from './hash'
import type { ParsedFrame, StealthMessageItem } from './types'
import { parseFrame } from './validate'

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
  return frame.typeId === TYPE_STEALTH_MESSAGE_ITEM && frame.typed?.type === 19
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
