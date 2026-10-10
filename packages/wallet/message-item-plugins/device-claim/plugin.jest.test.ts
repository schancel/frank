import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initDeviceClaimPlugin } from './plugin'

describePluginContract({
  type: 'device-claim',
  init: initDeviceClaimPlugin,
  samples: [
    {
      item: {
        type: 'device-claim',
        instanceId: 'instance-0123456789',
        deviceName: 'Laptop',
        claimedAt: 1728000000000,
        leaseDurationMs: 60000,
      },
      preview: 'Active master claim: Laptop',
    },
    {
      item: {
        type: 'device-claim',
        instanceId: 'instance-0123456789',
        claimedAt: 1,
      },
      preview: 'Active master claim: instance',
    },
  ],
})
