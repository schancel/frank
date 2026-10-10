/** @jest-environment jsdom */
// Mounted Chat.vue: the TEMPLATE wiring of blackjack. A challenge is offered from the composer's
// message-type menu in every chat with any contact (no dealer, bot or curated-list gate); it opens
// the challenge form, whose submit sends a challenge through the chat's normal send pipeline.
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
// The active wallet, as the own-address lookup reads it.
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(async () => mockUseMonadWallet()),
}))

// jsdom has no TextEncoder/TextDecoder (the wallet/relay modules Chat.vue imports need them).
import { TextDecoder, TextEncoder } from 'util'
import { setConversationIdSalt as installTestConversationIdSalt } from '../stores/chats'
import { conversationIdSalt as testConversationIdSalt } from '@frank/cashweb/relay/conversation-id'

// An account that can open a chat always has its conversation-ID salt installed.
beforeEach(() =>
  installTestConversationIdSalt(
    testConversationIdSalt(new Uint8Array(32).fill(0x7e)),
  ),
)
Object.assign(globalThis, { TextEncoder, TextDecoder })
/* eslint-disable @typescript-eslint/no-var-requires */
const ChatPage = require('./Chat.vue').default
const ChatInput = require('../components/chat/ChatInput.vue').default
const { useChatStore } = require('../stores/chats')
const { useContactStore } = require('../stores/contacts')
const { activeChain } = require('@frank/wallet/chain')

const DEALER = '0x3e3e3e3e3e3E3E3E3e3e3E3E3e3e3E3E3e3E3E3e'
const SELF = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const items = [{ type: 'text', text: 'hello' }]

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
// Menu entries keep their attributes and clicks.
stubs.QItem = defineComponent({
  inheritAttrs: false,
  setup:
    (_, { attrs, slots }) =>
    () =>
      h('div', attrs, slots.default?.()),
})
stubs.QDialog = defineComponent({
  props: ['modelValue'],
  setup:
    (props, { slots }) =>
    () =>
      props.modelValue ? h('div', slots.default?.()) : null,
})
const FormStub = defineComponent({
  props: ['busy'],
  emits: ['submit'],
  setup: () => () => h('div', { 'data-stub': 'challenge-form' }),
})
const Bubble = defineComponent({
  setup: () => () => h('div', { 'data-stub': 'bubble' }),
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
  const wrapper = mount(ChatPage as never, {
    global: {
      plugins: [pinia],
      components: stubs,
      directives: { 'close-popup': {}, 'touch-swipe': {} },
      stubs: {
        ...(options.realInput ? {} : { ChatInput: InputStub }),
        BlackjackChallengeForm: FormStub,
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
    ['a bot-marked contact', { isBot: true }],
    ['a plain profile', { isBot: false }],
    ['a profile with no marker', {}],
    ['a chat with no contact', undefined],
  ])(
    'the message-type menu offers a blackjack challenge for %s',
    async (_name, profile) => {
      const { wrapper } = await mountChat(profile, { realInput: true })
      expect(wrapper.find('[data-testid="blackjack-menu-item"]').exists()).toBe(
        true,
      )
      // No separate toolbar button, and the compose bar itself is still there.
      expect(wrapper.find('[data-icon="casino"]').exists()).toBe(false)
      expect(wrapper.find('[data-icon="send"]').exists()).toBe(true)
    },
  )

  it('passes the compose bar no blackjack props', async () => {
    const { input } = await mountChat({ isBot: true })
    expect(Object.keys(input.props())).toEqual(['disable'])
    expect(input.attributes()).not.toHaveProperty('address')
  })

  it('opens the challenge form from the menu and sends its challenge through the normal send', async () => {
    const { wrapper } = await mountChat(undefined, { realInput: true })
    expect(wrapper.findComponent(FormStub).exists()).toBe(false)
    await wrapper.find('[data-testid="blackjack-menu-item"]').trigger('click')
    const form = wrapper.findComponent(FormStub)
    expect(form.exists()).toBe(true)

    const vm = wrapper.vm as any
    jest
      .spyOn(activeChain.nativeTransfers, 'getBalance')
      .mockResolvedValue(10n ** 18n)
    vm.sendDirectMessage = jest
      .fn()
      .mockResolvedValue({ state: 'sent', payloadDigest: 'd' })
    form.vm.$emit('submit', { role: 'player', maxBetWei: 10n ** 17n })
    await flushPromises()
    expect(vm.sendDirectMessage).toHaveBeenCalledTimes(1)
    const sent = vm.sendDirectMessage.mock.calls[0][0]
    expect(sent.address).toBe(DEALER)
    expect(sent.items).toEqual([
      {
        type: 'blackjack-hand',
        gameId: expect.stringMatching(/^[0-9a-f]{32}$/),
        action: 'challenge',
        seq: 0,
        role: 'player',
        maxBetWei: (10n ** 17n).toString(),
      },
    ])
    // A challenge carries the chat's ordinary stamp, nothing more.
    expect(sent.stampValue).toBe(activeChain.fromDisplayAmount(vm.stampAmount))
    expect(wrapper.findComponent(FormStub).exists()).toBe(false)
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
