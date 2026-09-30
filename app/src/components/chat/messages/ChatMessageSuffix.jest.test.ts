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

  it('claims "not charged again" only when the payment is known live', () => {
    const live = mountSuffix({
      status: 'payment-pending',
      paymentState: 'live',
    })
    expect(live.text()).toContain('Payment pending, will retry')
    expect(live.text()).toContain('not be charged again')
    expect(live.text()).not.toContain('Failed to send')
    expect(live.find('[data-testid="outgoing-retry"]').exists()).toBe(false)

    const checking = mountSuffix({ status: 'payment-pending' })
    expect(checking.text()).toContain('Checking payment status')
    expect(checking.text()).not.toContain('not be charged again')
  })

  it('a message queued behind another one makes no payment claim', () => {
    const queued = mountSuffix({
      status: 'payment-pending',
      paymentState: 'queued',
    })
    expect(queued.text()).toContain('Waiting for an earlier message')
    expect(queued.text()).not.toContain('charged')
  })

  it('a fresh send is announced: the region is inserted empty, then filled', async () => {
    const wrapper = mountSuffix({ status: 'pending' })
    const region = () => wrapper.get('[data-testid="outgoing-announcement"]')
    expect(region().attributes('aria-live')).toBe('polite')
    expect(region().text()).toBe('') // inserted empty
    await wrapper.vm.$nextTick()
    expect(region().text()).toBe('Sending…')
  })

  it('a message that merely renders after a reload is silent until its state changes', async () => {
    const wrapper = mountSuffix({
      status: 'error',
      failureReason: 'unreachable',
    })
    const region = () => wrapper.get('[data-testid="outgoing-announcement"]')
    await wrapper.vm.$nextTick()
    expect(region().text()).toBe('')
    const element = region().element
    await wrapper.setProps({ status: 'pending' })
    expect(region().element).toBe(element) // same persistent region
    expect(region().text()).toBe('Sending…')
    await wrapper.setProps({ status: 'error', failureReason: 'unavailable' })
    expect(region().text()).toContain('Failed to send')
    expect(wrapper.findAll('[role="status"]')).toHaveLength(1)
    await wrapper.setProps({ status: 'confirmed' })
    expect(region().text()).toBe('')
  })

  it('focusStatus moves focus to the status text (used when Retry unmounts)', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(ChatMessageSuffix, {
      attachTo: host,
      props: { stamp: '', amount: '', outbound: true, status: 'error' },
      global: {
        mocks: { $t: translator(enUS) },
        stubs: {
          QIcon: { template: '<i />' },
          QBtn: { template: '<button><slot /></button>' },
        },
      },
    })
    ;(wrapper.vm as unknown as { focusStatus: () => void }).focusStatus()
    expect(document.activeElement).toBe(
      wrapper.get('[data-testid="outgoing-announcement"]').element,
    )
    wrapper.unmount()
    host.remove()
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
    const pending = mountSuffix(
      { status: 'payment-pending', paymentState: 'live' },
      frFR,
    )
    expect(pending.text()).toContain('Paiement en attente')
  })
})
