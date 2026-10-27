/** @jest-environment jsdom */
// Chat.vue under the real router, when the route moves to another conversation of the same page
// (/chat/<contact> -> /chat/<conversation>, as "Send message" on a contact page does). QA on lab
// main d28780527 saw "TypeError: Cannot read properties of null (reading 'cancelHistoryAnchor')
// at beforeRouteUpdate (src/pages/Chat.vue)": the router picks the component's guards with the
// page mounted, but calls each with whatever instance the record holds when its turn comes, and
// ChatLayout's own beforeRouteUpdate (run first) can hide its <router-view> (the info view, or
// "conversation not found" for an id the store does not have yet), unmounting the page.
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import * as quasar from 'quasar'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'

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

import { TextDecoder, TextEncoder } from 'util'
import { setConversationIdSalt as installTestConversationIdSalt } from '../stores/chats'
import { conversationIdSalt as testConversationIdSalt } from '@frank/cashweb/relay/conversation-id'

Object.assign(globalThis, { TextEncoder, TextDecoder })
/* eslint-disable @typescript-eslint/no-var-requires */
const ChatPage = require('./Chat.vue').default
const { useChatStore } = require('../stores/chats')

const DEALER = '0x3e3e3e3e3e3E3E3E3e3e3E3E3e3e3E3E3e3E3E3e'
const OTHER = '0x4444444444444444444444444444444444444444'

const Blank = defineComponent({ setup: () => () => h('div') })
const passThrough = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('div', slots.default?.()),
})
const stubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter(n => /^Q[A-Z]/.test(n))
    .map(n => [n, passThrough]),
)
stubs.QScrollArea = defineComponent({
  emits: ['scroll'],
  methods: {
    getScrollTarget: () => ({ scrollTop: 0, scrollHeight: 900 }),
    setScrollPosition: () => undefined,
  },
  render() {
    return h('div', this.$slots.default?.())
  },
})

/** Like ChatLayout: its own beforeRouteUpdate decides, before the page's guard runs, whether
 * the page is shown at all for the next route. */
function layout(showPageFor: (address: string) => boolean) {
  return defineComponent({
    data: () => ({ show: true }),
    beforeRouteUpdate(to) {
      this.show = showPageFor(String(to.params.address ?? ''))
    },
    render() {
      return this.show ? h(RouterView) : h('div', 'info')
    },
  })
}

async function mountAt(showPageFor: (address: string) => boolean) {
  installTestConversationIdSalt(
    testConversationIdSalt(new Uint8Array(32).fill(0x7e)),
  )
  const pinia = createPinia()
  setActivePinia(pinia)
  const chats = useChatStore()
  chats.openDirectConversation(DEALER)
  const other = chats.openDirectConversation(OTHER)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/chat',
        component: layout(showPageFor),
        children: [{ path: ':address', component: ChatPage }],
      },
    ],
  })
  const errors: unknown[] = []
  router.onError(error => errors.push(error))
  await router.push(`/chat/${DEALER}`)
  const wrapper = mount(defineComponent({ render: () => h(RouterView) }), {
    global: {
      plugins: [pinia, router],
      components: stubs,
      stubs: {
        ChatInput: Blank,
        ChatMessageComponent: Blank,
        ChatMessageReply: Blank,
        ChatBannerStack: Blank,
      },
      mocks: {
        $q: { dark: { isActive: false } },
        $t: (key: string) => key,
      },
    },
  })
  await flushPromises()
  return { wrapper, router, errors, otherId: other.id as string }
}

describe('Chat.vue when the route moves to another conversation', () => {
  it('does not fail when the layout hides the page earlier in the same navigation', async () => {
    const { wrapper, router, errors, otherId } = await mountAt(
      address => address !== otherId,
    )
    expect(wrapper.findComponent(ChatPage).exists()).toBe(true)
    await router.push(`/chat/${otherId}`)
    await flushPromises()
    expect(errors).toEqual([])
    expect(router.currentRoute.value.params.address).toBe(otherId)
    expect(wrapper.findComponent(ChatPage).exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens the next conversation at its latest messages when the page stays', async () => {
    const { wrapper, router, errors, otherId } = await mountAt(() => true)
    const page = wrapper.findComponent(ChatPage)
    const vm = page.vm as unknown as {
      address: string
      messagesToShow: number
      historyAnchorPending: boolean
    }
    expect(vm.address).toBe(DEALER)
    vm.messagesToShow = 90
    await router.push(`/chat/${otherId}`)
    await flushPromises()
    expect(errors).toEqual([])
    // The same page instance, now on the other conversation, back at its latest messages.
    const uid = (component: { vm: unknown }) =>
      (component.vm as { $: { uid: number } }).$.uid
    expect(uid(wrapper.findComponent(ChatPage))).toBe(uid(page))
    expect(vm.address).toBe(otherId)
    expect(vm.messagesToShow).toBe(30)
    expect(vm.historyAnchorPending).toBe(false)
    wrapper.unmount()
  })
})
