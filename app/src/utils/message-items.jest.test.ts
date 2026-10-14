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
  expect(app.types()).toEqual([
    ...defaults.types(),
    'group-welcome',
    'group-control',
    'swap-negotiation-v1',
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
