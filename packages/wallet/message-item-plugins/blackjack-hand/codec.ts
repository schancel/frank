/**
 * A peer-to-peer blackjack hand item is the canonical type-18 schema-3 frame, written and
 * projected by the same functions the canonical direct message path uses today, so the bytes are
 * identical.
 */
import {
  encodeBlackjackHandV3Item,
  isBlackjackHandV3Frame,
  projectBlackjackHandV3Item,
  type BlackjackHandV3Item,
} from '@frank/codec'

import { MessageItemDecodeError } from '../registry'
import { decodeWith, openItemFrame } from '../shared/frame'

export function encodeBlackjackHand(item: BlackjackHandV3Item): Uint8Array {
  return encodeBlackjackHandV3Item(item)
}

export function decodeBlackjackHand(bytes: Uint8Array): BlackjackHandV3Item {
  const parsed = openItemFrame('blackjack-hand', bytes)
  if (!isBlackjackHandV3Frame(parsed))
    throw new MessageItemDecodeError(
      'blackjack-hand',
      'not a schema-3 blackjack hand frame',
    )
  return decodeWith(
    'blackjack-hand',
    () => projectBlackjackHandV3Item(parsed).item,
  )
}
