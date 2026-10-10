/** @jest-environment jsdom */
import { setActivePinia, createPinia } from 'pinia'
import type { SwapRecordItem } from '@frank/cashweb/types/messages'
import { SWAP_STORAGE_KEY, useSwapStore } from './swaps'

const item = (over: Partial<SwapRecordItem> = {}): SwapRecordItem => ({
  type: 'swap-record',
  swapId: 'a'.repeat(64),
  chainIdentifier: 'monad-testnet',
  venueId: 'uniswap-v4',
  txHash: '0x' + 'ab'.repeat(32),
  account: '0x' + 'bb'.repeat(20),
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

describe('the swap history store', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
  })

  it('is the fold of the account’s swap records: the same record twice is one swap', () => {
    const store = useSwapStore()
    store.handleSwapItem(item())
    // The note arrives again, or the wallet journal lists it too, with a later clock.
    store.handleSwapItem(item({ timestamp: 9_000 }))
    expect(store.records).toHaveLength(1)
    expect(store.records[0]).toMatchObject({
      swapId: 'a'.repeat(64),
      venueId: 'uniswap-v4',
      amountIn: '5000000000000000',
      minimumAmountOut: '4947',
      timestamp: 2_000,
    })
    expect('type' in store.records[0]).toBe(false)
  })

  it('lists a swap only on the canonical chain it was made on, newest first', () => {
    const store = useSwapStore()
    store.handleSwapItem(item())
    store.handleSwapItem(item({ swapId: 'b'.repeat(64), timestamp: 5_000 }))
    store.handleSwapItem(
      item({ swapId: 'c'.repeat(64), chainIdentifier: 'monad-mainnet' }),
    )
    expect(
      store.getSwapsForChain('monad-testnet').map(record => record.swapId),
    ).toEqual(['b'.repeat(64), 'a'.repeat(64)])
    expect(store.getSwapsForChain('monad')).toEqual([])
    expect(store.getSwapsForChain(undefined)).toEqual([])
  })

  it('ignores anything that is not a swap record', () => {
    const store = useSwapStore()
    store.handleSwapItem({ type: 'text' } as unknown as SwapRecordItem)
    store.handleSwapItem(item({ swapId: '' }))
    expect(store.records).toEqual([])
  })

  it('remembers what the chain said a swap did, apart from the record, and a later note does not undo it', () => {
    const store = useSwapStore()
    store.cacheOutcome('a'.repeat(64), {
      status: 'confirmed',
      amountOut: '4997',
      feeWei: '21131544000000000',
    })
    // The outcome was read before the note arrived.
    store.handleSwapItem(item())
    expect(store.outcomes['a'.repeat(64)]).toEqual({
      status: 'confirmed',
      amountOut: '4997',
      feeWei: '21131544000000000',
    })
    expect(store.records).toHaveLength(1)
  })

  it('is only a cache: a fresh device starts empty and rebuilds from the same records', () => {
    const first = useSwapStore()
    first.handleSwapItem(item())
    first.cacheOutcome('a'.repeat(64), { status: 'confirmed' })
    // Reload on this device: the cache is read back.
    setActivePinia(createPinia())
    expect(useSwapStore().records).toHaveLength(1)
    expect(useSwapStore().outcomes['a'.repeat(64)]).toEqual({
      status: 'confirmed',
    })
    // Another device, or cleared storage: nothing until the mailbox delivers the note again.
    window.localStorage.clear()
    setActivePinia(createPinia())
    const other = useSwapStore()
    expect(other.records).toEqual([])
    other.handleSwapItem(item())
    expect(other.getSwapsForChain('monad-testnet')).toHaveLength(1)
  })

  it('survives storage that cannot be read or written', () => {
    window.localStorage.setItem(SWAP_STORAGE_KEY, '{not json')
    setActivePinia(createPinia())
    const store = useSwapStore()
    expect(store.records).toEqual([])
    const write = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })
    expect(() => store.handleSwapItem(item())).not.toThrow()
    expect(store.records).toHaveLength(1)
    write.mockRestore()
  })
})
