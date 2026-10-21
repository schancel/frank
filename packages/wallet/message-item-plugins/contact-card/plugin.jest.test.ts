import type { ContactCardItem } from '@frank/cashweb/types/messages'

import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initContactCardPlugin, isWakeupCapabilitySidecar } from './plugin'

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

it('identifies only the reserved wakeup sidecar, independently of the contact name', () => {
  const sidecar = {
    ...card,
    uid: 'frank-wakeup-capability',
    wakeupTokenHex: 'ab'.repeat(32),
  }
  expect(isWakeupCapabilitySidecar(sidecar)).toBe(true)
  expect(
    isWakeupCapabilitySidecar({ ...sidecar, fullName: 'Changed label' }),
  ).toBe(true)
  expect(
    isWakeupCapabilitySidecar({
      ...card,
      fullName: 'Wakeup Capability',
      wakeupTokenHex: sidecar.wakeupTokenHex,
    }),
  ).toBe(false)
  expect(
    isWakeupCapabilitySidecar({ ...sidecar, wakeupTokenHex: undefined }),
  ).toBe(false)
  expect(
    isWakeupCapabilitySidecar({ ...sidecar, wakeupTokenHex: 'malformed' }),
  ).toBe(false)
  expect(
    isWakeupCapabilitySidecar({ type: 'text', text: 'Wakeup Capability' }),
  ).toBe(false)
})
