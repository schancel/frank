/**
 * A dealer-bot `blackjack-move` item as bytes: the type-18 frame `@frank/codec` already defines
 * for the closed move shapes. The canonical direct message path does NOT carry this item type
 * (`NOT_CARRIED_ITEM_TYPES` in `../wire.ts`): it is refused on send and one that arrives is kept
 * as unsupported. The plugin remains so messages already stored still render.
 */
import {
  encodeBlackjackItem,
  isBlackjackHandFrame,
  isBlackjackHandV3Frame,
  projectBlackjackItem,
} from '@frank/codec'
import type {
  BlackjackMoveItem,
  CanonicalBlackjackMoveItem,
} from '@frank/cashweb/types/messages'

import {
  MessageItemDecodeError,
  MessageItemEncodeError,
  type MessageItemDecodeContext,
} from '../registry'
import { detailOf } from '../shared/cbor-fields'
import { decodeWith, openItemFrame } from '../shared/frame'

export function encodeBlackjackMove(item: BlackjackMoveItem): Uint8Array {
  try {
    return encodeBlackjackItem(item as CanonicalBlackjackMoveItem)
  } catch (error) {
    throw new MessageItemEncodeError('blackjack-move', detailOf(error))
  }
}

export function decodeBlackjackMove(
  bytes: Uint8Array,
  context: MessageItemDecodeContext,
): BlackjackMoveItem {
  const parsed = openItemFrame('blackjack-move', bytes, context)
  if (isBlackjackHandFrame(parsed) || isBlackjackHandV3Frame(parsed))
    throw new MessageItemDecodeError(
      'blackjack-move',
      'a blackjack hand frame is not a move',
    )
  // The projection's card arrays are fresh copies, so widening them to mutable is sound.
  return decodeWith(
    'blackjack-move',
    () => projectBlackjackItem(parsed).item as BlackjackMoveItem,
  )
}
