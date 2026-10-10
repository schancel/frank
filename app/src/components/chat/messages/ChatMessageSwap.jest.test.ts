/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import ChatMessageSwap from './ChatMessageSwap.vue'
import enUS from '../../../i18n/en-us'

function translator(messages: unknown) {
  return (key: string, params?: Record<string, unknown>) => {
    let value: unknown = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
    if (typeof value === 'string' && params) {
      for (const [k, v] of Object.entries(params)) {
        value = value.replace(`{${k}}`, String(v))
      }
    }
    return typeof value === 'string' ? value : key
  }
}

// The card must not even reach for the escrow composable.
const mockUseSwapEscrow = jest.fn()
jest.mock('../../../composables/useSwapEscrow', () => ({
  useSwapEscrow: (...args: unknown[]) => mockUseSwapEscrow(...args),
}))

describe('ChatMessageSwap', () => {
  beforeEach(() => jest.clearAllMocks())

  const defaultProps = {
    swapId: 'swap1234567890abcdef',
    offeredChain: 'monad-testnet',
    offeredAsset: 'MON',
    offeredAmount: '10.0',
    requestedChain: 'solana-testnet',
    requestedAsset: 'SOL',
    requestedAmount: '1.5',
    status: 'pending',
    outbound: false,
  }

  const mountComponent = (props = {}) => {
    return mount(ChatMessageSwap, {
      props: {
        ...defaultProps,
        ...props,
      },
      global: {
        mocks: { $t: translator(enUS) },
        stubs: {
          QCard: { template: '<div><slot /></div>' },
          QIcon: { template: '<i />' },
          QBadge: { template: '<span><slot /></span>' },
          QBtn: {
            props: ['label'],
            template: '<button>{{ label }}</button>',
          },
        },
      },
    })
  }

  it('renders offered and requested amounts with chain badges', () => {
    const wrapper = mountComponent()
    expect(wrapper.text()).toContain('10.0 MON')
    expect(wrapper.text()).toContain('monad-testnet')
    expect(wrapper.text()).toContain('1.5 SOL')
    expect(wrapper.text()).toContain('solana-testnet')
    expect(wrapper.text()).toContain('pending')
  })

  it('shows Accept button for inbound pending swap offer and emits accept', async () => {
    const wrapper = mountComponent({ outbound: false, status: 'pending' })
    const acceptBtn = wrapper.find('[data-testid="swap-accept-btn"]')
    expect(acceptBtn.exists()).toBe(true)

    const cancelBtn = wrapper.find('[data-testid="swap-cancel-btn"]')
    expect(cancelBtn.exists()).toBe(false)

    await acceptBtn.trigger('click')
    expect(wrapper.emitted('accept')).toHaveLength(1)
    expect(wrapper.emitted('accept')![0]).toEqual(['swap1234567890abcdef'])
  })

  it('shows Cancel button for outbound pending swap offer and emits cancel', async () => {
    const wrapper = mountComponent({ outbound: true, status: 'pending' })
    const cancelBtn = wrapper.find('[data-testid="swap-cancel-btn"]')
    expect(cancelBtn.exists()).toBe(true)

    const acceptBtn = wrapper.find('[data-testid="swap-accept-btn"]')
    expect(acceptBtn.exists()).toBe(false)

    await cancelBtn.trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('cancel')![0]).toEqual(['swap1234567890abcdef'])
  })

  it('hides action buttons when swap is settled or cancelled', () => {
    const wrapperSettled = mountComponent({ status: 'settled' })
    expect(
      wrapperSettled.find('[data-testid="swap-accept-btn"]').exists(),
    ).toBe(false)
    expect(
      wrapperSettled.find('[data-testid="swap-cancel-btn"]').exists(),
    ).toBe(false)

    const wrapperCancelled = mountComponent({ status: 'cancelled' })
    expect(
      wrapperCancelled.find('[data-testid="swap-accept-btn"]').exists(),
    ).toBe(false)
    expect(
      wrapperCancelled.find('[data-testid="swap-cancel-btn"]').exists(),
    ).toBe(false)
  })

  // Atomic swaps are not available yet. The card used to offer "Deposit & Lock" on the
  // user's own offer, one click from locking real funds under a secret anyone could compute.
  describe('the card moves no funds, for any offer in any state', () => {
    const FUND_BUTTONS = ['swap-lock-btn', 'swap-claim-btn', 'swap-refund-btn']
    const STATUSES = [
      'pending',
      'accepted',
      'locked',
      'settled',
      'cancelled',
      'expired',
      'error',
    ]
    const EXTRAS = [
      {},
      { legATxHash: '0x' + '11'.repeat(32) },
      { legBTxHash: '0x' + 'bb'.repeat(32) },
      { preimage: '0x' + 'aa'.repeat(32) },
      { claimTxHash: '0x' + '22'.repeat(32) },
    ]
    const cases = [true, false].flatMap(outbound =>
      STATUSES.flatMap(status =>
        EXTRAS.map(extra => [outbound, status, extra] as const),
      ),
    )

    it.each(cases)(
      'outbound=%s status=%s %j: no lock, claim or refund button; the note says so',
      async (outbound, status, extra) => {
        const wrapper = mountComponent({
          outbound,
          status,
          hashLock: '0x' + 'cc'.repeat(32),
          recipientAddress: '0x' + '0b'.repeat(20),
          ...extra,
        })
        for (const id of FUND_BUTTONS)
          expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false)
        expect(
          wrapper.find('[data-testid="swap-unavailable-note"]').text(),
        ).toBe(enUS.chatMessageSwap.notAvailableYet)
        // Every control the card does render, clicked.
        for (const button of wrapper.findAll('button'))
          await button.trigger('click')
        expect(mockUseSwapEscrow).not.toHaveBeenCalled()
        for (const event of ['deposit', 'claim', 'refund'])
          expect(wrapper.emitted(event)).toBeUndefined()
      },
    )

    it('has no handler left that could deposit, claim or refund', () => {
      const vm = mountComponent({ outbound: true }).vm as unknown as Record<
        string,
        unknown
      >
      for (const handler of [
        'handleDepositLegA',
        'handleDepositLegB',
        'handleClaim',
        'handleRefund',
      ])
        expect(vm[handler]).toBeUndefined()
    })
  })

  it('renders explorer links when transaction hashes are provided', () => {
    const wrapper = mountComponent({
      legATxHash: '0x' + '11'.repeat(32),
      legBTxHash: 'sigsolana5abc',
      claimTxHash: '0x' + '22'.repeat(32),
    })

    expect(wrapper.find('[data-testid="swap-leg-a-tx-link"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-testid="swap-leg-b-tx-link"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-testid="swap-claim-tx-link"]').exists()).toBe(
      true,
    )
  })
})
