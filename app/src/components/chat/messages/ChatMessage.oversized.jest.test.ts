/** @jest-environment jsdom */

/**
 * One bad stored message must never blank a conversation. A multi-megabyte text item (stored
 * before the size limit was enforced) is shown as a short plain-text preview without ever
 * reaching the markdown parser, and an item that throws while rendering is contained to its own
 * bubble: the other messages, and that bubble's own Discard, stay usable.
 */
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import ChatMessage from './ChatMessage.vue'
import enUS from '../../../i18n/en-us'
import frFR from '../../../i18n/fr-fr'
import * as markdown from '../../../utils/markdown'
import { MAX_MESSAGE_TEXT_BYTES } from '../../../utils/message-limits'

jest.setTimeout(30000)

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

const message = (text: string, status = 'error') => ({
  outbound: true,
  status,
  receivedTime: 1,
  serverTime: 1,
  items: [{ type: 'text', text }],
  outpoints: [],
  senderAddress: '0xME',
  stampValueWei: 5n,
  delivery: status === 'error' ? { failureReason: 'too-large' } : undefined,
})

const stubs = {
  QDialog: { template: '<div />' },
  QIcon: { template: '<i />' },
  QBtn: { template: '<button><slot /></button>' },
  QChatMessage: { template: '<div><slot /></div>' },
  ChatMessageReply: { template: '<i />' },
  ChatMessageImage: { template: '<i />' },
  ChatMessageStealth: { template: '<i />' },
  ChatMessageBlackjack: { template: '<i />' },
  ChatMessageDigitalGoods: { template: '<i />' },
  ChatMessageRaffle: { template: '<i />' },
}

/** Two bubbles under one parent, like the chat page's list. */
function mountConversation(texts: string[], locale: unknown = enUS) {
  const Parent = defineComponent({
    setup: () => () =>
      h(
        'div',
        texts.map((text, index) =>
          h(ChatMessage, {
            key: index,
            address: '0xPEER',
            name: 'peer',
            chatWidth: 400,
            payloadDigest: `digest-${index}`,
            index,
            message: message(text, index === 0 ? 'error' : 'confirmed'),
          }),
        ),
      ),
  })
  return mount(Parent, {
    global: {
      mocks: { $t: translate(locale), $q: { dark: { isActive: false } } },
      directives: { 'touch-swipe': {} },
      stubs,
    },
  })
}

describe('an oversized or unrenderable stored message cannot blank the chat', () => {
  afterEach(() => jest.restoreAllMocks())

  it('shows a 9 MB stored text as a short plain preview with a notice, never parsing it', () => {
    const parse = jest.spyOn(markdown, 'renderMarkdown')
    const huge = '<b>x</b> '.repeat(1024 * 1024) // ~9 MB
    const wrapper = mountConversation([huge, 'hello **there**'])

    const plain = wrapper.get('[data-testid="chat-message-text-plain"]')
    // Plain text: the markup is shown as characters, not turned into elements.
    expect(plain.find('b').exists()).toBe(false)
    expect(plain.text()).toContain('<b>x</b>')
    expect(plain.text().length).toBeLessThan(markdown.TEXT_PREVIEW_CHARS + 200)
    expect(
      wrapper.get('[data-testid="chat-message-text-truncated"]').text(),
    ).toContain('too long to display in full')
    // The failed bubble still says why and can be discarded.
    expect(wrapper.get('[data-testid="outgoing-failure-reason"]').text()).toBe(
      'The message is too long to send.',
    )
    // The neighbouring message renders normally.
    expect(wrapper.html()).toContain('<strong>there</strong>')
    expect(parse).not.toHaveBeenCalledWith(huge, expect.anything())
  })

  it('has the notice and the reason in French', () => {
    const wrapper = mountConversation(
      ['y'.repeat(MAX_MESSAGE_TEXT_BYTES + 1)],
      frFR,
    )
    expect(
      wrapper.get('[data-testid="chat-message-text-truncated"]').text(),
    ).toContain('trop long pour être affiché')
    expect(wrapper.get('[data-testid="outgoing-failure-reason"]').text()).toBe(
      'Le message est trop long pour être envoyé.',
    )
  })

  it('falls back to plain text when the markdown parser throws (stack overflow)', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(markdown.renderMessageText('some *text*', false, false).kind).toBe(
      'html',
    )
    const DOMPurify = jest.requireActual('dompurify')
    jest.spyOn(DOMPurify, 'sanitize').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded')
    })
    expect(markdown.renderMessageText('some *text*', false, false)).toEqual({
      kind: 'plain',
      text: 'some *text*',
      truncated: false,
    })
  })

  it('contains a render error to its own bubble; the rest of the chat still renders', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const real = markdown.renderMessageText
    jest
      .spyOn(markdown, 'renderMessageText')
      .mockImplementation((input, dark, isReply) => {
        if (input === 'poison') {
          throw new RangeError('Maximum call stack size exceeded')
        }
        return real(input, dark, isReply)
      })
    const wrapper = mountConversation(['poison', 'still here'])
    await flushPromises()
    const bubbles = wrapper.findAll('[data-testid="chat-message-body"]')
    expect(bubbles).toHaveLength(2)
    expect(
      bubbles[0].get('[data-testid="chat-message-unrenderable"]').text(),
    ).toBe('This message could not be displayed.')
    // Its status row (Retry/Discard) is still there.
    expect(bubbles[0].find('[data-testid="outgoing-failed"]').exists()).toBe(
      true,
    )
    expect(bubbles[1].text()).toContain('still here')
  })
})
