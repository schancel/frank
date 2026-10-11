import type { ConversationStateItem } from '@frank/cashweb/types/messages'

import { MessageItemDecodeError, MessageItemEncodeError } from '../registry'
import {
  cborItemCodec,
  chainAddress,
  matching,
  opt,
  req,
  str,
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
  // Empty: the subject was removed. What a subject may contain is the chat store's rule.
  subject: opt(4, str(512)),
  subjectSetAt: opt(5, timestampMs),
})

/** The facts one note may state. A note that states none says nothing and is refused. */
const FACTS = ['clearedBefore', 'readUpTo', 'subject'] as const

/** Why the item cannot be a note, if it cannot. */
function refusal(item: ConversationStateItem): string | undefined {
  if ((item.subject === undefined) !== (item.subjectSetAt === undefined))
    return 'item: a subject and the time it was set go together'
  if (!FACTS.some(fact => item[fact] !== undefined))
    return 'item: states no fact about the conversation'
  return undefined
}

/**
 * What one device of an account notes to the account's other devices about one conversation.
 * Carried only in a note a wallet addresses to itself (`SELF_ONLY_ITEM_TYPES`). No message
 * content and no key.
 */
export const conversationStateCodec: ItemCodec<ConversationStateItem> = {
  encode(item) {
    const bytes = fields.encode(item)
    const refused = refusal(item)
    if (refused) throw new MessageItemEncodeError('conversation-state', refused)
    return bytes
  },
  decode(bytes, context) {
    const item = fields.decode(bytes, context)
    const refused = refusal(item)
    if (refused) throw new MessageItemDecodeError('conversation-state', refused)
    return item
  },
}
