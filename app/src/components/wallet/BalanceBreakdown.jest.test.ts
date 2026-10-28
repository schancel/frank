/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { formatEther, parseEther } from 'ethers'

const mockUseActiveWallet = jest.fn()
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: () => mockUseActiveWallet(),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MONT',
    toDisplayAmount: (raw: bigint) =>
      jest.requireActual('ethers').formatEther(raw),
    // The shared balance read (`useBalance`) asks the wallet, as the real chain does.
    nativeTransfers: {
      getBalance: ({ wallet }: { wallet: { getBalance(): Promise<bigint> } }) =>
        wallet.getBalance(),
    },
  },
  isChainUnreachableError: () => false,
}))

import { defineComponent, h } from 'vue'
import BalanceBreakdown from './BalanceBreakdown.vue'
import { useBalance } from 'src/composables/useBalance'

/** A wallet that reports where its balance is, as the EVM wallet does: each balance read keeps
 * its parts in the observation (`getBalanceObservation`), and `getBalance` is their sum. */
function partsWallet(initial: Parts) {
  let current = initial
  let observation:
    | { balance: bigint; observedAt: number; parts: Parts }
    | undefined
  const read = async () => {
    const parts = current
    const balance = parts.main + parts.profile + parts.received + parts.sending
    observation = { balance, observedAt: Date.now(), parts }
    return parts
  }
  return {
    wallet: {
      getReceiveAddress: async () => ({ raw: MAIN }),
      getBalanceParts: read,
      getBalance: async () => {
        const parts = await read()
        return parts.main + parts.profile + parts.received + parts.sending
      },
      getBalanceObservation: () => observation,
    },
    /** What the chain shows next. */
    set: (next: Parts) => {
      current = next
    },
  }
}
interface Parts {
  main: bigint
  profile: bigint
  received: bigint
  receivedCount: number
  sending: bigint
  tooSmall: bigint
  tooSmallCount: number
}

const MAIN = '0xF4B69f2BA70FBB80eC24B189DbFCD5eB83E8A6F1'

function mountBreakdown() {
  return mount(BalanceBreakdown, {
    global: {
      mocks: {
        $t: (key: string, params?: { count?: number }) =>
          key === 'balanceBreakdown.received'
            ? `${key}(${params?.count})`
            : key,
      },
      stubs: { QSpinner: { template: '<i data-testid="spinner" />' } },
    },
  })
}

describe('BalanceBreakdown', () => {
  it('shows an unavailable breakdown for a family without typed parts and never a fabricated zero', async () => {
    mockUseActiveWallet.mockResolvedValue({
      getBalance: async () => parseEther('0.24'),
      getContractCallFunds: async () => ({
        mainBalance: parseEther('0.04'),
        otherBalance: parseEther('0.2'),
      }),
    })
    const wrapper = mountBreakdown()
    await flushPromises()
    expect(
      wrapper.get('[data-testid="balance-breakdown-unavailable"]').text(),
    ).toContain('balanceBreakdown.unavailable')
    expect(
      wrapper.find('[data-testid="balance-breakdown-total"]').exists(),
    ).toBe(false)
  })

  it('shows the below-floor subset without adding it again to owned total', async () => {
    mockUseActiveWallet.mockResolvedValue(
      partsWallet({
        main: parseEther('0.04'),
        profile: 0n,
        received: parseEther('0.0542'),
        receivedCount: 3,
        sending: 0n,
        // Two 0.0021 MON stamps: below ten times the fee of moving one.
        tooSmall: parseEther('0.0042'),
        tooSmallCount: 2,
      }).wallet,
    )
    const wrapper = mountBreakdown()
    await flushPromises()
    const row = (id: string) =>
      wrapper.get(`[data-testid="balance-breakdown-${id}"]`).text()
    expect(row('tooSmall')).toContain('balanceBreakdown.tooSmall')
    expect(row('tooSmall')).toContain('balanceBreakdown.tooSmallNote')
    expect(row('tooSmall')).toContain('0.0042 MONT')
    expect(row('total')).toContain('0.0942 MONT')
    const order = wrapper
      .findAll('[data-testid^="balance-breakdown-"]')
      .map(el => el.attributes('data-testid'))
    expect(order.indexOf('balance-breakdown-tooSmall')).toBeGreaterThan(
      order.indexOf('balance-breakdown-total'),
    )
  })

  it('is the same read as the balance above it, and follows it when the balance is read again', async () => {
    const chain = partsWallet({
      main: parseEther('19.7513'),
      profile: 0n,
      received: 0n,
      receivedCount: 0,
      sending: 0n,
      tooSmall: 0n,
      tooSmallCount: 0,
    })
    mockUseActiveWallet.mockResolvedValue(chain.wallet)
    // The Wallet page: its balance headline and the breakdown under it.
    let balance: ReturnType<typeof useBalance> | undefined
    const Page = defineComponent({
      setup() {
        balance = useBalance()
        return () => h(BalanceBreakdown)
      },
    })
    const wrapper = mount(Page, {
      global: {
        mocks: { $t: (key: string) => key },
        stubs: { QSpinner: { template: '<i />' } },
      },
    })
    await flushPromises()
    const total = () =>
      wrapper
        .get('[data-testid="balance-breakdown-total"] [title]')
        .attributes('title')
    expect(total()).toBe(`${formatEther(parseEther('19.7513'))} MONT`)
    expect(balance!.balance.value).toBe(parseEther('19.7513'))

    // The other device paid: the next balance read shows less, and the breakdown with it.
    chain.set({
      main: parseEther('12.885'),
      profile: 0n,
      received: 0n,
      receivedCount: 0,
      sending: 0n,
      tooSmall: 0n,
      tooSmallCount: 0,
    })
    await balance!.refresh()
    await flushPromises()
    expect(balance!.balance.value).toBe(parseEther('12.885'))
    expect(total()).toBe(`${formatEther(parseEther('12.885'))} MONT`)
    wrapper.unmount()
  })

  it('says so when the wallet cannot be read, instead of showing an empty list', async () => {
    mockUseActiveWallet.mockRejectedValue(new Error('locked'))
    const wrapper = mountBreakdown()
    await flushPromises()
    expect(
      wrapper.get('[data-testid="balance-breakdown-unavailable"]').text(),
    ).toBe('balanceBreakdown.unavailable')
  })
})
