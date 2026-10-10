/** @jest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import type { SwapRecordItem } from '@frank/cashweb/types/messages'

enableAutoUnmount(afterEach)

const mockObserve = jest.fn()
const mockOpen = jest.fn(async () => ({ dex: { observe: mockObserve } }))
jest.mock('./evm-swap-session', () => ({
  evmSwapVenues: () => [{ id: 'uniswap-v4', displayName: 'Uniswap v4' }],
  openEvmSwapSession: (...args: unknown[]) => mockOpen(...(args as [])),
}))

import { useSwapStore } from '../stores/swaps'
import { useSwapActivity } from './useSwapActivity'

const note = (over: Partial<SwapRecordItem> = {}): SwapRecordItem => ({
  type: 'swap-record',
  swapId: 'a'.repeat(64),
  chainIdentifier: 'monad-testnet',
  venueId: 'uniswap-v4',
  txHash: '0x' + 'ab'.repeat(32),
  account: '0xMain',
  assetIn: { symbol: 'MON', decimals: 18 },
  amountIn: '5000000000000000',
  assetOut: { symbol: 'USDC', address: '0xusdc', decimals: 6 },
  quotedAmountOut: '4997',
  minimumAmountOut: '4947',
  interfaceFee: '0',
  networkFee: '21131544000000000',
  route: '{"zeroForOne":true}',
  timestamp: 2_000,
  ...over,
})

function mountActivity(chain = 'monad-testnet') {
  let api!: ReturnType<typeof useSwapActivity>
  mount(
    defineComponent({
      setup() {
        api = useSwapActivity(ref(chain))
        return () => h('div')
      },
    }),
  )
  return api
}

beforeEach(() => {
  window.localStorage.clear()
  setActivePinia(createPinia())
  mockObserve.mockReset()
  mockOpen.mockClear()
})

describe('Recent Activity', () => {
  it('is rebuilt from the account’s swap notes on a device that never made the swap, with the outcome read from the chain', async () => {
    mockObserve.mockResolvedValue({
      status: 'confirmed',
      txHash: note().txHash,
      operationId: '',
      amountOut: 4_997n,
      feeWei: 21_131_544_000_000_000n,
      totalFeeWei: 21_131_544_000_000_000n,
    })
    const api = mountActivity()
    expect(api.rows.value).toEqual([])
    // The mailbox delivers the note the account sent itself.
    useSwapStore().handleSwapItem(note())
    // Until the chain has been read: pending, showing the least that may arrive.
    expect(api.rows.value).toEqual([
      {
        id: 'a'.repeat(64),
        timestamp: 2_000,
        chainIdentifier: 'monad-testnet',
        txHash: note().txHash,
        fromAmount: '0.005',
        fromAsset: 'MON',
        toAmount: '0.004947',
        toAsset: 'USDC',
        route: 'Uniswap v4',
        status: 'pending',
      },
    ])
    await flushPromises()
    // Read by its transaction, for the venue and route the note names. Nothing is sent.
    expect(mockOpen).toHaveBeenCalledWith('monad-testnet', 'uniswap-v4')
    expect(mockObserve).toHaveBeenCalledWith({
      transactionId: note().txHash,
      account: '0xMain',
      route: { zeroForOne: true },
    })
    expect(api.rows.value[0]).toMatchObject({
      status: 'confirmed',
      toAmount: '0.004997',
    })
    // Remembered: the chain is not asked again for a swap whose outcome is known.
    mockObserve.mockClear()
    await api.readOutcomes()
    expect(mockObserve).not.toHaveBeenCalled()
  })

  it('shows a reverted swap as not completed with nothing received', async () => {
    mockObserve.mockResolvedValue({
      status: 'reverted',
      txHash: note().txHash,
      operationId: '',
      feeWei: 1n,
      totalFeeWei: 1n,
    })
    const api = mountActivity()
    useSwapStore().handleSwapItem(note())
    await flushPromises()
    expect(api.rows.value[0]).toMatchObject({ status: 'failed', toAmount: '0' })
  })

  it('leaves a swap pending when the chain has not shown it, and lists only this network’s swaps', async () => {
    mockObserve.mockResolvedValue({
      status: 'pending',
      txHash: note().txHash,
      operationId: '',
    })
    const api = mountActivity()
    useSwapStore().handleSwapItem(note())
    useSwapStore().handleSwapItem(
      note({ swapId: 'b'.repeat(64), chainIdentifier: 'monad-mainnet' }),
    )
    await flushPromises()
    expect(api.rows.value.map(row => [row.id, row.status])).toEqual([
      ['a'.repeat(64), 'pending'],
    ])
    expect(useSwapStore().outcomes).toEqual({})
  })
})
