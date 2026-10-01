/** @jest-environment jsdom */

/**
 * An outgoing bubble shows one status (#393). The send-flow line and the stamp
 * (where the time normally is) must not both say "Sending…". The stamp shows
 * the time or nothing. The live region announces the state once.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

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

const statusKeys = [
  'outgoing.sending',
  'outgoing.paymentPending',
  'outgoing.paymentQueued',
  'outgoing.paymentChecking',
  'chatMessage.failedToSend',
]

/** Apply the shipped `.q-sr-only` rule. A missing or non-hiding rule leaves the live region visible. */
function installProductionSrOnly(): void {
  const css = readFileSync(join(process.cwd(), 'src/css/app.scss'), 'utf8')
  const block = css.match(/\.q-sr-only\s*\{[^}]*\}/)?.[0] ?? ''
  const style = document.createElement('style')
  style.setAttribute('data-testid', 'sr-only-rule')
  style.textContent = block
  document.head.appendChild(style)
}

function isVisuallyHidden(node: Element): boolean {
  const style = window.getComputedStyle(node)
  return (
    style.position === 'absolute' &&
    style.width === '1px' &&
    style.height === '1px' &&
    style.overflow === 'hidden'
  )
}

function visibleText(wrapper: VueWrapper): string {
  const liveNodes = [wrapper.element, ...wrapper.element.querySelectorAll('*')]
  const root = wrapper.element.cloneNode(true) as HTMLElement
  const cloneNodes = [root, ...root.querySelectorAll('*')]
  liveNodes.forEach((node, index) => {
    if (node !== wrapper.element && isVisuallyHidden(node)) {
      cloneNodes[index].remove()
    }
  })
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

function footerRows(wrapper: VueWrapper): Element[] {
  const suffix = wrapper.getComponent({ name: 'ChatMessageSuffix' }).element
  return [...suffix.children].filter(element =>
    element.classList.contains('row'),
  )
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
    name: 'payment checking',
    status: 'payment-pending',
    delivery: { attemptDigest: 'abc' },
    phrase: 'outgoing.paymentChecking',
  },
  {
    name: 'failed',
    status: 'error',
    delivery: { failureReason: 'unavailable' },
    phrase: 'chatMessage.failedToSend',
  },
]

describe('outgoing bubble shows one status (#393)', () => {
  beforeAll(() => {
    installProductionSrOnly()
  })

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
        expect([state.name, countOf(shown, phrase)]).toEqual([state.name, 1])
        // Pending shares the last text line (#391). Error and payment-pending
        // still take one row under the text.
        const rowFooter =
          state.status === 'error' || state.status === 'payment-pending'
        expect(footerRows(wrapper)).toHaveLength(rowFooter ? 1 : 0)
        const stamp = wrapper.find('[data-testid="outgoing-stamp"]')
        if (stamp.exists()) {
          for (const key of statusKeys) {
            expect(stamp.text()).not.toContain(t(key))
          }
        }
        if (state.status === 'pending') {
          const meta = wrapper.get('[data-testid="outgoing-meta"]')
          expect(meta.findAll('br')).toHaveLength(0)
          expect(meta.get('[data-testid="outgoing-sending"]').text()).toBe(
            phrase,
          )
          expect(stamp.exists()).toBe(false)
        }
        const regions = wrapper.findAll('[role="status"]')
        expect(regions).toHaveLength(1)
        expect(regions[0].classes()).toContain('q-sr-only')
        expect(regions[0].attributes('aria-live')).toBe('polite')
        expect(isVisuallyHidden(regions[0].element)).toBe(true)
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
    for (const key of statusKeys) {
      expect(shown).not.toContain(t(key))
      expect(sent.get('[data-testid="outgoing-stamp"]').text()).not.toContain(
        t(key),
      )
    }
    expect(sent.get('[data-testid="outgoing-amount"]').text()).toContain('MON')
    // Time and amount are one line (#391), not stacked with a break.
    expect(
      sent.get('[data-testid="outgoing-meta"]').findAll('br'),
    ).toHaveLength(0)
    expect(sent.get('[data-testid="outgoing-meta"]').classes()).toContain(
      'chat-message-inline-meta',
    )
    expect(sent.find('[data-testid="outgoing-sending"]').exists()).toBe(false)
    expect(footerRows(sent)).toHaveLength(0)
    expect(sent.get('[data-testid="outgoing-announcement"]').text()).toBe('')
    expect(sent.findAll('[role="status"]')).toHaveLength(1)
    sending.unmount()
    sent.unmount()
  })
})
