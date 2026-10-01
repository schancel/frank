/** @jest-environment jsdom */
// Mounted Chat.vue (#310, #395): the TEMPLATE wiring of blackjack. The dealer's bubbles place bets
// through what Chat.vue `provide`s (the idle-waiting, chat-guarded delivery), so replacing
// `sendFollowUpWhenIdle` with `sendFollowUpItems` fails here; and the compose bar has no blackjack
// control in any chat (the toolbar "Play blackjack" button is gone).
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
const mockUseMonadWallet = jest.fn()
jest.mock('../utils/clients', () => ({
  useMonadWallet: () => mockUseMonadWallet(),
}))
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
const ChatInput = require('../components/chat/ChatInput.vue').default
const { useChatStore } = require('../stores/chats')
const { useContactStore } = require('../stores/contacts')
const { activeChain } = require('@frank/wallet/chain')

const DEALER = '0x3e3e3e3e3e3E3E3E3e3e3E3E3e3e3E3E3e3E3E3e'
const SELF = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
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
// Exposes the icon of every button so a casino (blackjack) button cannot hide.
stubs.QBtn = defineComponent({
  inheritAttrs: false,
  props: ['icon'],
  setup:
    (props, { attrs, slots }) =>
    () =>
      h('button', { ...attrs, 'data-icon': props.icon }, slots.default?.()),
})
const InputStub = defineComponent({
  props: ['disable'],
  setup: () => () => h('div', { 'data-stub': 'chat-input' }),
})
const BannerStub = defineComponent({
  props: ['address', 'name', 'submit'],
  setup: () => () => h('div', { 'data-stub': 'unsent' }),
})
// Stands in for a chat bubble and captures what Chat.vue provides to the dealer's bubbles.
let provided: any
const Bubble = defineComponent({
  inject: { blackjackChat: { from: 'blackjackChat', default: null } },
  setup() {
    return () => h('div', { 'data-stub': 'bubble' })
  },
  mounted() {
    provided = (this as any).blackjackChat
  },
})
const Blank = defineComponent({ setup: () => () => h('div') })

async function mountChat(
  profile: { isBot?: boolean } | undefined,
  options: {
    realInput?: boolean
    address?: string
    seedMessage?: boolean
  } = {},
) {
  const address = options.address ?? DEALER
  const pinia = createPinia()
  setActivePinia(pinia)
  const contacts = useContactStore()
  if (profile) {
    contacts.addContact({
      address,
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
  const chats = useChatStore()
  if (options.seedMessage !== false) {
    chats.chats[address] = {
      messages: [
        { payloadDigest: 'd1', outbound: false, items, outpoints: [] },
      ],
    } as never
  }
  provided = undefined
  const wrapper = mount(ChatPage as never, {
    global: {
      plugins: [pinia],
      components: stubs,
      directives: { 'close-popup': {}, 'touch-swipe': {} },
      stubs: {
        ...(options.realInput ? {} : { ChatInput: InputStub }),
        BlackjackUnsentWagers: BannerStub,
        ChatMessageComponent: Bubble,
        ChatMessageReply: Blank,
        ChatBannerStack: Blank,
      },
      mocks: {
        $route: { params: { address } },
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
    chats,
  }
}

describe('Chat.vue blackjack wiring (mounted)', () => {
  beforeEach(() => {
    mockUseMonadWallet.mockReset()
    mockUseMonadWallet.mockReturnValue({
      identity: { address: { raw: SELF }, displayAddress: SELF },
    })
  })

  it.each([
    ['a bot-marked dealer', { isBot: true }],
    ['a plain profile', { isBot: false }],
    ['a profile with no marker', {}],
    ['a chat with no contact', undefined],
  ])(
    'the compose bar has no blackjack control for %s (toolbar button removed)',
    async (_name, profile) => {
      const { wrapper } = await mountChat(profile, { realInput: true })
      expect(
        wrapper.find('[data-testid="blackjack-menu-button"]').exists(),
      ).toBe(false)
      expect(wrapper.find('[data-icon="casino"]').exists()).toBe(false)
      // The compose bar itself is still there.
      expect(wrapper.find('[data-icon="send"]').exists()).toBe(true)
    },
  )

  it('passes the compose bar no blackjack props', async () => {
    const { input } = await mountChat({ isBot: true })
    expect(Object.keys(input.props())).toEqual(['disable'])
    expect(input.attributes()).not.toHaveProperty('address')
    expect(input.attributes()).not.toHaveProperty('blackjack-enabled')
  })

  it('binds the peer name and address to the unsent banner', async () => {
    const { banner } = await mountChat({ isBot: true })
    expect(banner.props('address')).toBe(DEALER)
    expect(banner.props('name')).toBe('Dealer')
  })

  it.each([
    ['the banner submit', (c: any) => c.banner.props('submit')],
    ['the bubbles submit', () => provided.submit],
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

  it('provides the dealer bubbles the stamp this chat will pay', async () => {
    await mountChat({ isBot: true })
    expect(typeof provided.stampWei()).toBe('bigint')
    expect(provided.stampWei()).toBeGreaterThan(0n)
  })

  it('delivers through the real send pipeline for the right chat, and throws when it fails', async () => {
    const mounted = await mountChat({ isBot: true })
    const vm = mounted.wrapper.vm as any
    vm.sendDirectMessage = jest.fn().mockRejectedValue(new Error('relay down'))
    const submit = provided.submit as (p: unknown) => Promise<void>
    await expect(submit({ items, address: DEALER })).rejects.toThrow(
      /could not be sent/,
    )
    vm.sendDirectMessage = jest
      .fn()
      .mockResolvedValue({ state: 'sent', payloadDigest: 'd' })
    await expect(submit({ items, address: DEALER })).resolves.toBeUndefined()
    expect(vm.sendDirectMessage).toHaveBeenCalledTimes(1)
  })

  it('submits the mounted composer to the ordinary stamped store path for self-chat', async () => {
    const send = jest
      .spyOn(activeChain.directMessages, 'send')
      .mockResolvedValue({
        payloadDigest: 'self-digest',
        stampValueWei: 7000n,
        stampPayments: [
          {
            txHash: '0xstamp',
            destinationAddress: SELF,
            valueWei: 7000n,
          },
        ],
        preparationTxHashes: [],
      })
    const mounted = await mountChat(
      {},
      { address: SELF, realInput: true, seedMessage: false },
    )
    const vm = mounted.wrapper.vm as any
    vm.message = 'note to self'
    await mounted.wrapper.vm.$nextTick()
    ;(mounted.wrapper.findComponent(ChatInput).vm as any).sendMessage()
    await flushPromises()

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: expect.objectContaining({ raw: SELF }),
        stampValue: expect.anything(),
      }),
    )
    expect(typeof send.mock.calls[0]?.[0].stampValue).toBe('bigint')
    expect(mounted.chats.chats[SELF]?.messages).toEqual([
      expect.objectContaining({
        payloadDigest: 'self-digest',
        outbound: true,
        status: 'confirmed',
        items: [{ type: 'text', text: 'note to self' }],
      }),
    ])
    expect(mounted.chats.chats[SELF]?.totalValue).toBeGreaterThan(0)
  })
})
