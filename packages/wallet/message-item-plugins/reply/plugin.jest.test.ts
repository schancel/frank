import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initReplyPlugin } from './plugin'

describePluginContract({
  type: 'reply',
  init: initReplyPlugin,
  samples: [
    {
      item: { type: 'reply', payloadDigest: 'ab'.repeat(32) },
      preview: 'Replied to a message',
    },
  ],
})
