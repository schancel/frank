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
  },
}))

import BalanceBreakdown from './BalanceBreakdown.vue'

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
  it('lists each place the wallet holds money, in the chain’s unit; the rows above the total add up to it', async () => {
    mockUseActiveWallet.mockResolvedValue({
      identity: { address: { raw: MAIN } },
      getReceiveAddress: async () => ({ raw: MAIN }),
      getReceivedPayments: () => [
        { spendable: true, amountWei: parseEther('0.02') },
      ],
      getContractCallFunds: async () => ({
        mainBalance: parseEther('0.04'),
        otherBalance: parseEther('0.2'),
      }),
    })
    const wrapper = mountBreakdown()
    expect(
      wrapper.find('[data-testid="balance-breakdown-loading"]').exists(),
    ).toBe(true)
    await flushPromises()

    const row = (id: string) =>
      wrapper.get(`[data-testid="balance-breakdown-${id}"]`).text()
    expect(row('main')).toContain('balanceBreakdown.main')
    expect(row('main')).toContain('0xF4B6...A6F1')
    expect(row('main')).toContain('0.04 MONT')
    expect(row('received')).toContain('balanceBreakdown.received(1)')
    expect(row('received')).toContain('0.02 MONT')
    expect(row('other')).toContain('0.18 MONT')
    // Main + received: the balance the Wallet page shows. The sending accounts are listed
    // under the total, not added into it.
    expect(row('total')).toContain('0.06 MONT')
    const order = wrapper
      .findAll('[data-testid^="balance-breakdown-"]')
      .map(el => el.attributes('data-testid'))
    expect(order.indexOf('balance-breakdown-other')).toBeGreaterThan(
      order.indexOf('balance-breakdown-total'),
    )
    expect(
      wrapper.find('[data-testid="balance-breakdown-profile"]').exists(),
    ).toBe(false)
    // Every digit is on hover.
    expect(
      wrapper
        .get('[data-testid="balance-breakdown-total"] [title]')
        .attributes('title'),
    ).toBe(`${formatEther(parseEther('0.06'))} MONT`)
    expect(wrapper.text()).not.toMatch(/cordon/i)
  })

  it('shows received coins too small to move under the total, not in it', async () => {
    mockUseActiveWallet.mockResolvedValue({
      getReceiveAddress: async () => ({ raw: MAIN }),
      getBalanceParts: async () => ({
        main: parseEther('0.04'),
        profile: 0n,
        received: parseEther('0.05'),
        receivedCount: 1,
        sending: 0n,
        // Two 0.0021 MON stamps: below ten times the fee of moving one.
        tooSmall: parseEther('0.0042'),
        tooSmallCount: 2,
      }),
    })
    const wrapper = mountBreakdown()
    await flushPromises()
    const row = (id: string) =>
      wrapper.get(`[data-testid="balance-breakdown-${id}"]`).text()
    expect(row('tooSmall')).toContain('balanceBreakdown.tooSmall')
    expect(row('tooSmall')).toContain('balanceBreakdown.tooSmallNote')
    expect(row('tooSmall')).toContain('0.0042 MONT')
    expect(row('total')).toContain('0.09 MONT')
    const order = wrapper
      .findAll('[data-testid^="balance-breakdown-"]')
      .map(el => el.attributes('data-testid'))
    expect(order.indexOf('balance-breakdown-tooSmall')).toBeGreaterThan(
      order.indexOf('balance-breakdown-total'),
    )
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
