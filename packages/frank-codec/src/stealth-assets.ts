/** Dedicated type-19 schema-2 recipient payments; never a wallet-sync item. */
import { cborMap } from './cbor'
import { TYPE_STEALTH_MESSAGE_ITEM } from './constants'
import { FrankCodecError } from './errors'
import { encodeFrame } from './frame'
import { paymentMemberToCborMap } from './stealth'
import type { PaymentMemberInput } from './stealth'
import type { AccountRef, ParsedFrame, StealthAssetMessageItem } from './types'
import { parseFrame } from './validate'

export const STEALTH_SCHEME_SECP256K1_ECDH_ADD_V1 = 1

export interface CanonicalStealthAssetMessageItem {
  transfers: ReadonlyArray<{
    transfer: PaymentMemberInput
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
      [0, paymentMemberToCborMap(entry.transfer)],
      [1, entry.derivationScheme],
      [
        2,
        cborMap([
          [0, entry.recipientSpendKey.keyType],
          [1, entry.recipientSpendKey.keyBytes],
        ]),
      ],
    ])
    if (entry.tokenProgram !== undefined) fields.set(3, entry.tokenProgram)
    if (entry.derivationContext !== undefined)
      fields.set(4, entry.derivationContext)
    return fields
  })
  const payload = cborMap([[0, transfers]])
  if (item.memo !== undefined) payload.set(1, item.memo)
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
    frame.typed?.type === 24 &&
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
