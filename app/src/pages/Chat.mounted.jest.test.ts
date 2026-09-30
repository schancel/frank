/** @jest-environment jsdom */
// Mounted Chat.vue (#310, F3): the TEMPLATE wiring of the blackjack entry point. Children are
// stubs that expose the props Chat.vue binds, so replacing `sendFollowUpWhenIdle` with
// `sendFollowUpItems`, or the bot gate with `true`, fails here.
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
const items = [
  { type: 'blackjack-move', gameId: 'g', action: 'bet', wagerTxHash: '0xh' },
]

const passthrough = (tag = 'div') =>
  defineComponent({
    inheritAttrs: false,
    setup:
      (_, { slots }) =>
      () =>
        h(tag, slots.default?.()),
  })
const stubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter(n => /^Q[A-Z]/.test(n))
    .map(n => [n, passthrough()]),
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
const InputStub = defineComponent({
  props: [
    'address',
    'blackjackEnabled',
    'peerName',
    'submitFollowUp',
    'disable',
  ],
  setup: () => () => h('div', { 'data-stub': 'chat-input' }),
})
const BannerStub = defineComponent({
  props: ['address', 'name', 'submit'],
  setup: () => () => h('div', { 'data-stub': 'unsent' }),
})
const Blank = defineComponent({ setup: () => () => h('div') })

async function mountChat(profile: { isBot?: boolean } | undefined) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const contacts = useContactStore()
  if (profile) {
    contacts.addContact({
      address: DEALER,
      contact: {
        profile: {
          name: 'Dealer',
          bio: '',
          avatar: '',
          pubKey: null,
          ...profile,
        },
      },
    })
  }
  useChatStore().chats[DEALER] = { messages: [] } as never
  const wrapper = mount(ChatPage as never, {
    global: {
      plugins: [pinia],
      components: stubs,
      stubs: {
        ChatInput: InputStub,
        BlackjackUnsentWagers: BannerStub,
        ChatMessageComponent: Blank,
        ChatMessageReply: Blank,
        ChatBannerStack: Blank,
      },
      mocks: {
        $route: { params: { address: DEALER } },
        $q: { dark: { isActive: false } },
        $t: (key: string) => key,
      },
    },
  })
  await flushPromises()
  return {
    wrapper,
    input: wrapper.findComponent(InputStub),
    banner: wrapper.findComponent(BannerStub),
  }
}

describe('Chat.vue blackjack wiring (mounted)', () => {
  it('shows the blackjack control only for a peer whose profile carries the bot marker', async () => {
    expect(
      (await mountChat({ isBot: true })).input.props('blackjackEnabled'),
    ).toBe(true)
    expect(
      (await mountChat({ isBot: false })).input.props('blackjackEnabled'),
    ).toBe(false)
    expect((await mountChat({})).input.props('blackjackEnabled')).toBe(false)
    expect((await mountChat(undefined)).input.props('blackjackEnabled')).toBe(
      false,
    )
  })

  it('binds the peer name and address to the input and the unsent banner', async () => {
    const { input, banner } = await mountChat({ isBot: true })
    expect(input.props('address')).toBe(DEALER)
    expect(input.props('peerName')).toBe('Dealer')
    expect(banner.props('address')).toBe(DEALER)
    expect(banner.props('name')).toBe('Dealer')
  })

  it.each([
    ['ChatInput submit-follow-up', (c: any) => c.input.props('submitFollowUp')],
    ['unsent banner submit', (c: any) => c.banner.props('submit')],
  ])(
    '%s is the idle-waiting, chat-guarded delivery (not the raw send)',
    async (_name, pick) => {
      const mounted = await mountChat({ isBot: true })
      const submit = pick(mounted) as (p: unknown) => Promise<void>
      // The raw sendFollowUpItems ignores the chat guard; sendFollowUpWhenIdle refuses a different chat.
      await expect(
        submit({ items, address: '0xSomeOtherChat' }),
      ).rejects.toThrow(/chat changed/)
    },
  )

  it('delivers through the real send pipeline for the right chat, and throws when it fails', async () => {
    const mounted = await mountChat({ isBot: true })
    const vm = mounted.wrapper.vm as any
    vm.sendDirectMessage = jest.fn().mockRejectedValue(new Error('relay down'))
    const submit = mounted.input.props('submitFollowUp') as (
      p: unknown,
    ) => Promise<void>
    await expect(submit({ items, address: DEALER })).rejects.toThrow(
      /could not be sent/,
    )
    vm.sendDirectMessage = jest.fn().mockResolvedValue(undefined)
    await expect(submit({ items, address: DEALER })).resolves.toBeUndefined()
    expect(vm.sendDirectMessage).toHaveBeenCalledTimes(1)
  })
})
