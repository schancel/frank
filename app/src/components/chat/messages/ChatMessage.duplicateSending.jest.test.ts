/** @jest-environment jsdom */

/**
 * An outgoing bubble shows one status (#393). The send-flow line and the stamp
 * (where the time normally is) must not both say "Sending…". The stamp shows
 * the time or nothing. The live region announces the state once.
 */
import { mount, VueWrapper } from '@vue/test-utils'

import ChatMessage from './ChatMessage.vue'
import enUS from '../../../i18n/en-us'
import frFR from '../../../i18n/fr-fr'

jest.setTimeout(15000)

jest.mock('quasar', () => {
  const actual = jest.requireActual<Record<string, unknown>>('quasar')
  return {
    ...actual,
    useQuasar: () => ({ platform: { is: { mobile: false } } }),
  }
})
jest.mock('../../../stores/chats', () => ({
  useChatStore: () => ({
    deleteMessage: jest.fn(async () => undefined),
    getStampAmount: () => 0,
    sendMessage: jest.fn(),
    retryOutgoing: jest.fn(),
  }),
}))
jest.mock('../../dialogs/DeleteMessageDialog.vue', () => ({
  template: '<i />',
}))
jest.mock('../../dialogs/TransactionDialog.vue', () => ({ template: '<i />' }))
jest.mock('../../../utils/clients', () => ({
  useMonadWallet: () => ({ wallet: true }),
}))
jest.mock('../../../composables/useActiveWallet', () => ({
  useActiveWallet: () => ({}),
}))
jest.mock('../../../utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: { toDisplayAmount: () => '0', unit: 'MON' },
}))
jest.mock('@frank/wallet/message-item-plugins', () => ({
  getMessageItemPreview: () => '',
}))
jest.mock('@frank/wallet/message-item-plugins/built-in', () => ({}))
jest.mock('@frank/wallet/message-item-plugins/blackjack/plugin', () => ({}))
jest.mock('@frank/wallet/message-item-plugins/digital-goods/plugin', () => ({}))
jest.mock('@frank/wallet/message-item-plugins/raffle/plugin', () => ({}))
jest.mock('../../../utils/message-item-renderers', () => ({
  getMessageItemRenderer: () => undefined,
}))

function translate(messages: unknown) {
  return (key: string) => {
    const value = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
    return typeof value === 'string' ? value : key
  }
}

function visibleText(wrapper: VueWrapper): string {
  const root = wrapper.element.cloneNode(true) as HTMLElement
  root.querySelectorAll('.q-sr-only').forEach(node => node.remove())
  return (root.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function countOf(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  while (needle.length > 0) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return count
    count += 1
    from = at + needle.length
  }
  return count
}

/** The stamp/amount line. Status words belong in the status line, not here. */
function stampLine(wrapper: VueWrapper): string {
  const lines: string[] = []
  wrapper.element.querySelectorAll('div').forEach(node => {
    if (
      node.querySelector('div, span') === null &&
      (node.textContent ?? '').includes('MON')
    ) {
      lines.push((node.textContent ?? '').replace(/\s+/g, ' ').trim())
    }
  })
  return lines.join(' | ')
}

const quiet = { template: '<i />' }

function mountOutgoing(
  status: string,
  messages: unknown,
  delivery?: Record<string, unknown>,
) {
  return mount(ChatMessage, {
    props: {
      address: '0xPEER',
      name: 'peer',
      chatWidth: 400,
      payloadDigest: 'pending:1:1:abc',
      message: {
        outbound: true,
        status,
        receivedTime: 1,
        serverTime: Date.UTC(2026, 8, 30, 19, 0, 0),
        items: [{ type: 'text', text: 'hello' }],
        outpoints: [],
        senderAddress: '0xME',
        stampValueWei: 5n,
        delivery,
      },
    },
    global: {
      mocks: { $t: translate(messages) },
      directives: { 'touch-swipe': {} },
      stubs: {
        QChatMessage: { template: '<div><slot /><slot name="stamp" /></div>' },
        QDialog: { template: '<div />' },
        QIcon: { template: '<i />' },
        QBtn: { template: '<button><slot /></button>' },
        ChatMessageReply: quiet,
        ChatMessageText: quiet,
        ChatMessageImage: quiet,
        ChatMessageStealth: quiet,
        ChatMessageBlackjack: quiet,
        ChatMessageDigitalGoods: quiet,
        ChatMessageRaffle: quiet,
      },
    },
  })
}

const states: Array<{
  name: string
  status: string
  delivery?: Record<string, unknown>
  phrase: string
}> = [
  { name: 'sending', status: 'pending', phrase: 'outgoing.sending' },
  {
    name: 'queued behind another message',
    status: 'payment-pending',
    delivery: {},
    phrase: 'outgoing.paymentQueued',
  },
  {
    name: 'payment pending',
    status: 'payment-pending',
    delivery: { attemptDigest: 'abc', live: true },
    phrase: 'outgoing.paymentPending',
  },
  {
    name: 'failed',
    status: 'error',
    delivery: { failureReason: 'unavailable' },
    phrase: 'chatMessage.failedToSend',
  },
]

describe('outgoing bubble shows one status (#393)', () => {
  it.each([
    ['en-us', enUS],
    ['fr-fr', frFR],
  ])(
    '%s keeps each in-flight state to one visible phrase and out of the stamp',
    async (_locale, messages) => {
      const t = translate(messages)
      for (const state of states) {
        const phrase = t(state.phrase)
        const wrapper = mountOutgoing(state.status, messages, state.delivery)
        await wrapper.vm.$nextTick()
        const shown = visibleText(wrapper)
        const stamp = stampLine(wrapper)
        expect(`${state.name} stamp [${stamp}]`).not.toContain(phrase)
        expect([state.name, countOf(shown, phrase)]).toEqual([state.name, 1])
        const regions = wrapper.findAll('[role="status"]')
        expect(regions).toHaveLength(1)
        expect(regions[0].classes()).toContain('q-sr-only')
        expect(regions[0].attributes('aria-live')).toBe('polite')
        wrapper.unmount()
      }
    },
  )

  it('announces a fresh send once, and a sent bubble has no status phrase', async () => {
    const t = translate(enUS)
    const sending = mountOutgoing('pending', enUS)
    const region = () => sending.get('[data-testid="outgoing-announcement"]')
    expect(region().text()).toBe('')
    await sending.vm.$nextTick()
    expect(region().text()).toBe(t('outgoing.sending'))
    expect(countOf(visibleText(sending), t('outgoing.sending'))).toBe(1)
    expect(sending.findAll('[role="status"]')).toHaveLength(1)

    const sent = mountOutgoing('confirmed', enUS)
    await sent.vm.$nextTick()
    const shown = visibleText(sent)
    for (const key of [
      'outgoing.sending',
      'outgoing.paymentPending',
      'outgoing.paymentQueued',
      'outgoing.paymentChecking',
      'chatMessage.failedToSend',
    ]) {
      expect(shown).not.toContain(t(key))
      expect(stampLine(sent)).not.toContain(t(key))
    }
    expect(stampLine(sent)).toContain('MON')
    expect(sent.get('[data-testid="outgoing-announcement"]').text()).toBe('')
    expect(sent.findAll('[role="status"]')).toHaveLength(1)
    sending.unmount()
    sent.unmount()
  })
})
