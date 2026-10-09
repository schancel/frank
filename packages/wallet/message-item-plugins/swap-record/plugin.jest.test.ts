import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initSwapRecordPlugin } from './plugin'

describePluginContract({
  type: 'swap-record',
  init: initSwapRecordPlugin,
  samples: [
    {
      item: {
        type: 'swap-record',
        swapId: 'swap-1',
        chain: 'monad',
        fromAsset: 'MON',
        toAsset: 'USDC',
        fromAmount: '1.5',
        toAmount: '3.25',
        txHash: '0xabc',
        route: 'uniswap',
        feeDisplay: '0.01 MON',
        destinationAddress: '0xBob',
        status: 'confirmed',
        timestamp: 1728000000000,
        cborPayload: 'a0',
      },
      preview: 'Instant Swap: 1.5 MON → 3.25 USDC on MONAD',
    },
  ],
})
