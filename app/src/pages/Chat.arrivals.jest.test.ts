/** @jest-environment jsdom */
// A message that arrives while a chat is open is announced to assistive technology exactly once,
// through a polite log that starts empty: opening a chat must not read out its history.
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
const enUS = require('../i18n/en-us').default
const frFR = require('../i18n/fr-fr').default

const PEER = '0x3e3e3e3e3e3E3E3E3e3e3E3E3e3e3E3E3e3E3E3e'
const OTHER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'

const plain = (tag = 'div') =>
  defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h(tag, slots.default?.()),
  })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter(n => /^Q[A-Z]/.test(n))
    .map(n => [n, plain()]),
)
stubs.QScrollArea = defineComponent({
  methods: {
    getScrollTarget: () => ({ scrollTop: 0 }),
    setScrollPosition: () => undefined,
  },
  render() {
    return h('div', this.$slots.default?.())
  },
})
const Blank = defineComponent({ setup: () => () => h('div') })

function message(payloadDigest: string, text: string, outbound = false) {
  return {
    outbound,
    status: 'confirmed',
    receivedTime: 0,
    serverTime: 0,
    items: [{ type: 'text', text }],
    outpoints: [],
    senderAddress: PEER,
    payloadDigest,
  }
}

function translate(locale: unknown) {
  return (key: string, params: Record<string, unknown> = {}) => {
    const value = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], locale)
    return typeof value === 'string'
      ? value.replace(/\{(\w+)\}/g, (_m, k: string) => String(params[k]))
      : key
  }
}

async function mountChat(
  history: ReturnType<typeof message>[],
  locale: unknown = enUS,
) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const contacts = useContactStore()
  for (const [address, name] of [
    [PEER, 'Dana'],
    [OTHER, 'Eli'],
  ]) {
    contacts.addContact({
      address,
      contact: { profile: { name, bio: '', avatar: '', pubKey: null } },
    })
  }
  const chats = useChatStore()
  chats.chats[PEER] = { messages: history } as never
  chats.chats[OTHER] = {
    messages: [message('other-1', 'elsewhere')],
  } as never
  const $route = { params: { address: PEER } }
  const wrapper = mount(ChatPage as never, {
    global: {
      plugins: [pinia],
      components: stubs,
      stubs: {
        ChatInput: Blank,
        BlackjackUnsentWagers: Blank,
        ChatMessageComponent: Blank,
        ChatMessageReply: Blank,
        ChatBannerStack: Blank,
        QResizeObserver: Blank,
      },
      mocks: {
        $route,
        $q: { dark: { isActive: false } },
        $t: translate(locale),
      },
    },
  })
  await flushPromises()
  const log = () => wrapper.get('[data-testid="incoming-message-log"]')
  const entries = () => log().findAll('p')
  return { wrapper, chats, log, entries }
}

describe('Chat.vue announces arriving messages', () => {
  it('is a polite, additions-only log that does not read out history on load', async () => {
    const { log, entries } = await mountChat([
      message('old-1', 'old one'),
      message('old-2', 'old two'),
    ])
    expect(log().attributes()).toMatchObject({
      'role': 'log',
      'aria-live': 'polite',
      'aria-relevant': 'additions',
      'aria-label': 'New messages',
    })
    expect(entries()).toHaveLength(0)
    expect(log().text()).toBe('')
  })

  it('announces an arriving message once, and not again on later updates', async () => {
    const { wrapper, chats, entries } = await mountChat([
      message('old-1', 'old one'),
    ])
    chats.chats[PEER].messages.push(message('new-1', 'hello there'))
    await flushPromises()
    expect(entries()).toHaveLength(1)
    expect(entries()[0].text()).toBe('Message from Dana: hello there')
    const node = entries()[0].element

    // An own message and an unrelated re-render add nothing and do not re-insert the entry.
    chats.chats[PEER].messages.push(message('mine-1', 'my reply', true))
    ;(wrapper.vm as unknown as { message: string }).message = 'typing'
    await flushPromises()
    expect(entries()).toHaveLength(1)
    expect(entries()[0].element).toBe(node)
    expect(wrapper.html()).not.toContain('my reply')

    // The next arrival is announced on its own.
    chats.chats[PEER].messages.push(message('new-2', 'second'))
    await flushPromises()
    expect(entries()).toHaveLength(1)
    expect(entries()[0].text()).toContain('second')
    expect(entries()[0].text()).not.toContain('hello there')
  })

  it('announces every message of one batch, each once', async () => {
    const { chats, entries } = await mountChat([])
    chats.chats[PEER].messages.push(
      message('b-1', 'first of two'),
      message('b-2', 'second of two'),
    )
    await flushPromises()
    expect(entries().map(entry => entry.text())).toEqual([
      expect.stringContaining('first of two'),
      expect.stringContaining('second of two'),
    ])
  })

  it('treats another chat and a reloaded list as history, not arrivals', async () => {
    const { wrapper, chats, entries } = await mountChat([
      message('old-1', 'old one'),
    ])
    chats.chats[PEER].messages.push(message('new-1', 'hello there'))
    await flushPromises()
    expect(entries()).toHaveLength(1)

    // Switching chat (the route is reused) shows that chat's history silently.
    ;(wrapper.vm as unknown as { address: string }).address = OTHER
    await flushPromises()
    expect(entries()).toHaveLength(0)

    // The store being reloaded replaces the list: also history.
    chats.chats[OTHER] = {
      messages: [
        message('other-1', 'elsewhere'),
        message('other-2', 'restored'),
      ],
    } as never
    await flushPromises()
    expect(entries()).toHaveLength(0)

    chats.chats[OTHER].messages.push(message('other-3', 'live again'))
    await flushPromises()
    expect(entries()).toHaveLength(1)
    expect(entries()[0].text()).toContain('live again')
  })

  it('is localized in French', async () => {
    const { chats, log, entries } = await mountChat([], frFR)
    expect(log().attributes('aria-label')).toBe('Nouveaux messages')
    chats.chats[PEER].messages.push(message('fr-1', 'bonjour'))
    await flushPromises()
    expect(entries()[0].text()).toBe('Message de Dana : bonjour')
  })
})
