import type { ContactCardItem } from '@frank/cashweb/types/messages'

import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initContactCardPlugin } from './plugin'

const card: ContactCardItem = {
  type: 'contact-card',
  uid: 'vcard-alice-1573',
  fullName: 'Alice Nakamoto',
  frankAddress: '0x' + 'a1'.repeat(20),
  username: 'alice',
  emails: ['alice@frank.local'],
  phones: ['+1-555-0100'],
  organization: 'Frank Labs',
  title: 'Protocol Engineer',
  url: 'https://frank.local',
  note: 'Key fingerprint verified',
}

describePluginContract({
  type: 'contact-card',
  init: initContactCardPlugin,
  samples: [{ item: card, preview: 'Contact card: Alice Nakamoto' }],
})
