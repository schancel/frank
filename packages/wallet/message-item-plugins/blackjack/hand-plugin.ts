/**
 * Registers the peer-to-peer `blackjack-hand` item with the shared plugin registry. The registry
 * only needs the preview line and the thread key: a hand's state is folded by `foldHand`
 * (`./hand.ts`) from the conversation's messages, because it needs each message's sender,
 * recipient, stamp value and payload digest, which a single item does not carry.
 */
import type { BlackjackHandV3Item } from '@frank/codec'

import { handPreviewText } from './hand'
import { registerMessageItemPlugin } from '../index'

registerMessageItemPlugin<BlackjackHandV3Item>({
  type: 'blackjack-hand',
  hydrate: raw => raw,
  previewText: handPreviewText,
  threadKey: raw => raw.gameId,
})
