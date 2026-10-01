/** @jest-environment jsdom */

/**
 * Retry completion can replace or delete the keyed ChatMessage that owned focus (#429). This
 * mounts the real keyed message list and real Retry components; only unrelated chat children and
 * the store boundary are substituted.
 */
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, reactive } from 'vue'

import ChatPage from './Chat.vue'

jest.mock('quasar', () => {
  const actual = jest.requireActual<Record<string, unknown>>('quasar')
  return {
    ...actual,
    useQuasar: () => ({ platform: { is: { mobile: false } } }),
  }
})

const PEER = '0x3e3e3e3e3e3E3E3E3e3e3E3E3e3e3E3E3e3E3E3e'

let mockChatStore: any
let mockOriginalMessage: any
const mockDeleteMessage = jest.fn()
const mockRetryOutgoing = jest.fn()
const mockSendMessageImpl = jest.fn()

jest.mock('../stores/chats', () => ({
  useChatStore: () => mockChatStore,
}))
jest.mock('../stores/contacts', () => ({
  useContactStore: () => ({
    getAcceptancePrice: () => 0,
    getContact: () => ({ profile: { name: 'Peer' } }),
  }),
}))
jest.mock('../stores/my-profile', () => ({
  useProfileStore: () => ({ profile: { name: 'Me' } }),
}))
jest.mock('../utils/clients', () => ({ useMonadWallet: () => ({}) }))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
}))
jest.mock('../utils/blackjack-bet', () => ({
  deliverBetWhenReady: jest.fn(),
}))
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: () => ({}),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    defaultStampValue: 1n,
    fromDisplayAmount: () => 1n,
    toDisplayAmount: () => '1',
    unit: 'MON',
  },
}))
jest.mock('@frank/wallet/message-item-plugins', () => ({
  getMessageItemPreview: () => '',
}))
jest.mock('@frank/wallet/message-item-plugins/built-in', () => ({}))
jest.mock('@frank/wallet/message-item-plugins/blackjack/plugin', () => ({}))
jest.mock('@frank/wallet/message-item-plugins/digital-goods/plugin', () => ({}))
jest.mock('@frank/wallet/message-item-plugins/raffle/plugin', () => ({}))
jest.mock('../utils/message-item-renderers', () => ({
  getMessageItemRenderer: () => undefined,
}))

const passthrough = (tag = 'div') =>
  defineComponent({
    inheritAttrs: false,
    setup:
      (_, { attrs, slots }) =>
      () =>
        h(tag, attrs, slots.default?.()),
  })

const QScrollArea = defineComponent({
  methods: {
    getScrollTarget: () => ({ scrollTop: 0, scrollHeight: 0 }),
    setScrollPosition: () => undefined,
  },
  render() {
    return h('div', this.$slots.default?.())
  },
})

const QChatMessage = defineComponent({
  render() {
    return h('div', [this.$slots.default?.(), this.$slots.stamp?.()])
  },
})

const QBtn = defineComponent({
  inheritAttrs: false,
  setup:
    (_, { attrs, slots }) =>
    () =>
      h('button', attrs, slots.default?.()),
})

const InputStub = defineComponent({
  methods: {
    focus() {
      ;(this.$refs.input as HTMLInputElement).focus()
    },
  },
  render() {
    return h('input', {
      'ref': 'input',
      'data-testid': 'stable-chat-composer',
    })
  },
})

const Blank = defineComponent({ render: () => h('i') })

function failedMessage(monad: boolean) {
  return {
    payloadDigest: 'failed',
    outbound: true,
    status: 'error',
    receivedTime: 1,
    serverTime: 1,
    items: [{ type: 'text', text: 'hello' }],
    outpoints: [],
    senderAddress: '0xME',
    ...(monad ? { stampValueWei: 5n } : {}),
    delivery: { failureReason: 'unavailable' },
  }
}

function replaceFailedWithFinal() {
  const messages = mockChatStore.chats[PEER].messages
  const finalMessage = {
    ...mockOriginalMessage,
    payloadDigest: 'final',
    status: 'confirmed',
  }
  messages.splice(0, 1, finalMessage)
  delete mockChatStore.messages.failed
  mockChatStore.messages.final = finalMessage
}

function removeFailed() {
  const messages = mockChatStore.chats[PEER].messages
  const index = messages.findIndex(
    (message: { payloadDigest: string }) => message.payloadDigest === 'failed',
  )
  if (index >= 0) messages.splice(index, 1)
  delete mockChatStore.messages.failed
}

function appendRecord(payloadDigest: string, status: string) {
  const message = {
    ...mockOriginalMessage,
    payloadDigest,
    status,
  }
  mockChatStore.chats[PEER].messages.push(message)
  mockChatStore.messages[payloadDigest] = message
  return message
}

function openGate() {
  let release: () => void = () => undefined
  let markReady: () => void = () => undefined
  const opened = new Promise<void>(resolve => {
    markReady = resolve
  })
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  return { opened, gate, markReady, release }
}

async function mountFailed(monad: boolean) {
  const message = failedMessage(monad)
  mockOriginalMessage = message
  const messages = reactive([message])
  mockChatStore = reactive({
    chats: { [PEER]: { messages } },
    messages: { failed: message },
    getAcceptancePrice: () => 0,
    getStampAmount: () => 1,
    setStampAmount: jest.fn(),
    getMessageByPayload: () => null,
    sendMessage: jest.fn(),
    retryOutgoing: mockRetryOutgoing,
    deleteMessage: mockDeleteMessage,
  })

  const wrapper = mount(ChatPage, {
    attachTo: document.body,
    global: {
      components: {
        QPageContainer: passthrough(),
        QPage: passthrough(),
        QScrollArea,
        QPageSticky: passthrough(),
        QInnerLoading: passthrough(),
        QFooter: passthrough(),
        QDialog: passthrough(),
        QChatMessage,
        QIcon: passthrough('span'),
        QBtn,
      },
      directives: { 'touch-swipe': {} },
      stubs: {
        ChatInput: InputStub,
        ChatBannerStack: Blank,
        BlackjackUnsentWagers: Blank,
        ChatMessageReply: Blank,
        ChatMessageText: Blank,
        ChatMessageImage: Blank,
        ChatMessageStealth: Blank,
        ChatMessageBlackjack: Blank,
        ChatMessageDigitalGoods: Blank,
        ChatMessageRaffle: Blank,
        DeleteMessageDialog: Blank,
        TransactionDialog: Blank,
      },
      mocks: {
        $route: { params: { address: PEER } },
        $q: {
          dark: { isActive: false },
          dialog: () => ({ onOk: () => undefined }),
        },
        $t: (key: string) => key,
        $relayClient: {
          sendMessageImpl: mockSendMessageImpl,
        },
      },
    },
  })
  await flushPromises()
  return wrapper
}

describe('Retry focus after keyed message replacement (#429)', () => {
  let composerHandoff: jest.SpyInstance
  let failedHandoff: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    mockDeleteMessage.mockReset()
    mockRetryOutgoing.mockReset()
    mockSendMessageImpl.mockReset()
    document.body.innerHTML = ''
    const methods = (
      ChatPage as unknown as {
        methods: {
          focusComposerAfterRetry: () => void
          focusFailedAfterRetry: () => void
        }
      }
    ).methods
    composerHandoff = jest.spyOn(methods, 'focusComposerAfterRetry')
    failedHandoff = jest.spyOn(methods, 'focusFailedAfterRetry')
  })

  afterEach(() => {
    composerHandoff.mockRestore()
    failedHandoff.mockRestore()
  })

  it.each([
    [
      'Monad rekey',
      true,
      () =>
        mockRetryOutgoing.mockImplementation(async () => {
          replaceFailedWithFinal()
          await nextTick()
          return { state: 'sent', payloadDigest: 'final' }
        }),
    ],
    [
      'legacy Lotus deletion',
      false,
      () => {
        mockDeleteMessage.mockImplementation(async () => {
          removeFailed()
          await nextTick()
        })
        mockSendMessageImpl.mockImplementation(async () => {
          appendRecord('final', 'confirmed')
          return ['txid']
        })
      },
    ],
  ])(
    '%s hands focus to the visible stable composer after the focused bubble unmounts',
    async (_name, monad, arrange) => {
      arrange()
      const wrapper = await mountFailed(monad)
      const retry = wrapper.get('[data-testid="outgoing-retry"]')
      retry.element.focus()
      expect(document.activeElement).toBe(retry.element)

      await retry.trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="outgoing-retry"]').exists()).toBe(
        false,
      )
      const composer = wrapper.get('[data-testid="stable-chat-composer"]')
      expect(document.activeElement).toBe(composer.element)
      expect(composer.isVisible()).toBe(true)
      expect(composerHandoff).toHaveBeenCalled()
      expect(failedHandoff).not.toHaveBeenCalled()
      if (!monad) {
        expect(mockDeleteMessage).toHaveBeenCalledWith({
          address: PEER,
          payloadDigest: 'failed',
        })
        expect(mockSendMessageImpl).toHaveBeenCalledWith({
          address: PEER,
          items: [{ type: 'text', text: 'hello' }],
          stampAmount: 1,
        })
        expect(mockDeleteMessage.mock.invocationCallOrder[0]).toBeLessThan(
          mockSendMessageImpl.mock.invocationCallOrder[0],
        )
        expect(
          mockChatStore.chats[PEER].messages.map(
            (message: { payloadDigest: string; status: string }) => ({
              payloadDigest: message.payloadDigest,
              status: message.status,
            }),
          ),
        ).toEqual([{ payloadDigest: 'final', status: 'confirmed' }])
        expect(mockChatStore.messages.failed).toBeUndefined()
        expect(mockChatStore.messages.final.status).toBe('confirmed')
      }
      wrapper.unmount()
    },
  )

  it.each([
    [
      'Monad rekey',
      true,
      (gate: ReturnType<typeof openGate>) => {
        mockRetryOutgoing.mockImplementation(async () => {
          gate.markReady()
          await gate.gate
          replaceFailedWithFinal()
          await nextTick()
          return { state: 'sent', payloadDigest: 'final' }
        })
      },
    ],
    [
      'legacy Lotus deletion',
      false,
      (gate: ReturnType<typeof openGate>) => {
        mockDeleteMessage.mockImplementation(async () => {
          gate.markReady()
          await gate.gate
          removeFailed()
          await nextTick()
        })
        mockSendMessageImpl.mockImplementation(async () => {
          appendRecord('final', 'confirmed')
          return ['txid']
        })
      },
    ],
  ])(
    '%s keeps a competing control focused when Retry finishes later',
    async (_name, monad, arrange) => {
      const gate = openGate()
      arrange(gate)
      const wrapper = await mountFailed(monad)
      const retry = wrapper.get('[data-testid="outgoing-retry"]')
      retry.element.focus()
      const pending = retry.trigger('click')
      await gate.opened
      const other = document.createElement('button')
      other.setAttribute('data-testid', 'competing-control')
      document.body.appendChild(other)
      other.focus()
      expect(document.activeElement).toBe(other)

      gate.release()
      await pending
      await flushPromises()

      expect(composerHandoff).toHaveBeenCalled()
      expect(document.activeElement).toBe(other)
      wrapper.unmount()
      other.remove()
    },
  )

  it.each([
    ['payment-pending', { state: 'payment-pending' }],
    ['busy', { state: 'busy' }],
    ['failed', { state: 'failed', reason: 'rejected' }],
    [
      'needs-confirmation',
      { state: 'needs-confirmation', reason: 'unverified' },
    ],
  ])('Monad %s does not hand focus to the composer', async (_name, outcome) => {
    mockRetryOutgoing.mockResolvedValue(outcome)
    const wrapper = await mountFailed(true)
    await wrapper.get('[data-testid="outgoing-retry"]').trigger('click')
    await flushPromises()
    expect(composerHandoff).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(
      wrapper.get('[data-testid="stable-chat-composer"]').element,
    )
    wrapper.unmount()
  })

  it('Monad retry rejection does not hand focus to the composer', async () => {
    mockRetryOutgoing.mockRejectedValue(new Error('retry failed'))
    const wrapper = await mountFailed(true)
    await wrapper.get('[data-testid="outgoing-retry"]').trigger('click')
    await flushPromises()
    expect(composerHandoff).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(
      wrapper.get('[data-testid="stable-chat-composer"]').element,
    )
    wrapper.unmount()
  })

  it('legacy fulfilled undefined focuses the replacement failed status', async () => {
    mockDeleteMessage.mockImplementation(async () => {
      removeFailed()
      await nextTick()
    })
    mockSendMessageImpl.mockImplementation(async () => {
      appendRecord('failed-again', 'error')
      return undefined
    })
    const wrapper = await mountFailed(false)
    await wrapper.get('[data-testid="outgoing-retry"]').trigger('click')
    await flushPromises()
    expect(mockDeleteMessage).toHaveBeenCalledWith({
      address: PEER,
      payloadDigest: 'failed',
    })
    expect(mockSendMessageImpl).toHaveBeenCalledWith({
      address: PEER,
      items: [{ type: 'text', text: 'hello' }],
      stampAmount: 1,
    })
    expect(mockDeleteMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendMessageImpl.mock.invocationCallOrder[0],
    )
    expect(composerHandoff).not.toHaveBeenCalled()
    expect(failedHandoff).toHaveBeenCalled()
    expect(document.activeElement).toBe(
      wrapper.get('[data-testid="outgoing-focus-target"]').element,
    )
    expect(
      mockChatStore.chats[PEER].messages.map(
        (message: { payloadDigest: string; status: string }) => ({
          payloadDigest: message.payloadDigest,
          status: message.status,
        }),
      ),
    ).toEqual([{ payloadDigest: 'failed-again', status: 'error' }])
    wrapper.unmount()
  })

  it('legacy send rejection focuses the replacement failed status', async () => {
    mockDeleteMessage.mockImplementation(async () => {
      removeFailed()
      await nextTick()
    })
    mockSendMessageImpl.mockImplementation(async () => {
      appendRecord('failed-again', 'error')
      throw new Error('broadcast failed')
    })
    const wrapper = await mountFailed(false)
    await wrapper.get('[data-testid="outgoing-retry"]').trigger('click')
    await flushPromises()
    expect(mockSendMessageImpl).toHaveBeenCalled()
    expect(composerHandoff).not.toHaveBeenCalled()
    expect(failedHandoff).toHaveBeenCalled()
    expect(document.activeElement).toBe(
      wrapper.get('[data-testid="outgoing-focus-target"]').element,
    )
    expect(document.activeElement).not.toBe(
      wrapper.get('[data-testid="stable-chat-composer"]').element,
    )
    wrapper.unmount()
  })

  it('legacy delete rejection does not hand focus to the composer or send', async () => {
    mockDeleteMessage.mockRejectedValue(new Error('delete failed'))
    const wrapper = await mountFailed(false)
    await wrapper.get('[data-testid="outgoing-retry"]').trigger('click')
    await flushPromises()
    expect(mockSendMessageImpl).not.toHaveBeenCalled()
    expect(composerHandoff).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(
      wrapper.get('[data-testid="stable-chat-composer"]').element,
    )
    wrapper.unmount()
  })
})
