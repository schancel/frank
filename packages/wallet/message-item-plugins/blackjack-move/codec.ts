/**
 * A dealer-bot `blackjack-move` item as bytes: the type-18 frame `@frank/codec` already defines
 * for the closed move shapes. The canonical direct message path does not carry this item type
 * today; these bytes are what it would carry.
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

import { MessageItemDecodeError, MessageItemEncodeError } from '../registry'
import { detailOf } from '../shared/cbor-fields'
import { decodeWith, openItemFrame } from '../shared/frame'

export function encodeBlackjackMove(item: BlackjackMoveItem): Uint8Array {
  try {
    return encodeBlackjackItem(item as CanonicalBlackjackMoveItem)
  } catch (error) {
    throw new MessageItemEncodeError('blackjack-move', detailOf(error))
  }
}

export function decodeBlackjackMove(bytes: Uint8Array): BlackjackMoveItem {
  const parsed = openItemFrame('blackjack-move', bytes)
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
