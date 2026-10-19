/** @jest-environment node */
import { createAppMessageItemRegistry, messageItems } from './message-items'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '@frank/wallet/message-item-plugins/registry'

it('explicitly installs inert negotiation in the actual app composition without changing wallet defaults', () => {
  const defaults = createDefaultMessageItemRegistry(
    pluginCapabilitiesNotYetAvailable,
  )
  const app = createAppMessageItemRegistry()
  expect(defaults.has('swap-negotiation-v1')).toBe(false)
  expect(defaults.has('newsletter-article-v1')).toBe(false)
  expect(defaults.has('article-v1')).toBe(false)
  expect(defaults.has('invoice-v1')).toBe(false)
  expect(defaults.has('mental-poker-v1')).toBe(false)
  expect(defaults.has('webrtc-call-v1')).toBe(false)
  expect(defaults.has('swap-handshake-v1')).toBe(false)
  expect(app.types()).toEqual([
    ...defaults.types(),
    'swap-negotiation-v1',
    'newsletter-article-v1',
    'article-v1',
    'invoice-v1',
    'mental-poker-v1',
    'webrtc-call-v1',
    'swap-handshake-v1',
  ])
  expect(messageItems.types()).toEqual(app.types())
  expect(app).not.toBe(messageItems)
  expect(
    app.tallyValue([
      {
        type: 'application',
        itemType: 'swap-negotiation-v1',
        value: { eventHex: '00' },
      },
    ]),
  ).toBe(0)
})
