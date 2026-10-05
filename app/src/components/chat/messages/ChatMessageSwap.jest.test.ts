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

describe('ChatMessageSwap', () => {
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
})
