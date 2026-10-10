/** @jest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import type { SwapRecordItem } from '@frank/cashweb/types/messages'

enableAutoUnmount(afterEach)

const mockObserve = jest.fn()
const mockOpen = jest.fn(async () => ({
  dex: { observe: mockObserve },
  account: '0xMAIN',
}))
jest.mock('./evm-swap-session', () => ({
  evmSwapVenues: () => [{ id: 'uniswap-v4', displayName: 'Uniswap v4' }],
  openEvmSwapSession: (...args: unknown[]) => mockOpen(...(args as [])),
}))

import { useSwapStore } from '../stores/swaps'
import { SwapRecordMismatchError } from '@frank/wallet/swap/evm-dex'
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

/** Mounted, with the wallet's main account read (the list is one account's). */
async function mountActivity(chain = 'monad-testnet') {
  let api!: ReturnType<typeof useSwapActivity>
  mount(
    defineComponent({
      setup() {
        api = useSwapActivity(ref(chain))
        return () => h('div')
      },
    }),
  )
  await flushPromises()
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
    const api = await mountActivity()
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
    const api = await mountActivity()
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
    const api = await mountActivity()
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
  it('lists only the swaps of the account the wallet signs from', async () => {
    mockObserve.mockResolvedValue({ status: 'pending' })
    const api = await mountActivity()
    useSwapStore().handleSwapItem(note())
    useSwapStore().handleSwapItem(
      note({ swapId: 'b'.repeat(64), account: '0xSomeoneElse' }),
    )
    expect(api.rows.value.map(row => row.id)).toEqual(['a'.repeat(64)])
  })

  it('does not show a record whose transaction the chain says is not this account’s swap, and stops asking', async () => {
    mockObserve.mockRejectedValue(new SwapRecordMismatchError())
    const api = await mountActivity()
    useSwapStore().handleSwapItem(note())
    await flushPromises()
    expect(api.rows.value).toEqual([])
    mockObserve.mockClear()
    await api.readOutcomes()
    expect(mockObserve).not.toHaveBeenCalled()
  })

  it('asks less and less often about a swap whose transaction never appears', async () => {
    let now = 1_000_000
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      mockObserve.mockResolvedValue({ status: 'pending' })
      const api = await mountActivity()
      useSwapStore().handleSwapItem(note())
      await flushPromises()
      expect(mockObserve).toHaveBeenCalledTimes(1)
      // Asked again only when its wait is over: 20 s, then 40 s, then 80 s.
      const askedAfter = async (ms: number) => {
        now += ms
        await api.readOutcomes()
        return mockObserve.mock.calls.length
      }
      expect(await askedAfter(19_000)).toBe(1)
      expect(await askedAfter(1_000)).toBe(2)
      expect(await askedAfter(39_000)).toBe(2)
      expect(await askedAfter(1_000)).toBe(3)
      expect(await askedAfter(79_000)).toBe(3)
      expect(await askedAfter(1_000)).toBe(4)
      // Never rarer than once in ten minutes.
      for (let i = 0; i < 8; i++) await askedAfter(10 * 60_000)
      expect(mockObserve).toHaveBeenCalledTimes(12)
    } finally {
      clock.mockRestore()
    }
  })
})
