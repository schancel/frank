/** @jest-environment jsdom */
// Mounted Chat.vue LAYOUT structure (#390, and the structure half of #302). jsdom cannot measure
// layout (the real-pixel check is test/browser/chat-layout.mjs), but the classes that produce it
// are asserted here: the banner stack sits above the list in the same flex column, the list is
// wrapped in the `col relative-position` box that bounds the scroll area, and the message list
// carries vertical padding so the first bubble never touches the header.
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import * as quasar from 'quasar'
import { defineComponent, h } from 'vue'

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      /* none */
    },
  }),
}))
jest.mock('../utils/clients', () => ({ useMonadWallet: () => ({}) }))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
  desktopNotify: jest.fn(),
}))
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

// jsdom has no TextEncoder/TextDecoder (the wallet/relay modules Chat.vue imports need them).
import { TextDecoder, TextEncoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })
/* eslint-disable @typescript-eslint/no-var-requires */
const ChatPage = require('./Chat.vue').default
const { useChatStore } = require('../stores/chats')
const { useContactStore } = require('../stores/contacts')

const DEALER = '0x3e3e3e3e3e3E3E3E3e3e3E3E3e3e3E3E3e3E3E3e'

// Unlike Chat.mounted's stubs these keep the class attribute, since the classes are the subject.
const keepClass = (tag = 'div') =>
  defineComponent({
    setup:
      (_, { slots, attrs }) =>
      () =>
        h(tag, { class: attrs.class }, slots.default?.()),
  })
const stubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter(n => /^Q[A-Z]/.test(n))
    .map(n => [n, keepClass()]),
)
stubs.QScrollArea = defineComponent({
  methods: {
    getScrollTarget: () => ({ scrollTop: 0 }),
    setScrollPosition: () => undefined,
  },
  render() {
    return h(
      'div',
      { class: ['q-scroll-area-stub', this.$attrs.class] },
      this.$slots.default?.(),
    )
  },
})
const Blank = defineComponent({ setup: () => () => h('div') })
const BannerStackStub = defineComponent({
  props: ['stampStatus'],
  setup: () => () => h('div', { 'data-testid': 'chat-banner-stack' }),
})

async function mountChat() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useChatStore().chats[DEALER] = { messages: [] } as never
  const wrapper = mount(ChatPage as never, {
    global: {
      plugins: [pinia],
      components: stubs,
      stubs: {
        ChatInput: Blank,
        BlackjackUnsentWagers: Blank,
        ChatMessageComponent: Blank,
        ChatMessageReply: Blank,
        ChatBannerStack: BannerStackStub,
      },
      mocks: {
        $route: { params: { address: DEALER } },
        $q: { dark: { isActive: false } },
        $t: (key: string) => key,
      },
    },
  })
  await flushPromises()
  return wrapper
}

describe('Chat.vue layout structure (mounted)', () => {
  it('pads the message list vertically so the first bubble clears the header', async () => {
    const list = (await mountChat()).find('.chat-message-list')
    expect(list.exists()).toBe(true)
    expect(list.classes()).toEqual(
      expect.arrayContaining(['q-py-md', 'q-px-lg']),
    )
  })

  it('puts the message list inside the scroll area, inside the bounded col/relative box', async () => {
    const wrapper = await mountChat()
    const box = wrapper.find('.col.relative-position')
    expect(box.exists()).toBe(true)
    const scroll = box.find('.q-scroll-area-stub')
    expect(scroll.exists()).toBe(true)
    expect(scroll.classes()).toEqual(
      expect.arrayContaining(['absolute', 'full-width', 'full-height']),
    )
    expect(scroll.find('.chat-message-list').exists()).toBe(true)
  })

  it('stacks the banners ABOVE the list, as siblings in one no-wrap column', async () => {
    const wrapper = await mountChat()
    const page = wrapper.find('.chat-page-background')
    expect(page.classes()).toEqual(
      expect.arrayContaining(['column', 'no-wrap']),
    )
    const kids = Array.from(page.element.children)
    const banner = kids.findIndex(
      el => el.getAttribute('data-testid') === 'chat-banner-stack',
    )
    const listBox = kids.findIndex(
      el =>
        el.classList.contains('col') &&
        el.classList.contains('relative-position'),
    )
    expect(banner).toBeGreaterThanOrEqual(0)
    expect(listBox).toBeGreaterThan(banner)
  })
})
