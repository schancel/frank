/** @jest-environment jsdom */

/**
 * Retry completion can replace or delete the keyed ChatMessage that owned focus (#429). This
 * mounts the real keyed message list and real Retry components; only unrelated chat children and
 * the store boundary are substituted.
 */
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, reactive } from 'vue'

import ChatPage from './Chat.vue'

// Chat.vue reads the own address reactively; these tests have no wallet to resolve it from.
jest.mock('../utils/own-address', () => ({
  ...jest.requireActual('../utils/own-address'),
  useReactiveOwnCanonicalAddress: () => jest.requireActual('vue').ref(null),
}))
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
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: () => ({}),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    parseAddress: (input: string) => {
      try {
        return { raw: jest.requireActual('ethers').getAddress(input) }
      } catch {
        return undefined
      }
    },
    formatAddress: (address: { raw: string }) => address.raw,

    fromDisplayAmount: () => 1n,
    toDisplayAmount: () => '1',
    unit: 'MON',
  },
}))
jest.mock('../utils/message-items', () => ({
  messageItems: { previewText: () => '' },
}))
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

function failedMessage() {
  return {
    payloadDigest: 'failed',
    outbound: true,
    status: 'error',
    receivedTime: 1,
    serverTime: 1,
    items: [{ type: 'text', text: 'hello' }],
    outpoints: [],
    senderAddress: '0xME',
    stampValueWei: 5n,
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

async function mountFailed() {
  const message = failedMessage()
  mockOriginalMessage = message
  const messages = reactive([message])
  mockChatStore = reactive({
    conversations: {},
    chats: { [PEER]: { messages } },
    messages: { failed: message },
    getAcceptancePrice: () => 0,
    getStampWei: () => 1n,
    setStampWei: jest.fn(),
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
      },
    },
  })
  await flushPromises()
  return wrapper
}

describe('Retry focus after keyed message replacement (#429)', () => {
  let composerHandoff: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    mockDeleteMessage.mockReset()
    mockRetryOutgoing.mockReset()
    document.body.innerHTML = ''
    const methods = (
      ChatPage as unknown as {
        methods: {
          focusComposerAfterRetry: () => void
        }
      }
    ).methods
    composerHandoff = jest.spyOn(methods, 'focusComposerAfterRetry')
  })

  afterEach(() => {
    composerHandoff.mockRestore()
  })

  it('Monad rekey hands focus to the visible stable composer after the focused bubble unmounts', async () => {
    mockRetryOutgoing.mockImplementation(async () => {
      replaceFailedWithFinal()
      await nextTick()
      return { state: 'sent', payloadDigest: 'final' }
    })
    const wrapper = await mountFailed()
    const retry = wrapper.get('[data-testid="outgoing-retry"]')
    retry.element.focus()
    expect(document.activeElement).toBe(retry.element)

    await retry.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="outgoing-retry"]').exists()).toBe(false)
    const composer = wrapper.get('[data-testid="stable-chat-composer"]')
    expect(document.activeElement).toBe(composer.element)
    expect(composer.isVisible()).toBe(true)
    expect(composerHandoff).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('Monad rekey keeps a competing control focused when Retry finishes later', async () => {
    const gate = openGate()
    mockRetryOutgoing.mockImplementation(async () => {
      gate.markReady()
      await gate.gate
      replaceFailedWithFinal()
      await nextTick()
      return { state: 'sent', payloadDigest: 'final' }
    })
    const wrapper = await mountFailed()
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
  })

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
    const wrapper = await mountFailed()
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
    const wrapper = await mountFailed()
    await wrapper.get('[data-testid="outgoing-retry"]').trigger('click')
    await flushPromises()
    expect(composerHandoff).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(
      wrapper.get('[data-testid="stable-chat-composer"]').element,
    )
    wrapper.unmount()
  })
})
