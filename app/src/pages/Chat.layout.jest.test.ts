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

// Chat.vue reads the own address reactively; these tests have no wallet to resolve it from.
jest.mock('../utils/own-address', () => ({
  ...jest.requireActual('../utils/own-address'),
  useReactiveOwnCanonicalAddress: () => jest.requireActual('vue').ref(null),
}))
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
const setScrollPosition = jest.fn()
stubs.QScrollArea = defineComponent({
  methods: {
    getScrollTarget: () => ({ scrollTop: 0, scrollHeight: 900 }),
    setScrollPosition: (...args: unknown[]) => setScrollPosition(...args),
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
const MessageStub = defineComponent({
  inheritAttrs: false,
  props: { payloadDigest: { type: String, required: true } },
  setup:
    (props, { attrs }) =>
    () =>
      h('div', {
        ...attrs,
        'data-testid': 'chat-message',
        'data-payload-digest': props.payloadDigest,
      }),
})
const BannerStackStub = defineComponent({
  props: { stampStatus: { type: String, default: null } },
  setup: props => () => {
    if (!props.stampStatus) return null
    return h('div', { 'data-testid': 'chat-banner-stack' }, [
      h('div', { 'data-testid': 'mailbox-banner' }, 'Mailbox unavailable'),
      h('div', { 'data-testid': 'stamp-banner' }, String(props.stampStatus)),
    ])
  },
})
const ResizeObserverStub = defineComponent({
  name: 'QResizeObserver',
  emits: ['resize'],
  setup: () => () => h('span', { 'data-testid': 'banner-resize-observer' }),
})

// The page has two observers: the banner overlay's and the message list's.
const bannerObserver = (wrapper: { get: (selector: string) => any }) =>
  wrapper.get('.chat-banner-overlay').getComponent(ResizeObserverStub)
const listObserver = (wrapper: { get: (selector: string) => any }) =>
  wrapper.get('.chat-message-list').getComponent(ResizeObserverStub)

function message(payloadDigest: string) {
  return {
    outbound: false,
    status: '',
    receivedTime: 0,
    serverTime: 0,
    items: [],
    outpoints: [],
    senderAddress: DEALER,
    payloadDigest,
  }
}

async function mountChat(messages: ReturnType<typeof message>[] = []) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useChatStore().openDirectConversation(DEALER).messages = messages
  const wrapper = mount(ChatPage as never, {
    global: {
      plugins: [pinia],
      components: stubs,
      stubs: {
        ChatInput: Blank,
        ChatMessageComponent: MessageStub,
        ChatMessageReply: Blank,
        ChatBannerStack: BannerStackStub,
        QResizeObserver: ResizeObserverStub,
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
    expect(list.classes()).not.toContain('chat-message-list--overlay-clearance')
    expect((list.element as HTMLElement).style.paddingTop).toBe('')
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

  it('uses the measured two-banner height for list clearance without replacing the scroll box', async () => {
    const wrapper = await mountChat()
    const scroll = wrapper.get('.q-scroll-area-stub').element as HTMLElement
    const bottom = (wrapper.vm as unknown as { bottom: boolean }).bottom

    ;(
      wrapper.vm as unknown as { stampPreparationStatus: string | null }
    ).stampPreparationStatus = 'checking a wrapped funding transaction'
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('[data-testid$="banner"]')).toHaveLength(2)

    bannerObserver(wrapper).vm.$emit('resize', {
      width: 375,
      height: 96,
    })
    await wrapper.vm.$nextTick()

    const scrollAfter = wrapper.get('.q-scroll-area-stub')
      .element as HTMLElement
    expect(scrollAfter).toBe(scroll)
    expect(wrapper.get('.chat-message-list').attributes('style')).toContain(
      'padding-top: 112px',
    )
    expect((wrapper.vm as unknown as { bottom: boolean }).bottom).toBe(bottom)
  })

  it('lets pointer, wheel, and touch input pass through and paints no empty shadow', async () => {
    const wrapper = await mountChat()
    const overlay = wrapper.get('.chat-banner-overlay')
    expect(overlay.classes()).toContain('no-pointer-events')
    expect(overlay.classes()).not.toContain('shadow-2')
    ;(
      wrapper.vm as unknown as { stampPreparationStatus: string | null }
    ).stampPreparationStatus = 'checking'
    await wrapper.vm.$nextTick()
    bannerObserver(wrapper).vm.$emit('resize', {
      width: 375,
      height: 96,
    })
    await wrapper.vm.$nextTick()

    expect(overlay.classes()).toContain('shadow-2')
  })

  it('offsets an interior reply target by the same measured banner clearance', async () => {
    const wrapper = await mountChat([message('reply-target')])
    ;(
      wrapper.vm as unknown as { stampPreparationStatus: string | null }
    ).stampPreparationStatus = 'checking'
    await wrapper.vm.$nextTick()
    bannerObserver(wrapper).vm.$emit('resize', {
      width: 375,
      height: 96,
    })
    await wrapper.vm.$nextTick()

    const target = wrapper.get('[data-payload-digest="reply-target"]')
    const scrollIntoView = jest.fn()
    target.element.scrollIntoView = scrollIntoView
    ;(
      wrapper.vm as unknown as { scrollToMessage: (digest: string) => void }
    ).scrollToMessage('reply-target')
    await new Promise(resolve => setTimeout(resolve, 80))

    expect(target.attributes('style')).toContain('scroll-margin-top: 112px')
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' })
  })

  it('moves a history scroll by the padding change, not the extra stylesheet gap', async () => {
    const wrapper = await mountChat()
    const target = { scrollTop: 40 }
    const scroll = wrapper.getComponent(stubs.QScrollArea)
    scroll.vm.getScrollTarget = () => target
    ;(wrapper.vm as unknown as { bottom: boolean }).bottom = false
    ;(
      wrapper.vm as unknown as { stampPreparationStatus: string | null }
    ).stampPreparationStatus = 'checking'
    await wrapper.vm.$nextTick()
    bannerObserver(wrapper).vm.$emit('resize', {
      width: 375,
      height: 96,
    })
    await wrapper.vm.$nextTick()
    // q-py-md is already 16px. Clearance 112 replaces it, so the list grows by 96.
    expect(target.scrollTop).toBe(40 + 96)
  })

  it('stays on the newest message when a bubble grows, unless the user scrolled up', async () => {
    const wrapper = await mountChat([message('a'), message('b')])
    const vm = wrapper.vm as unknown as {
      scrollHandler(details: {
        verticalSize: number
        verticalContainerSize: number
        verticalPosition: number
      }): void
    }
    const size = { verticalSize: 900, verticalContainerSize: 500 }
    vm.scrollHandler({ ...size, verticalPosition: 400 }) // at the bottom
    setScrollPosition.mockClear()

    // The last bubble renders its result: the content is taller, the view has not moved.
    vm.scrollHandler({ ...size, verticalSize: 1080, verticalPosition: 400 })
    listObserver(wrapper).vm.$emit('resize', { width: 375, height: 1080 })
    expect(setScrollPosition).toHaveBeenCalledTimes(1)
    expect(setScrollPosition).toHaveBeenCalledWith('vertical', 900, 0)

    // Reading history: a bubble that grows must not pull the view down.
    vm.scrollHandler({ ...size, verticalSize: 1080, verticalPosition: 200 })
    setScrollPosition.mockClear()
    listObserver(wrapper).vm.$emit('resize', { width: 375, height: 1200 })
    expect(setScrollPosition).not.toHaveBeenCalled()
  })
})
