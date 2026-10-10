import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initSwapRecordPlugin } from './plugin'

describePluginContract({
  type: 'swap-record',
  init: initSwapRecordPlugin,
  samples: [
    {
      item: {
        type: 'swap-record',
        swapId: '00112233445566778899aabbccddeeff',
        chainIdentifier: 'monad-testnet',
        venueId: 'uniswap-v4',
        txHash: '0x' + 'ab'.repeat(32),
        account: '0x' + 'bb'.repeat(20),
        assetIn: { symbol: 'MON', decimals: 18 },
        amountIn: '5000000000000000',
        assetOut: {
          symbol: 'USDC',
          address: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
          decimals: 6,
        },
        quotedAmountOut: '4997',
        minimumAmountOut: '4947',
        interfaceFee: '0',
        networkFee: '21131544000000000',
        route: '{"zeroForOne":true}',
        timestamp: 1760000000000,
      },
      preview: 'Swap: MON → USDC on monad-testnet',
    },
  ],
})
