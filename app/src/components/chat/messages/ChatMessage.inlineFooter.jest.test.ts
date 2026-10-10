/** @jest-environment jsdom */

/**
 * Telegram-style footer (#391). Time and stamp amount sit on the last line of
 * the message text (right-aligned by float: inline-end). They are not a stacked
 * block under the text, and the actions control stays in that same cluster.
 * Error and payment-pending keep their own row.
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'

import { mount } from '@vue/test-utils'

import ChatMessage from './ChatMessage.vue'
import enUS from '../../../i18n/en-us'

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
  activeChain: { toDisplayAmount: () => '0.01', unit: 'MON' },
}))
jest.mock('../../../utils/message-items', () => ({
  messageItems: { previewText: () => '' },
}))
jest.mock('../../../utils/message-item-renderers', () => ({
  getMessageItemRenderer: () => undefined,
}))

const SERVER_TIME = Date.UTC(2026, 8, 30, 19, 0, 0)

function translate(messages: unknown) {
  return (key: string) => {
    const value = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
    return typeof value === 'string' ? value : key
  }
}

// The server build mapped by Jest does not render QChatMessage's real structure. Load the UMD
// build for the regression that must exercise Quasar's actual stamp layout.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadQuasar(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globals = globalThis as any
  globals.Vue = jest.requireActual('vue')
  jest.requireActual('quasar/dist/quasar.umd.prod.js')
  return globals.Quasar
}

function mountBubble(options: {
  status: string
  text: string
  outbound?: boolean
  delivery?: Record<string, unknown>
  attachToDocument?: boolean
  realQChatMessage?: boolean
}) {
  const stubs: Record<string, unknown> = {
    QDialog: { template: '<div />' },
    QIcon: { template: '<i />' },
    QBtn: { template: '<button><slot /></button>' },
    ChatMessageReply: { template: '<i />' },
    ChatMessageImage: { template: '<i />' },
    ChatMessageStealth: { template: '<i />' },
    ChatMessageBlackjack: { template: '<i />' },
    ChatMessageDigitalGoods: { template: '<i />' },
    ChatMessageRaffle: { template: '<i />' },
  }
  if (!options.realQChatMessage) {
    stubs.QChatMessage = {
      template: '<div><slot /><slot name="stamp" /></div>',
    }
  }

  return mount(ChatMessage, {
    attachTo: options.attachToDocument ? document.body : undefined,
    props: {
      address: '0xPEER',
      name: 'peer',
      chatWidth: 400,
      payloadDigest: 'digest-1',
      message: {
        outbound: options.outbound !== false,
        status: options.status,
        receivedTime: 1,
        serverTime: SERVER_TIME,
        items: [{ type: 'text', text: options.text }],
        outpoints: [],
        senderAddress: '0xME',
        stampValueWei: 5n,
        delivery: options.delivery,
      },
    },
    global: {
      plugins: options.realQChatMessage ? [loadQuasar()] : [],
      mocks: {
        $t: translate(enUS),
        $q: { dark: { isActive: false } },
      },
      directives: options.realQChatMessage ? {} : { 'touch-swipe': {} },
      stubs,
    },
  })
}

async function setStatus(
  wrapper: ReturnType<typeof mountBubble>,
  status: string,
) {
  await wrapper.setProps({
    message: {
      ...wrapper.props('message'),
      status,
      delivery: {
        attemptDigest: 'attempt-1',
        live: true,
        failureReason: status === 'error' ? 'unavailable' : undefined,
      },
    },
  })
  await wrapper.vm.$nextTick()
}

function inlineRule(): string {
  const css = readFileSync(join(process.cwd(), 'src/css/app.scss'), 'utf8')
  return css.match(/\.chat-message-inline-meta\s*\{[^}]*\}/)?.[0] ?? ''
}

describe('inline bubble footer (#391)', () => {
  it('puts a confirmed time and stamp amount on the text, not a stacked row', async () => {
    const wrapper = mountBubble({
      status: 'confirmed',
      text: 'Send me another message',
    })
    await wrapper.vm.$nextTick()
    const body = wrapper.get('[data-testid="chat-message-body"]')
    const text = body.get('.chat-message-text')
    expect(text.find('p').exists()).toBe(true)
    expect(text.text()).toContain('Send me another message')
    const meta = body.get('[data-testid="outgoing-meta"]')
    expect(
      text.element.compareDocumentPosition(meta.element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(meta.classes()).toContain('chat-message-inline-meta')
    expect(meta.classes()).toContain('chat-message-inline-meta--sent')
    expect(meta.findAll('br')).toHaveLength(0)
    expect(meta.findAll('.row')).toHaveLength(0)
    const time = meta.get('time[data-testid="outgoing-stamp"]')
    expect(time.text().length).toBeGreaterThan(0)
    expect(time.attributes('datetime')).toBe(
      new Date(SERVER_TIME).toISOString(),
    )
    expect(meta.get('[data-testid="outgoing-amount"]').text()).toBe('0.01 MON')
    expect(
      meta.findComponent({ name: 'ChatMessageSuffixButtons' }).exists(),
    ).toBe(true)
    expect(wrapper.find('[data-testid="outgoing-sending"]').exists()).toBe(
      false,
    )
    const rule = inlineRule()
    expect(rule).toMatch(/float:\s*inline-end/)
    expect(rule).toMatch(/margin-inline-start/)
    expect(rule).not.toMatch(/opacity/)
    const css = readFileSync(join(process.cwd(), 'src/css/app.scss'), 'utf8')
    expect(css).toMatch(
      /\.chat-message-inline-meta--sent\s*\{[^}]*color:\s*#000/,
    )
    expect(css).toMatch(/\.chat-message-text p \{[^}]*display:\s*inline/)
    expect(css).not.toMatch(/\.chat-message-body p \{/)
    expect(css).toMatch(
      /\.outgoing-focus-target:focus-visible\s*\{[^}]*outline:\s*2px solid/,
    )
    expect(css).toMatch(
      /\.outgoing-focus-target:focus:not\(:focus-visible\)\s*\{[^}]*outline:\s*none/,
    )
  })

  it('keeps a long message and an incoming bubble on the same inline cluster', async () => {
    const long = mountBubble({
      status: 'confirmed',
      text: 'word '.repeat(40) + 'https://example.invalid/' + 'a'.repeat(80),
    })
    await long.vm.$nextTick()
    const longMeta = long
      .get('[data-testid="chat-message-body"]')
      .get('[data-testid="outgoing-meta"]')
    expect(longMeta.classes()).toContain('chat-message-inline-meta')
    expect(longMeta.findAll('br')).toHaveLength(0)
    long.unmount()

    const incoming = mountBubble({
      status: 'confirmed',
      text: 'hello',
      outbound: false,
    })
    await incoming.vm.$nextTick()
    const meta = incoming
      .get('[data-testid="chat-message-body"]')
      .get('[data-testid="outgoing-meta"]')
    expect(meta.classes()).toContain('chat-message-inline-meta')
    expect(meta.classes()).not.toContain('chat-message-inline-meta--sent')
    expect(meta.get('[data-testid="outgoing-amount"]').text()).toContain('MON')
    expect(
      meta.get('time[data-testid="outgoing-stamp"]').text().length,
    ).toBeGreaterThan(0)
  })

  it('leaves failed and payment-pending on their own row, outside the text', async () => {
    const failed = mountBubble({
      status: 'error',
      text: 'hello',
      delivery: { failureReason: 'unavailable' },
    })
    await failed.vm.$nextTick()
    const failedBody = failed.get('[data-testid="chat-message-body"]')
    expect(failedBody.find('[data-testid="outgoing-meta"]').exists()).toBe(
      false,
    )
    const failedRow = failedBody.get('[data-testid="outgoing-failed"]')
    expect(failedRow.classes()).toContain('row')
    expect(
      failed.get('[data-testid="outgoing-focus-target"]').classes(),
    ).not.toContain('chat-message-inline-meta')
    expect(failed.get('[data-testid="outgoing-retry"]').exists()).toBe(true)
    failed.unmount()

    const pendingPay = mountBubble({
      status: 'payment-pending',
      text: 'hello',
      delivery: { attemptDigest: 'abc', live: true },
    })
    await pendingPay.vm.$nextTick()
    expect(
      pendingPay
        .get('[data-testid="chat-message-body"]')
        .find('[data-testid="outgoing-meta"]')
        .exists(),
    ).toBe(false)
    expect(
      pendingPay
        .get('[data-testid="chat-message-body"]')
        .get('[data-testid="outgoing-payment-pending"]')
        .classes(),
    ).toContain('row')
  })

  it('keeps Quasar stamp styling on one real suffix across row transitions', async () => {
    const wrapper = mountBubble({
      status: 'error',
      text: 'hello',
      delivery: { failureReason: 'unavailable' },
      realQChatMessage: true,
    })
    await wrapper.vm.$nextTick()
    const suffix = wrapper.get('[data-testid="outgoing-focus-target"]')
    const announcement = suffix.get('[data-testid="outgoing-announcement"]')

    expect(suffix.classes()).toContain('q-message-stamp')
    expect(
      wrapper
        .get('.q-message-text:last-child')
        .element.contains(suffix.element),
    ).toBe(true)

    await setStatus(wrapper, 'pending')
    expect(wrapper.get('[data-testid="outgoing-meta"]').element).toBe(
      suffix.element,
    )
    expect(suffix.classes()).not.toContain('q-message-stamp')

    await setStatus(wrapper, 'payment-pending')
    expect(wrapper.get('[data-testid="outgoing-focus-target"]').element).toBe(
      suffix.element,
    )
    expect(suffix.classes()).toContain('q-message-stamp')
    expect(suffix.get('[data-testid="outgoing-announcement"]').element).toBe(
      announcement.element,
    )

    const quasarCss = readFileSync(
      join(
        dirname(require.resolve('quasar/dist/quasar.umd.prod.js')),
        'quasar.css',
      ),
      'utf8',
    )
    const stampRule =
      quasarCss.match(/\.q-message-stamp\s*\{[^}]*\}/)?.[0] ?? ''
    expect(stampRule).toMatch(/margin-top:\s*4px/)
    expect(stampRule).toMatch(/opacity:\s*0\.6/)
    expect(stampRule).toMatch(/font-size:\s*small/)
  })

  it('puts a fresh send on the inline cluster without a second stamp line', async () => {
    const wrapper = mountBubble({ status: 'pending', text: 'hello' })
    await wrapper.vm.$nextTick()
    const meta = wrapper
      .get('[data-testid="chat-message-body"]')
      .get('[data-testid="outgoing-meta"]')
    expect(meta.classes()).toContain('chat-message-inline-meta')
    expect(meta.classes()).toContain('chat-message-inline-meta--sent')
    expect(meta.findAll('br')).toHaveLength(0)
    expect(meta.find('[data-testid="outgoing-stamp"]').exists()).toBe(false)
    expect(meta.get('[data-testid="outgoing-sending"]').text()).toBe(
      translate(enUS)('outgoing.sending'),
    )
    expect(meta.get('[data-testid="outgoing-amount"]').text()).toContain('MON')
  })

  it.each([
    ['payment-pending', 'outgoing.paymentPending'],
    ['error', 'chatMessage.failedToSend'],
  ])(
    'keeps the live region mounted and announces pending -> %s',
    async (status, announcementKey) => {
      const wrapper = mountBubble({ status: 'pending', text: 'hello' })
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      const region = wrapper.get('[data-testid="outgoing-announcement"]')

      await setStatus(wrapper, status)

      expect(wrapper.get('[data-testid="outgoing-announcement"]').element).toBe(
        region.element,
      )
      expect(region.text()).toContain(translate(enUS)(announcementKey))
    },
  )

  it.each(['payment-pending', 'error'])(
    'keeps Retry focus through error -> pending -> %s',
    async status => {
      const wrapper = mountBubble({
        status: 'error',
        text: 'hello',
        delivery: { failureReason: 'unavailable' },
        attachToDocument: true,
      })
      await wrapper.vm.$nextTick()
      const focusTarget = wrapper.get('[data-testid="outgoing-focus-target"]')
        .element as HTMLElement
      focusTarget.focus()
      expect(document.activeElement).toBe(focusTarget)

      await setStatus(wrapper, 'pending')
      expect(focusTarget.isConnected).toBe(true)
      expect(document.activeElement).toBe(focusTarget)

      await setStatus(wrapper, status)
      expect(focusTarget.isConnected).toBe(true)
      expect(document.activeElement).toBe(focusTarget)
      wrapper.unmount()
    },
  )
})

describe('modernized chat message bubble geometry (#1003)', () => {
  it('defines asymmetric corner radii and removes jagged speech bubble notch', () => {
    const css = readFileSync(join(process.cwd(), 'src/css/app.scss'), 'utf8')
    expect(css).toMatch(
      /\.q-message-text--sent\s*\{[^}]*border-radius:\s*18px 18px 4px 18px/,
    )
    expect(css).toMatch(
      /\.q-message-text--received\s*\{[^}]*border-radius:\s*18px 18px 18px 4px/,
    )
    expect(css).toMatch(/&:last-child::before\s*\{[^}]*display:\s*none/)
  })
})
