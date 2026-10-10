import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initSwapOfferPlugin } from './plugin'

import { registryWith } from '../shared/plugin-contract.testutil'

const offer = {
  type: 'swap-offer' as const,
  swapId: 'swap9876543210fedcba',
  offeredChain: 'monad-testnet',
  offeredAsset: 'MON',
  offeredAmount: '25.0',
  requestedChain: 'solana-testnet',
  requestedAsset: 'SOL',
  requestedAmount: '3.5',
  status: 'pending' as const,
  initiatorAddress: '0xAlice',
  recipientAddress: '0xBob',
  createdAt: 1728000000000,
}

describePluginContract({
  type: 'swap-offer',
  init: initSwapOfferPlugin,
  samples: [
    {
      item: offer,
      preview:
        'Atomic swap offer: 25.0 MON (monad-testnet) for 3.5 SOL (solana-testnet)',
    },
    {
      item: {
        ...offer,
        status: 'settled',
        expiresAt: 1728000600000,
        hashLock: 'aa'.repeat(32),
        preimage: 'bb'.repeat(32),
        legATxHash: '0x01',
        legBTxHash: '0x02',
        claimTxHash: '0x03',
        originInstanceId: 'instance-1',
      },
      preview:
        'Atomic swap offer: 25.0 MON (monad-testnet) for 3.5 SOL (solana-testnet)',
    },
  ],
})

it('tallies the offered amount', () => {
  expect(
    registryWith('swap-offer', initSwapOfferPlugin).tallyValue([offer]),
  ).toBe(25)
})
