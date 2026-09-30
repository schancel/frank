/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'

import ChatMessageSuffix from './ChatMessageSuffix.vue'
import enUS from '../../../i18n/en-us'
import frFR from '../../../i18n/fr-fr'

jest.mock('quasar', () => ({
  useQuasar: () => ({ platform: { is: { mobile: false } } }),
}))

function translator(messages: unknown) {
  return (key: string) => {
    const value = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
    return typeof value === 'string' ? value : key
  }
}

function mountSuffix(props: Record<string, unknown>, messages: unknown = enUS) {
  return mount(ChatMessageSuffix, {
    props: { stamp: '', amount: '', outbound: true, ...props },
    global: {
      mocks: { $t: translator(messages) },
      stubs: {
        QIcon: { template: '<i />' },
        QBtn: { template: '<button><slot /></button>' },
      },
    },
  })
}

describe('ChatMessageSuffix outgoing states (#269, #270)', () => {
  it('a failed message says why, offers Retry and Discard, and says what Retry pays', async () => {
    const wrapper = mountSuffix({
      status: 'error',
      failureReason: 'unavailable',
    })
    expect(wrapper.text()).toContain('Failed to send')
    expect(wrapper.get('[data-testid="outgoing-failure-reason"]').text()).toBe(
      'This relay does not offer messaging.',
    )
    expect(wrapper.get('[data-testid="outgoing-retry-hint"]').text()).toMatch(
      /same payment while it is still valid.*new payment.*only if it is not/,
    )

    await wrapper.get('[data-testid="outgoing-retry"]').trigger('click')
    await wrapper.get('[data-testid="outgoing-discard"]').trigger('click')
    expect(wrapper.emitted('resendClick')).toHaveLength(1)
    expect(wrapper.emitted('discardClick')).toHaveLength(1)
  })

  it('a pending payment is not shown as failed and has no Retry to click', () => {
    const wrapper = mountSuffix({ status: 'payment-pending' })
    expect(wrapper.text()).toContain('Payment pending, will retry')
    expect(wrapper.text()).toContain('not be charged again')
    expect(wrapper.text()).not.toContain('Failed to send')
    expect(wrapper.find('[data-testid="outgoing-retry"]').exists()).toBe(false)
    expect(wrapper.find('[role="status"]').exists()).toBe(true)
  })

  it('a confirmed message shows neither state', () => {
    const wrapper = mountSuffix({ status: 'confirmed', stamp: '12:00:00' })
    expect(wrapper.find('[data-testid="outgoing-failed"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Payment pending')
  })

  it('is localized in French', () => {
    const failed = mountSuffix(
      { status: 'error', failureReason: 'unreachable' },
      frFR,
    )
    expect(failed.text()).toContain("Échec de l'envoi")
    expect(failed.text()).toContain('Impossible de joindre le serveur.')
    const pending = mountSuffix({ status: 'payment-pending' }, frFR)
    expect(pending.text()).toContain('Paiement en attente')
  })
})
