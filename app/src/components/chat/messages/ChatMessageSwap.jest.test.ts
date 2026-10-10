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

const mockEscrow = {
  depositLock: jest.fn(async () => ({ txHash: '0x' })),
  claimLock: jest.fn(async () => ({ txHash: '0x' })),
  refundLock: jest.fn(async () => ({ txHash: '0x' })),
}
jest.mock('../../../composables/useSwapEscrow', () => ({
  useSwapEscrow: () => mockEscrow,
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

  it('shows Lock button for outbound pending swap offer and calls depositLegA', async () => {
    const wrapper = mountComponent({ outbound: true, status: 'pending' })
    const lockBtn = wrapper.find('[data-testid="swap-lock-btn"]')
    expect(lockBtn.exists()).toBe(true)

    await lockBtn.trigger('click')
    expect(wrapper.emitted('deposit')).toHaveLength(1)
  })

  it('shows Claim button when ready to claim', async () => {
    // Maker claiming Leg B
    const wrapperMaker = mountComponent({
      outbound: true,
      status: 'locked',
      legBTxHash: '0x' + 'bb'.repeat(32),
    })
    const claimBtnMaker = wrapperMaker.find('[data-testid="swap-claim-btn"]')
    expect(claimBtnMaker.exists()).toBe(true)
    await claimBtnMaker.trigger('click')
    expect(wrapperMaker.emitted('claim')).toHaveLength(1)

    expect(mockEscrow.claimLock).toHaveBeenCalledTimes(1)
  })

  it('shows Refund button when its own offer is expired', async () => {
    const wrapper = mountComponent({ outbound: true, status: 'expired' })
    const refundBtn = wrapper.find('[data-testid="swap-refund-btn"]')
    expect(refundBtn.exists()).toBe(true)

    await refundBtn.trigger('click')
    expect(wrapper.emitted('refund')).toHaveLength(1)
  })

  // A received offer is its sender's claims. An inbound item saying 'accepted' used to show
  // "Accept & Lock", one click from a deposit to the sender.
  describe('a received offer moves no funds', () => {
    const FUND_BUTTONS = ['swap-lock-btn', 'swap-claim-btn', 'swap-refund-btn']
    it.each([
      ['accepted', {}],
      ['locked', {}],
      ['locked', { legBTxHash: '0x' + 'bb'.repeat(32) }],
      ['locked', { preimage: '0x' + 'aa'.repeat(32) }],
      ['locked', { claimTxHash: '0x' + '22'.repeat(32) }],
      ['expired', {}],
    ])(
      'status %s %j: no lock, claim or refund button, and nothing to click sends funds',
      async (status, extra) => {
        const wrapper = mountComponent({
          outbound: false,
          status,
          hashLock: '0x' + 'cc'.repeat(32),
          recipientAddress: '0x' + '0b'.repeat(20),
          ...extra,
        })
        for (const id of FUND_BUTTONS)
          expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false)
        expect(
          wrapper.find('[data-testid="swap-unavailable-note"]').text(),
        ).toBe(enUS.walletPanel.swapUnavailableDescription)
        // Every control the card does render, clicked.
        for (const button of wrapper.findAll('button'))
          await button.trigger('click')
        for (const call of Object.values(mockEscrow))
          expect(call).not.toHaveBeenCalled()
        for (const event of ['deposit', 'claim', 'refund'])
          expect(wrapper.emitted(event)).toBeUndefined()
      },
    )

    it('a pending received offer can still be answered, with no fund action beside it', async () => {
      const wrapper = mountComponent({ outbound: false, status: 'pending' })
      expect(wrapper.find('[data-testid="swap-accept-btn"]').exists()).toBe(
        true,
      )
      expect(
        wrapper.find('[data-testid="swap-unavailable-note"]').exists(),
      ).toBe(false)
      for (const id of FUND_BUTTONS)
        expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false)
      for (const button of wrapper.findAll('button'))
        await button.trigger('click')
      for (const call of Object.values(mockEscrow))
        expect(call).not.toHaveBeenCalled()
    })

    it('the note is not shown on an offer this user made', () => {
      for (const status of ['pending', 'accepted', 'locked', 'expired'])
        expect(
          mountComponent({ outbound: true, status })
            .find('[data-testid="swap-unavailable-note"]')
            .exists(),
        ).toBe(false)
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
