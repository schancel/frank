import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initP2pkhPlugin } from './plugin'

describePluginContract({
  type: 'p2pkh',
  init: initP2pkhPlugin,
  samples: [
    {
      item: { type: 'p2pkh', address: 'lotus_16PSJ', amount: 1500000 },
      preview: 'Sent a payment',
    },
    {
      item: { type: 'p2pkh', address: 'lotus_16PSJ', amount: 0.5 },
      preview: 'Sent a payment',
    },
  ],
})
