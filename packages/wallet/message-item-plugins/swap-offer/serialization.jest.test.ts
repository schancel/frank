import type { SwapOfferItem } from '@frank/cashweb/types/messages'
import {
  deserializeMessageItems,
  serializeMessageItems,
} from '../../chain/monad-chain'
import { registryWith } from '../shared/plugin-contract.testutil'
import { initSwapOfferPlugin } from './plugin'

describe('swap-offer message item plugin and serialization', () => {
  const sampleOffer: SwapOfferItem = {
    type: 'swap-offer',
    swapId: 'swap9876543210fedcba',
    offeredChain: 'monad-testnet',
    offeredAsset: 'MON',
    offeredAmount: '25.0',
    requestedChain: 'solana-testnet',
    requestedAsset: 'SOL',
    requestedAmount: '3.5',
    status: 'pending',
    initiatorAddress: '0xAlice',
    recipientAddress: '0xBob',
    createdAt: 1728000000000,
  }

  it('registers swap-offer plugin with descriptive previewText and tallyValue', () => {
    const plugin = registryWith('swap-offer', initSwapOfferPlugin).get(
      'swap-offer',
    )
    expect(plugin).toBeDefined()
    expect(plugin!.previewText(sampleOffer)).toBe(
      'Atomic swap offer: 25.0 MON (monad-testnet) for 3.5 SOL (solana-testnet)',
    )
    expect(plugin!.tallyValue?.(sampleOffer)).toBe(25)
  })

  it('serializes and deserializes swap-offer items without loss', () => {
    const serialized = serializeMessageItems([sampleOffer])
    expect(typeof serialized).toBe('string')

    const deserialized = deserializeMessageItems(serialized)
    expect(deserialized).toHaveLength(1)
    expect(deserialized[0]).toEqual(sampleOffer)
  })
})
