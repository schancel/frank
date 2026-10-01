/** @jest-environment jsdom */

// Ticket #411: opening a chat must put the caret in the compose box on a fine pointer,
// including when the list item in the desktop drawer still holds focus. A coarse pointer,
// an open dialog or menu, and a drawer overlay (page inert) must not take focus.
import { mount } from '@vue/test-utils'
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
const OTHER = '0x4f4f4f4f4f4F4F4F4f4f4F4F4f4f4F4F4f4F4F4f'

let mockChatStore: ReturnType<typeof storeFor>

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

const InputStub = defineComponent({
  methods: {
    focus() {
      ;(this.$refs.box as HTMLTextAreaElement | undefined)?.focus()
    },
  },
  render() {
    return h('textarea', { 'ref': 'box', 'data-testid': 'compose-box' })
  },
})

const Blank = defineComponent({ render: () => h('i') })

function storeFor() {
  return reactive({
    chats: {
      [PEER]: { messages: [] },
      [OTHER]: { messages: [] },
    },
    messages: {},
    getAcceptancePrice: () => 0,
    getStampAmount: () => 1,
    setStampAmount: jest.fn(),
    getMessageByPayload: () => null,
    sendMessage: jest.fn(),
  })
}

function setPointer(fine: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === '(pointer: fine)' ? fine : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    }),
  })
}

function focusInDrawer() {
  const drawer = document.createElement('div')
  drawer.className = 'q-drawer'
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'chat'
  drawer.appendChild(button)
  document.body.appendChild(drawer)
  button.focus()
  return button
}

function mountChat(host: HTMLElement = document.body) {
  mockChatStore = storeFor()
  return mount(ChatPage, {
    attachTo: host,
    global: {
      components: {
        QPageContainer: passthrough(),
        QPage: passthrough(),
        QScrollArea,
        QPageSticky: passthrough(),
        QInnerLoading: passthrough(),
        QFooter: passthrough(),
        QBtn: passthrough('button'),
      },
      directives: { 'touch-swipe': {} },
      stubs: {
        ChatInput: InputStub,
        ChatBannerStack: Blank,
        BlackjackUnsentWagers: Blank,
        ChatMessageReply: Blank,
        ChatMessageComponent: Blank,
      },
      mocks: {
        $route: { params: { address: PEER } },
        $q: { dark: { isActive: false } },
        $t: (key: string) => key,
      },
    },
  })
}

async function settle() {
  await nextTick()
  await nextTick()
}

function composeBox(): HTMLTextAreaElement {
  const box = document.querySelector('[data-testid="compose-box"]')
  if (!(box instanceof HTMLTextAreaElement)) {
    throw new Error('compose box missing')
  }
  return box
}

describe('opening a chat focuses the compose box (#411)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('moves focus from the desktop chat list into the compose box', async () => {
    setPointer(true)
    const listItem = focusInDrawer()
    const wrapper = mountChat()
    await settle()
    expect(document.activeElement).toBe(composeBox())
    expect(document.activeElement).not.toBe(listItem)
    wrapper.unmount()
  })

  it('focuses the compose box again when the open chat changes', async () => {
    setPointer(true)
    focusInDrawer()
    const wrapper = mountChat()
    await settle()
    composeBox().blur()
    expect(document.activeElement).not.toBe(composeBox())
    ;(wrapper.vm as unknown as { address: string }).address = OTHER
    await settle()
    expect(document.activeElement).toBe(composeBox())
    wrapper.unmount()
  })

  it('does not take focus on a coarse pointer', async () => {
    setPointer(false)
    const listItem = focusInDrawer()
    const wrapper = mountChat()
    await settle()
    expect(document.activeElement).toBe(listItem)
    expect(document.activeElement).not.toBe(composeBox())
    wrapper.unmount()
  })

  it('does not take focus while a dialog is open', async () => {
    setPointer(true)
    const dialog = document.createElement('div')
    dialog.className = 'q-dialog'
    document.body.appendChild(dialog)
    const listItem = focusInDrawer()
    const wrapper = mountChat()
    await settle()
    expect(document.activeElement).toBe(listItem)
    wrapper.unmount()
  })

  it('does not take focus while a menu is open', async () => {
    setPointer(true)
    const menu = document.createElement('div')
    menu.className = 'q-menu'
    document.body.appendChild(menu)
    const listItem = focusInDrawer()
    const wrapper = mountChat()
    await settle()
    expect(document.activeElement).toBe(listItem)
    wrapper.unmount()
  })

  it('does not take focus while the drawer overlay leaves the page inert', async () => {
    setPointer(true)
    const host = document.createElement('div')
    host.setAttribute('inert', '')
    document.body.appendChild(host)
    const listItem = focusInDrawer()
    const wrapper = mountChat(host)
    await settle()
    expect(document.activeElement).toBe(listItem)
    expect(document.activeElement).not.toBe(composeBox())
    wrapper.unmount()
  })

  it('does not steal focus from a control the user already chose', async () => {
    setPointer(true)
    const wrapper = mountChat()
    const outside = document.createElement('button')
    outside.type = 'button'
    document.body.appendChild(outside)
    outside.focus()
    await settle()
    expect(document.activeElement).toBe(outside)
    wrapper.unmount()
  })
})
