/** @jest-environment jsdom */
// Mounted Chat.vue LAYOUT structure (#390, and the structure half of #302). jsdom cannot measure
// layout, but the topology and positioning classes that produce it are asserted here: the banner
// stack overlays the bounded chat viewport instead of consuming flex height, the scroll box keeps
// its identity when a banner toggles, and the message list carries vertical padding so the first
// bubble never touches the header.
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
  props: { stampStatus: { type: String, default: null } },
  setup: props => () =>
    props.stampStatus ? h('div', { 'data-testid': 'chat-banner-stack' }) : null,
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
      expect.arrayContaining([
        'chat-message-list--overlay-clearance',
        'q-py-md',
        'q-px-lg',
      ]),
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

  it('places the banner stack in an absolute overlay inside the bounded viewport', async () => {
    const wrapper = await mountChat()
    ;(
      wrapper.vm as unknown as { stampPreparationStatus: string | null }
    ).stampPreparationStatus = 'checking'
    await wrapper.vm.$nextTick()

    const viewport = wrapper.get('.col.relative-position')
    const scroll = viewport.get('.q-scroll-area-stub')
    const overlay = viewport.get('.chat-banner-overlay')
    expect(overlay.classes()).toEqual(
      expect.arrayContaining(['absolute-top', 'full-width']),
    )
    expect(overlay.get('[data-testid="chat-banner-stack"]').exists()).toBe(true)
    expect(scroll.element.parentElement).toBe(viewport.element)
    expect(overlay.element.parentElement).toBe(viewport.element)
  })

  it('keeps the same scroll box dimensions and bottom state when a banner toggles', async () => {
    const wrapper = await mountChat()
    const scroll = wrapper.get('.q-scroll-area-stub').element as HTMLElement
    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, value: 720 },
      clientHeight: { configurable: true, value: 480 },
    })
    const dimensions = [scroll.clientWidth, scroll.clientHeight]
    const bottom = (wrapper.vm as unknown as { bottom: boolean }).bottom

    ;(
      wrapper.vm as unknown as { stampPreparationStatus: string | null }
    ).stampPreparationStatus = 'checking'
    await wrapper.vm.$nextTick()

    const scrollAfter = wrapper.get('.q-scroll-area-stub')
      .element as HTMLElement
    expect(scrollAfter).toBe(scroll)
    expect([scrollAfter.clientWidth, scrollAfter.clientHeight]).toEqual(
      dimensions,
    )
    expect((wrapper.vm as unknown as { bottom: boolean }).bottom).toBe(bottom)
  })
})
