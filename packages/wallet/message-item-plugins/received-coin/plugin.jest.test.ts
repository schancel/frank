import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initReceivedCoinPlugin } from './plugin'

describePluginContract({
  type: 'received-coin',
  init: initReceivedCoinPlugin,
  samples: [
    {
      item: {
        type: 'received-coin',
        chainIdentifier: 'monad-testnet',
        address: '0x' + 'cc'.repeat(20),
        origin: 'stamp',
        stampSharedPoint: '02' + 'ab'.repeat(32),
        childIndex: 0,
        claimedAmountWei: '1000000000000',
        transactions: ['ef'.repeat(32)],
        payloadDigest: '12'.repeat(32),
        timestamp: 1760000000000,
      },
      preview: 'Received coin on monad-testnet',
    },
    {
      item: {
        type: 'received-coin',
        chainIdentifier: 'monad-testnet',
        address: '0x' + 'dd'.repeat(20),
        origin: 'stealth',
        ephemeralPubKey: '03' + 'cd'.repeat(32),
        claimedAmountWei: '10000000000000000',
        timestamp: 1760000000001,
      },
      preview: 'Received coin on monad-testnet',
    },
  ],
})
