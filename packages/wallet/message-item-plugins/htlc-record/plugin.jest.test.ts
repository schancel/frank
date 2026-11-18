import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initHtlcRecordPlugin } from './plugin'

describePluginContract({
  type: 'htlc-record',
  init: initHtlcRecordPlugin,
  samples: (['lock', 'withdraw', 'refund'] as const).map(action => ({
    item: {
      type: 'htlc-record' as const,
      chainIdentifier: 'monad-testnet',
      action,
      swapId: '0f'.repeat(32),
      lockId: '0x' + 'cd'.repeat(32),
      txHash: '0x' + 'ab'.repeat(32),
      timestamp: 1760000000000,
    },
    preview: `Swap HTLC ${action} on monad-testnet`,
  })),
})
