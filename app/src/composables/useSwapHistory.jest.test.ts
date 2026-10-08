/** @jest-environment jsdom */
import { setActivePinia, createPinia } from 'pinia'
import { useSwapHistory } from './useSwapHistory'

jest.mock('../stores/chats', () => ({
  useChatStore: jest.fn(() => ({
    selfSendMessage: jest.fn().mockResolvedValue(undefined),
  })),
}))

describe('useSwapHistory composable', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('logs a swap record, stores it in history, and filters by chain', async () => {
    const { logSwap, getSwapsForChain, allSwaps } = useSwapHistory()

    const swap = await logSwap({
      chain: 'solana',
      fromAsset: 'SOL',
      toAsset: 'USDC',
      fromAmount: '1.0',
      toAmount: '144.87',
      txHash: '5Kabcdef1234567890',
      route: 'Jupiter Aggregator (Solana)',
      feeDisplay: '0.0875% (~$0.13)',
      destinationAddress: 'Private Stealth Address',
    })

    expect(swap.id).toBeDefined()
    expect(swap.status).toBe('confirmed')
    expect(allSwaps.value).toHaveLength(1)

    const solanaSwaps = getSwapsForChain('solana')
    expect(solanaSwaps.value).toHaveLength(1)
    expect(solanaSwaps.value[0].fromAsset).toBe('SOL')
    expect(solanaSwaps.value[0].toAsset).toBe('USDC')

    const monadSwaps = getSwapsForChain('monad')
    expect(monadSwaps.value).toHaveLength(0)
  })
})
