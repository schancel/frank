import type { ConversationStateItem } from '@frank/cashweb/types/messages'

import { MessageItemDecodeError, MessageItemEncodeError } from '../registry'
import {
  cborItemCodec,
  chainAddress,
  matching,
  opt,
  req,
  timestampMs,
  type ItemCodec,
} from '../shared/cbor-fields'

/** A conversation ID as the chat store keys it: 16 bytes as lowercase `8-4-4-4-12` text. */
const conversationId = matching(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  'a conversation ID (16 bytes as lowercase 8-4-4-4-12 text)',
)

const fields = cborItemCodec<ConversationStateItem>('conversation-state', {
  conversationId: req(0, conversationId),
  peer: req(1, chainAddress),
  clearedBefore: opt(2, timestampMs),
  readUpTo: opt(3, timestampMs),
})

/** The facts one note may state. A note that states none says nothing and is refused. */
const FACTS = ['clearedBefore', 'readUpTo'] as const

function statesAFact(item: ConversationStateItem): boolean {
  return FACTS.some(fact => item[fact] !== undefined)
}

/**
 * What one device of an account notes to the account's other devices about one conversation.
 * Carried only in a note a wallet addresses to itself (`SELF_ONLY_ITEM_TYPES`). No message
 * content and no key.
 */
export const conversationStateCodec: ItemCodec<ConversationStateItem> = {
  encode(item) {
    if (!statesAFact(item))
      throw new MessageItemEncodeError(
        'conversation-state',
        'item: states no fact about the conversation',
      )
    return fields.encode(item)
  },
  decode(bytes, context) {
    const item = fields.decode(bytes, context)
    if (!statesAFact(item))
      throw new MessageItemDecodeError(
        'conversation-state',
        'item: states no fact about the conversation',
      )
    return item
  },
}
