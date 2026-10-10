/** @jest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

enableAutoUnmount(afterEach)

const mockReads = jest.fn(async () => 7n)
jest.mock('@frank/wallet/swap/evm-swap', () => ({
  readTokenBalance: () => mockReads(),
}))
jest.mock('src/swap/evm-swap-session', () => ({
  evmSwapVenues: (id: string) => (id === 'monad-testnet' ? [{}] : []),
  openEvmSwapSession: async () => ({
    reader: {},
    account: '0x0000000000000000000000000000000000000001',
    dex: {
      tokens: [
        { symbol: 'MON', name: 'Monad', decimals: 18, address: null },
        { symbol: 'USDC', name: 'USD Coin', decimals: 6, address: '0xusdc' },
      ],
    },
  }),
}))

import { useEvmTokenBalances } from './useEvmTokenBalances'

function mountWith(chain: string | undefined) {
  let api!: ReturnType<typeof useEvmTokenBalances>
  mount(
    defineComponent({
      setup() {
        api = useEvmTokenBalances(ref(chain))
        return () => h('div')
      },
    }),
  )
  return api
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
  jest.setSystemTime(1_800_000_000_000)
  mockReads.mockClear()
})
afterEach(() => jest.useRealTimers())

describe('ERC-20 balances on the wallet page', () => {
  it('lists the tokens of the chain’s exchange with balances read from the chain', async () => {
    const api = mountWith('monad-testnet')
    await flushPromises()
    expect(api.status.value).toBe('available')
    expect(api.rows.value).toEqual([
      {
        symbol: 'USDC',
        name: 'USD Coin',
        address: '0xusdc',
        balance: '0.000007',
        exact: '0.000007',
      },
    ])
  })

  it('reads nothing for a network with no exchange', async () => {
    const api = mountWith('monad-mainnet')
    await flushPromises()
    expect(api.status.value).toBe('none')
    expect(mockReads).not.toHaveBeenCalled()
  })

  it('does not poll in a hidden tab or after two minutes without input, and reads again when looked at', async () => {
    mountWith('monad-testnet')
    await flushPromises()
    const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    mockReads.mockClear()
    jest.advanceTimersByTime(60_000)
    await flushPromises()
    expect(mockReads).not.toHaveBeenCalled()
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(mockReads).toHaveBeenCalledTimes(2)

    jest.advanceTimersByTime(121_000)
    await flushPromises()
    mockReads.mockClear()
    jest.advanceTimersByTime(120_000)
    await flushPromises()
    expect(mockReads).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('pointerdown'))
    await flushPromises()
    expect(mockReads).toHaveBeenCalledTimes(2)
    hidden.mockRestore()
  })
})
