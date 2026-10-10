/**
 * A stealth item is the canonical type-19 frame. `encodeStealthItem` makes the same call the
 * canonical direct message path makes today (including how the deprecated `chainId`, `rawTx` and
 * `solanaTx` fields are folded in), so the bytes are identical; `decodeStealthItem` gives the same
 * projection the receive path gives.
 */
import {
  encodeStealthMessageItem,
  isStealthMessageItemFrame,
  projectStealthMessageItem,
} from '@frank/codec'
import type { StealthItem } from '@frank/cashweb/types/messages'

import {
  MessageItemDecodeError,
  type MessageItemDecodeContext,
} from '../registry'
import { decodeWith, openItemFrame } from '../shared/frame'

export function encodeStealthItem(item: StealthItem): Uint8Array {
  const networkTag = item.networkTag ?? item.chainId
  if (!networkTag) {
    throw new Error('Stealth item must have networkTag or chainId')
  }
  const ephemeralPubKey = item.ephemeralPubKey
  if (!ephemeralPubKey) {
    throw new Error('Stealth item must have ephemeralPubKey')
  }
  const rawTxs =
    item.transactions ??
    (item.rawTx ? [item.rawTx] : item.solanaTx ? [item.solanaTx] : [])
  if (rawTxs.length === 0) {
    throw new Error('Stealth item must have at least one transaction')
  }
  return encodeStealthMessageItem({
    type: 'stealth',
    networkTag,
    keyType: item.keyType ?? 1,
    ephemeralPubKey,
    transactions: rawTxs,
    // The exact amount when the item has it: a JS number cannot hold most wei amounts.
    amount: item.amountWei !== undefined ? BigInt(item.amountWei) : item.amount,
    memo: item.memo,
  })
}

export function decodeStealthItem(
  bytes: Uint8Array,
  context: MessageItemDecodeContext,
): StealthItem {
  const parsed = openItemFrame('stealth', bytes, context)
  if (!isStealthMessageItemFrame(parsed))
    throw new MessageItemDecodeError('stealth', 'not a stealth item frame')
  return decodeWith('stealth', () => {
    const projected = projectStealthMessageItem(parsed)
    return {
      ...projected,
      amount: Number(projected.amount),
      // The frame's own integer, exact.
      amountWei: BigInt(parsed.typed.amount).toString(),
    }
  })
}
