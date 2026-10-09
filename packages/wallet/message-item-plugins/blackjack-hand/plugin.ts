/**
 * The peer-to-peer `blackjack-hand` item. The registry only needs the preview line, the thread key
 * and the bytes: a hand's state is folded by `foldHand` (`../blackjack/hand.ts`) from the
 * conversation's messages, because it needs each message's sender, recipient, stamp value and
 * payload digest, which a single item does not carry.
 */
import type { BlackjackHandV3Item } from '@frank/codec'

import { handPreviewText } from '../blackjack/hand'
import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { decodeBlackjackHand, encodeBlackjackHand } from './codec'

export function initBlackjackHandPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('blackjack-hand', capabilities)
  registry.register<BlackjackHandV3Item>({
    type: 'blackjack-hand',
    hydrate: raw => raw,
    previewText: handPreviewText,
    threadKey: raw => raw.gameId,
    encode: encodeBlackjackHand,
    decode: decodeBlackjackHand,
  })
}
