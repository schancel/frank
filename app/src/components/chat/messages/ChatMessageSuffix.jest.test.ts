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
  it.each([
    ['en-us', enUS],
    ['fr-fr', frFR],
  ])(
    'a message whose payment waits for the previous one says so on the bubble, in place of "Sending" (%s)',
    (_name, messages) => {
      const t = translator(messages)
      const sending = mountSuffix({ status: 'pending', inline: true }, messages)
      expect(sending.get('[data-testid="outgoing-sending"]').text()).toBe(
        t('outgoing.sending'),
      )
      const waiting = mountSuffix(
        { status: 'pending', inline: true, waitingForPreviousPayment: true },
        messages,
      )
      expect(waiting.get('[data-testid="outgoing-sending"]').text()).toBe(
        t('outgoing.waitingForPreviousPayment'),
      )
      expect(t('outgoing.waitingForPreviousPayment')).not.toBe(
        'outgoing.waitingForPreviousPayment',
      )
      expect(t('outgoing.waitingForPreviousPayment')).not.toBe(
        t('outgoing.paymentChecking'),
      )
    },
  )

  it('a failed message shows one localized failure line and offers Retry and Discard', async () => {
    const wrapper = mountSuffix({
      status: 'error',
      failureReason: 'unavailable',
    })
    expect(wrapper.text()).toContain('Failed to send')
    expect(wrapper.get('[data-testid="outgoing-failure-reason"]').text()).toBe(
      'This relay does not offer messaging.',
    )
    expect(wrapper.find('[data-testid="outgoing-retry-hint"]').exists()).toBe(
      false,
    )
    expect(wrapper.get('[data-testid="outgoing-failed"]').text()).toContain(
      'Failed to send',
    )

    await wrapper.get('[data-testid="outgoing-retry"]').trigger('click')
    await wrapper.get('[data-testid="outgoing-discard"]').trigger('click')
    expect(wrapper.emitted('resendClick')).toHaveLength(1)
    expect(wrapper.emitted('discardClick')).toHaveLength(1)
  })

  it('shows recipient-unregistered failure reason in English and French', () => {
    const en = mountSuffix(
      {
        status: 'error',
        failureReason: 'recipient-unregistered',
      },
      enUS,
    )
    expect(en.get('[data-testid="outgoing-failure-reason"]').text()).toBe(
      'Recipient is not registered on this relay.',
    )

    const fr = mountSuffix(
      {
        status: 'error',
        failureReason: 'recipient-unregistered',
      },
      frFR,
    )
    expect(fr.get('[data-testid="outgoing-failure-reason"]').text()).toBe(
      "Le destinataire n'est pas enregistré sur ce relais.",
    )
  })

  it('claims "not charged again" only when the payment is known live', async () => {
    const live = mountSuffix({
      status: 'payment-pending',
      paymentState: 'live',
    })
    expect(live.text()).toContain('Payment pending, will retry')
    expect(live.text()).toContain('not be charged again')
    expect(live.text()).not.toContain('Failed to send')
    expect(live.find('[data-testid="outgoing-retry"]').exists()).toBe(false)
    expect(live.find('[data-testid="outgoing-discard"]').exists()).toBe(true)
    await live.get('[data-testid="outgoing-discard"]').trigger('click')
    expect(live.emitted('discardClick')).toHaveLength(1)

    const checking = mountSuffix({ status: 'payment-pending' })
    expect(checking.text()).toContain('Checking payment status')
    expect(checking.text()).not.toContain('not be charged again')
    expect(checking.find('[data-testid="outgoing-discard"]').exists()).toBe(
      true,
    )
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

  it('focusStatus moves focus to the visible suffix (used when Retry unmounts)', async () => {
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
      wrapper.get('[data-testid="outgoing-focus-target"]').element,
    )
    expect(document.activeElement).not.toBe(
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
    expect(failed.text()).toContain('Échec de l’envoi')
    expect(failed.text()).toContain('Impossible de joindre le serveur.')
    const pending = mountSuffix(
      { status: 'payment-pending', paymentState: 'live' },
      frFR,
    )
    expect(pending.text()).toContain('Paiement en attente')
  })

  it.each([
    [enUS, 'There are not enough funds to send this message.'],
    [frFR, 'Les fonds sont insuffisants pour envoyer ce message.'],
  ])('localizes an insufficient-funds preparation failure', (locale, text) => {
    const failed = mountSuffix(
      { status: 'error', failureReason: 'insufficient-funds' },
      locale,
    )
    expect(failed.get('[data-testid="outgoing-failure-reason"]').text()).toBe(
      text,
    )
    expect(failed.text()).not.toContain('stamp-account')
  })

  it('keeps a localized generic fallback for unclassified failures', () => {
    const failed = mountSuffix({ status: 'error', failureReason: 'error' })
    expect(failed.get('[data-testid="outgoing-failure-reason"]').text()).toBe(
      'The message could not be sent.',
    )
  })

  it.each([
    ['en-us', enUS],
    ['fr-fr', frFR],
  ])(
    'a send waiting out the blocks after the previous payment says how many remain (%s)',
    (_name, messages) => {
      const t = translator(messages)
      const waiting = mountSuffix(
        {
          status: 'pending',
          inline: true,
          waitingForPreviousPayment: true,
          waitingBlocks: 2,
        },
        messages,
      )
      expect(waiting.get('[data-testid="outgoing-sending"]').text()).toBe(
        t('outgoing.waitingBlocks'),
      )
      expect(t('outgoing.waitingBlocks')).toContain('{blocks}')
    },
  )

  it.each([
    ['pending', 'outgoing.paymentSent'],
    ['mempool', 'outgoing.paymentInMempool'],
    ['reverted', 'outgoing.paymentReverted'],
    ['failed', 'outgoing.paymentFailed'],
    ['unsent', 'outgoing.paymentUnsent'],
  ])(
    'a sent message says what the chain has shown of its payment: %s',
    (summary, key) => {
      for (const messages of [enUS, frFR]) {
        const t = translator(messages)
        const sent = mountSuffix(
          {
            status: 'confirmed',
            inline: true,
            amount: '0.002 MON',
            paymentSummary: summary,
          },
          messages,
        )
        expect(
          sent.get('[data-testid="outgoing-payment-summary"]').text(),
        ).toBe(t(key))
        const label = sent.get(
          '[data-testid="outgoing-payment-summary"]',
        ).element
        expect(label.parentElement).toBe(
          sent.get('[data-testid="outgoing-footer"]').element,
        )
        expect(label.nextElementSibling).toBe(
          sent.get('[data-testid="outgoing-amount"]').element,
        )
        if (summary === 'pending') {
          expect(label.textContent).toBe(messages === enUS ? 'Sent' : 'Envoyé')
        }
        expect(sent.findAll('.outgoing-status')).toHaveLength(0)
        // A real string in both languages, never the key.
        expect(t(key)).not.toBe(key)
      }
    },
  )

  it('keeps one time/amount/actions footer through send and payment transitions, with status to the left of the time', async () => {
    const wrapper = mountSuffix({
      status: 'pending',
      inline: true,
      stamp: '12:34',
      amount: '0.002 MON',
    })
    const footer = wrapper.get('[data-testid="outgoing-footer"]').element
    const time = wrapper.get('[data-testid="outgoing-stamp"]').element
    const amount = wrapper.get('[data-testid="outgoing-amount"]').element
    const sending = wrapper.get('[data-testid="outgoing-sending"]').element
    expect(sending.parentElement).toBe(footer)
    expect(sending.nextElementSibling).toBe(time)
    expect(wrapper.findAll('.outgoing-status')).toHaveLength(0)
    for (const props of [
      { status: 'payment-pending' },
      { status: 'error', failureReason: 'unavailable' },
      { status: 'confirmed', paymentSummary: 'paid' },
      { status: 'confirmed', paymentSummary: 'repaid' },
    ]) {
      await wrapper.setProps(props)
      expect(wrapper.get('[data-testid="outgoing-footer"]').element).toBe(
        footer,
      )
      expect(wrapper.get('[data-testid="outgoing-stamp"]').element).toBe(time)
      expect(wrapper.get('[data-testid="outgoing-amount"]').element).toBe(
        amount,
      )
      expect(
        wrapper.find('[data-testid="outgoing-payment-summary"]').exists(),
      ).toBe(false)
      if (props.status === 'error') {
        const failed = wrapper.get('[data-testid="outgoing-failed"]').element
        expect(failed.parentElement).toBe(footer)
        expect(failed.nextElementSibling).toBe(time)
      } else {
        expect(
          wrapper
            .get('[data-testid="outgoing-footer"]')
            .find('[data-testid="outgoing-failed"]')
            .exists(),
        ).toBe(false)
      }
    }
    wrapper.unmount()
  })

  it.each(['paid', 'repaid'])(
    'briefly shows a new %s result beside the amount, then clears it',
    async summary => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
      })
      const wrapper = mountSuffix({
        status: 'confirmed',
        paymentSummary: 'mempool',
        stamp: '12:34',
        amount: '0.002 MON',
      })
      try {
        const footer = wrapper.get('[data-testid="outgoing-footer"]')
        await wrapper.setProps({ paymentSummary: summary })
        const success = footer.get('[data-testid="outgoing-payment-success"]')
        expect(success.element.tagName).toBe('SPAN')
        expect(success.text()).toBe(
          translator(enUS)(
            summary === 'paid'
              ? 'outgoing.paymentPaid'
              : 'outgoing.paymentRepaid',
          ),
        )
        expect(
          wrapper.get('[data-testid="outgoing-announcement"]').text(),
        ).toBe(success.text())
        jest.advanceTimersByTime(5000)
        await wrapper.vm.$nextTick()
        expect(
          footer.find('[data-testid="outgoing-payment-success"]').exists(),
        ).toBe(false)
        expect(
          wrapper.get('[data-testid="outgoing-announcement"]').text(),
        ).toBe('')
        expect(footer.get('[data-testid="outgoing-stamp"]').text()).toBe(
          '12:34',
        )
        expect(footer.get('[data-testid="outgoing-amount"]').text()).toBe(
          '0.002 MON',
        )
      } finally {
        wrapper.unmount()
        jest.useRealTimers()
      }
    },
  )

  it('does not replay historical success, and does not hide a subsequent failure', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    })
    const wrapper = mountSuffix({ status: 'confirmed', paymentSummary: 'paid' })
    try {
      expect(
        wrapper.find('[data-testid="outgoing-payment-success"]').exists(),
      ).toBe(false)
      await wrapper.setProps({ paymentSummary: 'repaid' })
      expect(
        wrapper.find('[data-testid="outgoing-payment-success"]').exists(),
      ).toBe(true)
      await wrapper.setProps({ paymentSummary: 'failed' })
      expect(
        wrapper.find('[data-testid="outgoing-payment-success"]').exists(),
      ).toBe(false)
      jest.advanceTimersByTime(5000)
      await wrapper.vm.$nextTick()
      expect(
        wrapper.get('[data-testid="outgoing-payment-summary"]').text(),
      ).toBe(translator(enUS)('outgoing.paymentFailed'))
      expect(wrapper.get('[data-testid="outgoing-announcement"]').text()).toBe(
        translator(enUS)('outgoing.paymentFailed'),
      )
      await wrapper.setProps({ paymentSummary: 'paid' })
      wrapper.unmount()
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      wrapper.unmount()
      jest.useRealTimers()
    }
  })

  it('says nothing about a payment it knows nothing of, on a received message, or while sending', () => {
    for (const props of [
      { status: 'confirmed', inline: true },
      {
        status: 'confirmed',
        inline: true,
        outbound: false,
        paymentSummary: 'paid',
      },
      { status: 'pending', inline: true, paymentSummary: 'pending' },
    ])
      expect(
        mountSuffix(props)
          .find('[data-testid="outgoing-payment-summary"]')
          .exists(),
      ).toBe(false)
  })
})
