import { encodeCanonical } from '@frank/codec'
import type { ConversationStateItem } from '@frank/cashweb/types/messages'

import { MessageItemDecodeError, MessageItemEncodeError } from '../registry'
import {
  describePluginContract,
  registryWith,
  standaloneDecodeContext,
} from '../shared/plugin-contract.testutil'
import { initConversationStatePlugin } from './plugin'

const CONVERSATION = '123e4567-e89b-52d3-a456-426614174000'
const PEER = '0x' + 'b2'.repeat(20)

describePluginContract({
  type: 'conversation-state',
  init: initConversationStatePlugin,
  samples: [
    {
      item: {
        type: 'conversation-state',
        conversationId: CONVERSATION,
        peer: PEER,
        clearedBefore: 1760000000000,
      },
      preview: 'Conversation state',
    },
  ],
})

describe('a conversation-state note must state a fact', () => {
  const registry = registryWith(
    'conversation-state',
    initConversationStatePlugin,
  )

  it('is not encoded without one', () => {
    expect(() =>
      registry.encodeItem({
        type: 'conversation-state',
        conversationId: CONVERSATION,
        peer: PEER,
      } as ConversationStateItem),
    ).toThrow(MessageItemEncodeError)
  })

  it('is refused on receive without one', () => {
    const bytes = encodeCanonical(
      new Map<bigint, string>([
        [0n, CONVERSATION],
        [1n, PEER],
      ]),
    )
    expect(() =>
      registry.decodeItem(
        'conversation-state',
        bytes,
        standaloneDecodeContext(),
      ),
    ).toThrow(MessageItemDecodeError)
  })
})
