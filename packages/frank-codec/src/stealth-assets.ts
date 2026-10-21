/** Dedicated type-19 schema-2 recipient payments; never a wallet-sync item. */
import { cborMap } from './cbor'
import {
  ACCOUNT_REF,
  STEALTH_ASSET_MESSAGE_ITEM,
  STEALTH_ASSET_TRANSFER,
  TYPE_STEALTH_MESSAGE_ITEM,
} from './constants'
import { FrankCodecError } from './errors'
import { encodeFrame } from './frame'
import { paymentTransferToCborMap } from './stealth'
import type { CanonicalPaymentTransfer } from './stealth'
import type {
  AccountRef,
  ParsedFrame,
  PaymentTransfer,
  StealthAssetMessageItem,
} from './types'
import { parseFrame } from './validate'

export const STEALTH_SCHEME_SECP256K1_ECDH_ADD_V1 = 1

export interface CanonicalStealthAssetMessageItem {
  transfers: ReadonlyArray<{
    transfer: PaymentTransfer | CanonicalPaymentTransfer
    derivationScheme: number
    recipientSpendKey: AccountRef
    tokenProgram?: Uint8Array
    derivationContext?: Uint8Array
  }>
  memo?: string
}

export function encodeStealthAssetMessageItem(
  item: CanonicalStealthAssetMessageItem,
): Uint8Array {
  if (
    !item ||
    !Array.isArray(item.transfers) ||
    item.transfers.length === 0 ||
    item.transfers.length > 16
  )
    throw new FrankCodecError(
      'schema',
      '8.2',
      'expected 1..16 recipient transfers',
      'stealth-assets/writer',
    )
  const transfers = item.transfers.map(entry => {
    const fields = cborMap([
      [
        STEALTH_ASSET_TRANSFER.transfer,
        paymentTransferToCborMap(entry.transfer),
      ],
      [STEALTH_ASSET_TRANSFER.derivationScheme, entry.derivationScheme],
      [
        STEALTH_ASSET_TRANSFER.recipientSpendKey,
        cborMap([
          [ACCOUNT_REF.keyType, entry.recipientSpendKey.keyType],
          [ACCOUNT_REF.keyBytes, entry.recipientSpendKey.keyBytes],
        ]),
      ],
    ])
    if (entry.tokenProgram !== undefined)
      fields.set(STEALTH_ASSET_TRANSFER.tokenProgram, entry.tokenProgram)
    if (entry.derivationContext !== undefined)
      fields.set(
        STEALTH_ASSET_TRANSFER.derivationContext,
        entry.derivationContext,
      )
    return fields
  })
  const payload = cborMap([[STEALTH_ASSET_MESSAGE_ITEM.transfers, transfers]])
  if (item.memo !== undefined)
    payload.set(STEALTH_ASSET_MESSAGE_ITEM.memo, item.memo)
  const bytes = encodeFrame(
    {
      typeId: TYPE_STEALTH_MESSAGE_ITEM,
      schemaVersion: 2,
      minReaderVersion: 2,
    },
    payload,
  )
  parseFrame(bytes)
  return bytes
}

export function isStealthAssetMessageItemFrame(
  frame: ParsedFrame,
): frame is ParsedFrame & { typed: StealthAssetMessageItem } {
  return (
    frame.typeId === TYPE_STEALTH_MESSAGE_ITEM &&
    frame.schemaVersion >= 2 &&
    frame.typed?.type === TYPE_STEALTH_MESSAGE_ITEM &&
    'transfers' in frame.typed
  )
}

export function projectStealthAssetMessageItem(
  frame: ParsedFrame,
): StealthAssetMessageItem {
  if (!isStealthAssetMessageItemFrame(frame))
    throw new FrankCodecError(
      'schema',
      '8.2',
      'frame is not a schema-2 recipient payment',
      'stealth-assets/projection',
    )
  return frame.typed
}
